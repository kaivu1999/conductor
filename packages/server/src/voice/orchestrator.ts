/**
 * The voice orchestrator: a Claude agent (Agent SDK) that turns a GPT-Live delegation into
 * conductor actions. No built-in tools (no files, no Bash), only the conductor tools below,
 * so it cannot go around the supervisor. One streaming SDK session per voice session keeps
 * it warm and gives it memory for "yes", "the second one", and "no, the other repo".
 */
import { randomUUID } from 'node:crypto';
import { query, createSdkMcpServer, tool, type Query, type SDKMessage, type SDKUserMessage, type CanUseTool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { SystemInfo } from '@conductor/shared';
import type { Git, Store, Supervisor } from '../contracts.ts';
import { ConfirmGate } from './confirm.ts';
import type { Transcript } from './transcript.ts';
import { getAgentAuth } from '../agent/auth.ts';
import { AsyncQueue } from '../agent/queue.ts';
import { errorMessage, type Logger } from '../supervisor/errors.ts';
import type { DelegationRequest, VoiceBackend } from './manager.ts';
import {
  acceptRun, answerQuestion, cancelRun, describeRun, listRuns, messageRun, rejectRun, resolveRun, restartRun, runActivity, systemStatus,
  showNeeds, showRun, snapshot, startRuns, type ScreenCommand, type ToolContext, type ToolResult,
} from './tools.ts';

export const SYSTEM_PROMPT = `You are Conductor, backstage. Conductor is an app, built by Kaivu, that runs an orchestra of background coding agents ("tasks"), each in its own git worktree. The user talks to Conductor by voice: a realtime voice model does the talking and hands requests to you. You decide what is true and what to do; your reply goes back to the voice, which paraphrases it aloud as Conductor. Anything the user can do in the app, they should be able to do through you.

## Voice conversation context
You get the latest transcript lines and a snapshot of the active tasks. Transcripts can contain mistakes (misheard task names), unfinished phrases, and later corrections. Use the latest context. If a needed detail is unclear, say what you need to know instead of guessing.

## Tools
Look: list_runs (the snapshot is usually enough), describe_run (question and options, summary, changes, tests, errors), run_activity (a task's recent timeline), system_status (busy agent slots, queue, disk use).
Act: start_run (one or more tasks in a repo), answer_question, message_run, restart_run, accept_run, reject_run, cancel_run.
Screen: show_run opens a task in the app, show_needs filters the list to tasks that need the user. When you talk about one specific task, open it with show_run too.
Refer to tasks by id in tool calls. If a name could match more than one task, ask which one; never guess on an action.
accept_run, reject_run, and cancel_run need two steps: call without a token, relay the confirmation question in your reply, and stop. Only after the user clearly says yes, call again with the token. Never invent a yes.
When starting a task, pass the user's request as the task text, cleaned up but complete. If the repo is unclear, ask.
If the user asks for something no tool does, say plainly you can't do that by voice yet and they can use the screen.

## Reply
Plain text to be spoken, in Conductor's voice: calm, warm, brief. One to three short sentences. No markdown, lists, ids, branch names, or file paths unless asked. Summarize; never read code or diffs. Say task titles in a short natural form. Only state facts from the snapshot or tools, and report an action as done only after its tool confirms it.`;

const TOOL_NAMES = ['list_runs', 'describe_run', 'start_run', 'answer_question', 'message_run', 'restart_run', 'accept_run', 'reject_run', 'cancel_run', 'show_run', 'show_needs', 'system_status', 'run_activity'].map((n) => `mcp__conductor__${n}`);
const TURN_TIMEOUT_MS = 60_000;
/** Transcript lines per delegation. The SDK session remembers earlier turns. */
const TRANSCRIPT_LINES = 8;

export interface OrchestratorDeps {
  store: Store;
  supervisor: Supervisor;
  git: Pick<Git, 'inspectRepo'>;
  systemInfo(): Promise<SystemInfo>;
  /** Send a UI command to the open browser tabs. */
  screen(cmd: ScreenCommand): void;
  model?: string;
  log: Logger;
  /** Injected for tests. */
  query?: typeof query;
}

const reply = (r: ToolResult) => ({ content: [{ type: 'text' as const, text: r.text }], ...(r.error ? { isError: true } : {}) });
const RUN = z.string().describe('Task id, or words from its title or repo.');
const TOKEN = z.string().optional().describe('Token from the first call, only after the user clearly said yes.');

function conductorTools(ctx: ToolContext & { systemInfo(): Promise<SystemInfo> }) {
  return createSdkMcpServer({
    name: 'conductor',
    version: '1.0.0',
    tools: [
      tool('list_runs', 'List tasks, most urgent first.', {
        filter: z.enum(['needs_you', 'active', 'all']).optional().describe('needs_you: only tasks waiting on the user. active (default): not yet accepted/rejected/cancelled. all: include finished ones.'),
      }, async ({ filter }) => reply({ text: listRuns(ctx.store, filter ?? 'active') })),
      tool('describe_run', "One task's details: pending question and options, summary, changes, tests, errors.", { run: RUN }, async ({ run }) => {
        const r = resolveRun(ctx.store, run);
        return reply('error' in r ? { text: r.error, error: true } : { text: describeRun(r.run) });
      }),
      tool('start_run', 'Start one coding agent per task in a repo. Several tasks run in parallel.', {
        repo: z.string().describe('Repo name as the user said it (matched against known repos), or an absolute path.'),
        tasks: z.array(z.string()).min(1).describe('What each agent should do, one entry per task.'),
      }, async ({ repo, tasks }) => reply(await startRuns(ctx, repo, tasks))),
      tool('answer_question', "Answer the question a task's agent is waiting on.", { run: RUN, answer: z.string() },
        async ({ run, answer }) => reply(await answerQuestion(ctx, run, answer))),
      tool('message_run', 'Send a steering message to a running agent.', { run: RUN, text: z.string() },
        async ({ run, text }) => reply(await messageRun(ctx, run, text))),
      tool('restart_run', 'Restart an interrupted, failed, or cancelled task (resumes its agent).', { run: RUN },
        async ({ run }) => reply(await restartRun(ctx, run))),
      tool('accept_run', 'Accept a finished task: merge it into its base branch, or keep its branch. Two-step confirmation.', {
        run: RUN, mode: z.enum(['merge', 'branch']).optional().describe('merge (default) or branch: keep the branch, no merge.'), confirm_token: TOKEN,
      }, async ({ run, mode, confirm_token }) => reply(await acceptRun(ctx, run, mode ?? 'merge', confirm_token))),
      tool('reject_run', "Reject a task: delete its worktree and branch. Two-step confirmation.", { run: RUN, confirm_token: TOKEN },
        async ({ run, confirm_token }) => reply(await rejectRun(ctx, run, confirm_token))),
      tool('cancel_run', 'Stop a queued or running task. Two-step confirmation.', { run: RUN, confirm_token: TOKEN },
        async ({ run, confirm_token }) => reply(await cancelRun(ctx, run, confirm_token))),
      tool('run_activity', "A task's recent timeline: tools used, messages, questions, tests.", { run: RUN },
        async ({ run }) => reply(await runActivity(ctx, run))),
      tool('system_status', 'Busy agent slots, queued tasks, and worktree disk use.', {},
        async () => reply(await systemStatus(ctx))),
      tool('show_run', 'Open a task on the screen.', { run: RUN }, async ({ run }) => reply(await showRun(ctx, run))),
      tool('show_needs', 'Filter the screen to tasks that need the user (on) or show all (off).', { on: z.boolean() },
        async ({ on }) => reply(showNeeds(ctx, on))),
    ],
  });
}

/** One Claude conversation, alive for one voice session. Turns run one at a time. */
class VoiceAgent {
  private input = new AsyncQueue<SDKUserMessage>();
  private q: Query;
  private waiting: { resolve(text: string): void; reject(err: Error): void } | null = null;
  private chain: Promise<unknown> = Promise.resolve();
  private stderr = '';
  private closed = false;

  constructor(private readonly id: string, private readonly deps: OrchestratorDeps, transcript: Transcript) {
    const auth = getAgentAuth();
    // Nothing but our tools: `tools: []` removes the built-ins, and canUseTool refuses the rest.
    const canUseTool: CanUseTool = async (name, input) =>
      TOOL_NAMES.includes(name) ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Not available.' };
    this.q = (deps.query ?? query)({
      prompt: this.input,
      options: {
        ...(deps.model ? { model: deps.model } : {}),
        tools: [],
        mcpServers: { conductor: conductorTools({ ...deps, confirm: new ConfirmGate(), transcript }) },
        allowedTools: TOOL_NAMES,
        canUseTool,
        settingSources: [],
        ...(auth.settings ? { settings: auth.settings } : {}),
        env: auth.env,
        systemPrompt: SYSTEM_PROMPT,
        stderr: (d: string) => { this.stderr = (this.stderr + d).slice(-2000); },
      },
    });
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for await (const m of this.q) this.onMessage(m);
      this.fail(new Error(`The voice agent exited.${this.stderr ? ` ${this.stderr.trim().split('\n').pop()}` : ''}`));
    } catch (err) {
      this.fail(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onMessage(m: SDKMessage): void {
    if (m.type !== 'result' || !this.waiting) return;
    const w = this.waiting;
    this.waiting = null;
    if (m.subtype === 'success' && !m.is_error) w.resolve(m.result.trim());
    else w.reject(new Error(`the voice agent stopped (${m.subtype})`));
  }

  private fail(err: Error): void {
    this.closed = true;
    this.waiting?.reject(err);
    this.waiting = null;
  }

  /** Run one turn. Queued behind any turn in progress. */
  ask(prompt: string): Promise<string> {
    const turn = this.chain.then(() => this.turn(prompt));
    this.chain = turn.catch(() => {});
    return turn;
  }

  private turn(prompt: string): Promise<string> {
    if (this.closed) return Promise.reject(new Error('the voice agent is not running'));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting = null;
        reject(new Error('the voice agent took too long'));
      }, TURN_TIMEOUT_MS);
      this.waiting = {
        resolve: (t) => { clearTimeout(timer); resolve(t); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      this.input.push({ type: 'user', message: { role: 'user', content: prompt }, parent_tool_use_id: null, uuid: randomUUID() });
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.input.end();
    this.q.close?.();
    this.deps.log.info(`${this.id}: voice agent closed`);
  }
}

export function buildPrompt(req: DelegationRequest, runs: string): string {
  return [
    '<transcript>',
    req.transcript.render(TRANSCRIPT_LINES) || '(nothing transcribed yet)',
    '</transcript>',
    '<tasks>',
    runs,
    '</tasks>',
    `The voice model delegated at ${(req.offsetMs / 1000).toFixed(1)}s. Work out what the user wants from the latest lines and reply with what to say.`,
  ].join('\n');
}

export function createOrchestrator(deps: OrchestratorDeps): VoiceBackend {
  const agents = new Map<string, VoiceAgent>();
  const agentFor = (id: string, transcript: Transcript) => {
    let a = agents.get(id);
    if (!a) { a = new VoiceAgent(id, deps, transcript); agents.set(id, a); }
    return a;
  };
  return {
    // Start the CLI when the voice session opens, so the first question doesn't pay for the spawn.
    open(id, transcript) { agentFor(id, transcript); },
    async delegate(req) {
      const started = Date.now();
      try {
        return await agentFor(req.sessionId, req.transcript).ask(buildPrompt(req, snapshot(deps.store)));
      } catch (err) {
        // A dead agent is replaced on the next delegation.
        agents.get(req.sessionId)?.close();
        agents.delete(req.sessionId);
        throw new Error(errorMessage(err));
      } finally {
        deps.log.info(`${req.sessionId}: conductor turn took ${Date.now() - started}ms`);
      }
    },
    close(id) {
      agents.get(id)?.close();
      agents.delete(id);
    },
  };
}
