import { describe, expect, it } from 'vitest';
import type { Run } from '@conductor/shared';
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { createOrchestrator } from '../src/voice/orchestrator.ts';
import { describeRun, listRuns, resolveRun } from '../src/voice/tools.ts';
import { Transcript } from '../src/voice/transcript.ts';
import { createMemoryStore } from './helpers/index.ts';

const NOW = 1_800_000_000_000;

function storeWith(...runs: Partial<Run>[]) {
  const store = createMemoryStore();
  for (const r of runs) {
    const base = store.createRun({ repoPath: `/repos/${r.repoName ?? 'demo'}`, repoName: r.repoName ?? 'demo', task: r.title ?? 'task', title: r.title ?? 'task', baseBranch: 'main', branch: 'b', testCommand: null });
    store.runs.delete(base.id);
    store.runs.set(r.id ?? base.id, { ...base, activityAt: NOW - 60_000, ...r, id: r.id ?? base.id });
  }
  return store;
}

const quiet = { info() {}, warn() {}, error() {} };

describe('voice tools', () => {
  const store = storeWith(
    { id: 'r_night', title: 'Add night mode', repoName: 'tictactoe', state: 'waiting_input', pendingQuestion: { id: 'q1', question: 'Dark or dim?', options: ['Dark', 'Dim'], askedAt: NOW - 120_000 } },
    { id: 'r_score', title: 'Add a score board', repoName: 'tictactoe', state: 'running', activity: 'Editing src/score.js' },
    { id: 'r_slug', title: 'Fix slugify unicode', repoName: 'sample-app', state: 'ready', diffStat: { files: 2, insertions: 30, deletions: 4, paths: ['src/slugify.js', 'test/slugify.test.js'] }, tests: { command: 'npm test', passed: true, exitCode: 0, durationMs: 900, output: '' }, summary: 'Handled accents.' },
    { id: 'r_old', title: 'Add night mode toggle', repoName: 'tictactoe', state: 'accepted' },
  );

  it('lists active runs most urgent first, with what they are doing', () => {
    expect(listRuns(store, 'active', NOW)).toBe([
      '3 tasks, 2 need the user:',
      '- r_night · "Add night mode" · repo tictactoe · waiting on your answer · asked 2 min ago',
      '- r_slug · "Fix slugify unicode" · repo sample-app · ready for review',
      '- r_score · "Add a score board" · repo tictactoe · running · doing: Editing src/score.js',
    ].join('\n'));
    expect(listRuns(store, 'needs_you', NOW).split('\n')).toHaveLength(3);
    expect(listRuns(storeWith(), 'needs_you', NOW)).toBe('Nothing needs the user right now.');
  });

  it('resolves spoken references by id, title words, or repo', () => {
    const id = (ref: string) => { const r = resolveRun(store, ref, NOW); return 'run' in r ? r.run.id : r.error; };
    expect(id('r_slug')).toBe('r_slug');
    expect(id('the slugify one')).toBe('r_slug');
    expect(id('score board task')).toBe('r_score');
    expect(id('sample app')).toBe('r_slug');
    // A live run wins over a finished one with the same words.
    expect(id('night mode')).toBe('r_night');
  });

  it('asks instead of guessing when a reference is ambiguous or unknown', () => {
    const r = resolveRun(store, 'tictactoe', NOW);
    expect('error' in r && r.error).toMatch(/could mean \d tasks/);
    expect('error' in r && r.error).toContain('Add a score board');
    const none = resolveRun(store, 'database migration', NOW);
    expect('error' in none && none.error).toMatch(/No task matches "database migration"/);
  });

  it('describes a run with its question, changes, and tests', () => {
    const night = describeRun(store.getRun('r_night')!, NOW);
    expect(night).toContain('Question from the agent (2 min ago): Dark or dim?');
    expect(night).toContain('Options: 1) Dark; 2) Dim');
    const slug = describeRun(store.getRun('r_slug')!, NOW);
    expect(slug).toContain('is ready for review');
    expect(slug).toContain('Changes: 2 files, +30 −4 (src/slugify.js, test/slugify.test.js).');
    expect(slug).toContain('Tests: `npm test` passed.');
    expect(slug).toContain("Agent's summary: Handled accents.");
  });
});

/** Fake SDK query: records prompts, answers each user turn with a result after `delay`. */
function fakeQuery(reply: (prompt: string, n: number) => string, delay = 5) {
  const prompts: string[] = [];
  const calls: unknown[] = [];
  let closed = false;
  const q = ((args: { prompt: AsyncIterable<SDKUserMessage>; options: unknown }) => {
    calls.push(args.options);
    async function* run(): AsyncGenerator<SDKMessage> {
      for await (const m of args.prompt) {
        const p = String(m.message.content);
        prompts.push(p);
        await new Promise((r) => setTimeout(r, delay));
        yield { type: 'result', subtype: 'success', is_error: false, result: ` ${reply(p, prompts.length)} ` } as unknown as SDKMessage;
      }
    }
    return Object.assign(run(), { close() { closed = true; } });
  }) as never;
  return { q, prompts, calls, isClosed: () => closed };
}

function request(sessionId: string, said: string) {
  const transcript = new Transcript();
  transcript.add('user', { delta: said, start_ms: 0, end_ms: 500 });
  return { sessionId, delegationId: 'item_1', offsetMs: 900, transcript };
}

describe('orchestrator', () => {
  const store = storeWith({ id: 'r_night', title: 'Add night mode', repoName: 'tictactoe', state: 'waiting_input', pendingQuestion: { id: 'q1', question: 'Dark or dim?', askedAt: NOW } });

  it('starts one agent per voice session with only the conductor tools', async () => {
    const f = fakeQuery(() => 'ok');
    const o = createOrchestrator({ store, log: quiet, query: f.q });
    o.open!('live_1');
    await o.delegate(request('live_1', 'hi'));
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toMatchObject({ tools: [], allowedTools: ['mcp__conductor__list_runs', 'mcp__conductor__describe_run'], settingSources: [] });
    o.close!('live_1');
    expect(f.isClosed()).toBe(true);
  });

  it('sends the transcript and task snapshot, and returns the trimmed result', async () => {
    const f = fakeQuery(() => 'Night mode is waiting on you.');
    const o = createOrchestrator({ store, log: quiet, query: f.q });
    expect(await o.delegate(request('live_2', 'What needs me?'))).toBe('Night mode is waiting on you.');
    expect(f.prompts[0]).toContain('<transcript>\nuser: What needs me?\n</transcript>');
    expect(f.prompts[0]).toContain('r_night · "Add night mode" · repo tictactoe · waiting on your answer');
    o.close!('live_2');
  });

  it('runs overlapping delegations one at a time, in order', async () => {
    const f = fakeQuery((_p, n) => `answer ${n}`, 20);
    const o = createOrchestrator({ store, log: quiet, query: f.q });
    const [a, b] = await Promise.all([o.delegate(request('live_3', 'first')), o.delegate(request('live_3', 'second'))]);
    expect([a, b]).toEqual(['answer 1', 'answer 2']);
    expect(f.prompts.map((p) => p.includes('first') ? 'first' : 'second')).toEqual(['first', 'second']);
    o.close!('live_3');
  });

  it('replaces an agent that died', async () => {
    let n = 0;
    const q = ((args: { prompt: AsyncIterable<SDKUserMessage> }) => {
      n++;
      const first = n === 1;
      async function* run(): AsyncGenerator<SDKMessage> {
        for await (const _m of args.prompt) {
          if (first) throw new Error('CLI crashed');
          yield { type: 'result', subtype: 'success', is_error: false, result: 'back' } as unknown as SDKMessage;
        }
      }
      return Object.assign(run(), { close() {} });
    }) as never;
    const o = createOrchestrator({ store, log: quiet, query: q });
    await expect(o.delegate(request('live_4', 'x'))).rejects.toThrow('CLI crashed');
    expect(await o.delegate(request('live_4', 'x'))).toBe('back');
    expect(n).toBe(2);
    o.close!('live_4');
  });
});
