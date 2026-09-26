/**
 * Internal seams of the server. Each module implements one interface and depends
 * only on the others' interfaces, so they can be built and tested independently.
 *
 *   api/        HTTP + SSE           -> Supervisor, Store, Git
 *   supervisor/ lifecycle, scheduling, recovery, reaper  -> Store, Git, AgentAdapter
 *   agent/      Claude Agent SDK adapter (+ fake for tests)
 *   git/        worktrees, diffs, merges, tests, disk usage
 *   store/      SQLite persistence
 */
import type { Run, RunEvent, RunState, DiffStat, RunDiff, TestResult, RepoInfo, DiskUsage, PendingQuestion } from '@conductor/shared';

// ─── store/ ──────────────────────────────────────────────────────────────────

export type NewRun = Pick<Run, 'repoPath' | 'repoName' | 'task' | 'title' | 'baseBranch' | 'branch'> & {
  testCommand: string | null;
};

export interface Store {
  createRun(input: NewRun): Run; // state = queued, id generated
  getRun(id: string): Run | null;
  listRuns(opts?: { includeTerminal?: boolean }): Run[];
  listByState(states: readonly RunState[]): Run[];
  getTestCommand(id: string): string | null;
  /**
   * Atomic compare-and-set on state. Returns the updated run, or null if the run's
   * current state is not in `from` (someone else won). Also throws if from->to is
   * not a legal transition per @conductor/shared TRANSITIONS.
   * This is the ONLY way state changes. It must also append a 'state' RunEvent.
   */
  transition(id: string, from: RunState | readonly RunState[], to: RunState, patch?: Partial<Run>): Run | null;
  /** Non-state field updates (activity, cost, pid, etc). Never touches `state`. */
  patch(id: string, patch: Partial<Omit<Run, 'id' | 'state'>>): Run;
  appendEvent(runId: string, kind: RunEvent['kind'], text: string, data?: unknown): RunEvent;
  listEvents(runId: string, afterId?: number, limit?: number): RunEvent[];
  /** Persisted key/value for conductor-level metadata (e.g. last boot time). */
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
  close(): void;
}

// ─── git/ ────────────────────────────────────────────────────────────────────

export interface Git {
  inspectRepo(path: string): Promise<RepoInfo>;
  /** Creates branch `branch` at `baseBranch` HEAD and a worktree for it. Returns base commit sha. */
  createWorktree(repoPath: string, runId: string, branch: string, baseBranch: string): Promise<{ worktreePath: string; baseCommit: string }>;
  /** Stages and commits everything in the worktree (if anything changed). Returns new HEAD sha or null if no changes. */
  commitAll(worktreePath: string, message: string): Promise<string | null>;
  diffStat(worktreePath: string, baseCommit: string): Promise<DiffStat>;
  diff(worktreePath: string, baseCommit: string): Promise<RunDiff['files']>;
  /** Paths changed on the run branch relative to base (committed + uncommitted). Cheap; used for overlap detection. */
  changedPaths(worktreePath: string, baseCommit: string): Promise<string[]>;
  runTests(worktreePath: string, command: string, timeoutMs: number): Promise<TestResult>;
  detectTestCommand(dir: string): Promise<string | null>;
  /**
   * Merge `branch` into `baseBranch` in the user's repo WITHOUT touching the user's
   * working tree or index (use a temporary worktree on baseBranch, or `git merge-tree`
   * + update-ref). --no-ff. On conflict: abort cleanly, return the conflicting paths.
   * If baseBranch is currently checked out in the user's working copy and that tree
   * is clean, the result must leave their checkout at the new commit (fast-forward the
   * checkout). If it's checked out and dirty, refuse with a clear error.
   */
  merge(repoPath: string, branch: string, baseBranch: string, message: string):
    Promise<{ ok: true; mergeCommit: string } | { ok: false; conflicts: string[]; error: string }>;
  /** Remove worktree dir + `git worktree prune`. Idempotent. Does NOT delete the branch. */
  removeWorktree(repoPath: string, worktreePath: string): Promise<void>;
  deleteBranch(repoPath: string, branch: string): Promise<void>;
  diskUsage(knownWorktrees: Map<string, string>): Promise<DiskUsage>; // path -> runId
}

// ─── agent/ ──────────────────────────────────────────────────────────────────

/** Normalized events the adapter emits; the supervisor turns these into Store writes. */
export type AgentEvent =
  | { type: 'session'; sessionId: string }
  | { type: 'process'; pid: number; startedAt: number }
  | { type: 'activity'; text: string } // the short "what it's doing now" line
  | { type: 'tool'; name: string; summary: string } // timeline entry
  | { type: 'text'; text: string } // assistant prose, trimmed
  | { type: 'question'; question: PendingQuestion } // agent is blocked on the user
  | { type: 'usage'; costUsd: number; turns: number }
  | { type: 'done'; summary: string; costUsd: number; turns: number }
  | { type: 'error'; message: string };

export interface AgentStartOptions {
  runId: string;
  cwd: string; // the worktree
  task: string;
  resumeSessionId?: string; // set on restart
  /** The user's follow-up instructions after reviewing (Continue). Sent as the first message. */
  followUp?: string;
  maxBudgetUsd?: number;
  onEvent: (e: AgentEvent) => void;
}

export interface AgentSession {
  /** Resolves once the agent finishes (after 'done' or 'error' has been emitted). Never rejects. */
  readonly finished: Promise<{ ok: boolean }>;
  answer(questionId: string, answer: string): boolean; // false if no such pending question
  sendMessage(text: string): void; // steer: queue a follow-up user message
  /** Graceful stop, then SIGKILL the process group after a grace period. */
  stop(): Promise<void>;
}

export interface AgentAdapter {
  readonly name: string;
  start(opts: AgentStartOptions): AgentSession;
}

// ─── supervisor/ ─────────────────────────────────────────────────────────────

export interface Supervisor {
  /** Boot: reconcile persisted state with reality (see README "restart semantics"). */
  recover(): Promise<{ interrupted: string[]; orphansKilled: number; worktreesPruned: number }>;
  startScheduler(): void; // pulls queued runs up to maxConcurrent
  createRun(input: { repoPath: string; task: string; baseBranch?: string; testCommand?: string }): Promise<Run>;
  answer(runId: string, questionId: string, answer: string): Run;
  message(runId: string, text: string): Run;
  cancel(runId: string): Promise<Run>;
  restart(runId: string): Run;
  /** Send a finished (or stopped) run back to its agent with follow-up instructions. */
  continueRun(runId: string, text: string): Run;
  accept(runId: string, mode: 'merge' | 'branch'): Promise<Run>;
  reject(runId: string): Promise<Run>;
  shutdown(): Promise<void>; // stop all agents, mark their runs interrupted
  on(event: 'run', cb: (run: Run) => void): void;
  on(event: 'event', cb: (e: RunEvent) => void): void;
}

export interface Config {
  dataDir: string; // ~/.conductor-runs
  worktreeRoot: string; // ~/.conductor-runs/worktrees
  dbPath: string; // ~/.conductor-runs/conductor.db
  port: number;
  maxConcurrent: number;
  testTimeoutMs: number;
  maxBudgetUsd: number | undefined;
}
