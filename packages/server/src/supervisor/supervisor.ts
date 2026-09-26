/**
 * Run lifecycle, scheduling and the live agent sessions.
 *
 * Invariants:
 *  - Every state change is a Store CAS (`w.transition`). A null result means another actor
 *    (cancel, shutdown, a concurrent tick) won the race; we log and bail, never proceed.
 *  - `sessions` is a cache of reality: it holds the only handle to each live agent process.
 *    The DB is truth. After a crash the map is empty and recover() reconciles the DB.
 *  - Whoever *stops* an agent (cancel/reject/shutdown) owns the resulting state. They set
 *    `live.intent` first, so the agent's own "finished"/"error" callbacks leave state alone.
 */
import { LIVE_STATES, isLive, type Run, type RunEvent, type RunState, type SystemInfo, type DiskUsage } from '@conductor/shared';
import type { AgentAdapter, AgentEvent, AgentSession, Config, Git, Store, Supervisor } from '../contracts.ts';
import { consoleLogger, conflict, badRequest, notFound, errorMessage, type Logger } from './errors.ts';
import { createWriter } from './writer.ts';
import { noProcessControl, type ProcessControl, type SupervisorContext } from './context.ts';
import { createOverlapTracker } from './overlaps.ts';
import { recoverRuns, type RecoveryResult } from './recovery.ts';
import { reapWorktrees } from './reaper.ts';

export const VERSION = '0.1.0';

export interface SupervisorDeps {
  store: Store;
  git: Git;
  agent: AgentAdapter;
  config: Config;
  log?: Logger;
  processes?: ProcessControl;
  /** Overridable for tests. */
  timings?: Partial<Timings>;
}

interface Timings {
  tickMs: number;
  reapMs: number;
  activityWriteMs: number; // min interval between activity DB writes per run
  shutdownStopMs: number; // total budget for stopping agents on shutdown
  cancelStopMs: number;
  orphanGraceMs: number; // SIGTERM -> SIGKILL grace for orphans found at boot
  diskCacheMs: number;
}

const DEFAULT_TIMINGS: Timings = {
  tickMs: 2000,
  reapMs: 10 * 60_000,
  activityWriteMs: 500,
  shutdownStopMs: 5000,
  cancelStopMs: 10_000,
  orphanGraceMs: 3000,
  diskCacheMs: 30_000,
};

/** Supervisor plus a few extras the HTTP layer and tests use. */
export interface ConductorSupervisor extends Supervisor {
  tick(): void;
  reap(): Promise<number>;
  systemInfo(opts?: { fresh?: boolean }): Promise<SystemInfo>;
  /** Resolves when no lifecycle step is in flight (tests). */
  idle(): Promise<void>;
}

type Intent = 'cancel' | 'shutdown' | null;

/** One agent attempt. A new object per start so late callbacks from an old attempt are ignored. */
interface Live {
  runId: string;
  session: AgentSession | null;
  intent: Intent;
  summary: string | null;
  error: string | null;
  /** A question that arrived before starting -> running was recorded. */
  earlyQuestion: Extract<AgentEvent, { type: 'question' }>['question'] | null;
  activity: { text: string; at: number } | null;
  lastActivityWrite: number;
  activityTimer: NodeJS.Timeout | null;
  /** Resolves once onAgentFinished has run for this attempt (session handle released). */
  settled: Promise<void>;
}

const RESTARTABLE: readonly RunState[] = ['interrupted', 'failed', 'cancelled'];
const REJECTABLE: readonly RunState[] = ['ready', 'conflict', 'failed', 'cancelled', 'interrupted'];
const AGENT_STATES: readonly RunState[] = ['starting', 'running', 'waiting_input'];

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p.then(() => true), sleep(ms).then(() => false)]);

export function titleFromTask(task: string): string {
  const first = task.trim().split(/\r?\n/)[0]!.trim();
  return first.length > 80 ? first.slice(0, 79).trimEnd() + '…' : first;
}

export function createSupervisor(deps: SupervisorDeps): ConductorSupervisor {
  const { store, git, agent, config } = deps;
  const log = deps.log ?? consoleLogger;
  const t: Timings = { ...DEFAULT_TIMINGS, ...deps.timings };
  const w = createWriter(store, log);
  const sessions = new Map<string, Live>();
  /** Runs with an async lifecycle step in flight in this process (start/finish/accept/reject). */
  const busy = new Map<string, number>();
  const inflight = new Set<Promise<unknown>>();
  const ctx: SupervisorContext = {
    store, git, config, log, w,
    processes: deps.processes ?? noProcessControl,
    busy: (id) => (busy.get(id) ?? 0) > 0 || sessions.has(id),
  };
  const overlaps = createOverlapTracker(ctx);

  let schedulerOn = false;
  let shuttingDown = false;
  let tickTimer: NodeJS.Timeout | null = null;
  let reapTimer: NodeJS.Timeout | null = null;
  let recovered: RecoveryResult = { interrupted: [], orphansKilled: 0, worktreesPruned: 0 };
  let diskCache: { at: number; usage: DiskUsage } | null = null;
  const startedAt = Date.now();

  /** Track an async lifecycle step: marks the run busy and lets idle()/shutdown() await it. */
  function track<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    busy.set(runId, (busy.get(runId) ?? 0) + 1);
    const p = fn().finally(() => {
      const n = (busy.get(runId) ?? 1) - 1;
      if (n <= 0) busy.delete(runId);
      else busy.set(runId, n);
      inflight.delete(p);
    });
    inflight.add(p);
    return p;
  }

  function mustGet(id: string): Run {
    const run = w.get(id);
    if (!run) throw notFound(`Run ${id} not found.`);
    return run;
  }

  async function waitNotBusy(id: string, ms: number): Promise<void> {
    const deadline = Date.now() + ms;
    while (busy.get(id) && Date.now() < deadline) await sleep(25);
  }

  /** CAS failed inside a user action: tell them what the run is doing now. */
  function raced(id: string, what: string): never {
    const cur = w.get(id);
    throw conflict(`Could not ${what}: the run is now ${cur?.state ?? 'gone'}. Refresh and try again.`);
  }

  // ─── scheduling ────────────────────────────────────────────────────────────

  /**
   * Synchronous claim loop. The live count comes from the DB and the claim is a CAS, so
   * concurrent ticks (or two supervisors on one DB) can never start a run twice or exceed
   * the cap by more than their own claims.
   */
  function tick(): void {
    if (!schedulerOn || shuttingDown || w.closed) return;
    try {
      let live = store.listByState(LIVE_STATES).length;
      if (live >= config.maxConcurrent) return;
      const queued = store.listByState(['queued']).sort((a, b) => a.createdAt - b.createdAt);
      for (const run of queued) {
        if (live >= config.maxConcurrent) break;
        // A previous attempt's agent is still being stopped: starting now would put two agents in one worktree.
        if (ctx.busy(run.id)) continue;
        const claimed = w.transition(run.id, 'queued', 'starting', {
          attempt: run.attempt + 1,
          startedAt: Date.now(),
          finishedAt: null,
          activity: 'Preparing worktree',
          activityAt: Date.now(),
          error: null,
        });
        if (!claimed) continue;
        live++;
        void track(claimed.id, () => startRun(claimed));
      }
    } catch (err) {
      log.error(`scheduler tick failed: ${errorMessage(err)}`);
    }
  }

  async function startRun(run: Run): Promise<void> {
    const id = run.id;
    let live: Live | null = null;
    try {
      const { worktreePath, baseCommit } = await git.createWorktree(run.repoPath, id, run.branch, run.baseBranch);
      // Cancelled / shut down while git was working? The stopper owns the state; keep the worktree.
      const cur = w.get(id);
      if (!cur || cur.state !== 'starting' || shuttingDown) return;
      w.patch(id, { worktreePath, baseCommit, activity: run.sessionId ? 'Resuming agent session' : 'Starting agent', activityAt: Date.now() });
      w.event(id, 'system', `${run.attempt > 0 ? 'Reusing' : 'Created'} worktree at ${worktreePath} on ${run.branch} (base ${baseCommit.slice(0, 8)}).`);

      live = {
        runId: id, session: null, intent: null, summary: null, error: null, earlyQuestion: null,
        activity: null, lastActivityWrite: 0, activityTimer: null, settled: Promise.resolve(),
      };
      sessions.set(id, live);
      const l = live;
      const session = agent.start({
        runId: id,
        cwd: worktreePath,
        task: run.task,
        ...(run.sessionId ? { resumeSessionId: run.sessionId } : {}),
        ...(config.maxBudgetUsd !== undefined ? { maxBudgetUsd: config.maxBudgetUsd } : {}),
        onEvent: (e) => onAgentEvent(l, e),
      });
      live.session = session;
      l.settled = session.finished
        .catch((err) => {
          l.error ??= `agent crashed: ${errorMessage(err)}`;
          return { ok: false };
        })
        .then((res) => track(id, () => onAgentFinished(l, res.ok)));

      const running = w.transition(id, 'starting', 'running', { activity: run.sessionId ? 'Resumed; working' : 'Working', activityAt: Date.now() });
      if (!running) {
        // Lost to cancel/shutdown between the check above and here; they set intent and stop it.
        if (!l.intent) {
          l.intent = 'cancel';
          void session.stop();
        }
        return;
      }
      if (l.earlyQuestion) applyQuestion(l, l.earlyQuestion);
    } catch (err) {
      const msg = `Could not start the agent: ${errorMessage(err)}`;
      log.error(`run ${id}: ${msg}`);
      if (live?.session && !live.intent) {
        live.intent = 'cancel'; // we own the state below
        void live.session.stop();
      }
      const failed = w.transition(id, 'starting', 'failed', { error: msg, activity: 'Failed to start', finishedAt: Date.now() });
      if (failed) w.event(id, 'error', msg);
      tick();
    }
  }

  // ─── agent events ──────────────────────────────────────────────────────────

  function current(l: Live): boolean {
    return sessions.get(l.runId) === l && !w.closed;
  }

  function onAgentEvent(l: Live, e: AgentEvent): void {
    if (!current(l)) return; // stale attempt, or store closed during shutdown
    const id = l.runId;
    try {
      switch (e.type) {
        case 'session':
          // Persist immediately: this id is what makes resume after a crash possible.
          if (w.get(id)?.sessionId !== e.sessionId) w.patch(id, { sessionId: e.sessionId });
          break;
        case 'process':
          w.patch(id, { pid: e.pid, pidStartedAt: e.startedAt });
          break;
        case 'activity':
          setActivity(l, e.text);
          break;
        case 'tool':
          w.event(id, 'tool', e.summary, { name: e.name });
          break;
        case 'text':
          if (e.text) w.event(id, 'text', e.text);
          break;
        case 'question':
          if (l.intent) break;
          applyQuestion(l, e.question);
          break;
        case 'usage':
          // Cumulative for the whole query: latest value wins.
          w.patch(id, { costUsd: e.costUsd, turns: e.turns });
          break;
        case 'done':
          l.summary = e.summary || null;
          w.patch(id, { costUsd: e.costUsd, turns: e.turns });
          break;
        case 'error':
          l.error = e.message;
          if (!l.intent) w.event(id, 'error', e.message);
          break;
      }
    } catch (err) {
      log.error(`run ${id}: handling agent '${e.type}' event failed: ${errorMessage(err)}`);
    }
  }

  function applyQuestion(l: Live, q: NonNullable<Live['earlyQuestion']>): void {
    const id = l.runId;
    const cur = w.get(id);
    if (cur?.state === 'starting') {
      l.earlyQuestion = q; // applied right after starting -> running
      return;
    }
    l.earlyQuestion = null;
    flushActivity(l);
    const r = w.transition(id, 'running', 'waiting_input', {
      pendingQuestion: q,
      activity: `Waiting for your answer: ${q.question}`,
      activityAt: Date.now(),
    });
    if (r) w.event(id, 'question', q.question, q);
  }

  /** Always emit the latest activity; write it to the DB at most every activityWriteMs. */
  function setActivity(l: Live, text: string): void {
    const at = Date.now();
    l.activity = { text, at };
    const since = at - l.lastActivityWrite;
    if (since >= t.activityWriteMs) {
      flushActivity(l);
      return;
    }
    const snap = w.get(l.runId);
    if (snap) w.emitRun({ ...snap, activity: text, activityAt: at });
    l.activityTimer ??= setTimeout(() => {
      l.activityTimer = null;
      if (current(l)) flushActivity(l);
    }, t.activityWriteMs - since);
  }

  function flushActivity(l: Live): void {
    if (l.activityTimer) clearTimeout(l.activityTimer);
    l.activityTimer = null;
    if (!l.activity || w.closed) return;
    const { text, at } = l.activity;
    l.activity = null;
    l.lastActivityWrite = Date.now();
    // Don't clobber the "Waiting for your answer" line with a stale in-flight activity.
    if (w.get(l.runId)?.state === 'waiting_input') return;
    w.patch(l.runId, { activity: text, activityAt: at });
  }

  // ─── finishing ─────────────────────────────────────────────────────────────

  async function onAgentFinished(l: Live, ok: boolean): Promise<void> {
    const id = l.runId;
    if (l.activityTimer) clearTimeout(l.activityTimer);
    l.activityTimer = null;
    const mine = sessions.get(id) === l;
    if (mine) sessions.delete(id);
    if (w.closed) return;
    try {
      if (mine) w.patch(id, { pid: null, pidStartedAt: null });
      if (l.intent || !mine) return; // the stopper owns the state
      if (!ok) {
        const error = l.error ? `Agent failed: ${l.error}` : 'Agent exited without finishing.';
        const r = w.transition(id, AGENT_STATES, 'failed', { error, activity: 'Failed', finishedAt: Date.now(), pendingQuestion: null });
        if (r) tick();
        return;
      }
      await finishRun(id, l.summary);
    } catch (err) {
      log.error(`run ${id}: finishing failed: ${errorMessage(err)}`);
    } finally {
      tick();
    }
  }

  /** running -> testing: commit, measure, test -> ready. Test failure is a result, not a failure. */
  async function finishRun(id: string, summary: string | null): Promise<void> {
    // The agent can end while a question is pending (e.g. it gave up); drop the question.
    if (w.get(id)?.state === 'waiting_input') w.transition(id, 'waiting_input', 'running', { pendingQuestion: null });
    const run = w.transition(id, 'running', 'testing', { activity: 'Committing changes', activityAt: Date.now(), summary });
    if (!run) return;
    try {
      if (!run.worktreePath || !run.baseCommit) throw new Error('run has no worktree');
      await git.commitAll(run.worktreePath, `conductor: ${run.title}`);
      const diffStat = await git.diffStat(run.worktreePath, run.baseCommit);
      // Nothing detected at creation (a new, empty project)? The agent may have added tests since.
      let testCommand = store.getTestCommand(id);
      if (!testCommand && diffStat.files > 0) {
        testCommand = await git.detectTestCommand(run.worktreePath);
        if (testCommand) w.event(id, 'system', `Found a test command after the run: ${testCommand}.`);
      }
      let tests: Run['tests'] = null;
      if (testCommand && diffStat.files > 0) {
        if (!w.patch(id, { activity: `Running tests: ${testCommand}`, activityAt: Date.now(), diffStat })) return;
        tests = await git.runTests(run.worktreePath, testCommand, config.testTimeoutMs);
        const secs = (tests.durationMs / 1000).toFixed(1);
        w.event(id, 'test', `Tests ${tests.passed ? 'passed' : `failed (exit ${tests.exitCode})`}: ${testCommand} in ${secs}s`, tests);
      } else if (testCommand) {
        w.event(id, 'system', 'No changes, so tests were skipped.');
      }
      const activity = diffStat.files === 0
        ? 'Finished with no changes'
        : `Ready for review: ${diffStat.files} file${diffStat.files === 1 ? '' : 's'} changed${tests && !tests.passed ? ', tests failing' : ''}`;
      const ready = w.transition(id, 'testing', 'ready', { summary, diffStat, tests, finishedAt: Date.now(), activity, activityAt: Date.now(), error: null });
      if (ready) await overlaps.refresh(ready.repoPath);
    } catch (err) {
      const msg = `Agent finished, but collecting its changes failed: ${errorMessage(err)}`;
      log.error(`run ${id}: ${msg}`);
      const r = w.transition(id, 'testing', 'failed', { error: msg, activity: 'Failed', finishedAt: Date.now() });
      if (r) w.event(id, 'error', msg);
    }
  }

  // ─── stopping ──────────────────────────────────────────────────────────────

  /** Stop a live session (intent must already be set). Bounded; also sweeps tagged subprocesses. */
  async function stopSession(l: Live, budgetMs: number): Promise<void> {
    if (!l.session) return;
    // Wait for the finish handler too, so a cancel -> restart right after never sees a stale handle.
    const session = l.session;
    const stopped = await withTimeout(
      session.stop().catch((err) => log.warn(`run ${l.runId}: stop failed: ${errorMessage(err)}`)).then(() => l.settled),
      budgetMs,
    );
    if (!stopped) {
      log.warn(`run ${l.runId}: agent did not stop within ${budgetMs}ms; dropping its handle`);
      // Don't let a wedged handle block restart forever; its callbacks become no-ops.
      if (sessions.get(l.runId) === l) sessions.delete(l.runId);
    }
    try {
      ctx.processes.killRunProcesses(l.runId); // tool subprocesses outside the agent's group
    } catch (err) {
      log.warn(`run ${l.runId}: sweeping subprocesses failed: ${errorMessage(err)}`);
    }
  }

  // ─── cleanup helpers ───────────────────────────────────────────────────────

  /** Remove worktree (then branch). Failures become timeline events; the reaper retries worktrees. */
  async function cleanup(run: Run, opts: { deleteBranch: boolean }): Promise<void> {
    if (run.worktreePath) {
      try {
        await git.removeWorktree(run.repoPath, run.worktreePath);
        w.patch(run.id, { worktreePath: null });
      } catch (err) {
        const msg = `Could not remove worktree ${run.worktreePath}: ${errorMessage(err)} (will retry automatically)`;
        log.warn(`run ${run.id}: ${msg}`);
        w.event(run.id, 'error', msg);
        return; // a branch checked out in a worktree can't be deleted anyway
      }
    }
    if (opts.deleteBranch) {
      try {
        await git.deleteBranch(run.repoPath, run.branch);
      } catch (err) {
        const msg = `Could not delete branch ${run.branch}: ${errorMessage(err)}`;
        log.warn(`run ${run.id}: ${msg}`);
        w.event(run.id, 'error', msg);
      }
    }
  }

  // ─── public API ────────────────────────────────────────────────────────────

  const sup: ConductorSupervisor = {
    async recover() {
      const { interrupted, orphansKilled } = await recoverRuns(ctx, { killGraceMs: t.orphanGraceMs });
      let worktreesPruned = 0;
      try {
        worktreesPruned = await sup.reap();
      } catch (err) {
        log.error(`boot reaper failed: ${errorMessage(err)}`);
      }
      recovered = { interrupted, orphansKilled, worktreesPruned };
      return recovered;
    },

    startScheduler() {
      if (schedulerOn || shuttingDown) return;
      schedulerOn = true;
      tickTimer = setInterval(tick, t.tickMs);
      tickTimer.unref();
      reapTimer = setInterval(() => void sup.reap().catch((err) => log.error(`reaper failed: ${errorMessage(err)}`)), t.reapMs);
      reapTimer.unref();
      tick();
    },

    tick,

    async reap() {
      if (w.closed) return 0;
      const { pruned, usage } = await reapWorktrees(ctx);
      diskCache = { at: Date.now(), usage };
      return pruned;
    },

    async createRun(input) {
      if (shuttingDown) throw conflict('Conductor is shutting down.');
      const task = input.task?.trim();
      if (!task) throw badRequest('Task is empty. Describe what the agent should do.');
      const info = await git.inspectRepo(input.repoPath);
      if (!info.isGitRepo) throw badRequest(info.error ?? `${input.repoPath} is not a git repository.`);
      if (info.error) throw badRequest(info.error);
      const baseBranch = input.baseBranch?.trim() || info.currentBranch;
      if (!baseBranch) throw badRequest('The repository is on a detached HEAD; choose a base branch.');
      if (input.baseBranch && info.branches.length && !info.branches.includes(baseBranch)) {
        throw badRequest(`Branch "${baseBranch}" does not exist in ${info.path}.`);
      }
      const testCommand = input.testCommand?.trim() || info.detectedTestCommand || null;
      // The branch name embeds the store-generated id, so create then patch (both synchronous:
      // no tick can observe the placeholder).
      const created = store.createRun({
        repoPath: info.path, repoName: info.name, task, title: titleFromTask(task),
        baseBranch, branch: 'conductor/pending', testCommand,
      });
      const run = w.patch(created.id, { branch: `conductor/${created.id}`, activity: 'Queued' }) ?? created;
      w.event(run.id, 'system', `Queued on ${baseBranch}. Tests: ${testCommand ?? 'none detected'}.`);
      tick();
      return w.get(run.id) ?? run;
    },

    answer(runId, questionId, answer) {
      const run = mustGet(runId);
      if (run.state !== 'waiting_input') throw conflict(`This run is ${run.state}, not waiting for an answer.`);
      if (!run.pendingQuestion || run.pendingQuestion.id !== questionId) {
        throw conflict('That question is no longer pending (it was answered or replaced). Refresh to see the current question.');
      }
      const l = sessions.get(runId);
      if (!l?.session || l.intent || !l.session.answer(questionId, answer)) {
        throw conflict('The agent is no longer running; restart the run.');
      }
      const r = w.transition(runId, 'waiting_input', 'running', { pendingQuestion: null, activity: 'Working on your answer', activityAt: Date.now() });
      w.event(runId, 'answer', answer, { questionId });
      return r ?? mustGet(runId);
    },

    message(runId, text) {
      const body = text?.trim();
      if (!body) throw badRequest('Message is empty.');
      const run = mustGet(runId);
      const l = sessions.get(runId);
      if (!(run.state === 'running' || run.state === 'waiting_input') || !l?.session || l.intent) {
        throw conflict(run.state === 'starting'
          ? 'The agent is still starting; try again in a moment.'
          : `This run is ${run.state}; you can only message a running agent.`);
      }
      l.session.sendMessage(body);
      w.event(runId, 'answer', body, { kind: 'message' });
      return mustGet(runId);
    },

    async cancel(runId) {
      const run = mustGet(runId);
      if (run.state === 'queued') {
        return w.transition(runId, 'queued', 'cancelled', { activity: 'Cancelled', finishedAt: Date.now() }) ?? raced(runId, 'cancel');
      }
      if (!isLive(run.state)) throw conflict(`This run is ${run.state}; only queued or live runs can be cancelled.`);
      // Everything up to the first await is synchronous, so the CAS below can't race with the
      // agent's own completion handling in this process.
      const l = sessions.get(runId);
      const prevIntent = l?.intent ?? null;
      if (l) l.intent = 'cancel';
      const r = w.transition(runId, LIVE_STATES, 'cancelled', {
        activity: 'Cancelled', activityAt: Date.now(), finishedAt: Date.now(), pendingQuestion: null,
      });
      if (!r) {
        if (l) l.intent = prevIntent;
        raced(runId, 'cancel');
      }
      w.event(runId, 'system', 'Cancelled. The worktree is kept, so you can restart or reject the run.');
      if (l) await track(runId, () => stopSession(l, t.cancelStopMs));
      return mustGet(runId);
    },

    restart(runId) {
      const run = mustGet(runId);
      if (!RESTARTABLE.includes(run.state)) throw conflict(`This run is ${run.state}; only interrupted, failed or cancelled runs can be restarted.`);
      if (ctx.busy(runId)) throw conflict('The previous agent for this run is still stopping; try again in a few seconds.');
      // Keep sessionId: the adapter resumes the conversation instead of starting over.
      const r = w.transition(runId, RESTARTABLE, 'queued', {
        error: null, pendingQuestion: null, pid: null, pidStartedAt: null, finishedAt: null,
        activity: run.sessionId ? 'Queued to resume' : 'Queued to restart', activityAt: Date.now(),
      }) ?? raced(runId, 'restart');
      tick();
      return r;
    },

    async accept(runId, mode) {
      const run = mustGet(runId);
      if (run.state !== 'ready' && run.state !== 'conflict') throw conflict(`This run is ${run.state}; only ready or conflicted runs can be accepted.`);
      if (ctx.busy(runId)) throw conflict('This run is busy; try again in a moment.');
      const claimed = w.transition(runId, ['ready', 'conflict'], 'accepting', {
        error: null, activity: mode === 'merge' ? `Merging into ${run.baseBranch}` : 'Keeping branch', activityAt: Date.now(),
      }) ?? raced(runId, 'accept');
      return track(runId, async () => {
        try {
          if (mode === 'branch') await acceptBranch(claimed);
          else await acceptMerge(claimed);
        } catch (err) {
          // Unexpected failure mid-accept: back to ready so the user can retry (accepting -> ready is legal).
          const msg = `Accept failed: ${errorMessage(err)}`;
          log.error(`run ${runId}: ${msg}`);
          if (w.transition(runId, 'accepting', 'ready', { error: msg, activity: 'Accept failed' })) w.event(runId, 'error', msg);
        }
        await overlaps.refresh(run.repoPath);
        return mustGet(runId);
      });
    },

    async reject(runId) {
      let run = mustGet(runId);
      if (run.state === 'queued' || isLive(run.state)) run = await sup.cancel(runId);
      if (!REJECTABLE.includes(run.state)) throw conflict(`This run is ${run.state}; it cannot be rejected right now.`);
      // A just-cancelled agent's completion handler may still be in flight; give it a moment.
      await waitNotBusy(runId, 3000);
      if (busy.get(runId)) throw conflict('This run is busy (merging or finishing); try again in a moment.');
      return track(runId, async () => {
        const l = sessions.get(runId); // e.g. a cancel whose stop is still in progress
        if (l) {
          l.intent ??= 'cancel';
          await stopSession(l, t.cancelStopMs);
        }
        // The state change is the commit point; cleanup after it is best-effort + reaper-retried.
        const r = w.transition(runId, REJECTABLE, 'rejected', {
          finishedAt: Date.now(), activity: 'Rejected', activityAt: Date.now(), pendingQuestion: null, pid: null, pidStartedAt: null,
        }) ?? raced(runId, 'reject');
        await cleanup(r, { deleteBranch: true });
        await overlaps.refresh(r.repoPath);
        return mustGet(runId);
      });
    },

    /**
     * Killing the conductor kills its agents. An unsupervised agent writing into a worktree
     * nobody is watching is exactly the chaos conductor exists to prevent. The session id is
     * persisted, so restarting the run resumes the conversation.
     */
    async shutdown() {
      if (shuttingDown) return;
      shuttingDown = true;
      schedulerOn = false;
      if (tickTimer) clearInterval(tickTimer);
      if (reapTimer) clearInterval(reapTimer);
      const lives = [...sessions.values()];
      for (const l of lives) {
        l.intent = 'shutdown';
        flushActivity(l);
      }
      await withTimeout(Promise.allSettled(lives.map((l) => stopSession(l, t.shutdownStopMs))), t.shutdownStopMs);
      try {
        for (const run of store.listByState(LIVE_STATES)) {
          w.transition(run.id, run.state, 'interrupted', {
            error: `Conductor was shut down while this run was ${run.state}; the agent was stopped. Restart to resume.`,
            activity: 'Interrupted by conductor shutdown', pid: null, pidStartedAt: null,
          });
        }
      } catch (err) {
        log.error(`shutdown: marking runs interrupted failed: ${errorMessage(err)}`);
      }
      // In-flight git steps (a merge, a test run) get a short grace to land their CAS; anything
      // left over is reconciled by recover() on next boot.
      await withTimeout(Promise.allSettled([...inflight]), 1000);
      w.close();
      store.close();
    },

    on(event: 'run' | 'event', cb: ((run: Run) => void) | ((e: RunEvent) => void)) {
      w.emitter.on(event, cb as (x: unknown) => void);
    },

    async systemInfo(opts) {
      if (opts?.fresh || !diskCache || Date.now() - diskCache.at > t.diskCacheMs) {
        const known = new Map<string, string>();
        for (const r of store.listRuns()) if (r.worktreePath) known.set(r.worktreePath, r.id);
        try {
          diskCache = { at: Date.now(), usage: await git.diskUsage(known) };
        } catch (err) {
          log.warn(`disk usage failed: ${errorMessage(err)}`);
          diskCache ??= { at: Date.now(), usage: { worktreeRoot: config.worktreeRoot, totalBytes: 0, worktrees: [] } };
        }
      }
      return {
        version: VERSION,
        startedAt,
        maxConcurrent: config.maxConcurrent,
        liveCount: store.listByState(LIVE_STATES).length,
        queuedCount: store.listByState(['queued']).length,
        disk: diskCache.usage,
        recoveredOnBoot: recovered,
      };
    },

    async idle() {
      while (inflight.size) await Promise.allSettled([...inflight]);
    },
  };

  async function acceptBranch(run: Run): Promise<void> {
    const cmd = `git -C ${shellQuote(run.repoPath)} merge --no-ff ${run.branch}`;
    const r = w.transition(run.id, 'accepting', 'accepted', {
      finishedAt: Date.now(), activity: `Kept branch ${run.branch}`, activityAt: Date.now(),
    });
    if (!r) return;
    w.event(run.id, 'system', `Kept branch ${run.branch} (not merged). To merge it yourself: ${cmd}`, { branch: run.branch, command: cmd });
    await cleanup(r, { deleteBranch: false });
  }

  async function acceptMerge(run: Run): Promise<void> {
    // Safety: anything left uncommitted in the worktree would silently not be merged.
    if (run.worktreePath) await git.commitAll(run.worktreePath, `conductor: ${run.title}`);
    const res = await git.merge(run.repoPath, run.branch, run.baseBranch, `Merge conductor run ${run.id}: ${run.title}`);
    if (res.ok) {
      // The merge is the commit point; mark accepted before cleanup so a crash can't re-merge.
      const r = w.transition(run.id, 'accepting', 'accepted', {
        finishedAt: Date.now(), activity: `Merged into ${run.baseBranch}`, activityAt: Date.now(), error: null, overlaps: [],
      });
      if (!r) return;
      w.event(run.id, 'system', `Merged into ${run.baseBranch} as ${res.mergeCommit.slice(0, 8)}.`, { mergeCommit: res.mergeCommit });
      // Runs that touched the same files now fork from an older base; warn them before they try to merge.
      for (const o of run.overlaps) {
        const other = w.get(o.runId);
        if (!other || other.state === 'accepted' || other.state === 'rejected') continue;
        w.event(o.runId, 'system', `"${run.title}" was merged into ${run.baseBranch} and changed the same files (${o.paths.join(', ')}); merging this run may conflict.`, { mergedRunId: run.id, paths: o.paths });
      }
      await cleanup(r, { deleteBranch: true });
      return;
    }
    if (res.conflicts.length) {
      const n = res.conflicts.length;
      const error = `Merge conflict in ${n} file${n === 1 ? '' : 's'}: ${res.conflicts.join(', ')}`;
      if (w.transition(run.id, 'accepting', 'conflict', { error, activity: 'Merge conflict — branch and worktree kept', activityAt: Date.now() })) {
        w.event(run.id, 'error', error, { conflicts: res.conflicts, detail: res.error });
      }
      return;
    }
    // No content conflict: dirty checkout, base moved, ff refused... retryable, so back to ready.
    const error = `Merge did not happen: ${res.error}`;
    if (w.transition(run.id, 'accepting', 'ready', { error, activity: 'Merge did not happen — fix and accept again', activityAt: Date.now() })) {
      w.event(run.id, 'error', error);
    }
  }

  return sup;
}

function shellQuote(s: string): string {
  return /^[\w./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
