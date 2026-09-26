/**
 * What the voice orchestrator can see and do, as plain functions over the store and
 * supervisor. The SDK tool wrappers in orchestrator.ts only adapt these. Output is short,
 * factual text meant to be summarized aloud, never read verbatim.
 */
import { needsAttention, sortByAttention, type Run, type RunState, type SystemInfo, type VoiceScreenCommand } from '@conductor/shared';
import os from 'node:os';
import path from 'node:path';
import type { Git, Store, Supervisor } from '../contracts.ts';
import { errorMessage } from '../supervisor/errors.ts';
import type { ConfirmAction, ConfirmGate } from './confirm.ts';
import type { Transcript } from './transcript.ts';

/** How a state sounds in a sentence: "Add night mode is <phrase>". */
const SPOKEN: Record<RunState, string> = {
  waiting_input: 'waiting on your answer',
  conflict: 'blocked on a merge conflict',
  failed: 'failed',
  interrupted: 'interrupted',
  ready: 'ready for review',
  running: 'running',
  starting: 'starting',
  testing: 'running tests',
  accepting: 'merging',
  queued: 'queued',
  accepted: 'accepted',
  rejected: 'rejected',
  cancelled: 'cancelled',
};

const TERMINAL: readonly RunState[] = ['accepted', 'rejected', 'cancelled'];

export type RunFilter = 'needs_you' | 'active' | 'all';

const ago = (t: number | null, now: number) => {
  if (!t) return '';
  const m = Math.round((now - t) / 60_000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function line(r: Run, now: number): string {
  const bits = [`${r.id}`, `"${r.title}"`, `repo ${r.repoName}`, SPOKEN[r.state]];
  if (r.state === 'waiting_input' && r.pendingQuestion) bits.push(`asked ${ago(r.pendingQuestion.askedAt, now)}`);
  else if (!TERMINAL.includes(r.state) && r.activity) bits.push(`doing: ${r.activity}`);
  return bits.join(' · ');
}

/** Runs as one line each, most urgent first. */
export function listRuns(store: Store, filter: RunFilter = 'active', now = Date.now()): string {
  const all = sortByAttention(store.listRuns({ includeTerminal: filter === 'all' }), now);
  const runs = filter === 'needs_you' ? all.filter((r) => needsAttention(r, now))
    : filter === 'active' ? all.filter((r) => !TERMINAL.includes(r.state))
    : all;
  if (!runs.length) {
    return filter === 'needs_you' ? 'Nothing needs the user right now.' : filter === 'active' ? 'No active tasks.' : 'No tasks yet.';
  }
  const needs = runs.filter((r) => needsAttention(r, now)).length;
  const head = filter === 'needs_you' ? `${runs.length} need the user:` : `${runs.length} tasks, ${needs} need the user:`;
  return [head, ...runs.map((r) => `- ${line(r, now)}`)].join('\n');
}

/** A compact snapshot sent with every delegation so simple questions need no tool call. */
export function snapshot(store: Store, now = Date.now()): string {
  return listRuns(store, 'active', now);
}

const STOP = new Set(['the', 'a', 'an', 'task', 'tasks', 'run', 'one', 'that', 'this', 'in', 'on', 'for', 'to', 'of', 'about', 'thing']);
const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((w) => w && !STOP.has(w));

export type Resolved = { run: Run } | { error: string };

/**
 * Find the run the user means, by id, or by words from its title or repo (people don't say
 * "r_7k2m9q"). Ambiguity is an error listing the candidates, so the caller asks instead of guessing.
 */
export function resolveRun(store: Store, ref: string, now = Date.now()): Resolved {
  const runs = store.listRuns({ includeTerminal: true });
  const byId = runs.find((r) => r.id === ref.trim());
  if (byId) return { run: byId };
  const want = words(ref);
  if (!want.length) return { error: `"${ref}" doesn't name a task. Ask which one.` };
  const scored = runs.map((r) => {
    const have = words(`${r.title} ${r.repoName}`);
    const hits = want.filter((w) => have.some((h) => h === w || (w.length >= 4 && (h.startsWith(w) || w.startsWith(h))))).length;
    return { r, score: hits / want.length };
  }).filter((x) => x.score >= 0.5).sort((a, b) => b.score - a.score || b.r.createdAt - a.r.createdAt);
  if (!scored.length) return { error: `No task matches "${ref}". ${listRuns(store, 'active', now)}` };
  const best = scored[0]!;
  let tied = scored.filter((x) => best.score - x.score < 0.2);
  // People mean a live task over a finished one with the same words.
  const live = tied.filter((x) => !TERMINAL.includes(x.r.state));
  if (live.length) tied = live;
  if (tied.length > 1) {
    return { error: `"${ref}" could mean ${tied.length} tasks. Ask which one:\n${tied.slice(0, 5).map((x) => `- ${line(x.r, now)}`).join('\n')}` };
  }
  return { run: tied[0]!.r };
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Everything the user might ask about one run, in a few lines. */
export function describeRun(run: Run, now = Date.now()): string {
  const out = [`${run.id} "${run.title}" in ${run.repoName} (branch ${run.branch}) is ${SPOKEN[run.state]}.`];
  if (run.task.trim() !== run.title.trim()) out.push(`Task: ${clip(run.task.trim(), 400)}`);
  if (run.pendingQuestion) {
    const q = run.pendingQuestion;
    out.push(`Question from the agent (${ago(q.askedAt, now)}): ${q.question}`);
    if (q.options?.length) out.push(`Options: ${q.options.map((o, i) => `${i + 1}) ${o}`).join('; ')}`);
  }
  if (!TERMINAL.includes(run.state) && run.activity) out.push(`Latest activity (${ago(run.activityAt, now)}): ${run.activity}`);
  if (run.error) out.push(`Problem: ${run.error}`);
  if (run.summary) out.push(`Agent's summary: ${clip(run.summary.trim(), 800)}`);
  if (run.diffStat) {
    const d = run.diffStat;
    out.push(`Changes: ${d.files} file${d.files === 1 ? '' : 's'}, +${d.insertions} −${d.deletions}${d.paths.length ? ` (${d.paths.slice(0, 5).join(', ')}${d.paths.length > 5 ? ', …' : ''})` : ''}.`);
  }
  if (run.tests) out.push(`Tests: \`${run.tests.command}\` ${run.tests.passed ? 'passed' : `failed (exit ${run.tests.exitCode})`}.`);
  if (run.overlaps.length) out.push(`Overlaps with: ${run.overlaps.map((o) => `"${o.title}"`).join(', ')} (same files).`);
  return out.join('\n');
}

// ─── actions ─────────────────────────────────────────────────────────────────

/** A UI command voice sends to the open browser tabs. */
export type ScreenCommand = VoiceScreenCommand;

export interface ToolContext {
  store: Store;
  supervisor: Supervisor;
  git: Pick<Git, 'inspectRepo'>;
  confirm: ConfirmGate;
  /** The voice session's transcript, for confirmations. */
  transcript: Transcript;
  screen(cmd: ScreenCommand): void;
}

/** A tool result. `error` results go back to the model flagged as errors. */
export type ToolResult = { text: string; error?: boolean };
const ok = (text: string): ToolResult => ({ text });
const fail = (text: string): ToolResult => ({ text, error: true });

function withRun(ctx: ToolContext, ref: string, fn: (run: Run) => ToolResult | Promise<ToolResult>): Promise<ToolResult> {
  const r = resolveRun(ctx.store, ref);
  if ('error' in r) return Promise.resolve(fail(r.error));
  return Promise.resolve().then(() => fn(r.run)).catch((err: unknown) => fail(errorMessage(err)));
}

/** Known repos: every repo a run has used, most recent first. */
function knownRepos(store: Store): { path: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const r of [...store.listRuns({ includeTerminal: true })].sort((a, b) => b.createdAt - a.createdAt)) {
    if (!seen.has(r.repoPath)) seen.set(r.repoPath, r.repoName);
  }
  return [...seen].map(([path, name]) => ({ path, name }));
}

/** A spoken repo name ("tictactoe", "the sample app") or a path. */
export async function resolveRepo(ctx: ToolContext, ref: string): Promise<{ path: string } | { error: string }> {
  const raw = ref.trim();
  const repos = knownRepos(ctx.store);
  const list = repos.length ? `Known repos: ${repos.map((r) => r.name).join(', ')}.` : 'No repos have been used yet; the user needs to give a full path.';
  if (/^(\/|~\/)/.test(raw)) {
    const info = await ctx.git.inspectRepo(raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : raw);
    return info.isGitRepo ? { path: info.path } : { error: `${raw} is not a git repo${info.error ? ` (${info.error})` : ''}. ${list}` };
  }
  const want = words(raw).join('');
  if (!want) return { error: `Which repo? ${list}` };
  const squash = (s: string) => words(s).join('');
  const exact = repos.filter((r) => squash(r.name) === want);
  const partial = exact.length ? exact : repos.filter((r) => squash(r.name).includes(want) || want.includes(squash(r.name)));
  if (partial.length === 1) return { path: partial[0]!.path };
  if (partial.length > 1) return { error: `"${ref}" could mean ${partial.map((r) => r.name).join(' or ')}. Ask which one.` };
  return { error: `I don't know a repo called "${ref}". ${list}` };
}

const say = (run: Run) => `"${run.title}"`;

export async function startRuns(ctx: ToolContext, repoRef: string, tasks: string[]): Promise<ToolResult> {
  const todo = tasks.map((t) => t.trim()).filter(Boolean);
  if (!todo.length) return fail('No task given. Ask what the agent should do.');
  const repo = await resolveRepo(ctx, repoRef);
  if ('error' in repo) return fail(repo.error);
  const started: Run[] = [];
  const failed: string[] = [];
  for (const task of todo) {
    try { started.push(await ctx.supervisor.createRun({ repoPath: repo.path, task })); }
    catch (err) { failed.push(`"${task.split('\n')[0]}": ${errorMessage(err)}`); }
  }
  if (started.length === 1 && !failed.length) ctx.screen({ kind: 'show_run', runId: started[0]!.id });
  const out: string[] = [];
  if (started.length) out.push(`Started ${started.map(say).join(', ')} in ${started[0]!.repoName} (${started.map((r) => r.id).join(', ')}).`);
  if (failed.length) out.push(`Could not start: ${failed.join('; ')}`);
  return started.length ? ok(out.join(' ')) : fail(out.join(' '));
}

export function answerQuestion(ctx: ToolContext, ref: string, answer: string): Promise<ToolResult> {
  return withRun(ctx, ref, (run) => {
    const q = run.pendingQuestion;
    if (run.state !== 'waiting_input' || !q) return fail(`${say(run)} isn't waiting on a question; it's ${SPOKEN[run.state]}.`);
    ctx.supervisor.answer(run.id, q.id, answer.trim());
    return ok(`Answered ${say(run)}: "${answer.trim()}". The agent is continuing.`);
  });
}

export function messageRun(ctx: ToolContext, ref: string, text: string): Promise<ToolResult> {
  return withRun(ctx, ref, (run) => {
    ctx.supervisor.message(run.id, text.trim());
    return ok(`Sent to ${say(run)}.`);
  });
}

export function restartRun(ctx: ToolContext, ref: string): Promise<ToolResult> {
  return withRun(ctx, ref, (run) => {
    const r = ctx.supervisor.restart(run.id);
    return ok(`Restarted ${say(r)}; it's ${SPOKEN[r.state]}.`);
  });
}

const CONFIRM_TEXT: Record<ConfirmAction, (run: Run) => string> = {
  accept_merge: (r) => `Merge ${say(r)} into ${r.baseBranch}?`,
  accept_branch: (r) => `Accept ${say(r)} and keep its branch, without merging?`,
  reject: (r) => `Reject ${say(r)}? Its worktree and branch will be deleted.`,
  cancel: (r) => `Cancel ${say(r)}? The agent will stop.`,
};

/** Shared two-step flow for accept/reject/cancel. */
function confirmed(ctx: ToolContext, ref: string, action: ConfirmAction, token: string | undefined, act: (run: Run) => Promise<Run>, done: (run: Run) => string): Promise<ToolResult> {
  return withRun(ctx, ref, async (run) => {
    if (!token) {
      const t = ctx.confirm.issue(action, run.id, ctx.transcript);
      return ok(`Needs confirmation. Ask the user: "${CONFIRM_TEXT[action](run)}" If they clearly say yes, call again with confirm_token "${t}". Expires in 60 seconds.`);
    }
    const r = ctx.confirm.redeem(token, action, run.id, ctx.transcript);
    if (!r.ok) return fail(r.reason);
    return ok(done(await act(run)));
  });
}

export function acceptRun(ctx: ToolContext, ref: string, mode: 'merge' | 'branch', token?: string): Promise<ToolResult> {
  return confirmed(ctx, ref, mode === 'merge' ? 'accept_merge' : 'accept_branch', token, (run) => ctx.supervisor.accept(run.id, mode), (r) =>
    r.state === 'accepted' ? (mode === 'merge' ? `Merged ${say(r)} into ${r.baseBranch}.` : `Accepted ${say(r)}; its branch ${r.branch} is kept.`)
      : r.state === 'conflict' ? `${say(r)} hit a merge conflict: ${r.error ?? 'resolve it in the repo, then accept again'}.`
      : `${say(r)} is now ${SPOKEN[r.state]}.`);
}

export function rejectRun(ctx: ToolContext, ref: string, token?: string): Promise<ToolResult> {
  return confirmed(ctx, ref, 'reject', token, (run) => ctx.supervisor.reject(run.id), (r) => `Rejected ${say(r)}; its worktree and branch are gone.`);
}

export function cancelRun(ctx: ToolContext, ref: string, token?: string): Promise<ToolResult> {
  return confirmed(ctx, ref, 'cancel', token, (run) => ctx.supervisor.cancel(run.id), (r) => `Cancelled ${say(r)}.`);
}

export function showRun(ctx: ToolContext, ref: string): Promise<ToolResult> {
  return withRun(ctx, ref, (run) => {
    ctx.screen({ kind: 'show_run', runId: run.id });
    return ok(`${say(run)} is open on screen.`);
  });
}

export function showNeeds(ctx: ToolContext, on: boolean): ToolResult {
  ctx.screen({ kind: 'show_needs', on });
  return ok(on ? 'The screen now shows only tasks that need the user.' : 'The screen shows all tasks again.');
}

/** The header's numbers: live agents, queue, worktree disk use. */
export async function systemStatus(ctx: Pick<ToolContext, 'supervisor'> & { systemInfo(): Promise<SystemInfo> }): Promise<ToolResult> {
  const s = await ctx.systemInfo();
  const gb = s.disk.totalBytes / 1024 ** 3;
  return ok(`${s.liveCount} of ${s.maxConcurrent} agent slots busy, ${s.queuedCount} queued. Worktrees use ${gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(s.disk.totalBytes / 1024 ** 2)} MB`}${gb > 5 ? ', which is a lot: accepting or rejecting finished tasks frees it' : ''}.`);
}

/** A run's recent timeline (what the Activity tab shows), newest last. */
export function runActivity(ctx: ToolContext, ref: string, limit = 12): Promise<ToolResult> {
  return withRun(ctx, ref, (run) => {
    const events = ctx.store.listEvents(run.id, 0, 5000).slice(-limit);
    if (!events.length) return ok(`${say(run)} has no activity yet.`);
    const now = Date.now();
    return ok([`Recent activity for ${say(run)}:`, ...events.map((e) => `- ${ago(e.ts, now)} ${e.kind}: ${clip(e.text.replace(/\s+/g, ' '), 200)}`)].join('\n'));
  });
}
