/**
 * What the voice orchestrator can see and do, as plain functions over the store and
 * supervisor. The SDK tool wrappers in orchestrator.ts only adapt these. Output is short,
 * factual text meant to be summarized aloud, never read verbatim.
 */
import { needsAttention, sortByAttention, type Run, type RunState } from '@conductor/shared';
import type { Store } from '../contracts.ts';

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
