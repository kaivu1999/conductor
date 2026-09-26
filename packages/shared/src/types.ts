import type { RunState } from './states.ts';

export interface Run {
  id: string; // short, url-safe, e.g. "r_7k2m9q"
  repoPath: string; // absolute path to the user's working copy
  repoName: string; // basename, for display
  task: string;
  title: string; // first line of task, truncated to ~80 chars
  baseBranch: string; // branch the run forked from and merges back into
  baseCommit: string | null; // sha of baseBranch at worktree creation
  branch: string; // "conductor/<id>"
  worktreePath: string | null; // null once cleaned up
  state: RunState;
  /** One-line human description of what the agent is doing right now. */
  activity: string;
  activityAt: number | null; // epoch ms of last agent event
  sessionId: string | null; // Claude session id, for resume
  attempt: number; // 1 on first start, +1 per restart
  pid: number | null;
  pidStartedAt: number | null; // epoch ms; guards against pid reuse
  costUsd: number;
  turns: number;
  error: string | null; // human-readable, set on failed/conflict/interrupted
  summary: string | null; // agent's own final summary
  diffStat: DiffStat | null;
  tests: TestResult | null;
  pendingQuestion: PendingQuestion | null;
  /** Other non-terminal runs in the same repo that changed at least one of the same files. */
  overlaps: Overlap[];
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  updatedAt: number;
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  paths: string[];
}

export interface TestResult {
  command: string;
  passed: boolean;
  exitCode: number;
  durationMs: number;
  /** Tail of combined stdout/stderr, <= 8KB. */
  output: string;
}

export interface PendingQuestion {
  id: string;
  question: string;
  options?: string[];
  askedAt: number;
}

export interface Overlap {
  runId: string;
  title: string;
  paths: string[];
}

/** One entry in a run's readable activity timeline (not the raw agent log). */
export interface RunEvent {
  id: number;
  runId: string;
  ts: number;
  kind:
    | 'state' // state transition: text = "running → waiting_input"
    | 'tool' // agent used a tool: text = "Edit src/parser.ts"
    | 'text' // agent prose (assistant message), trimmed
    | 'question' // agent asked the user
    | 'answer' // user answered
    | 'test' // test run result
    | 'error'
    | 'system'; // conductor-level notes: "worktree created at …"
  text: string;
  data?: unknown;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  insertions: number;
  deletions: number;
  patch: string; // unified diff text for this file
}

export interface RunDiff {
  runId: string;
  base: string;
  head: string;
  files: FileDiff[];
}

export interface DiskUsage {
  worktreeRoot: string;
  totalBytes: number;
  worktrees: { runId: string | null; path: string; bytes: number; orphan: boolean }[];
}
