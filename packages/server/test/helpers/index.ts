import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/contracts.ts';
import { createSupervisor, type SupervisorDeps } from '../../src/supervisor/supervisor.ts';
import type { ProcessControl } from '../../src/supervisor/context.ts';
import type { Logger } from '../../src/supervisor/errors.ts';
import { createMemoryStore } from './memoryStore.ts';
import { createFakeGit } from './fakeGit.ts';
import { createControlledAgent } from './fakeAgent.ts';

export * from './memoryStore.ts';
export * from './fakeGit.ts';
export * from './fakeAgent.ts';

export const REPO = '/repos/demo';

export const silentLog: Logger & { lines: string[] } = {
  lines: [],
  info(m) { silentLog.lines.push(`info ${m}`); },
  warn(m) { silentLog.lines.push(`warn ${m}`); },
  error(m) { silentLog.lines.push(`error ${m}`); },
};

export function makeHarness(over: { config?: Partial<Config>; processes?: ProcessControl; store?: ReturnType<typeof createMemoryStore> } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-test-'));
  const config: Config = {
    dataDir, worktreeRoot: path.join(dataDir, 'worktrees'), dbPath: ':memory:', port: 0,
    maxConcurrent: 2, testTimeoutMs: 1000, maxBudgetUsd: undefined, ...over.config,
  };
  fs.mkdirSync(config.worktreeRoot, { recursive: true });
  const store = over.store ?? createMemoryStore();
  const git = createFakeGit({ worktreeRoot: config.worktreeRoot, repos: { [REPO]: { detectedTestCommand: 'npm test' } } });
  const agent = createControlledAgent();
  const killed: string[] = [];
  const processes: ProcessControl = over.processes ?? {
    findRunProcesses: () => [],
    killRunProcesses: (id) => (killed.push(id), 0),
  };
  const deps: SupervisorDeps = {
    store, git, agent, config, processes, log: silentLog,
    timings: { tickMs: 60_000, reapMs: 60_000, activityWriteMs: 50, shutdownStopMs: 500, cancelStopMs: 500, orphanGraceMs: 500 },
  };
  const sup = createSupervisor(deps);
  return { sup, store, git, agent, config, killed, deps };
}

export async function until(cond: () => boolean, ms = 2000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
