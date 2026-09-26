/**
 * Soft notifications: when a task starts needing the user, Conductor mentions it in one
 * line, never over anyone's speech, and several at once become "two tasks need you".
 * Details go in quietly (thinking) so they're ready when the user says "go on".
 */
import type { Run, RunState } from '@conductor/shared';
import { describeRun } from './tools.ts';

/** Entering one of these states nudges the user (the "needs you" states). */
export const NUDGE_STATES: readonly RunState[] = ['waiting_input', 'ready', 'failed', 'conflict'];

export interface Notice {
  runId: string;
  title: string;
  state: RunState;
  /** describeRun() text at the time of the notice. */
  details: string;
}

const PHRASE: Partial<Record<RunState, string>> = {
  waiting_input: 'is blocked on a question',
  ready: 'is finished and ready for review',
  failed: 'failed',
  conflict: 'hit a merge conflict',
};

export const toNotice = (run: Run): Notice => ({ runId: run.id, title: run.title, state: run.state, details: describeRun(run) });

/**
 * Calls `notify` when a run moves into a nudge state. Seed with the current runs so tasks
 * that already needed the user when conductor started don't all fire at once.
 */
export function createAttentionWatcher(initial: Run[], notify: (n: Notice) => void): (run: Run) => void {
  const last = new Map(initial.map((r) => [r.id, r.state]));
  return (run) => {
    const prev = last.get(run.id);
    last.set(run.id, run.state);
    if (prev === run.state || !NUDGE_STATES.includes(run.state)) return;
    notify(toNotice(run));
  };
}

/** What to append for a batch of notices: one spoken line, plus quiet details. */
export function composeNotices(notices: Notice[]): { commentary: string; thinking: string } {
  const each = notices.map((n) => `"${n.title}" ${PHRASE[n.state] ?? `is ${n.state}`}`);
  const commentary = notices.length === 1
    ? `Notice: ${each[0]}. Mention it to the user in one short sentence and offer to go into detail. Do not read the details unless asked.`
    : `Notice: ${notices.length} tasks need the user: ${each.join('; ')}. Say so in one short sentence, like "${notices.length === 2 ? 'Two' : String(notices.length)} tasks need you", and offer to go through them. Do not read details unless asked.`;
  return { commentary, thinking: `Details for the notice, use only if the user asks:\n\n${notices.map((n) => n.details).join('\n\n')}` };
}

export interface NoticeGateOptions {
  /** Quiet time (no transcript from either side) before speaking. */
  silenceMs?: number;
  /** Treat the first this-many ms as busy (the browser's audio is still connecting). */
  startDelayMs?: number;
  now?: () => number;
}

/**
 * Per-session queue. Holds notices while anyone is speaking or a delegation is running,
 * and releases them together after a stretch of silence. Call tick() on a timer.
 */
export class NoticeGate {
  private queue: Notice[] = [];
  private lastSpeechAt: number;
  private busy = 0;
  private readonly silenceMs: number;
  private readonly now: () => number;

  constructor(private readonly send: (notices: Notice[]) => void, opts: NoticeGateOptions = {}) {
    this.silenceMs = opts.silenceMs ?? 1500;
    this.now = opts.now ?? Date.now;
    // lastSpeechAt in the future holds everything until startDelayMs + silenceMs have passed.
    this.lastSpeechAt = this.now() + (opts.startDelayMs ?? 0);
  }

  get pending(): number { return this.queue.length; }

  /** Queue a notice; a newer notice for the same run replaces the older one. */
  push(n: Notice): void {
    this.queue = [...this.queue.filter((q) => q.runId !== n.runId), n];
  }

  /** A run changed state: drop its notice if it no longer needs the user. */
  update(run: Run): void {
    if (!NUDGE_STATES.includes(run.state)) this.queue = this.queue.filter((q) => q.runId !== run.id);
  }

  /** Someone is speaking (a transcript fragment arrived). */
  speech(): void { this.lastSpeechAt = this.now(); }

  /** A delegation started (+1) or finished (-1). Its answer is about to be spoken. */
  delegation(delta: 1 | -1): void {
    this.busy = Math.max(0, this.busy + delta);
    this.lastSpeechAt = this.now();
  }

  tick(): void {
    if (!this.queue.length || this.busy > 0 || this.now() - this.lastSpeechAt < this.silenceMs) return;
    const batch = this.queue;
    this.queue = [];
    this.send(batch);
  }
}
