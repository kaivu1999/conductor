/** Hand-driven AgentAdapter: tests push events and decide when/how a session finishes. */
import type { AgentAdapter, AgentEvent, AgentSession, AgentStartOptions } from '../../src/contracts.ts';

export class ControlledSession implements AgentSession {
  readonly finished: Promise<{ ok: boolean }>;
  private resolve!: (r: { ok: boolean }) => void;
  ended = false;
  stopped = false;
  messages: string[] = [];
  answers: { questionId: string; answer: string }[] = [];
  pendingQuestionId: string | null = null;
  /** When true, answer() returns false (process died). */
  dead = false;

  constructor(readonly opts: AgentStartOptions) {
    this.finished = new Promise((r) => (this.resolve = r));
  }
  emit(e: AgentEvent): void {
    if (e.type === 'question') this.pendingQuestionId = e.question.id;
    this.opts.onEvent(e);
  }
  ask(id = 'q1', question = 'Which colour?'): void {
    this.emit({ type: 'question', question: { id, question, askedAt: Date.now() } });
  }
  finish(ok = true, summary = 'did the thing'): void {
    if (this.ended) return;
    this.ended = true;
    this.emit(ok ? { type: 'done', summary, costUsd: 0.5, turns: 3 } : { type: 'error', message: 'model overloaded' });
    this.resolve({ ok });
  }
  answer(questionId: string, answer: string): boolean {
    if (this.dead || this.ended || questionId !== this.pendingQuestionId) return false;
    this.pendingQuestionId = null;
    this.answers.push({ questionId, answer });
    return true;
  }
  sendMessage(text: string): void {
    this.messages.push(text);
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.ended) return;
    this.ended = true;
    this.opts.onEvent({ type: 'error', message: 'Agent stopped' }); // mirrors the real adapters
    this.resolve({ ok: false });
  }
}

export function createControlledAgent(): AgentAdapter & { sessions: ControlledSession[]; last(runId: string): ControlledSession } {
  const sessions: ControlledSession[] = [];
  return {
    name: 'controlled',
    sessions,
    start(opts) {
      const s = new ControlledSession(opts);
      sessions.push(s);
      // Like the real adapters: session + process are reported right away.
      queueMicrotask(() => {
        if (s.ended) return;
        opts.onEvent({ type: 'session', sessionId: opts.resumeSessionId ?? `sess-${opts.runId}-${sessions.length}` });
        opts.onEvent({ type: 'process', pid: 999_000 + sessions.length, startedAt: Date.now() });
      });
      return s;
    },
    last(runId) {
      const s = [...sessions].reverse().find((x) => x.opts.runId === runId);
      if (!s) throw new Error(`no session for ${runId}`);
      return s;
    },
  };
}
