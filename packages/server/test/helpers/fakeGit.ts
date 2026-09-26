/** Scriptable Git fake. Worktrees are recorded in memory; nothing touches disk unless a test asks. */
import path from 'node:path';
import type { DiffStat, DiskUsage, RepoInfo, TestResult } from '@conductor/shared';
import type { Git } from '../../src/contracts.ts';

export interface FakeGit extends Git {
  worktrees: Map<string, { repoPath: string; runId: string; branch: string }>; // path -> info
  branches: Set<string>;
  /** paths changed per worktree path */
  changes: Map<string, string[]>;
  commits: string[];
  merges: { branch: string; baseBranch: string }[];
  testResult: Partial<TestResult>;
  mergeResult: Awaited<ReturnType<Git['merge']>>;
  createWorktreeHook?: (runId: string) => Promise<void> | void;
  failRemove: boolean;
  /** What detectTestCommand finds after a run (e.g. the agent added tests to a new project). */
  laterTestCommand: string | null;
  diskEntries: { path: string }[];
  calls: string[];
}

export function createFakeGit(opts: { worktreeRoot: string; repos?: Record<string, Partial<RepoInfo>> }): FakeGit {
  const g: FakeGit = {
    worktrees: new Map(), branches: new Set(), changes: new Map(), commits: [], merges: [], calls: [],
    testResult: { passed: true, exitCode: 0 },
    mergeResult: { ok: true, mergeCommit: 'm'.repeat(40) },
    failRemove: false,
    laterTestCommand: null,
    diskEntries: [],

    async inspectRepo(p) {
      const repo = opts.repos?.[p];
      const base: RepoInfo = { path: p, name: path.basename(p), isGitRepo: false, currentBranch: null, branches: [], dirty: false, detectedTestCommand: null };
      if (!repo) return { ...base, error: `not a git repository: ${p}` };
      return { ...base, isGitRepo: true, currentBranch: 'main', branches: ['main'], ...repo };
    },
    async createWorktree(repoPath, runId, branch) {
      g.calls.push(`createWorktree ${runId}`);
      await g.createWorktreeHook?.(runId);
      const wt = path.join(opts.worktreeRoot, runId);
      g.worktrees.set(wt, { repoPath, runId, branch });
      g.branches.add(branch);
      return { worktreePath: wt, baseCommit: 'b'.repeat(40) };
    },
    async commitAll(wt, message) {
      g.commits.push(`${wt}: ${message}`);
      return (g.changes.get(wt)?.length ?? 0) > 0 ? 'c'.repeat(40) : null;
    },
    async diffStat(wt): Promise<DiffStat> {
      const paths = g.changes.get(wt) ?? [];
      return { files: paths.length, insertions: paths.length * 3, deletions: 0, paths };
    },
    async diff(wt) {
      return (g.changes.get(wt) ?? []).map((p) => ({ path: p, status: 'modified' as const, insertions: 3, deletions: 0, patch: '' }));
    },
    async changedPaths(wt) {
      return g.changes.get(wt) ?? [];
    },
    async runTests(_wt, command) {
      return { command, passed: true, exitCode: 0, durationMs: 10, output: 'ok', ...g.testResult };
    },
    async detectTestCommand() {
      return g.laterTestCommand;
    },
    async merge(_repo, branch, baseBranch) {
      g.merges.push({ branch, baseBranch });
      return g.mergeResult;
    },
    async removeWorktree(_repo, wt) {
      g.calls.push(`removeWorktree ${wt}`);
      if (g.failRemove) throw new Error('device busy');
      g.worktrees.delete(wt);
    },
    async deleteBranch(_repo, branch) {
      g.calls.push(`deleteBranch ${branch}`);
      g.branches.delete(branch);
    },
    async diskUsage(known): Promise<DiskUsage> {
      const paths = new Set([...g.worktrees.keys(), ...g.diskEntries.map((e) => e.path)]);
      const worktrees = [...paths].map((p) => ({ path: p, runId: known.get(p) ?? null, bytes: 100, orphan: !known.has(p) }));
      return { worktreeRoot: opts.worktreeRoot, totalBytes: worktrees.length * 100, worktrees };
    },
  };
  return g;
}
