import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { Run, VoiceScreenCommand } from '@conductor/shared';
import { ConfirmGate, saidYes } from '../src/voice/confirm.ts';
import {
  acceptRun, answerQuestion, cancelRun, messageRun, rejectRun, resolveRepo, showNeeds, showRun, startRuns, type ToolContext,
} from '../src/voice/tools.ts';
import { Transcript } from '../src/voice/transcript.ts';
import { makeHarness, until, REPO } from './helpers/index.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

/** Transcript helper: each call is a new, separate line. */
function talk(t: Transcript, role: 'user' | 'assistant', text: string) {
  const end = (t.all().at(-1)?.endMs ?? 0) + 5000;
  t.add(role, { delta: text, start_ms: end - 500, end_ms: end });
}

describe('saidYes', () => {
  it.each(['yes', 'Yeah, do it.', 'sure', 'OK go ahead', 'yes please, merge it', 'Confirmed.'])('%s → yes', (s) => expect(saidYes(s)).toBe(true));
  it.each(['no', 'wait', 'yes, no wait', "don't", 'hmm', 'not yet', 'which one?', 'hold on, okay'])('%s → no', (s) => expect(saidYes(s)).toBe(false));
});

describe('ConfirmGate', () => {
  it('only redeems after a later user yes, once, for the same action and run', () => {
    let now = 0;
    const gate = new ConfirmGate(60_000, () => now);
    const t = new Transcript();
    talk(t, 'user', 'Merge the night mode one.');
    const token = gate.issue('accept_merge', 'r_1', t);
    // The user's earlier request is not a yes to the question.
    expect(gate.redeem(token, 'accept_merge', 'r_1', t)).toMatchObject({ ok: false, reason: expect.stringMatching(/not answered/) });
    talk(t, 'assistant', 'Merge Add night mode into main?');
    talk(t, 'user', 'Yes.');
    expect(gate.redeem(token, 'reject', 'r_1', t).ok).toBe(false);
    expect(gate.redeem(token, 'accept_merge', 'r_2', t).ok).toBe(false);
    expect(gate.redeem(token, 'accept_merge', 'r_1', t)).toEqual({ ok: true });
    expect(gate.redeem(token, 'accept_merge', 'r_1', t).ok).toBe(false); // single use
  });

  it('refuses after a no, and after the TTL', () => {
    let now = 0;
    const gate = new ConfirmGate(60_000, () => now);
    const t = new Transcript();
    const a = gate.issue('reject', 'r_1', t);
    talk(t, 'user', 'No, keep it.');
    expect(gate.redeem(a, 'reject', 'r_1', t)).toMatchObject({ ok: false, reason: expect.stringMatching(/did not clearly confirm/) });
    const b = gate.issue('reject', 'r_1', t);
    talk(t, 'user', 'yes');
    now = 60_001;
    expect(gate.redeem(b, 'reject', 'r_1', t)).toMatchObject({ ok: false, reason: expect.stringMatching(/expired/) });
  });
});

describe('voice actions', () => {
  function setup() {
    const h = makeHarness();
    h.sup.startScheduler();
    cleanups.push(async () => { await h.sup.shutdown(); fs.rmSync(h.config.dataDir, { recursive: true, force: true }); });
    const screen: VoiceScreenCommand[] = [];
    const ctx: ToolContext = { store: h.store, supervisor: h.sup, git: h.git, confirm: new ConfirmGate(), transcript: new Transcript(), screen: (c) => screen.push(c) };
    const state = (id: string) => h.store.getRun(id)!.state;
    return { h, ctx, screen, state };
  }
  type S = ReturnType<typeof setup>;

  async function started(s: S, task: string): Promise<Run> {
    const res = await startRuns(s.ctx, REPO, [task]);
    expect(res.error).toBeFalsy();
    const run = s.h.store.listRuns().find((r) => r.task === task)!;
    await until(() => s.state(run.id) === 'running', 2000, 'running');
    return run;
  }

  async function ready(s: S, task: string): Promise<Run> {
    const run = await started(s, task);
    s.h.git.changes.set(run.worktreePath ?? s.h.store.getRun(run.id)!.worktreePath!, ['src/a.ts']);
    s.h.agent.last(run.id).finish(true);
    await until(() => s.state(run.id) === 'ready', 2000, 'ready');
    await s.h.sup.idle();
    return s.h.store.getRun(run.id)!;
  }

  it('starts tasks by path or by a known repo name, and opens a single new task', async () => {
    const s = setup();
    const res = await startRuns(s.ctx, REPO, ['Add night mode']);
    expect(res.text).toMatch(/^Started "Add night mode" in demo/);
    expect(s.screen).toEqual([{ kind: 'show_run', runId: s.h.store.listRuns()[0]!.id }]);
    const two = await startRuns(s.ctx, 'the demo repo', ['Add a score board', 'Fix the tie check']);
    expect(two.text).toMatch(/^Started "Add a score board", "Fix the tie check" in demo/);
    expect(s.h.store.listRuns()).toHaveLength(3);
    expect(s.screen).toHaveLength(1); // fan-out doesn't yank the screen around
  });

  it('asks about unknown repos instead of guessing', async () => {
    const s = setup();
    expect(await resolveRepo(s.ctx, 'tictactoe')).toEqual({ error: expect.stringMatching(/needs to give a full path/) });
    await startRuns(s.ctx, REPO, ['x']);
    expect(await resolveRepo(s.ctx, 'tictactoe')).toEqual({ error: 'I don\'t know a repo called "tictactoe". Known repos: demo.' });
  });

  it('answers a pending question and messages a running agent', async () => {
    const s = setup();
    const run = await started(s, 'Add night mode');
    expect((await answerQuestion(s.ctx, run.id, 'dark')).text).toMatch(/isn't waiting on a question; it's running/);
    s.h.agent.last(run.id).ask('q1', 'Dark or dim?');
    await until(() => s.state(run.id) === 'waiting_input', 2000, 'question');
    expect((await answerQuestion(s.ctx, 'night mode', 'Dim, please')).text).toBe('Answered "Add night mode": "Dim, please". The agent is continuing.');
    await until(() => s.state(run.id) === 'running', 2000, 'answered');
    expect((await messageRun(s.ctx, run.id, 'also add a toggle')).text).toBe('Sent to "Add night mode".');
  });

  it('merges only after the user says yes to the confirmation', async () => {
    const s = setup();
    const run = await ready(s, 'Add night mode');
    const t = s.ctx.transcript;
    talk(t, 'user', 'Merge night mode.');
    const first = await acceptRun(s.ctx, 'night mode', 'merge');
    const token = /confirm_token "(c_[0-9a-f]+)"/.exec(first.text)![1]!;
    expect(first.text).toContain('Ask the user: "Merge "Add night mode" into main?"');
    expect(s.state(run.id)).toBe('ready');
    // Model tries to skip ahead without the user's answer.
    expect((await acceptRun(s.ctx, run.id, 'merge', token)).error).toBe(true);
    expect(s.state(run.id)).toBe('ready');
    talk(t, 'assistant', 'Merge Add night mode into main?');
    talk(t, 'user', 'Yes, go ahead.');
    const done = await acceptRun(s.ctx, run.id, 'merge', token);
    expect(done).toEqual({ text: 'Merged "Add night mode" into main.' });
    expect(s.state(run.id)).toBe('accepted');
  });

  it('does not reject or cancel on a no', async () => {
    const s = setup();
    const run = await ready(s, 'Add night mode');
    const token = /confirm_token "(c_[0-9a-f]+)"/.exec((await rejectRun(s.ctx, run.id)).text)![1]!;
    talk(s.ctx.transcript, 'user', 'No, wait.');
    expect((await rejectRun(s.ctx, run.id, token)).error).toBe(true);
    expect(s.state(run.id)).toBe('ready');

    const live = await started(s, 'Add a score board');
    const c = /confirm_token "(c_[0-9a-f]+)"/.exec((await cancelRun(s.ctx, live.id)).text)![1]!;
    talk(s.ctx.transcript, 'user', 'yes cancel it');
    expect((await cancelRun(s.ctx, live.id, c)).text).toBe('Cancelled "Add a score board".');
    expect(s.state(live.id)).toBe('cancelled');
  });

  it('drives the screen', async () => {
    const s = setup();
    const run = await started(s, 'Add night mode');
    s.screen.length = 0;
    expect((await showRun(s.ctx, 'night')).text).toBe('"Add night mode" is open on screen.');
    showNeeds(s.ctx, true);
    expect(s.screen).toEqual([{ kind: 'show_run', runId: run.id }, { kind: 'show_needs', on: true }]);
  });
});
