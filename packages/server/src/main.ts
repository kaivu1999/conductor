/**
 * Entry point: one conductor per CONDUCTOR_HOME (lockfile), reconcile state from the last
 * run (recover), then schedule + serve. SIGINT/SIGTERM stop all agents cleanly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.ts';
import { createSqliteStore } from './store/sqlite.ts';
import { createGit } from './git/git.ts';
import { createAdapterFromEnv, findRunProcesses, killRunProcesses } from './agent/index.ts';
import { createSupervisor } from './supervisor/supervisor.ts';
import { pidExists } from './supervisor/process.ts';
import { buildServer } from './api/server.ts';

/** Take `${dataDir}/conductor.lock` or exit. A lock whose pid is dead is stale and taken over. */
function acquireLock(lockPath: string): () => void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' }); // atomic create-if-absent
      return () => {
        try {
          if (fs.readFileSync(lockPath, 'utf8').trim() === String(process.pid)) fs.unlinkSync(lockPath);
        } catch {
          /* already gone */
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const holder = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== process.pid && pidExists(holder)) {
        console.error(`conductor already running as pid ${holder} (lock ${lockPath}). Stop it first, or use a different CONDUCTOR_HOME.`);
        process.exit(1);
      }
      console.warn(`[conductor] taking over stale lock ${lockPath} (pid ${holder || '?'} is not running)`);
      fs.rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not acquire ${lockPath}`);
}

async function main(): Promise<void> {
  const config = loadConfig();
  const releaseLock = acquireLock(path.join(config.dataDir, 'conductor.lock'));
  process.on('exit', releaseLock);

  const store = createSqliteStore(config.dbPath);
  const git = createGit({ worktreeRoot: config.worktreeRoot });
  const agent = createAdapterFromEnv();
  const supervisor = createSupervisor({ store, git, agent, config, processes: { findRunProcesses, killRunProcesses } });

  const rec = await supervisor.recover();
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  console.log(`[conductor] recovered: ${plural(rec.interrupted.length, 'run')} interrupted, ${plural(rec.orphansKilled, 'orphan agent')} killed, ${plural(rec.worktreesPruned, 'worktree')} pruned`);

  supervisor.startScheduler();
  const app = buildServer({ supervisor, store, git });
  await app.listen({ port: config.port, host: '127.0.0.1' });
  console.log(`[conductor] agent=${agent.name} max=${config.maxConcurrent} home=${config.dataDir} → http://127.0.0.1:${config.port}`);

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) {
      console.warn('[conductor] second signal: exiting immediately');
      process.exit(1);
    }
    stopping = true;
    console.log(`[conductor] ${signal}: stopping agents...`);
    const hardExit = setTimeout(() => process.exit(1), 15_000);
    hardExit.unref();
    try {
      await app.close();
      await supervisor.shutdown();
    } catch (err) {
      console.error('[conductor] shutdown error:', err);
    }
    console.log('[conductor] bye');
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error(`[conductor] failed to start: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
