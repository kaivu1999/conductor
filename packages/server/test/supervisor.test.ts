import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, RunEvent } from '@conductor/shared';
import { makeHarness, until, REPO } from './helpers/index.ts';
import { pidExists } from '../src/supervisor/process.ts';
import { computeOverlaps } from '../src/supervisor/overlaps.ts';

type H = ReturnType<typeof makeHarness>;
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function harness(over?: Parameters<typeof makeHarness>[0]): H {
  const h = makeHarness(over);
  cleanups.push(() => fs.rmSync(h.config.dataDir, { recursive: true, force: true }));
  return h;
}

const state = (h: H, id: string) => h.store.getRun(id)!.state;
const create = (h: H, task = 'Add a --verbose flag\nmore detail') => h.sup.createRun({ repoPath: REPO, task });

/** Start a run and wait for it to be running with its session id persisted. */
async function running(h: H, task?: string): Promise<Run> {
  const run = await create(h, task);
  await until(() => state(h, run.id) === 'running' && !!h.store.getRun(run.id)!.sessionId, 2000, `${run.id} running`);
  return h.store.getRun(run.id)!;
}

async function ready(h: H, changes: string[] = ['src/a.ts']): Promise<Run> {
  const run = await running(h);
  h.git.changes.set(run.worktreePath!, changes);
  h.agent.last(run.id).finish(true);
  await until(() => state(h, run.id) === 'ready', 2000, 'ready');
  await h.sup.idle();
  return h.store.getRun(run.id)!;
}

describe('create + scheduling', () => {
  it('rejects non-git paths with a readable 400 error', async () => {
    const h = harness();
    await expect(h.sup.createRun({ repoPath: '/nope', task: 'x' })).rejects.toMatchObject({ code: 'bad_request', message: expect.stringContaining('not a git repository') });
  });

  it('creates queued with defaults, then the scheduler starts it with a worktree', async () => {
    const h = harness();
    h.sup.startScheduler();
    const long = 'x'.repeat(200);
    const run = await create(h, `  ${long}\nsecond line`);
    expect(run.branch).toBe(`conductor/${run.id}`);
    expect(run.baseBranch).toBe('main');
    expect(run.title.length).toBeLessThanOrEqual(80);
    expect(h.store.getTestCommand(run.id)).toBe('npm test');
    await until(() => state(h, run.id) === 'running');
    const r = h.store.getRun(run.id)!;
    expect(r.worktreePath).toBe(path.join(h.config.worktreeRoot, run.id));
    expect(r.baseCommit).toBeTruthy();
    expect(r.attempt).toBe(1);
    expect(r.startedAt).toBeTruthy();
    await until(() => h.store.getRun(run.id)!.pid !== null);
    const transitions = h.store.events.filter((e) => e.runId === run.id && e.kind === 'state').map((e) => e.text);
    expect(transitions).toEqual(['queued → starting', 'starting → running']);
  });

  it('respects maxConcurrent (5 runs, max 2) and fills slots as runs finish', async () => {
    const h = harness({ config: { maxConcurrent: 2 } });
    h.sup.startScheduler();
    const runs: Run[] = [];
    for (let i = 0; i < 5; i++) runs.push(await create(h, `task ${i}`));
    await until(() => runs.filter((r) => state(h, r.id) === 'running').length === 2);
    await new Promise((r) => setTimeout(r, 30));
    expect(runs.map((r) => state(h, r.id))).toEqual(['running', 'running', 'queued', 'queued', 'queued']); // oldest first
    h.agent.last(runs[0]!.id).finish(true);
    await until(() => state(h, runs[2]!.id) === 'running');
    expect(runs.filter((r) => ['starting', 'running'].includes(state(h, r.id))).length).toBe(2);
  });

  it('concurrent ticks never start a run twice', async () => {
    const h = harness({ config: { maxConcurrent: 10 } });
    const a = await create(h, 'a');
    const b = await create(h, 'b');
    h.sup.startScheduler();
    for (let i = 0; i < 20; i++) h.sup.tick();
    await Promise.all(Array.from({ length: 20 }, async () => h.sup.tick()));
    await until(() => state(h, a.id) === 'running' && state(h, b.id) === 'running');
    expect(h.git.calls.filter((c) => c.startsWith('createWorktree')).sort()).toEqual([`createWorktree ${a.id}`, `createWorktree ${b.id}`]);
    expect(h.agent.sessions.length).toBe(2);
  });

  it('a failure while starting → failed with a human error', async () => {
    const h = harness();
    h.git.createWorktreeHook = () => { throw new Error('base branch "main" not found'); };
    h.sup.startScheduler();
    const run = await create(h);
    await until(() => state(h, run.id) === 'failed');
    expect(h.store.getRun(run.id)!.error).toMatch(/Could not start the agent: base branch "main" not found/);
  });
});

describe('agent events', () => {
  it('persists session/pid, throttles activity writes but always emits the latest', async () => {
    const h = harness({ config: { maxConcurrent: 1 } });
    const emitted: Run[] = [];
    h.sup.on('run', (r) => emitted.push(r));
    h.sup.startScheduler();
    const run = await running(h);
    const s = h.agent.last(run.id);
    let writes = 0;
    const orig = h.store.patch.bind(h.store);
    h.store.patch = (id, p) => { if ('activity' in p) writes++; return orig(id, p); };
    for (let i = 0; i < 20; i++) s.emit({ type: 'activity', text: `step ${i}` });
    expect(emitted.at(-1)!.activity).toBe('step 19');
    expect(writes).toBeLessThanOrEqual(1);
    await until(() => h.store.getRun(run.id)!.activity === 'step 19', 1000, 'throttled flush');
    s.emit({ type: 'tool', name: 'Edit', summary: 'Edit src/a.ts' });
    s.emit({ type: 'usage', costUsd: 0.2, turns: 2 });
    s.emit({ type: 'usage', costUsd: 0.3, turns: 3 });
    expect(h.store.getRun(run.id)!.costUsd).toBe(0.3); // cumulative: latest wins
    expect(h.store.events.some((e) => e.kind === 'tool' && e.text === 'Edit src/a.ts')).toBe(true);
  });

  it('question flow: waiting_input, wrong id rejected, answer resumes', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    const s = h.agent.last(run.id);
    s.ask('q1', 'Which colour?');
    expect(state(h, run.id)).toBe('waiting_input');
    expect(h.store.getRun(run.id)!.activity).toBe('Waiting for your answer: Which colour?');
    expect(() => h.sup.answer(run.id, 'q-wrong', 'blue')).toThrow(expect.objectContaining({ code: 'conflict' }));
    const r = h.sup.answer(run.id, 'q1', 'blue');
    expect(r.state).toBe('running');
    expect(r.pendingQuestion).toBeNull();
    expect(s.answers).toEqual([{ questionId: 'q1', answer: 'blue' }]);
    expect(h.store.events.some((e) => e.kind === 'answer' && e.text === 'blue')).toBe(true);
    expect(() => h.sup.answer(run.id, 'q1', 'blue')).toThrow(/not waiting/);
  });

  it('answer when the agent process is gone → 409 "restart the run"', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    const s = h.agent.last(run.id);
    s.ask('q1');
    s.dead = true;
    expect(() => h.sup.answer(run.id, 'q1', 'x')).toThrow(/no longer running; restart the run/);
    expect(state(h, run.id)).toBe('waiting_input');
  });

  it('message steers a live run and records an answer event', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    h.sup.message(run.id, 'also update the README');
    expect(h.agent.last(run.id).messages).toEqual(['also update the README']);
    expect(h.store.events.find((e) => e.kind === 'answer')).toMatchObject({ text: 'also update the README', data: { kind: 'message' } });
  });
});

describe('finishing', () => {
  it('finish → testing → ready with diffStat/tests/summary', async () => {
    const h = harness();
    h.sup.startScheduler();
    const r = await ready(h, ['src/a.ts', 'src/b.ts']);
    expect(r.diffStat).toMatchObject({ files: 2, paths: ['src/a.ts', 'src/b.ts'] });
    expect(r.tests).toMatchObject({ command: 'npm test', passed: true });
    expect(r.summary).toBe('did the thing');
    expect(r.finishedAt).toBeTruthy();
    expect(r.pid).toBeNull();
    const states = h.store.events.filter((e) => e.runId === r.id && e.kind === 'state').map((e) => e.text);
    expect(states.slice(-2)).toEqual(['running → testing', 'testing → ready']);
    expect(h.git.commits[0]).toContain('conductor: Add a --verbose flag');
    expect(h.store.events.some((e) => e.kind === 'test')).toBe(true);
  });

  it('failing tests still → ready with tests.passed=false', async () => {
    const h = harness();
    h.git.testResult = { passed: false, exitCode: 1, output: 'FAIL' };
    h.sup.startScheduler();
    const r = await ready(h);
    expect(r.state).toBe('ready');
    expect(r.tests).toMatchObject({ passed: false, exitCode: 1 });
    expect(r.error).toBeNull();
  });

  it('no changes → ready with files: 0', async () => {
    const h = harness();
    h.sup.startScheduler();
    const r = await ready(h, []);
    expect(r.diffStat!.files).toBe(0);
  });

  it('agent error → failed with the error', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    h.agent.last(run.id).finish(false);
    await until(() => state(h, run.id) === 'failed');
    expect(h.store.getRun(run.id)!.error).toBe('Agent failed: model overloaded');
  });

  it('flags overlaps between runs touching the same files', async () => {
    const h = harness();
    h.sup.startScheduler();
    const a = await running(h, 'a');
    const b = await running(h, 'b');
    h.git.changes.set(a.worktreePath!, ['src/x.ts', 'src/y.ts']);
    h.git.changes.set(b.worktreePath!, ['src/y.ts']);
    h.agent.last(a.id).finish(true);
    await until(() => h.store.getRun(a.id)!.overlaps.length > 0);
    expect(h.store.getRun(a.id)!.overlaps).toEqual([{ runId: b.id, title: 'b', paths: ['src/y.ts'] }]);
    expect(h.store.getRun(b.id)!.overlaps).toEqual([{ runId: a.id, title: 'a', paths: ['src/y.ts'] }]);
  });

  it('computeOverlaps is symmetric and ignores self', () => {
    const m = computeOverlaps([
      { run: { id: '1', title: 'one' }, paths: ['a', 'b'] },
      { run: { id: '2', title: 'two' }, paths: ['b', 'c'] },
      { run: { id: '3', title: 'three' }, paths: ['d'] },
    ]);
    expect(m.get('1')).toEqual([{ runId: '2', title: 'two', paths: ['b'] }]);
    expect(m.get('3')).toEqual([]);
  });
});

describe('accept / reject', () => {
  it('merge ok → accepted, worktree removed, branch deleted', async () => {
    const h = harness();
    h.sup.startScheduler();
    const r = await ready(h);
    const done = await h.sup.accept(r.id, 'merge');
    expect(done.state).toBe('accepted');
    expect(done.worktreePath).toBeNull();
    expect(h.git.worktrees.has(r.worktreePath!)).toBe(false);
    expect(h.git.branches.has(r.branch)).toBe(false);
    expect(h.store.events.some((e) => e.runId === r.id && /Merged into main/.test(e.text))).toBe(true);
  });

  it('merge conflict → conflict with files in error, worktree + branch kept', async () => {
    const h = harness();
    h.git.mergeResult = { ok: false, conflicts: ['src/a.ts', 'src/b.ts'], error: 'conflict' };
    h.sup.startScheduler();
    const r = await ready(h);
    const done = await h.sup.accept(r.id, 'merge');
    expect(done.state).toBe('conflict');
    expect(done.error).toBe('Merge conflict in 2 files: src/a.ts, src/b.ts');
    expect(done.worktreePath).toBe(r.worktreePath);
    expect(h.git.branches.has(r.branch)).toBe(true);
  });

  it('merge refused without conflicts (dirty checkout) → back to ready with the error', async () => {
    const h = harness();
    h.git.mergeResult = { ok: false, conflicts: [], error: 'main is checked out with uncommitted changes' };
    h.sup.startScheduler();
    const r = await ready(h);
    const done = await h.sup.accept(r.id, 'merge');
    expect(done.state).toBe('ready');
    expect(done.error).toMatch(/uncommitted changes/);
  });

  it('accept branch → accepted, branch kept, merge command recorded', async () => {
    const h = harness();
    h.sup.startScheduler();
    const r = await ready(h);
    const done = await h.sup.accept(r.id, 'branch');
    expect(done.state).toBe('accepted');
    expect(h.git.branches.has(r.branch)).toBe(true);
    expect(h.git.merges).toEqual([]);
    expect(h.store.events.some((e) => e.text.includes(`merge --no-ff ${r.branch}`))).toBe(true);
  });

  it('reject → rejected, worktree removed, branch deleted; cleanup failure does not strand it', async () => {
    const h = harness();
    h.sup.startScheduler();
    const r = await ready(h);
    const done = await h.sup.reject(r.id);
    expect(done.state).toBe('rejected');
    expect(done.worktreePath).toBeNull();
    expect(h.git.branches.has(r.branch)).toBe(false);

    const r2 = await ready(h);
    h.git.failRemove = true;
    const done2 = await h.sup.reject(r2.id);
    expect(done2.state).toBe('rejected');
    expect(done2.worktreePath).toBe(r2.worktreePath); // reaper retries
    h.git.failRemove = false;
    expect(await h.sup.reap()).toBe(1);
    expect(h.store.getRun(r2.id)!.worktreePath).toBeNull();
  });

  it('reaper deletes unowned run-id dirs but never foreign dirs in the worktree root', async () => {
    const h = harness();
    const root = h.config.worktreeRoot;
    const ours = path.join(root, 'r_abc123'); // looks like a run id, no run in the DB
    const foreign = path.join(root, 'someones-project'); // e.g. another tool sharing the dir
    for (const d of [ours, foreign]) fs.mkdirSync(d, { recursive: true });
    h.git.diskEntries.push({ path: ours }, { path: foreign });
    expect(await h.sup.reap()).toBe(1);
    expect(fs.existsSync(ours)).toBe(false);
    expect(fs.existsSync(foreign)).toBe(true);
  });

  it('reject a live run stops the agent first', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    const done = await h.sup.reject(run.id);
    expect(done.state).toBe('rejected');
    expect(h.agent.last(run.id).stopped).toBe(true);
  });
});

describe('cancel / restart', () => {
  it('cancel owns the state: the agent\'s "Agent stopped" error does not mark it failed', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    const r = await h.sup.cancel(run.id);
    expect(r.state).toBe('cancelled');
    expect(h.agent.last(run.id).stopped).toBe(true);
    await h.sup.idle();
    expect(state(h, run.id)).toBe('cancelled');
    expect(h.store.getRun(run.id)!.worktreePath).toBeTruthy();
    expect(h.killed).toContain(run.id); // tagged subprocess sweep
  });

  it('cancel a queued run', async () => {
    const h = harness();
    const run = await create(h);
    expect((await h.sup.cancel(run.id)).state).toBe('cancelled');
  });

  it('restart: cancelled → queued → starts again with resumeSessionId (immediately after cancel)', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    const sessionId = h.store.getRun(run.id)!.sessionId!;
    await h.sup.cancel(run.id);
    const r = h.sup.restart(run.id);
    expect(['queued', 'starting']).toContain(r.state);
    expect(r.error).toBeNull();
    await until(() => h.agent.sessions.filter((s) => s.opts.runId === run.id).length === 2 && state(h, run.id) === 'running');
    expect(h.agent.last(run.id).opts.resumeSessionId).toBe(sessionId);
    expect(h.store.getRun(run.id)!.attempt).toBe(2);
  });

  it('restart: interrupted (after recover) → resumes the persisted session', async () => {
    const h = harness();
    const run = await create(h);
    h.store.transition(run.id, 'queued', 'starting');
    h.store.transition(run.id, 'starting', 'running');
    h.store.patch(run.id, { sessionId: 'sess-old', attempt: 1, worktreePath: '/wt', baseCommit: 'b' });
    await h.sup.recover();
    expect(state(h, run.id)).toBe('interrupted');
    h.sup.startScheduler();
    h.sup.restart(run.id);
    await until(() => state(h, run.id) === 'running');
    expect(h.agent.last(run.id).opts.resumeSessionId).toBe('sess-old');
    expect(h.store.getRun(run.id)!.attempt).toBe(2);
  });

  it('restart is refused for non-restartable states', async () => {
    const h = harness();
    const run = await create(h);
    expect(() => h.sup.restart(run.id)).toThrow(expect.objectContaining({ code: 'conflict' }));
  });
});

describe('recover()', () => {
  function spawnSleeper(): number {
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1e9)'], { detached: true, stdio: 'ignore' });
    child.unref();
    const pid = child.pid!;
    cleanups.push(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } });
    return pid;
  }

  /** Put a run directly into `st` (bypassing the scheduler), as if a previous conductor had. */
  async function seed(h: H, st: Run['state'], patch: Partial<Run> = {}): Promise<Run> {
    const run = await create(h);
    const path: Record<string, Run['state'][]> = {
      queued: [], running: ['starting', 'running'], waiting_input: ['starting', 'running', 'waiting_input'],
      accepting: ['starting', 'running', 'testing', 'ready', 'accepting'], ready: ['starting', 'running', 'testing', 'ready'],
    };
    let from: Run['state'] = 'queued';
    for (const to of path[st]!) {
      h.store.transition(run.id, from, to);
      from = to;
    }
    return h.store.patch(run.id, { worktreePath: `${h.config.worktreeRoot}/${run.id}`, baseCommit: 'b'.repeat(40), sessionId: 's1', ...patch });
  }

  it('interrupts live runs, kills a real orphan, spares a reused pid, accepting → ready, queued stays', { timeout: 15_000 }, async () => {
    const h = harness();
    const orphanPid = spawnSleeper();
    const strangerPid = spawnSleeper();
    await new Promise((r) => setTimeout(r, 300));
    const orphan = await seed(h, 'running', { pid: orphanPid, pidStartedAt: Date.now() });
    const stranger = await seed(h, 'waiting_input', { pid: strangerPid, pidStartedAt: Date.now() - 3_600_000 });
    const accepting = await seed(h, 'accepting');
    const queued = await seed(h, 'queued');
    const readyRun = await seed(h, 'ready');

    const res = await h.sup.recover();

    expect(res.interrupted.sort()).toEqual([orphan.id, stranger.id].sort());
    expect(res.orphansKilled).toBe(1);
    await until(() => !pidExists(orphanPid), 3000, 'orphan to die');
    expect(pidExists(strangerPid)).toBe(true);
    expect(state(h, orphan.id)).toBe('interrupted');
    expect(h.store.getRun(orphan.id)!.error).toBe('Conductor restarted while this run was running; the agent was stopped. Restart to resume.');
    expect(h.store.getRun(orphan.id)!.pid).toBeNull();
    expect(h.store.getRun(orphan.id)!.sessionId).toBe('s1'); // kept for resume
    expect(state(h, stranger.id)).toBe('interrupted');
    expect(state(h, accepting.id)).toBe('ready');
    expect(h.store.getRun(accepting.id)!.error).toMatch(/accept again/);
    expect(state(h, queued.id)).toBe('queued');
    expect(state(h, readyRun.id)).toBe('ready');
  });

  it('sweeps tagged subprocesses of known runs and counts them', async () => {
    const swept: string[] = [];
    const h = harness({
      processes: {
        findRunProcesses: () => [{ pid: 1234, runId: 'r_000001' }, { pid: 1235, runId: 'r_unknown' }],
        killRunProcesses: (id) => (swept.push(id), 1),
      },
    });
    await seed(h, 'running');
    const res = await h.sup.recover();
    expect(swept).toEqual(['r_000001']);
    expect(res.orphansKilled).toBe(1);
  });

  it('prunes orphan worktree dirs and terminal runs\' leftover worktrees', async () => {
    const h = harness();
    const strayDir = path.join(h.config.worktreeRoot, 'r_stray1');
    fs.mkdirSync(strayDir);
    fs.writeFileSync(path.join(strayDir, 'f'), 'x');
    h.git.diskEntries.push({ path: strayDir });
    const run = await seed(h, 'ready');
    h.store.transition(run.id, 'ready', 'rejected');
    const res = await h.sup.recover();
    expect(res.worktreesPruned).toBe(2);
    expect(fs.existsSync(strayDir)).toBe(false);
    expect(h.store.getRun(run.id)!.worktreePath).toBeNull();
  });

  it('after recover, the scheduler starts queued runs and never restarts interrupted ones', async () => {
    const h = harness();
    const live = await seed(h, 'running');
    const queued = await seed(h, 'queued');
    await h.sup.recover();
    h.sup.startScheduler();
    await until(() => state(h, queued.id) === 'running');
    expect(state(h, live.id)).toBe('interrupted');
    expect(h.agent.sessions.map((s) => s.opts.runId)).toEqual([queued.id]);
  });
});

describe('shutdown', () => {
  it('stops agents, marks live runs interrupted, closes the store', async () => {
    const h = harness({ config: { maxConcurrent: 3 } });
    h.sup.startScheduler();
    const a = await running(h, 'a');
    const b = await running(h, 'b');
    h.agent.last(b.id).ask('q1');
    const q = await create(h, 'queued one');
    h.store.transition(q.id, ['starting', 'running'], 'cancelled'); // keep it out of the way if it started
    const events: RunEvent[] = [];
    h.sup.on('event', (e) => events.push(e));
    await h.sup.shutdown();
    for (const id of [a.id, b.id]) {
      expect(h.agent.last(id).stopped).toBe(true);
      expect(h.store.runs.get(id)!.state).toBe('interrupted');
      expect(h.store.runs.get(id)!.error).toMatch(/shut down/);
      expect(h.store.runs.get(id)!.sessionId).toBeTruthy();
    }
    expect(h.store.closed).toBe(true);
    expect(events.filter((e) => e.kind === 'state').length).toBeGreaterThanOrEqual(2);
    // Late agent callbacks after shutdown are harmless.
    expect(() => h.agent.last(a.id).emit({ type: 'activity', text: 'late' })).not.toThrow();
  });
});

describe('test command for new projects', () => {
  it('detects a test command after the run when none existed at creation', async () => {
    const h = harness();
    h.sup.startScheduler();
    const run = await running(h);
    h.store.testCommands.set(run.id, null); // e.g. an empty new project
    h.git.laterTestCommand = 'pytest';
    h.git.changes.set(run.worktreePath!, ['app.py', 'test_app.py']);
    h.agent.last(run.id).finish(true);
    await until(() => state(h, run.id) === 'ready', 2000, 'ready');
    expect(h.store.getRun(run.id)!.tests?.command).toBe('pytest');
    expect(h.store.listEvents(run.id).some((e) => e.text === 'Found a test command after the run: pytest.')).toBe(true);
    await h.sup.shutdown();
  });
});
