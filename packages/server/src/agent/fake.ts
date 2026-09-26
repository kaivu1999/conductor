/**
 * Deterministic adapter for tests and token-free demos. Runs a script of steps, really
 * writes files into cwd, blocks on `ask` until answer(), and owns a real detached child
 * process (a sleeping node) so pid / process-group semantics match the real adapter.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import type { PendingQuestion } from '@conductor/shared';
import type { AgentAdapter, AgentEvent, AgentSession, AgentStartOptions } from '../contracts.ts';
import { ASK_TOOL_NAME, describeToolUse, firstSentence, normalizeText } from './activity.ts';
import { killTree, spawnPlaceholder } from './process.ts';

export type FakeStep = {
  /** Wait this long before performing the step. */
  delayMs?: number;
} & (
  | { activity: string }
  | { tool: { name: string; input?: Record<string, unknown> } } // described via activity.ts
  | { text: string }
  | { writeFile: { path: string; content: string } } // relative to cwd; emits Write tool events
  | { ask: string | { question: string; options?: string[] } }
  | { usage: { costUsd: number; turns: number } }
  | { done: string }
  | { error: string }
  | { sleep: true } // no-op; just the delay
);

export type FakeScript = FakeStep[];

export const DEFAULT_FAKE_SCRIPT: FakeScript = [
  { activity: 'Reading the codebase', delayMs: 300 },
  { tool: { name: 'Glob', input: { pattern: '**/*' } }, delayMs: 300 },
  { text: 'I will add a note file describing the task.', delayMs: 300 },
  { ask: { question: 'Should the note be Markdown or plain text?', options: ['Markdown', 'Plain text'] }, delayMs: 300 },
  { writeFile: { path: 'CONDUCTOR_FAKE.md', content: '# Fake agent run\n\nThis file was written by the fake adapter.\n' }, delayMs: 300 },
  { usage: { costUsd: 0.01, turns: 2 } },
  { done: 'Added CONDUCTOR_FAKE.md (fake adapter). Verified by reading it back.', delayMs: 200 },
];

export interface FakeAdapterOptions {
  /** Called with every sendMessage() text (tests can assert steering). */
  onMessage?: (runId: string, text: string) => void;
}

export function createFakeAdapter(script: FakeScript = DEFAULT_FAKE_SCRIPT, fakeOpts: FakeAdapterOptions = {}): AgentAdapter {
  return {
    name: 'fake',
    start(opts: AgentStartOptions): AgentSession {
      return new FakeSession(opts, script, fakeOpts);
    },
  };
}

class StoppedError extends Error {}

class FakeSession implements AgentSession {
  readonly finished: Promise<{ ok: boolean }>;
  private settle!: (r: { ok: boolean }) => void;
  private terminal = false;
  private stopped = false;
  private stopping: Promise<void> | null = null;
  private child: ChildProcess;
  private waiters = new Map<string, (answer: string) => void>();
  private wake: (() => void) | null = null;
  private costUsd = 0;
  private turns = 0;
  readonly messages: string[] = [];

  constructor(private readonly opts: AgentStartOptions, private readonly script: FakeScript, private readonly fakeOpts: FakeAdapterOptions) {
    this.finished = new Promise((r) => (this.settle = r));
    this.child = spawnPlaceholder(opts.cwd, opts.runId);
    if (this.child.pid !== undefined) this.emit({ type: 'process', pid: this.child.pid, startedAt: Date.now() });
    void this.run();
  }

  private emit(e: AgentEvent): void {
    if (this.terminal) return;
    if (e.type === 'done' || e.type === 'error') this.terminal = true;
    try {
      this.opts.onEvent(e);
    } catch {
      /* ignore listener errors */
    }
  }

  answer(questionId: string, answer: string): boolean {
    const w = this.waiters.get(questionId);
    if (!w) return false;
    this.waiters.delete(questionId);
    w(answer);
    return true;
  }

  sendMessage(text: string): void {
    if (this.terminal) return;
    this.messages.push(text);
    this.fakeOpts.onMessage?.(this.opts.runId, text);
    this.emit({ type: 'text', text: normalizeText(`(received follow-up) ${text}`) });
  }

  stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.stopped = true;
      this.emit({ type: 'error', message: 'Agent stopped' });
      this.wake?.();
      await this.finished;
    })();
    return this.stopping;
  }

  private sleep(ms: number): Promise<void> {
    if (this.stopped) return Promise.reject(new StoppedError());
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.wake = null;
        resolve();
      }, ms);
      this.wake = () => {
        clearTimeout(t);
        this.wake = null;
        reject(new StoppedError());
      };
    });
  }

  private waitForAnswer(q: PendingQuestion): Promise<string> {
    if (this.stopped) return Promise.reject(new StoppedError());
    return new Promise((resolve, reject) => {
      this.waiters.set(q.id, (a) => {
        this.wake = null;
        resolve(a);
      });
      this.wake = () => {
        this.waiters.delete(q.id);
        this.wake = null;
        reject(new StoppedError());
      };
      this.emit({ type: 'question', question: q });
    });
  }

  private async run(): Promise<void> {
    const cwd = this.opts.cwd;
    let ok = false;
    try {
      this.emit({ type: 'session', sessionId: this.opts.resumeSessionId ?? `fake-${randomUUID()}` });
      if (this.opts.followUp) {
        // Make the follow-up visible in the diff, like a real agent's extra changes would be.
        this.emit({ type: 'text', text: normalizeText(`Working on your follow-up: ${this.opts.followUp}`) });
        const notes = path.resolve(cwd, 'FOLLOW_UPS.md');
        const prev = await fs.readFile(notes, 'utf8').catch(() => '# Follow-ups\n');
        await fs.writeFile(notes, `${prev}\n- ${this.opts.followUp.split('\n')[0]}\n`);
        this.emit({ type: 'tool', name: 'Write', summary: 'Write FOLLOW_UPS.md' });
      }
      for (const step of this.script) {
        if (step.delayMs) await this.sleep(step.delayMs);
        if (this.stopped) throw new StoppedError();
        if ('activity' in step) {
          this.emit({ type: 'activity', text: step.activity });
        } else if ('tool' in step) {
          const d = describeToolUse(step.tool.name, step.tool.input ?? {}, cwd);
          this.emit({ type: 'activity', text: d.activity });
          this.emit({ type: 'tool', name: step.tool.name, summary: d.summary });
        } else if ('text' in step) {
          this.emit({ type: 'text', text: normalizeText(step.text) });
          const s = firstSentence(step.text);
          if (s) this.emit({ type: 'activity', text: s });
        } else if ('writeFile' in step) {
          const abs = path.resolve(cwd, step.writeFile.path);
          const d = describeToolUse('Write', { file_path: abs }, cwd);
          this.emit({ type: 'activity', text: d.activity });
          this.emit({ type: 'tool', name: 'Write', summary: d.summary });
          await fs.mkdir(path.dirname(abs), { recursive: true });
          await fs.writeFile(abs, step.writeFile.content);
        } else if ('ask' in step) {
          if (this.opts.resumeSessionId) continue; // already asked and answered in this session
          const a = typeof step.ask === 'string' ? { question: step.ask } : step.ask;
          const q: PendingQuestion = {
            id: 'q_' + randomBytes(6).toString('hex'),
            question: a.question,
            ...(a.options?.length ? { options: a.options } : {}),
            askedAt: Date.now(),
          };
          const d = describeToolUse(ASK_TOOL_NAME, { question: a.question }, cwd);
          this.emit({ type: 'activity', text: d.activity });
          this.emit({ type: 'tool', name: ASK_TOOL_NAME, summary: d.summary });
          const answer = await this.waitForAnswer(q);
          this.emit({ type: 'text', text: normalizeText(`Got answer: ${answer}`) });
        } else if ('usage' in step) {
          this.costUsd = step.usage.costUsd;
          this.turns = step.usage.turns;
          this.emit({ type: 'usage', costUsd: this.costUsd, turns: this.turns });
        } else if ('done' in step) {
          ok = true;
          this.emit({ type: 'done', summary: step.done, costUsd: this.costUsd, turns: this.turns });
          break;
        } else if ('error' in step) {
          this.emit({ type: 'error', message: step.error });
          break;
        }
      }
      if (!this.terminal) {
        ok = true;
        this.emit({ type: 'done', summary: '', costUsd: this.costUsd, turns: this.turns });
      }
    } catch (e) {
      ok = false;
      if (!(e instanceof StoppedError)) this.emit({ type: 'error', message: (e as Error)?.message || String(e) });
    } finally {
      this.waiters.clear();
      await killTree(this.child, 0);
      this.settle({ ok: ok && !this.stopped });
    }
  }
}
