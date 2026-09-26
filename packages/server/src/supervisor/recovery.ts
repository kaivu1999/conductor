/**
 * Boot-time reconciliation: the DB says what *should* be happening; this makes it true.
 * Runs once, before the scheduler, so nothing in this process is live yet — any agent
 * process that exists now belongs to a conductor that died.
 */
import { LIVE_STATES, type RunState } from '@conductor/shared';
import { errorMessage } from './errors.ts';
import { killOrphan } from './process.ts';
import type { SupervisorContext } from './context.ts';

export interface RecoveryResult {
  interrupted: string[];
  orphansKilled: number;
  worktreesPruned: number;
}

export async function recoverRuns(ctx: SupervisorContext, opts: { killGraceMs?: number } = {}): Promise<Omit<RecoveryResult, 'worktreesPruned'>> {
  const { w, store, log } = ctx;
  const interrupted: string[] = [];
  let orphansKilled = 0;

  const stale = store.listByState([...LIVE_STATES, 'accepting']);
  for (const run of stale) {
    // 1. The agent's own process group, guarded against pid reuse.
    if (run.pid) {
      try {
        const verdict = await killOrphan(run.pid, run.pidStartedAt, opts.killGraceMs);
        if (verdict === 'killed') {
          orphansKilled++;
          w.event(run.id, 'system', `Stopped orphaned agent process ${run.pid} left over from the previous conductor.`);
        } else if (verdict === 'pid_reused' || verdict === 'unverifiable') {
          log.warn(`run ${run.id}: pid ${run.pid} is alive but not provably our agent (${verdict}); leaving it alone`);
          w.event(run.id, 'system', `Process ${run.pid} is alive but is not this run's agent (pid was reused); left it alone.`);
        }
      } catch (err) {
        log.error(`run ${run.id}: failed to stop orphan pid ${run.pid}: ${errorMessage(err)}`);
      }
    }

    // 2. Move out of live states so the scheduler can never see it as running.
    const was: RunState = run.state;
    if (was === 'accepting') {
      // Not interrupted: interrupted -> queued would re-run the agent on an already-finished run.
      // Git.merge updates the base ref atomically, so the merge either fully happened or not at
      // all; going back to `ready` lets the user accept again (re-merging an already-merged
      // branch is a harmless no-op merge). A smarter version would check ancestry and go
      // straight to accepted.
      const r = w.transition(run.id, 'accepting', 'ready', {
        error: 'Conductor restarted while merging this run. The merge either completed or did not start; accept again to finish.',
        activity: 'Merge was interrupted — accept again',
      });
      if (r) w.event(run.id, 'system', 'Merge was interrupted by a conductor restart; accept again.');
      continue;
    }
    const r = w.transition(run.id, was, 'interrupted', {
      error: `Conductor restarted while this run was ${was}; the agent was stopped. Restart to resume.`,
      activity: 'Interrupted by conductor restart',
      pid: null,
      pidStartedAt: null,
    });
    if (r) interrupted.push(run.id);
  }

  // 3. Sweep tagged processes (agent tool subprocesses live in their own groups and survive
  //    step 1). Only for runs in *our* DB: a tag from another CONDUCTOR_HOME isn't ours.
  //    Nothing is live yet, so every tagged process of a known run is an orphan.
  try {
    const ownTag = process.env.CONDUCTOR_RUN_ID; // if conductor itself runs inside a run, spare that run
    const runIds = new Set(ctx.processes.findRunProcesses().map((p) => p.runId));
    for (const id of runIds) {
      if (id === ownTag || !store.getRun(id)) continue;
      const n = ctx.processes.killRunProcesses(id);
      if (n > 0) {
        orphansKilled += n;
        log.info(`run ${id}: killed ${n} leftover agent subprocess(es)`);
      }
    }
  } catch (err) {
    log.error(`orphan process sweep failed: ${errorMessage(err)}`);
  }

  return { interrupted, orphansKilled };
}
