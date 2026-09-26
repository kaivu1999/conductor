import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import type { AgentEvent } from '../src/contracts.ts';
import { describeToolUse, firstSentence, normalizeText, resultErrorMessage, relPath, ASK_TOOL_NAME } from '../src/agent/activity.ts';
import { createFakeAdapter, createClaudeAdapter, createAdapterFromEnv, findRunProcesses, killRunProcesses, type FakeScript } from '../src/agent/index.ts';
import { readUserSettings } from '../src/agent/auth.ts';
import { AsyncQueue } from '../src/agent/queue.ts';

const CWD = '/work/repo';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'conductor-agent-'));
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const until = async (cond: () => boolean, ms = 5000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
};

// ─── activity.ts ─────────────────────────────────────────────────────────────

describe('describeToolUse', () => {
  const cases: [string, Record<string, unknown>, string, string][] = [
    ['Read', { file_path: '/work/repo/src/foo.ts' }, 'Reading src/foo.ts', 'Read src/foo.ts'],
    ['Read', { file_path: 'src/rel.ts' }, 'Reading src/rel.ts', 'Read src/rel.ts'],
    ['Read', { file_path: '/etc/hosts' }, 'Reading /etc/hosts', 'Read /etc/hosts'],
    ['Edit', { file_path: '/work/repo/src/foo.ts' }, 'Editing src/foo.ts', 'Edit src/foo.ts'],
    ['MultiEdit', { file_path: '/work/repo/a.ts' }, 'Editing a.ts', 'Edit a.ts'],
    ['NotebookEdit', { notebook_path: '/work/repo/nb.ipynb' }, 'Editing nb.ipynb', 'Edit nb.ipynb'],
    ['Write', { file_path: '/work/repo/src/new.ts' }, 'Writing src/new.ts', 'Write src/new.ts'],
    ['Bash', { command: 'npm test' }, 'Running `npm test`', 'Run `npm test`'],
    ['Bash', { command: 'npm   test\n  --silent' }, 'Running `npm test --silent`', 'Run `npm test --silent`'],
    ['Bash', { command: 'npm test', description: 'Run tests' }, 'Running tests', 'Run `npm test`'],
    ['Bash', { command: 'pnpm i', description: 'Install dependencies' }, 'Install dependencies', 'Run `pnpm i`'],
    ['Grep', { pattern: 'TODO\\(' }, 'Searching for `TODO\\(`', 'Search `TODO\\(`'],
    ['Glob', { pattern: '**/*.ts' }, 'Finding files `**/*.ts`', 'Find files `**/*.ts`'],
    ['WebFetch', { url: 'https://example.com/docs/x' }, 'Fetching example.com', 'Fetch https://example.com/docs/x'],
    ['WebSearch', { query: 'vitest mock timers' }, 'Searching the web: vitest mock timers', 'Web search: vitest mock timers'],
    [
      'TodoWrite',
      { todos: [{ content: 'Plan', status: 'completed' }, { content: 'Fix the parser', status: 'in_progress' }] },
      'Working on: Fix the parser',
      'Todo: Fix the parser',
    ],
    ['TodoWrite', { todos: [{ content: 'Plan', status: 'pending' }] }, 'Updating the plan', 'Update todos (1)'],
    ['Task', { description: 'Explore auth code', prompt: '…' }, 'Delegating: Explore auth code', 'Delegate: Explore auth code'],
    ['Agent', { description: 'Review diff' }, 'Delegating: Review diff', 'Delegate: Review diff'],
    [ASK_TOOL_NAME, { question: 'Which DB?' }, 'Waiting for your answer', 'Ask: Which DB?'],
    ['FooTool', {}, 'Using FooTool', 'Use FooTool'],
    ['mcp__github__create_issue', {}, 'Using create_issue (github)', 'Use create_issue (github)'],
  ];
  it.each(cases)('%s %j', (name, input, activity, summary) => {
    expect(describeToolUse(name, input, CWD)).toEqual({ activity, summary });
  });

  it('truncates long bash commands to ~60 chars', () => {
    const d = describeToolUse('Bash', { command: 'echo ' + 'x'.repeat(200) }, CWD);
    expect(d.activity.length).toBeLessThanOrEqual('Running ``'.length + 60);
    expect(d.activity.endsWith('…`')).toBe(true);
  });

  it('shortens absolute cwd paths inside bash commands', () => {
    expect(describeToolUse('Bash', { command: 'cat /work/repo/src/a.ts && ls /work/repo' }, CWD).activity).toBe('Running `cat src/a.ts && ls .`');
    expect(describeToolUse('Bash', { command: 'cat /work/repository/x' }, CWD).activity).toBe('Running `cat /work/repository/x`');
  });

  it('accepts multiple equivalent roots (macOS /private realpath)', () => {
    expect(describeToolUse('Read', { file_path: '/private/tmp/w/a.ts' }, ['/tmp/w', '/private/tmp/w']).activity).toBe('Reading a.ts');
  });

  it('tolerates garbage input', () => {
    expect(describeToolUse('Read', null, CWD)).toEqual({ activity: 'Reading ', summary: 'Read ' });
    expect(describeToolUse('TodoWrite', { todos: 'nope' }, CWD).activity).toBe('Updating the plan');
  });
});

describe('relPath', () => {
  it.each([
    ['/work/repo/a/b.ts', 'a/b.ts'],
    ['/work/repo', '.'],
    ['/work/repository/x', '/work/repository/x'],
    ['/work/other/x', '/work/other/x'],
    ['rel/x', 'rel/x'],
  ])('%s -> %s', (p, want) => expect(relPath(p, CWD)).toBe(want));
});

describe('text normalization', () => {
  it('normalizeText trims and caps at 500', () => {
    expect(normalizeText('  hi  ')).toBe('hi');
    expect(normalizeText('a'.repeat(900)).length).toBe(500);
    expect(normalizeText('   ')).toBe('');
  });
  it.each([
    ['I will fix the parser. Then tests.', 'I will fix the parser.'],
    ['Done! All good.', 'Done!'],
    ['No terminal punctuation here', 'No terminal punctuation here'],
    ['**Summary**: changed foo.ts. More.', 'Summary : changed foo.ts.'],
    ['Version 1.2.3 is out', 'Version 1.2.3 is out'],
    ['line one\nline two', 'line one line two'],
    ['', ''],
  ])('firstSentence(%j)', (input, want) => expect(firstSentence(input)).toBe(want));
  it('firstSentence caps at 100', () => {
    expect(firstSentence('word '.repeat(60)).length).toBeLessThanOrEqual(100);
  });
});

describe('resultErrorMessage', () => {
  it('success -> null', () => expect(resultErrorMessage({ subtype: 'success', is_error: false, result: 'ok' })).toBeNull());
  it('success + is_error -> API error', () =>
    expect(resultErrorMessage({ subtype: 'success', is_error: true, result: 'overloaded', api_error_status: 529 })).toBe(
      'Agent API error (HTTP 529): overloaded',
    ));
  it('budget', () => expect(resultErrorMessage({ subtype: 'error_max_budget_usd', total_cost_usd: 1.234 })).toBe('Budget exceeded ($1.23 spent)'));
  it('max turns', () => expect(resultErrorMessage({ subtype: 'error_max_turns', num_turns: 30 })).toBe('Hit the max turn limit (30 turns)'));
  it('during execution', () =>
    expect(resultErrorMessage({ subtype: 'error_during_execution', errors: ['boom'] })).toBe('Agent error during execution: boom'));
  it('unknown subtype', () => expect(resultErrorMessage({ subtype: 'weird' })).toBe('Agent stopped: weird'));
});

// ─── small pieces ───────────────────────────────────────────────────────────

describe('AsyncQueue', () => {
  it('delivers pushed items and ends', async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => {
      q.push(2);
      q.end();
      expect(q.push(3)).toBe(false);
    }, 10);
    const got: number[] = [];
    for await (const x of q) got.push(x);
    expect(got).toEqual([1, 2]);
  });
});

describe('readUserSettings', () => {
  it('tolerates missing and invalid files', () => {
    const d = tmp();
    expect(readUserSettings(path.join(d, 'nope.json'))).toEqual({ env: {} });
    fs.writeFileSync(path.join(d, 'bad.json'), '{not json');
    expect(readUserSettings(path.join(d, 'bad.json'))).toEqual({ env: {} });
  });
  it('extracts apiKeyHelper and env', () => {
    const d = tmp();
    fs.writeFileSync(path.join(d, 's.json'), JSON.stringify({ apiKeyHelper: 'x', env: { A: 'b', N: 1 }, hooks: {} }));
    expect(readUserSettings(path.join(d, 's.json'))).toEqual({ apiKeyHelper: 'x', env: { A: 'b', N: '1' } });
  });
});

describe('createAdapterFromEnv', () => {
  it('picks by CONDUCTOR_AGENT', () => {
    expect(createAdapterFromEnv({ CONDUCTOR_AGENT: 'fake' }).name).toBe('fake');
    expect(createAdapterFromEnv({}).name).toBe('claude');
  });
});

// ─── fake adapter ───────────────────────────────────────────────────────────

describe('fake adapter', () => {
  it('runs a full script, emitting events in order and writing files', async () => {
    const cwd = tmp();
    const events: AgentEvent[] = [];
    const script: FakeScript = [
      { activity: 'Reading src/a.ts', delayMs: 20 },
      { writeFile: { path: 'src/a.ts', content: 'export const a = 1;\n' } },
      { text: 'Wrote it. Next step.' },
      { usage: { costUsd: 0.05, turns: 3 } },
      { done: 'Summary: wrote a.ts' },
    ];
    const s = createFakeAdapter(script).start({ runId: 'r1', cwd, task: 't', onEvent: (e) => events.push(e) });
    expect(await s.finished).toEqual({ ok: true });
    expect(events.map((e) => e.type)).toEqual(['process', 'session', 'activity', 'activity', 'tool', 'text', 'activity', 'usage', 'done']);
    expect(events.find((e) => e.type === 'tool')).toEqual({ type: 'tool', name: 'Write', summary: 'Write src/a.ts' });
    expect(events.at(-1)).toEqual({ type: 'done', summary: 'Summary: wrote a.ts', costUsd: 0.05, turns: 3 });
    expect(fs.readFileSync(path.join(cwd, 'src/a.ts'), 'utf8')).toBe('export const a = 1;\n');
    const pid = (events[0] as { pid: number }).pid;
    await until(() => !alive(pid));
  });

  it('ask blocks until answer; wrong id returns false', async () => {
    const cwd = tmp();
    const events: AgentEvent[] = [];
    const s = createFakeAdapter([{ ask: { question: 'Which approach?', options: ['A', 'B'] } }, { done: 'ok' }]).start({
      runId: 'r2',
      cwd,
      task: 't',
      onEvent: (e) => events.push(e),
    });
    await until(() => events.some((e) => e.type === 'question'));
    const q = (events.find((e) => e.type === 'question') as Extract<AgentEvent, { type: 'question' }>).question;
    expect(q.question).toBe('Which approach?');
    expect(q.options).toEqual(['A', 'B']);
    expect(q.id).toMatch(/^q_/);
    await new Promise((r) => setTimeout(r, 50));
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(s.answer('q_wrong', 'A')).toBe(false);
    expect(s.answer(q.id, 'B')).toBe(true);
    expect(s.answer(q.id, 'B')).toBe(false); // already answered
    expect(await s.finished).toEqual({ ok: true });
    expect(events.some((e) => e.type === 'text' && e.text.includes('B'))).toBe(true);
  });

  it('stop mid-run resolves finished {ok:false} and kills the child', async () => {
    const cwd = tmp();
    const events: AgentEvent[] = [];
    const s = createFakeAdapter([{ activity: 'working', delayMs: 10 }, { sleep: true, delayMs: 60_000 }, { done: 'never' }]).start({
      runId: 'r3',
      cwd,
      task: 't',
      onEvent: (e) => events.push(e),
    });
    const pid = (events[0] as { pid: number }).pid;
    expect(alive(pid)).toBe(true);
    await until(() => events.some((e) => e.type === 'activity'));
    await Promise.all([s.stop(), s.stop()]); // idempotent
    expect(await s.finished).toEqual({ ok: false });
    expect(() => process.kill(pid, 0)).toThrow();
    expect(events.some((e) => e.type === 'done')).toBe(false);
    expect(events.filter((e) => e.type === 'error')).toHaveLength(1);
  });

  it('stop while waiting on a question unblocks', async () => {
    const events: AgentEvent[] = [];
    const s = createFakeAdapter([{ ask: 'ok?' }, { done: 'x' }]).start({ runId: 'r4', cwd: tmp(), task: 't', onEvent: (e) => events.push(e) });
    await until(() => events.some((e) => e.type === 'question'));
    await s.stop();
    expect(await s.finished).toEqual({ ok: false });
  });

  it('error step -> error event, ok:false', async () => {
    const events: AgentEvent[] = [];
    const s = createFakeAdapter([{ error: 'Budget exceeded' }]).start({ runId: 'r5', cwd: tmp(), task: 't', onEvent: (e) => events.push(e) });
    expect(await s.finished).toEqual({ ok: false });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Budget exceeded' });
  });
});

// ─── live (opt-in) ──────────────────────────────────────────────────────────

const LIVE = process.env.CONDUCTOR_LIVE === '1';

function gitRepo(): string {
  const d = tmp();
  const git = (...a: string[]) => execFileSync('git', a, { cwd: d, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(d, 'README.md'), '# test\n');
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  git('checkout', '-qb', 'conductor/live1');
  return d;
}

describe.skipIf(!LIVE)('claude adapter (live)', () => {
  it('asks, gets an answer, finishes, writes the file', async () => {
    const cwd = gitRepo();
    const events: AgentEvent[] = [];
    const s = createClaudeAdapter().start({
      runId: 'live1',
      cwd,
      task: "Create hello.txt containing the word hi, then call ask_user asking 'ok?' , then finish.",
      maxBudgetUsd: 1,
      onEvent: (e) => {
        events.push(e);
        if (process.env.CONDUCTOR_LIVE_LOG) console.log(JSON.stringify(e));
        if (e.type === 'question') setTimeout(() => s.answer(e.question.id, 'yes, ok'), 200);
      },
    });
    const res = await s.finished;
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('process');
    expect(types).toContain('session');
    expect(types).toContain('question');
    expect(events.at(-1)?.type).toBe('done');
    expect(res).toEqual({ ok: true });
    expect(fs.readFileSync(path.join(cwd, 'hello.txt'), 'utf8')).toMatch(/hi/);
    const pid = (events[0] as { pid: number }).pid;
    expect(alive(pid)).toBe(false);
  }, 180_000);

  const LONG_TASK =
    'Run exactly this shell command in the foreground (not in the background), with a 5 minute timeout, and then say done: ' +
    '`node -e "setTimeout(()=>{},120000)" && echo finished-waiting`';

  async function startLong(runId: string) {
    const cwd = gitRepo();
    const events: AgentEvent[] = [];
    const s = createClaudeAdapter().start({ runId, cwd, task: LONG_TASK, maxBudgetUsd: 1, onEvent: (e) => events.push(e) });
    // wait until the tool's command is actually running (it carries the run marker)
    await until(() => findRunProcesses(runId).length > 0, 120_000);
    const pid = (events.find((e) => e.type === 'process') as { pid: number }).pid;
    return { s, events, pid };
  }

  it('stop() kills the CLI and its tool subprocesses mid-run', async () => {
    const { s, pid } = await startLong('live2');
    const t0 = Date.now();
    await s.stop();
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(await s.finished).toEqual({ ok: false });
    expect(alive(pid)).toBe(false);
    expect(alive(-pid)).toBe(false); // CLI's group gone
    expect(findRunProcesses('live2')).toEqual([]); // tool processes (own groups) gone too
  }, 180_000);

  it('after a conductor crash, orphans survive a group kill but are found by run marker', async () => {
    // Host the adapter in a separate "conductor" process so we can SIGKILL it for real.
    const cwd = gitRepo();
    const script = path.join(tmp(), 'host.mts');
    const claudeTs = path.resolve(__dirname, '../src/agent/claude.ts');
    fs.writeFileSync(
      script,
      `import { createClaudeAdapter } from ${JSON.stringify(claudeTs)};
       createClaudeAdapter().start({ runId: 'live3', cwd: ${JSON.stringify(cwd)}, task: ${JSON.stringify(LONG_TASK)}, maxBudgetUsd: 1,
         onEvent: (e) => { if (e.type === 'process') console.log('PID ' + e.pid); } });`,
    );
    const tsx = path.resolve(__dirname, '../node_modules/.bin/tsx');
    const host = spawn(tsx, [script], { stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    let out = '';
    host.stdout!.on('data', (d) => (out += d));
    await until(() => /PID \d+/.test(out) && findRunProcesses('live3').length > 1, 120_000);
    const cliPid = Number(/PID (\d+)/.exec(out)![1]);
    process.kill(-host.pid!, 'SIGKILL'); // conductor dies hard
    process.kill(-cliPid, 'SIGKILL'); // supervisor recovery: kill the recorded process group
    await new Promise((r) => setTimeout(r, 500));
    expect(alive(cliPid)).toBe(false);
    const orphans = findRunProcesses('live3');
    expect(orphans.length).toBeGreaterThan(0); // group-kill alone is NOT enough: Bash tool uses its own pgroup
    expect(killRunProcesses('live3')).toBe(orphans.length);
    await until(() => findRunProcesses('live3').length === 0, 5000);
  }, 180_000);
});
