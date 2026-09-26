/**
 * Run lifecycle. This file is the single source of truth for which
 * transitions are legal; the server enforces it on every state write.
 *
 *   queued ─▶ starting ─▶ running ⇄ waiting_input
 *                           │
 *                           ▼
 *                        testing ─▶ ready ─▶ accepting ─▶ accepted
 *                                     │           └─▶ conflict ─▶ (accept retry | rejected)
 *                                     └──────────▶ rejected
 *   any active state ─▶ failed | cancelled | interrupted
 *   interrupted | failed | cancelled ─▶ queued   (explicit user restart)
 */
export const RUN_STATES = [
  'queued',
  'starting',
  'running',
  'waiting_input',
  'testing',
  'ready', // finished, awaiting review
  'accepting', // merge in progress
  'conflict', // merge failed; branch preserved
  'accepted',
  'rejected',
  'failed',
  'cancelled',
  'interrupted', // conductor died while this run was live
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TRANSITIONS: Record<RunState, readonly RunState[]> = {
  queued: ['starting', 'cancelled'],
  starting: ['running', 'failed', 'cancelled', 'interrupted'],
  running: ['waiting_input', 'testing', 'failed', 'cancelled', 'interrupted'],
  waiting_input: ['running', 'failed', 'cancelled', 'interrupted'],
  testing: ['ready', 'failed', 'cancelled', 'interrupted'],
  ready: ['accepting', 'rejected'],
  accepting: ['accepted', 'conflict', 'ready', 'interrupted'],
  conflict: ['accepting', 'rejected'],
  accepted: [],
  rejected: [],
  failed: ['queued', 'rejected'],
  cancelled: ['queued', 'rejected'],
  interrupted: ['queued', 'rejected'],
};

export function canTransition(from: RunState, to: RunState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** States in which an agent process is (or should be) alive. */
export const LIVE_STATES: readonly RunState[] = ['starting', 'running', 'waiting_input', 'testing'];
/** States that hold a worktree on disk. */
export const WORKTREE_STATES: readonly RunState[] = [
  'starting', 'running', 'waiting_input', 'testing', 'ready', 'accepting', 'conflict',
  'failed', 'cancelled', 'interrupted',
];
export const TERMINAL_STATES: readonly RunState[] = ['accepted', 'rejected'];

export const isLive = (s: RunState) => LIVE_STATES.includes(s);
export const isTerminal = (s: RunState) => TERMINAL_STATES.includes(s);
