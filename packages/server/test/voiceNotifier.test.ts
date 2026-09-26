import { describe, expect, it } from 'vitest';
import type { Run, RunState } from '@conductor/shared';
import { composeNotices, createAttentionWatcher, NoticeGate, type Notice } from '../src/voice/notifier.ts';

const notice = (runId: string, state: RunState = 'waiting_input', title = `Task ${runId}`): Notice => ({ runId, title, state, details: `${title} details` });
const run = (id: string, state: RunState) => ({ id, state, title: `Task ${id}` }) as Run;

function gate(silenceMs = 1500) {
  let now = 0;
  const sent: Notice[][] = [];
  const g = new NoticeGate((n) => sent.push(n), { silenceMs, now: () => now });
  return { g, sent, advance: (ms: number) => { now += ms; g.tick(); } };
}

describe('NoticeGate', () => {
  it('waits for silence, then sends', () => {
    const { g, sent, advance } = gate();
    g.push(notice('a'));
    advance(1000);
    expect(sent).toEqual([]);
    advance(600);
    expect(sent).toEqual([[notice('a')]]);
    advance(5000);
    expect(sent).toHaveLength(1);
  });

  it('never talks over speech: each fragment restarts the silence window', () => {
    const { g, sent, advance } = gate();
    g.push(notice('a'));
    for (let i = 0; i < 5; i++) { advance(1000); g.speech(); }
    expect(sent).toEqual([]);
    advance(1500);
    expect(sent).toHaveLength(1);
  });

  it('holds while a delegation runs, and after its answer starts', () => {
    const { g, sent, advance } = gate();
    g.delegation(1);
    g.push(notice('a'));
    advance(10_000);
    expect(sent).toEqual([]);
    g.delegation(-1);
    advance(1000);
    expect(sent).toEqual([]);
    advance(500);
    expect(sent).toHaveLength(1);
  });

  it('coalesces queued notices, keeps the latest per run, and drops ones that stopped mattering', () => {
    const { g, sent, advance } = gate();
    g.push(notice('a', 'waiting_input'));
    g.push(notice('b', 'ready'));
    g.push(notice('c', 'failed'));
    g.push(notice('a', 'ready'));
    g.update(run('c', 'queued')); // restarted before we said anything
    advance(2000);
    expect(sent).toEqual([[notice('b', 'ready'), notice('a', 'ready')]]);
  });
});

describe('NoticeGate start delay', () => {
  it('holds notices while the session connects', () => {
    let now = 0;
    const sent: Notice[][] = [];
    const g = new NoticeGate((n) => sent.push(n), { silenceMs: 1500, startDelayMs: 2000, now: () => now });
    g.push(notice('a'));
    now = 3000; g.tick();
    expect(sent).toEqual([]);
    now = 3600; g.tick();
    expect(sent).toHaveLength(1);
  });
});

describe('composeNotices', () => {
  it('one notice: one sentence, offer detail', () => {
    const { commentary, thinking } = composeNotices([notice('a', 'waiting_input', 'Add night mode')]);
    expect(commentary).toBe('Notice: "Add night mode" is blocked on a question. Mention it to the user in one short sentence and offer to go into detail. Do not read the details unless asked.');
    expect(thinking).toContain('Add night mode details');
  });

  it('several notices: "Two tasks need you"', () => {
    const { commentary } = composeNotices([notice('a', 'ready', 'Fix slugify'), notice('b', 'conflict', 'Add flag')]);
    expect(commentary).toContain('2 tasks need the user: "Fix slugify" is finished and ready for review; "Add flag" hit a merge conflict.');
    expect(commentary).toContain('"Two tasks need you"');
  });
});

describe('createAttentionWatcher', () => {
  it('fires on entering a needs-you state, once, and not for runs that already needed the user', () => {
    const fired: string[] = [];
    const watch = createAttentionWatcher([{ ...run('old', 'ready'), overlaps: [], task: 'x', repoName: 'r', branch: 'b', activity: '' } as Run],
      (n) => fired.push(`${n.runId}:${n.state}`));
    const full = (id: string, state: RunState) => ({ ...run(id, state), overlaps: [], task: 'x', repoName: 'r', branch: 'b', activity: '' }) as Run;
    watch(full('old', 'ready'));
    watch(full('a', 'queued'));
    watch(full('a', 'running'));
    watch(full('a', 'waiting_input'));
    watch(full('a', 'waiting_input')); // same state again (activity update)
    watch(full('a', 'running'));
    watch(full('a', 'ready'));
    expect(fired).toEqual(['a:waiting_input', 'a:ready']);
  });
});
