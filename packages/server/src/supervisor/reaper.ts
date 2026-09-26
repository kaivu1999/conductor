/**
 * Disk hygiene. Worktrees are the expensive resource; this removes the ones nobody owns and
 * retries cleanups that failed earlier (accept/reject log cleanup errors instead of failing).
 * Idempotent and safe to run at any time, including while runs are live.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { TERMINAL_STATES, WORKTREE_STATES, type DiskUsage } from '@conductor/shared';
import { errorMessage } from './errors.ts';
import type { SupervisorContext } from './context.ts';

export async function reapWorktrees(ctx: SupervisorContext): Promise<{ pruned: number; usage: DiskUsage }> {
  const { store, git, log, w } = ctx;
  let pruned = 0;
  const root = path.resolve(ctx.config.worktreeRoot);

  // 1. Terminal runs whose cleanup failed earlier.
  for (const run of store.listByState(TERMINAL_STATES)) {
    if (!run.worktreePath || ctx.busy(run.id)) continue;
    try {
      await git.removeWorktree(run.repoPath, run.worktreePath);
      w.patch(run.id, { worktreePath: null });
      pruned++;
    } catch (err) {
      log.warn(`reaper: could not remove worktree of ${run.id}: ${errorMessage(err)}`);
    }
  }

  // 2. Directories in worktreeRoot that no run owns.
  const known = new Map<string, string>();
  for (const run of store.listByState(WORKTREE_STATES)) if (run.worktreePath) known.set(run.worktreePath, run.id);
  const usage = await git.diskUsage(known);
  const removed = new Set<string>();
  for (const wt of usage.worktrees) {
    if (!wt.orphan) continue;
    const dir = path.resolve(wt.path);
    // Worktrees live at <root>/<runId>. The DB may not have the path yet (createWorktree is in
    // flight), so decide ownership by the run the directory is named after, not by path.
    const id = path.basename(dir);
    const owner = store.getRun(id);
    if (ctx.busy(id) || (owner && (owner.state === 'queued' || WORKTREE_STATES.includes(owner.state)))) continue;
    try {
      if (owner) {
        await git.removeWorktree(owner.repoPath, dir);
      } else {
        // No run to tell us the repo: plain delete, but only a real directory directly in root.
        if (path.dirname(dir) !== root) throw new Error(`${dir} is not directly inside ${root}`);
        const st = await fs.lstat(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${dir} is not a plain directory`);
        await fs.rm(dir, { recursive: true, force: true });
      }
      removed.add(wt.path);
      pruned++;
      log.info(`reaper: removed orphan worktree ${dir}`);
    } catch (err) {
      log.warn(`reaper: could not remove orphan ${dir}: ${errorMessage(err)}`);
    }
  }

  const worktrees = usage.worktrees.filter((x) => !removed.has(x.path));
  return {
    pruned,
    usage: { ...usage, worktrees, totalBytes: worktrees.reduce((n, x) => n + x.bytes, 0) },
  };
}
