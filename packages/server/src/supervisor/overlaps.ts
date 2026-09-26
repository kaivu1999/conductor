import { WORKTREE_STATES, type Overlap, type Run } from '@conductor/shared';
import { errorMessage } from './errors.ts';
import type { SupervisorContext } from './context.ts';

/**
 * Pure: given each run's changed paths, list for every run the other runs touching the
 * same files. O(n²·p) — fine for the handful of concurrent runs per repo.
 */
export function computeOverlaps(entries: { run: Pick<Run, 'id' | 'title'>; paths: readonly string[] }[]): Map<string, Overlap[]> {
  const sets = entries.map((e) => ({ ...e, set: new Set(e.paths) }));
  const out = new Map<string, Overlap[]>();
  for (const a of sets) {
    const list: Overlap[] = [];
    for (const b of sets) {
      if (a.run.id === b.run.id) continue;
      const shared = [...new Set(a.paths.filter((p) => b.set.has(p)))].sort();
      if (shared.length) list.push({ runId: b.run.id, title: b.run.title, paths: shared });
    }
    out.set(a.run.id, list);
  }
  return out;
}

const same = (a: readonly Overlap[], b: readonly Overlap[]) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Recompute `overlaps` for every open run with a worktree in `repoPath`. Serialized per repo
 * so two recomputes can't interleave and write each other's stale results.
 */
export function createOverlapTracker(ctx: SupervisorContext) {
  const chains = new Map<string, Promise<void>>();

  async function recompute(repoPath: string): Promise<void> {
    const runs = ctx.store
      .listRuns({ includeTerminal: false })
      .filter((r) => r.repoPath === repoPath && WORKTREE_STATES.includes(r.state));
    const entries = await Promise.all(
      runs
        .filter((r) => r.worktreePath && r.baseCommit)
        .map(async (run) => {
          try {
            return { run, paths: await ctx.git.changedPaths(run.worktreePath!, run.baseCommit!) };
          } catch (err) {
            ctx.log.warn(`overlaps: could not read changes of ${run.id}: ${errorMessage(err)}`);
            return { run, paths: [] as string[] };
          }
        }),
    );
    const result = computeOverlaps(entries);
    for (const run of runs) {
      const next = result.get(run.id) ?? []; // runs without a worktree overlap nothing
      const fresh = ctx.w.get(run.id);
      if (!fresh || same(fresh.overlaps, next)) continue;
      ctx.w.patch(run.id, { overlaps: next });
    }
  }

  return {
    /** Never rejects; overlap detection is advisory and must not break a lifecycle step. */
    refresh(repoPath: string): Promise<void> {
      const prev = chains.get(repoPath) ?? Promise.resolve();
      const next = prev
        .then(() => (ctx.w.closed ? undefined : recompute(repoPath)))
        .catch((err) => ctx.log.warn(`overlaps: recompute for ${repoPath} failed: ${errorMessage(err)}`));
      chains.set(repoPath, next);
      void next.finally(() => {
        if (chains.get(repoPath) === next) chains.delete(repoPath);
      });
      return next;
    },
  };
}
