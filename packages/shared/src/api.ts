import type { Run, RunDiff, RunEvent, DiskUsage } from './types.ts';

/**
 * HTTP contract between server and web. All JSON. Errors: { error: string } with 4xx/5xx.
 *
 *   GET    /api/runs                     -> { runs: Run[] }            (attention-sorted)
 *   POST   /api/runs                     CreateRunBody -> { run: Run }  (created in `queued`; scheduler starts it)
 *   GET    /api/runs/:id                 -> { run: Run }
 *   GET    /api/runs/:id/events?after=N  -> { events: RunEvent[] }
 *   GET    /api/runs/:id/diff            -> RunDiff
 *   POST   /api/runs/:id/answer          AnswerBody -> { run: Run }    (only in waiting_input)
 *   POST   /api/runs/:id/message         MessageBody -> { run: Run }   (steer a live run with a follow-up)
 *   POST   /api/runs/:id/cancel          -> { run: Run }
 *   POST   /api/runs/:id/restart         -> { run: Run }               (interrupted|failed|cancelled -> queued; resumes session)
 *   POST   /api/runs/:id/accept          AcceptBody -> { run: Run }    (ready|conflict)
 *   POST   /api/runs/:id/reject          -> { run: Run }
 *   GET    /api/repos/inspect?path=      -> RepoInfo                   (validates a path before create)
 *   GET    /api/system                   -> SystemInfo
 *   GET    /api/stream                   Server-Sent Events, see StreamEvent
 */
export interface CreateRunBody {
  repoPath: string;
  task: string;
  baseBranch?: string; // defaults to repo's current branch
  testCommand?: string; // defaults to autodetect (package.json "test", pytest, go test, cargo test)
}
export interface AnswerBody { questionId: string; answer: string }
export interface MessageBody { text: string }
export interface AcceptBody { mode?: 'merge' | 'branch' } // 'branch' = keep branch, don't merge

export interface RepoInfo {
  path: string;
  name: string;
  isGitRepo: boolean;
  currentBranch: string | null;
  branches: string[];
  dirty: boolean;
  detectedTestCommand: string | null;
  error?: string;
}

export interface SystemInfo {
  version: string;
  startedAt: number;
  maxConcurrent: number;
  liveCount: number;
  queuedCount: number;
  disk: DiskUsage;
  recoveredOnBoot: { interrupted: string[]; orphansKilled: number; worktreesPruned: number };
}

/** SSE `data:` payloads. Event name = `type`. */
export type StreamEvent =
  | { type: 'run'; run: Run } // full run snapshot on any change
  | { type: 'event'; event: RunEvent } // new timeline entry
  | { type: 'system'; system: SystemInfo };
