/**
 * Dev-only in-browser fake backend. Enabled with `?mock` in the URL.
 * Covers every interesting state and simulates live activity.
 * `window.conductorMock.drop(ms)` simulates the server dying for `ms` (default 6s).
 */
import type {
  CreateRunBody, FileDiff, RepoInfo, Run, RunDiff, RunEvent, RunState, StreamEvent, SystemInfo,
} from '@conductor/shared';
import { isLive } from '@conductor/shared';
import { ApiError, type DataSource, type StreamHandlers } from './api.ts';

const MIN = 60_000;
const now0 = Date.now();
const ago = (m: number) => now0 - m * MIN;

function base(id: string, over: Partial<Run>): Run {
  const task = over.task ?? 'Do the thing';
  return {
    id, repoPath: '/Users/dev/code/acme-api', repoName: 'acme-api', task,
    title: task.split('\n')[0]!.slice(0, 80), baseBranch: 'main', baseCommit: '4f1c2a9',
    branch: `conductor/${id}`, worktreePath: `/Users/dev/.conductor/worktrees/${id}`,
    state: 'running', activity: '', activityAt: now0, sessionId: 'sess_' + id, attempt: 1,
    pid: 4242, pidStartedAt: ago(10), costUsd: 0, turns: 0, error: null, summary: null,
    diffStat: null, tests: null, pendingQuestion: null, overlaps: [],
    createdAt: ago(20), startedAt: ago(20), finishedAt: null, updatedAt: now0, ...over,
  };
}

const PARSER_PATCH = `diff --git a/src/parser.ts b/src/parser.ts
index 3b18e51..a9c4f02 100644
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -12,14 +12,22 @@ import { Token, TokenKind } from './lexer';
 export interface ParseOptions {
   strict?: boolean;
+  /** Maximum nesting depth before we bail out with a clear error. */
+  maxDepth?: number;
 }
 
-export function parse(tokens: Token[], opts: ParseOptions = {}): Node {
-  const p = new Parser(tokens, opts.strict ?? false);
-  return p.parseExpression();
+export function parse(tokens: Token[], opts: ParseOptions = {}): Node {
+  const p = new Parser(tokens, {
+    strict: opts.strict ?? false,
+    maxDepth: opts.maxDepth ?? 256,
+  });
+  const node = p.parseExpression();
+  p.expectEnd();
+  return node;
 }
 
 class Parser {
   private pos = 0;
-  constructor(private tokens: Token[], private strict: boolean) {}
+  private depth = 0;
+  constructor(private tokens: Token[], private opts: Required<ParseOptions>) {}
 
   parseExpression(): Node {
@@ -58,7 +66,16 @@ class Parser {
   private parseGroup(): Node {
     this.expect(TokenKind.LParen);
-    const inner = this.parseExpression();
+    if (++this.depth > this.opts.maxDepth) {
+      throw new ParseError(\`nesting deeper than \${this.opts.maxDepth}\`, this.peek());
+    }
+    const inner = this.parseExpression();
+    this.depth--;
     this.expect(TokenKind.RParen);
     return inner;
   }
+
+  expectEnd(): void {
+    if (this.pos < this.tokens.length) throw new ParseError('unexpected trailing input', this.peek());
+  }
 }
`;

const TEST_PATCH = `diff --git a/test/parser.test.ts b/test/parser.test.ts
new file mode 100644
index 0000000..77ab1c3
--- /dev/null
+++ b/test/parser.test.ts
@@ -0,0 +1,18 @@
+import { describe, expect, it } from 'vitest';
+import { lex } from '../src/lexer';
+import { parse } from '../src/parser';
+
+describe('parse', () => {
+  it('rejects trailing input', () => {
+    expect(() => parse(lex('1 + 2 )'))).toThrow(/trailing input/);
+  });
+
+  it('limits nesting depth', () => {
+    const deep = '('.repeat(300) + '1' + ')'.repeat(300);
+    expect(() => parse(lex(deep))).toThrow(/nesting deeper than 256/);
+  });
+
+  it('honours a custom maxDepth', () => {
+    expect(() => parse(lex('((1))'), { maxDepth: 1 })).toThrow();
+  });
+});
`;

const README_PATCH = `diff --git a/README.md b/README.md
index 1d2e3f4..5a6b7c8 100644
--- a/README.md
+++ b/README.md
@@ -40,6 +40,8 @@ const ast = parse(lex(src));
 
 ### Options
 
-- \`strict\` — reject deprecated syntax.
+- \`strict\` — reject deprecated syntax.
+- \`maxDepth\` — maximum nesting depth (default 256). Inputs nested deeper
+  throw a \`ParseError\` instead of overflowing the stack.
 
 ## License
`;

function bigPatch(): string {
  const lines = ['diff --git a/src/generated/schema.ts b/src/generated/schema.ts', 'index 0000000..1111111 100644',
    '--- a/src/generated/schema.ts', '+++ b/src/generated/schema.ts', '@@ -1,6 +1,460 @@'];
  lines.push(' // AUTO-GENERATED. Do not edit.', '-export const VERSION = 3;', '+export const VERSION = 4;');
  for (let i = 0; i < 457; i++) lines.push(`+export const field_${i} = { name: 'field_${i}', type: '${i % 3 ? 'string' : 'number'}' } as const;`);
  lines.push(' ', ' export default {};');
  return lines.join('\n') + '\n';
}

const DIFFS: Record<string, FileDiff[]> = {
  r_ready1: [
    { path: 'src/parser.ts', status: 'modified', insertions: 21, deletions: 5, patch: PARSER_PATCH },
    { path: 'test/parser.test.ts', status: 'added', insertions: 18, deletions: 0, patch: TEST_PATCH },
    { path: 'README.md', status: 'modified', insertions: 3, deletions: 1, patch: README_PATCH },
  ],
  r_fail2: [
    { path: 'src/generated/schema.ts', status: 'modified', insertions: 458, deletions: 1, patch: bigPatch() },
    { path: 'src/db/migrate.ts', oldPath: 'src/db/migrations.ts', status: 'renamed', insertions: 2, deletions: 2,
      patch: `diff --git a/src/db/migrations.ts b/src/db/migrate.ts\nsimilarity index 94%\nrename from src/db/migrations.ts\nrename to src/db/migrate.ts\n--- a/src/db/migrations.ts\n+++ b/src/db/migrate.ts\n@@ -1,4 +1,4 @@\n-import { schema } from '../generated/schema';\n+import schema from '../generated/schema';\n export async function migrate(db: Db) {\n-  await db.apply(schema.v3);\n+  await db.apply(schema.v4);\n }\n` },
    { path: 'src/legacy/v2.ts', status: 'deleted', insertions: 0, deletions: 3,
      patch: `diff --git a/src/legacy/v2.ts b/src/legacy/v2.ts\ndeleted file mode 100644\n--- a/src/legacy/v2.ts\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-export function upgradeV2() {\n-  throw new Error('unsupported');\n-}\n` },
  ],
  r_conf3: [
    { path: 'src/parser.ts', status: 'modified', insertions: 6, deletions: 2,
      patch: `diff --git a/src/parser.ts b/src/parser.ts\n--- a/src/parser.ts\n+++ b/src/parser.ts\n@@ -30,6 +30,10 @@ class Parser {\n   parseExpression(): Node {\n-    return this.parseBinary(0);\n+    const start = this.pos;\n+    const node = this.parseBinary(0);\n+    node.span = [start, this.pos];\n+    return node;\n   }\n` },
    { path: 'src/ast.ts', status: 'modified', insertions: 4, deletions: 0,
      patch: `diff --git a/src/ast.ts b/src/ast.ts\n--- a/src/ast.ts\n+++ b/src/ast.ts\n@@ -1,5 +1,9 @@\n export interface Node {\n   kind: string;\n+  /** [start, end) token offsets, for error messages. */\n+  span?: [number, number];\n }\n+\n+export type Span = [number, number];\n` },
  ],
};

function statOf(files: FileDiff[]) {
  return {
    files: files.length,
    insertions: files.reduce((a, f) => a + f.insertions, 0),
    deletions: files.reduce((a, f) => a + f.deletions, 0),
    paths: files.map((f) => f.path),
  };
}

function seedRuns(): Run[] {
  return [
    base('r_wait1', {
      task: 'Add rate limiting to the public /v1/search endpoint\n\nUse a token bucket per API key. Limits should be configurable per plan. Return 429 with Retry-After.',
      state: 'waiting_input', activity: 'Asked: which store should back the rate limiter?', activityAt: ago(3),
      costUsd: 0.84, turns: 14, createdAt: ago(26), startedAt: ago(25),
      pendingQuestion: {
        id: 'q_1', askedAt: ago(3),
        question: 'Should the rate limiter state live in Redis (shared across instances) or in-process memory (simpler, but per-instance)? The repo already has an ioredis client in src/cache.ts.',
        options: ['Redis (shared)', 'In-process memory', 'Make it pluggable, default memory'],
      },
      diffStat: { files: 2, insertions: 64, deletions: 3, paths: ['src/middleware/rateLimit.ts', 'src/routes/search.ts'] },
    }),
    base('r_conf3', {
      task: 'Track source spans on AST nodes so parse errors can point at the exact token',
      state: 'conflict', activity: 'Merge into main failed', activityAt: ago(6),
      error: 'Merge conflict in 2 files: src/parser.ts, src/ast.ts', costUsd: 1.12, turns: 22,
      createdAt: ago(80), startedAt: ago(79), finishedAt: ago(12),
      summary: 'Added an optional `span` to `Node` and populated it in `parseExpression`.\n\n- `src/ast.ts`: new `Span` type\n- `src/parser.ts`: records start/end token offsets',
      diffStat: statOf(DIFFS.r_conf3!), tests: { command: 'pnpm test', passed: true, exitCode: 0, durationMs: 8420, output: ' ✓ test/ast.test.ts (4)\n\n Test Files  6 passed (6)\n      Tests  41 passed (41)' },
      overlaps: [{ runId: 'r_ready1', title: 'Harden the expression parser against deep nesting and trailing input', paths: ['src/parser.ts'] }],
    }),
    base('r_fail2', {
      task: 'Regenerate the DB schema for v4 and migrate callers off the legacy v2 upgrader',
      state: 'ready', activity: 'Tests failed (2 of 57)', activityAt: ago(9), costUsd: 2.31, turns: 38,
      createdAt: ago(70), startedAt: ago(69), finishedAt: ago(9),
      summary: 'Regenerated `src/generated/schema.ts` for v4 and renamed `migrations.ts` → `migrate.ts`.\n\nTwo tests in `test/migrate.test.ts` still fail: they assert on the v3 table list. I was not sure whether to update the fixtures or keep v3 compatibility, so I left them failing.',
      diffStat: statOf(DIFFS.r_fail2!),
      tests: { command: 'pnpm test', passed: false, exitCode: 1, durationMs: 12930,
        output: ' ✓ test/parser.test.ts (12)\n ✓ test/lexer.test.ts (19)\n ❯ test/migrate.test.ts (6)\n   × applies v4 schema to empty db\n     → expected [ \'users\', \'orgs\' ] to deeply equal [ \'users\', \'orgs\', \'api_keys\' ]\n   × is idempotent\n     → expected 3 tables, received 2\n\n Test Files  1 failed | 5 passed (6)\n      Tests  2 failed | 55 passed (57)\n   Duration  12.93s' },
    }),
    base('r_stale4', {
      task: 'Upgrade to TypeScript 5.6 and fix the resulting type errors across packages/',
      state: 'running', activity: 'Running pnpm -r typecheck', activityAt: ago(9), costUsd: 1.47, turns: 27,
      createdAt: ago(45), startedAt: ago(44),
      diffStat: { files: 11, insertions: 88, deletions: 61, paths: [] },
    }),
    base('r_int5', {
      repoPath: '/Users/dev/code/web-app', repoName: 'web-app',
      task: 'Replace moment.js with date-fns in the billing pages',
      state: 'interrupted', activity: 'Edit src/billing/Invoice.tsx', activityAt: ago(38), costUsd: 0.52, turns: 9,
      pid: null, createdAt: ago(60), startedAt: ago(58), attempt: 1,
      error: 'Conductor stopped while this run was live. Its worktree and session are intact — Resume to continue where it left off.',
      diffStat: { files: 3, insertions: 22, deletions: 19, paths: [] },
    }),
    base('r_ready1', {
      task: 'Harden the expression parser against deep nesting and trailing input\n\nRight now `parse("((((…")` blows the stack and `parse("1 + 2 )")` silently ignores the trailing paren. Add a configurable max depth and reject trailing input. Add tests.',
      state: 'ready', activity: 'Tests passed', activityAt: ago(2), costUsd: 0.97, turns: 19,
      createdAt: ago(40), startedAt: ago(39), finishedAt: ago(2),
      summary: 'The parser now rejects trailing input and enforces a configurable nesting limit.\n\n- Added `maxDepth` to `ParseOptions` (default **256**); exceeding it throws a `ParseError` with the offending token\n- `parse()` now calls `expectEnd()` so `1 + 2 )` is an error instead of being silently truncated\n- Added `test/parser.test.ts` covering both cases\n- Documented `maxDepth` in the README\n\nNo public API was removed; callers that relied on trailing input being ignored will now get an error.',
      diffStat: statOf(DIFFS.r_ready1!),
      tests: { command: 'pnpm test', passed: true, exitCode: 0, durationMs: 6310, output: ' ✓ test/lexer.test.ts (19)\n ✓ test/parser.test.ts (15)\n\n Test Files  6 passed (6)\n      Tests  60 passed (60)\n   Duration  6.31s' },
      overlaps: [{ runId: 'r_conf3', title: 'Track source spans on AST nodes so parse errors can point at the exact token', paths: ['src/parser.ts'] }],
    }),
    base('r_run6', {
      repoPath: '/Users/dev/code/web-app', repoName: 'web-app',
      task: 'Add a dark-mode toggle to the settings page and persist the choice',
      state: 'running', activity: 'Edit src/settings/Appearance.tsx', activityAt: now0 - 8000, costUsd: 0.31, turns: 7,
      createdAt: ago(6), startedAt: ago(6),
      diffStat: { files: 2, insertions: 41, deletions: 4, paths: [] },
    }),
    base('r_test8', {
      task: 'Add OpenTelemetry spans around every outbound HTTP call in src/clients',
      state: 'testing', activity: 'Running pnpm test', activityAt: now0 - 20_000, costUsd: 0.66, turns: 12,
      createdAt: ago(15), startedAt: ago(14),
      diffStat: { files: 4, insertions: 57, deletions: 8, paths: [] },
    }),
    base('r_q7', {
      task: 'Write a CLI command `acme export --since` that dumps audit logs as NDJSON',
      state: 'queued', activity: 'Waiting for a free slot (4 of 4 in use)', activityAt: null, pid: null,
      sessionId: null, worktreePath: null, startedAt: null, createdAt: ago(1),
    }),
    base('r_acc9', {
      task: 'Fix flaky retry test in test/http.test.ts',
      state: 'accepted', activity: 'Merged into main', activityAt: ago(95), costUsd: 0.22, turns: 5, pid: null,
      createdAt: ago(130), startedAt: ago(129), finishedAt: ago(100), worktreePath: null,
      diffStat: { files: 1, insertions: 3, deletions: 7, paths: ['test/http.test.ts'] },
      tests: { command: 'pnpm test', passed: true, exitCode: 0, durationMs: 5100, output: 'ok' },
      summary: 'Replaced the real timer with fake timers.',
    }),
    base('r_rej10', {
      task: 'Try rewriting the lexer with a regex table',
      state: 'rejected', activity: 'Rejected', activityAt: ago(200), costUsd: 0.4, turns: 8, pid: null,
      createdAt: ago(240), startedAt: ago(239), finishedAt: ago(210), worktreePath: null,
    }),
  ];
}

const ACTIVITY_SCRIPT: Record<string, string[]> = {
  r_run6: [
    'Read src/settings/index.tsx', 'Grep "prefers-color-scheme"', 'Edit src/theme/ThemeProvider.tsx',
    'Write src/settings/Appearance.tsx', 'Bash pnpm tsc --noEmit', 'Edit src/settings/Appearance.tsx',
    'Thinking: persisting to localStorage under "theme"', 'Edit src/App.tsx',
  ],
  r_test8: ['Running pnpm test', 'Running pnpm test — 31/57 passed so far', 'Running pnpm test — 49/57 passed so far'],
};

function seedEvents(run: Run): RunEvent[] {
  let id = 1;
  const t0 = run.startedAt ?? run.createdAt;
  const ev = (dt: number, kind: RunEvent['kind'], text: string): RunEvent => ({ id: id++, runId: run.id, ts: t0 + dt, kind, text });
  const out: RunEvent[] = [
    ev(0, 'system', `Worktree created at ${run.worktreePath ?? '(cleaned up)'} from ${run.baseBranch}@${run.baseCommit}`),
    ev(1000, 'state', 'queued → starting'),
    ev(3000, 'state', 'starting → running'),
    ev(8000, 'text', 'I\'ll start by reading the relevant files to understand the current structure.'),
    ev(12000, 'tool', 'Read src/index.ts'),
    ev(15000, 'tool', 'Grep "export function" src/'),
    ev(40000, 'tool', 'Edit src/parser.ts'),
    ev(70000, 'text', 'The core change is in place. Now adding tests.'),
    ev(90000, 'tool', 'Bash pnpm vitest run test/parser.test.ts'),
  ];
  if (run.pendingQuestion) {
    out.push({ id: id++, runId: run.id, ts: run.pendingQuestion.askedAt - 20000, kind: 'text', text: 'There are two reasonable places to keep limiter state and they have different operational trade-offs.' });
    out.push({ id: id++, runId: run.id, ts: run.pendingQuestion.askedAt, kind: 'question', text: run.pendingQuestion.question });
    out.push({ id: id++, runId: run.id, ts: run.pendingQuestion.askedAt, kind: 'state', text: 'running → waiting_input' });
  }
  if (run.tests) out.push(ev(120000, 'test', `${run.tests.command} ${run.tests.passed ? 'passed' : 'failed'} in ${(run.tests.durationMs / 1000).toFixed(1)}s`));
  if (run.error) out.push({ id: id++, runId: run.id, ts: run.activityAt ?? now0, kind: 'error', text: run.error });
  return out.sort((a, b) => a.ts - b.ts).map((e, i) => ({ ...e, id: i + 1 }));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createMockSource(): DataSource {
  const runs = new Map<string, Run>(seedRuns().map((r) => [r.id, r]));
  const events = new Map<string, RunEvent[]>();
  for (const r of runs.values()) events.set(r.id, seedEvents(r));
  let subscribers: StreamHandlers[] = [];
  let down = false;
  const scriptPos: Record<string, number> = {};

  const system = (): SystemInfo => {
    const all = [...runs.values()];
    return {
      version: '0.1.0-mock', startedAt: ago(180), maxConcurrent: 4,
      liveCount: all.filter((r) => isLive(r.state)).length,
      queuedCount: all.filter((r) => r.state === 'queued').length,
      disk: { worktreeRoot: '/Users/dev/.conductor/worktrees', totalBytes: 6.3 * 1024 ** 3, worktrees: [] },
      recoveredOnBoot: { interrupted: ['r_int5'], orphansKilled: 1, worktreesPruned: 0 },
    };
  };

  const emit = (ev: StreamEvent) => { if (!down) for (const s of subscribers) s.onEvent(ev); };
  const pushEvent = (runId: string, kind: RunEvent['kind'], text: string) => {
    const list = events.get(runId) ?? [];
    const e: RunEvent = { id: (list[list.length - 1]?.id ?? 0) + 1, runId, ts: Date.now(), kind, text };
    list.push(e);
    events.set(runId, list);
    emit({ type: 'event', event: e });
  };
  const update = (id: string, patch: Partial<Run>) => {
    const r = runs.get(id);
    if (!r) throw new ApiError(`No run ${id}`, 404);
    const prevState = r.state;
    const next = { ...r, ...patch, updatedAt: Date.now() };
    runs.set(id, next);
    if (patch.state && patch.state !== prevState) pushEvent(id, 'state', `${prevState} → ${patch.state}`);
    emit({ type: 'run', run: next });
    emit({ type: 'system', system: system() });
    return next;
  };
  const guard = (id: string, allowed: RunState[], verb: string) => {
    const r = runs.get(id);
    if (!r) throw new ApiError(`No run ${id}`, 404);
    if (!allowed.includes(r.state)) throw new ApiError(`Cannot ${verb} a run in state "${r.state}".`, 409);
    return r;
  };
  const call = async <T>(fn: () => T): Promise<T> => {
    await sleep(120);
    if (down) throw new ApiError('Cannot reach conductor server — is it running?', 0);
    return fn();
  };

  // Live simulation.
  setInterval(() => {
    for (const [id, script] of Object.entries(ACTIVITY_SCRIPT)) {
      const r = runs.get(id);
      if (!r || !['running', 'testing'].includes(r.state)) continue;
      const i = (scriptPos[id] = ((scriptPos[id] ?? -1) + 1) % script.length);
      const text = script[i]!;
      const kind: RunEvent['kind'] = text.startsWith('Thinking') ? 'text' : 'tool';
      pushEvent(id, kind, text);
      update(id, { activity: text, activityAt: Date.now(), costUsd: r.costUsd + 0.01 + Math.random() * 0.02, turns: r.turns + 1 });
    }
  }, 3500);

  const src: DataSource = {
    listRuns: () => call(() => [...runs.values()]),
    getRun: (id) => call(() => guard(id, [...runs.values()].map((r) => r.state), 'get')),
    events: (id, after) => call(() => (events.get(id) ?? []).filter((e) => after === undefined || e.id > after)),
    diff: (id) => call((): RunDiff => ({ runId: id, base: '4f1c2a9', head: 'b7e0d13', files: DIFFS[id] ?? [] })),
    createRun: (body: CreateRunBody) => call(() => {
      if (!body.task.trim()) throw new ApiError('Task is empty — describe what the agent should do.', 400);
      const id = 'r_' + Math.random().toString(36).slice(2, 8);
      const run = base(id, {
        task: body.task, repoPath: body.repoPath, repoName: body.repoPath.split('/').filter(Boolean).pop() ?? 'repo',
        baseBranch: body.baseBranch ?? 'main', state: 'queued', activity: 'Queued', activityAt: null,
        createdAt: Date.now(), startedAt: null, sessionId: null, pid: null,
      });
      runs.set(id, run);
      events.set(id, [{ id: 1, runId: id, ts: Date.now(), kind: 'system', text: 'Run created' }]);
      emit({ type: 'run', run });
      setTimeout(() => update(id, { state: 'starting', activity: 'Creating worktree', activityAt: Date.now(), startedAt: Date.now() }), 1500);
      setTimeout(() => update(id, { state: 'running', activity: 'Read README.md', activityAt: Date.now() }), 3500);
      return run;
    }),
    answer: (id, questionId, answer) => call(() => {
      const r = guard(id, ['waiting_input'], 'answer');
      if (r.pendingQuestion?.id !== questionId) throw new ApiError('That question was already answered or has expired. Refresh to see the current question.', 409);
      pushEvent(id, 'answer', answer);
      ACTIVITY_SCRIPT[id] = ['Edit src/middleware/rateLimit.ts', 'Read src/cache.ts', 'Bash pnpm vitest run rateLimit'];
      return update(id, { state: 'running', pendingQuestion: null, activity: 'Continuing with: ' + answer, activityAt: Date.now() });
    }),
    message: (id, text) => call(() => {
      const r = guard(id, ['running', 'waiting_input', 'testing', 'starting'], 'message');
      pushEvent(id, 'answer', text);
      return update(id, { activity: 'Read your message', activityAt: Date.now(), turns: r.turns });
    }),
    cancel: (id) => call(() => { guard(id, ['queued', 'starting', 'running', 'waiting_input', 'testing'], 'cancel'); return update(id, { state: 'cancelled', activity: 'Cancelled by you', pid: null, pendingQuestion: null }); }),
    restart: (id) => call(() => {
      const r = guard(id, ['interrupted', 'failed', 'cancelled'], 'restart');
      setTimeout(() => update(id, { state: 'starting', activity: r.sessionId ? 'Resuming session' : 'Starting', activityAt: Date.now() }), 1200);
      setTimeout(() => update(id, { state: 'running', activity: 'Read src/billing/Invoice.tsx', activityAt: Date.now() }), 2600);
      return update(id, { state: 'queued', error: null, attempt: r.attempt + 1, activity: 'Queued for restart' });
    }),
    accept: (id, mode) => call(() => {
      guard(id, ['ready', 'conflict'], 'accept');
      const r = update(id, { state: 'accepting', activity: mode === 'merge' ? 'Merging into main' : 'Keeping branch' });
      setTimeout(() => update(id, { state: 'accepted', activity: mode === 'merge' ? 'Merged into main' : `Kept branch ${r.branch}`, finishedAt: Date.now(), error: null }), 1200);
      return r;
    }),
    reject: (id) => call(() => { guard(id, ['ready', 'conflict', 'failed', 'cancelled', 'interrupted'], 'reject'); return update(id, { state: 'rejected', activity: 'Rejected — branch and worktree removed' }); }),
    inspectRepo: (path) => call((): RepoInfo => {
      const name = path.split('/').filter(Boolean).pop() ?? '';
      if (!path.startsWith('/')) return { path, name, isGitRepo: false, currentBranch: null, branches: [], dirty: false, detectedTestCommand: null, error: 'Path must be absolute.' };
      if (name.includes('not')) return { path, name, isGitRepo: false, currentBranch: null, branches: [], dirty: false, detectedTestCommand: null, error: `${path} is not a git repository.` };
      return { path, name, isGitRepo: true, currentBranch: 'main', branches: ['main', 'develop', 'release/2.4'], dirty: name.includes('web'), detectedTestCommand: 'pnpm test' };
    }),
    system: () => call(system),
    stream(h) {
      let open = true;
      const tryOpen = () => {
        if (!open) return;
        if (down) { h.onDrop(); return; }
        subscribers.push(h);
        h.onOpen();
      };
      setTimeout(tryOpen, 50);
      return () => { open = false; subscribers = subscribers.filter((s) => s !== h); };
    },
  };

  const w = window as unknown as { conductorMock?: unknown };
  w.conductorMock = {
    drop(ms = 6000) {
      down = true;
      const subs = subscribers;
      subscribers = [];
      for (const s of subs) s.onDrop();
      setTimeout(() => { down = false; }, ms);
    },
  };
  return src;
}
