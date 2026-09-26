/**
 * Real adapter: drives the Claude Code CLI through the Claude Agent SDK.
 *
 * Lifecycle (streaming-input mode — the prompt is an AsyncQueue we keep open):
 *   - The first queued message is the task (or a "conductor restarted, continue" note on resume).
 *   - sendMessage() pushes follow-up user messages into the live session.
 *   - With streaming input the CLI does NOT exit after a `result`; it waits for more input.
 *     So on every `result` we mark the user messages it answered (via `user_message_uuids`)
 *     as handled. If nothing is outstanding, we end the input stream -> CLI sees stdin EOF,
 *     exits, the iterator ends, and `finished` resolves. If a follow-up is outstanding
 *     (sent mid-turn or right after the result), we keep going and only emit `done` after
 *     the final result.
 *   - Error results (budget, max turns, API error) end the session immediately with `error`.
 *
 * Process ownership: we spawn the CLI ourselves (`spawnClaudeCodeProcess`) with
 * `detached: true`, so it leads its own process group (pgid == pid). BUT the CLI's Bash
 * tool runs commands in their own, separate process groups, so `kill(-pid)` alone doesn't
 * reach them (and they get re-parented to init if the CLI is SIGKILLed). Every process in
 * the tree therefore inherits CONDUCTOR_RUN_ID=<runId>; `killRunProcesses(runId)` finds
 * them by that marker. stop(): interrupt -> close (graceful: the CLI kills its own tool
 * children) -> SIGKILL the group after 3s -> kill anything still carrying the marker.
 */
import fs from 'node:fs';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { query, createSdkMcpServer, tool, type Query, type SDKMessage, type SDKUserMessage, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { PendingQuestion } from '@conductor/shared';
import type { AgentAdapter, AgentEvent, AgentSession, AgentStartOptions } from '../contracts.ts';
import { getAgentAuth } from './auth.ts';
import { ASK_TOOL_NAME, describeToolUse, firstSentence, normalizeText, resultErrorMessage, truncate } from './activity.ts';
import { AsyncQueue } from './queue.ts';
import { exited, killRunProcesses, killTree, waitForExit, RUN_ENV_MARKER } from './process.ts';

const STOP_GRACE_MS = 3000;
const INTERRUPT_TIMEOUT_MS = 1500;
/** Safety net: after a result, if the only outstanding message is never echoed back, don't hang forever. */
const ORPHAN_FOLLOWUP_MS = 120_000;

export interface ClaudeAdapterOptions {
  model?: string;
}

export function buildSystemAppend(branch: string | null, cwd: string): string {
  return [
    '# Conductor run',
    `You are running unattended (no human is watching live) inside an isolated git worktree at ${cwd}${branch ? ` on branch \`${branch}\`` : ''}.`,
    '- Do NOT push, do NOT switch or create branches, and do NOT modify files outside the current working directory.',
    '- Do NOT commit. The conductor commits your changes when you finish.',
    `- If you are genuinely blocked on a real decision only the human can make (ambiguous requirements, destructive or irreversible choices), call the \`${ASK_TOOL_NAME}\` tool and wait for the answer. Do not use it for routine confirmations — make reasonable choices yourself.`,
    '- When you are finished, end with a short summary: what changed, why, and how you verified it.',
  ].join('\n');
}

/**
 * AgentStartOptions carries no branch name, so read it from the worktree (falls back to
 * the conductor naming convention `conductor/<runId>`).
 */
function currentBranch(cwd: string, runId: string): string {
  try {
    const b = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }).trim();
    if (b && b !== 'HEAD') return b;
  } catch {
    /* not a git dir */
  }
  return `conductor/${runId}`;
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: 'user',
    message: { role: 'user', content: text },
    parent_tool_use_id: null,
    uuid: randomUUID(),
  };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([p, new Promise<undefined>((r) => setTimeout(() => r(undefined), ms).unref())]);
}

export function createClaudeAdapter(adapterOpts: ClaudeAdapterOptions = {}): AgentAdapter {
  return {
    name: 'claude',
    start(opts: AgentStartOptions): AgentSession {
      return new ClaudeSession(opts, adapterOpts);
    },
  };
}

interface Waiter {
  question: PendingQuestion;
  resolve: (answer: string) => void;
  reject: (err: Error) => void;
}

class ClaudeSession implements AgentSession {
  readonly finished: Promise<{ ok: boolean }>;
  private settle!: (r: { ok: boolean }) => void;
  private settled = false;
  private terminalEmitted = false;

  private readonly input = new AsyncQueue<SDKUserMessage>();
  /** uuids of user messages the CLI hasn't produced a result for yet. */
  private readonly outstanding: string[] = [];
  private readonly waiters = new Map<string, Waiter>();
  private readonly toolsInFlight = new Set<string>();
  private readonly abort = new AbortController();
  private q: Query | null = null;
  private child: ChildProcess | null = null;
  private stderrTail = '';
  private stopping: Promise<void> | null = null;
  private orphanTimer: NodeJS.Timeout | null = null;
  private sessionId: string | null = null;
  private turns = 0;
  private costUsd = 0;

  constructor(private readonly opts: AgentStartOptions, private readonly adapterOpts: ClaudeAdapterOptions) {
    this.finished = new Promise((r) => (this.settle = r));
    this.roots = [opts.cwd];
    try {
      const real = fs.realpathSync(opts.cwd);
      if (real !== opts.cwd) this.roots.push(real);
    } catch {
      /* ignore */
    }
    const first = opts.followUp
      ? opts.resumeSessionId
        ? `The user reviewed your work so far (it is committed on this branch) and wants more changes:\n\n${opts.followUp}`
        : `${opts.task}\n\nAn earlier attempt at this task is committed on this branch. The user reviewed it and wants more changes:\n\n${opts.followUp}`
      : opts.resumeSessionId
        ? `The conductor restarted; continue the task from where you left off. Original task:\n\n${opts.task}`
        : opts.task;
    this.enqueue(first);
    void this.run();
  }

  private emit(e: AgentEvent): void {
    if (this.terminalEmitted) return;
    if (e.type === 'done' || e.type === 'error') this.terminalEmitted = true;
    try {
      this.opts.onEvent(e);
    } catch {
      /* a broken listener must not kill the session */
    }
  }

  private enqueue(text: string): boolean {
    const msg = userMessage(text);
    if (!this.input.push(msg)) return false;
    this.outstanding.push(msg.uuid!);
    if (this.orphanTimer) {
      clearTimeout(this.orphanTimer);
      this.orphanTimer = null;
    }
    return true;
  }

  // ─── public API ────────────────────────────────────────────────────────────

  answer(questionId: string, answer: string): boolean {
    const w = this.waiters.get(questionId);
    if (!w) return false;
    this.waiters.delete(questionId);
    w.resolve(answer);
    return true;
  }

  sendMessage(text: string): void {
    // After the input stream is closed (session wrapping up / stopped) messages are dropped.
    this.enqueue(text);
  }

  stop(): Promise<void> {
    this.stopping ??= this.doStop();
    return this.stopping;
  }

  private async doStop(): Promise<void> {
    this.emit({ type: 'error', message: 'Agent stopped' });
    for (const w of this.waiters.values()) w.reject(new Error('The session was stopped by the conductor.'));
    this.waiters.clear();
    this.input.end();
    if (this.q) {
      try {
        await withTimeout(this.q.interrupt().catch(() => undefined), INTERRUPT_TIMEOUT_MS);
      } catch {
        /* best effort */
      }
      try {
        this.q.close();
      } catch {
        /* ignore */
      }
    }
    this.abort.abort();
    if (this.child) await killTree(this.child, STOP_GRACE_MS);
    killRunProcesses(this.opts.runId); // tool subprocesses live in other process groups
    await this.finished;
  }

  // ─── internals ─────────────────────────────────────────────────────────────

  private askTool() {
    return tool(
      'ask_user',
      'Ask the human operator a question and wait for their answer. Use this ONLY when a decision genuinely needs the human: ' +
        'ambiguous or conflicting requirements, destructive or irreversible choices, or missing information you cannot infer. ' +
        'Do NOT use it for routine confirmations, progress updates, or to ask permission for normal edits — make a sensible choice yourself. ' +
        'Provide `options` when there is a small set of reasonable choices.',
      { question: z.string().describe('The question, self-contained.'), options: z.array(z.string()).optional().describe('Suggested answers, if any.') },
      async (args, extra) => {
        const question: PendingQuestion = {
          id: 'q_' + randomBytes(6).toString('hex'),
          question: args.question,
          ...(args.options && args.options.length ? { options: args.options } : {}),
          askedAt: Date.now(),
        };
        const signal = (extra as { signal?: AbortSignal } | undefined)?.signal;
        try {
          const answer = await new Promise<string>((resolve, reject) => {
            if (this.stopping) return reject(new Error('The session was stopped by the conductor.'));
            this.waiters.set(question.id, { question, resolve, reject });
            const onAbort = () => {
              this.waiters.delete(question.id);
              reject(new Error('The question was cancelled.'));
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            this.abort.signal.addEventListener('abort', onAbort, { once: true });
            this.emit({ type: 'question', question });
          });
          return { content: [{ type: 'text' as const, text: answer }] };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `No answer: ${(e as Error).message} Stop working now.` }], isError: true };
        }
      },
    );
  }

  private async run(): Promise<void> {
    const { cwd } = this.opts;
    const auth = getAgentAuth();
    const conductor = createSdkMcpServer({ name: 'conductor', version: '1.0.0', tools: [this.askTool()] });

    // SEAM: permissions. Runs are in isolated worktrees, so everything is allowed for now
    // (and with bypassPermissions the CLI may not consult this at all). A later extension
    // switches permissionMode and routes risky tools (rm -rf, network, etc.) to the user here.
    const canUseTool: CanUseTool = async (_toolName, input) => ({ behavior: 'allow', updatedInput: input });

    try {
      this.q = query({
        prompt: this.input,
        options: {
          cwd,
          ...(this.adapterOpts.model ? { model: this.adapterOpts.model } : {}),
          ...(this.opts.resumeSessionId ? { resume: this.opts.resumeSessionId } : {}),
          ...(this.opts.maxBudgetUsd !== undefined ? { maxBudgetUsd: this.opts.maxBudgetUsd } : {}),
          abortController: this.abort,
          settingSources: [],
          ...(auth.settings ? { settings: auth.settings } : {}),
          env: auth.env,
          permissionMode: 'bypassPermissions',
          allowDangerouslySkipPermissions: true,
          canUseTool,
          mcpServers: { conductor },
          allowedTools: [ASK_TOOL_NAME],
          disallowedTools: ['AskUserQuestion'],
          systemPrompt: { type: 'preset', preset: 'claude_code', append: buildSystemAppend(currentBranch(cwd, this.opts.runId), cwd) },
          spawnClaudeCodeProcess: (so) => {
            const child = spawn(so.command, so.args, {
              cwd: so.cwd ?? cwd,
              // Marker is inherited by every tool subprocess -> findable after a crash even though
              // the Bash tool puts its commands in their own process groups.
              env: { ...(so.env as NodeJS.ProcessEnv), [RUN_ENV_MARKER]: this.opts.runId },
              stdio: ['pipe', 'pipe', 'pipe'],
              detached: true, // own process group: supervisor can kill -pid
            });
            this.child = child;
            child.on('error', () => {});
            child.stderr?.on('data', (d: Buffer) => {
              this.stderrTail = (this.stderrTail + d.toString()).slice(-4000);
            });
            so.signal.addEventListener('abort', () => {
              if (!exited(child)) child.kill('SIGTERM');
            }, { once: true });
            if (child.pid !== undefined) this.emit({ type: 'process', pid: child.pid, startedAt: Date.now() });
            // If stop() already happened before the spawn, kill immediately.
            if (this.stopping && child.pid !== undefined) void killTree(child, 0);
            return child;
          },
        },
      });

      for await (const m of this.q) this.handle(m);

      if (!this.terminalEmitted) {
        this.emit({ type: 'error', message: this.stderrMessage('Agent exited without a result') });
      }
    } catch (e) {
      this.emit({ type: 'error', message: this.stderrMessage((e as Error)?.message || String(e)) });
    } finally {
      this.input.end();
      if (this.orphanTimer) clearTimeout(this.orphanTimer);
      for (const w of this.waiters.values()) w.reject(new Error('The session ended.'));
      this.waiters.clear();
      if (this.child) {
        // Normal exit after stdin EOF; make sure no grandchildren survive either.
        await waitForExit(this.child, STOP_GRACE_MS);
        await killTree(this.child, 0);
      }
      killRunProcesses(this.opts.runId);
      this.finish();
    }
  }

  private finish(): void {
    if (this.settled) return;
    this.settled = true;
    this.settle({ ok: this.lastOk });
  }

  private lastOk = false;
  /** cwd plus its realpath: tool inputs may use either spelling. */
  private readonly roots: string[];

  private stderrMessage(base: string): string {
    const tail = this.stderrTail.trim();
    if (!tail || base.includes(tail.slice(-200))) return base;
    return `${base}\n${truncate(tail.slice(-1000), 1000)}`;
  }

  private handle(m: SDKMessage): void {
    switch (m.type) {
      case 'system':
        if (m.subtype === 'init' && m.session_id && m.session_id !== this.sessionId) {
          this.sessionId = m.session_id;
          this.emit({ type: 'session', sessionId: m.session_id });
        }
        return;
      case 'assistant': {
        if (m.parent_tool_use_id) return; // subagent chatter: the parent's Task line already covers it
        for (const block of m.message.content) {
          if (block.type === 'tool_use') {
            this.toolsInFlight.add(block.id);
            const d = describeToolUse(block.name, block.input, this.roots);
            this.emit({ type: 'activity', text: d.activity });
            this.emit({ type: 'tool', name: block.name, summary: d.summary });
          } else if (block.type === 'text') {
            const text = normalizeText(block.text);
            if (!text) continue;
            this.emit({ type: 'text', text });
            if (this.toolsInFlight.size === 0) {
              const s = firstSentence(block.text);
              if (s) this.emit({ type: 'activity', text: s });
            }
          }
        }
        return;
      }
      case 'user': {
        const content = m.message.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b && typeof b === 'object' && b.type === 'tool_result') this.toolsInFlight.delete(b.tool_use_id);
          }
        }
        return;
      }
      case 'result': {
        this.toolsInFlight.clear();
        this.turns += m.num_turns;
        this.costUsd = m.total_cost_usd; // cumulative per query() — latest wins
        this.emit({ type: 'usage', costUsd: this.costUsd, turns: this.turns });

        const err = resultErrorMessage(m);
        if (err) {
          this.lastOk = false;
          this.emit({ type: 'error', message: err });
          this.input.end();
          return;
        }

        // Mark the user messages this result answered.
        const answered = m.user_message_uuids ?? (m.user_message_uuid ? [m.user_message_uuid] : []);
        if (answered.length) {
          for (const u of answered) {
            const i = this.outstanding.indexOf(u);
            if (i >= 0) this.outstanding.splice(i, 1);
          }
        } else {
          this.outstanding.shift();
        }

        const summary = m.subtype === 'success' ? m.result.trim() : '';
        if (this.outstanding.length === 0 && !(m.queued_turn_count && m.queued_turn_count > 0)) {
          this.lastOk = true;
          this.emit({ type: 'done', summary, costUsd: this.costUsd, turns: this.turns });
          this.input.end(); // -> stdin EOF -> CLI exits -> iterator ends -> finished
        } else {
          // A follow-up is still pending; keep the session alive for it.
          if (summary) this.emit({ type: 'text', text: normalizeText(summary) });
          this.orphanTimer = setTimeout(() => {
            if (this.input.closed) return;
            this.lastOk = true;
            this.emit({ type: 'done', summary, costUsd: this.costUsd, turns: this.turns });
            this.input.end();
          }, ORPHAN_FOLLOWUP_MS);
          this.orphanTimer.unref();
        }
        return;
      }
      default:
        return;
    }
  }
}
