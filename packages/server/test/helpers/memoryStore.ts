/** In-memory Store with the same CAS + transition-legality semantics as the SQLite store. */
import { canTransition, type Run, type RunEvent, type RunState } from '@conductor/shared';
import type { NewRun, Store } from '../../src/contracts.ts';

export function createMemoryStore(): Store & { runs: Map<string, Run>; events: RunEvent[]; closed: boolean; testCommands: Map<string, string | null> } {
  const runs = new Map<string, Run>();
  const testCommands = new Map<string, string | null>();
  const events: RunEvent[] = [];
  const meta = new Map<string, string>();
  let seq = 0;
  let clock = 0;
  const now = () => (clock = Math.max(Date.now(), clock + 1));
  const copy = (r: Run): Run => structuredClone(r);
  const s = {
    runs, events, testCommands, closed: false,
    createRun(input: NewRun): Run {
      const id = `r_${(++seq).toString(36).padStart(6, '0')}`;
      const t = now();
      const { testCommand, ...rest } = input;
      const run: Run = {
        id, ...rest, baseCommit: null, worktreePath: null, state: 'queued', activity: '', activityAt: null,
        sessionId: null, attempt: 0, pid: null, pidStartedAt: null, costUsd: 0, turns: 0, error: null, summary: null,
        diffStat: null, tests: null, pendingQuestion: null, overlaps: [], createdAt: t, startedAt: null, finishedAt: null, updatedAt: t,
      };
      runs.set(id, run);
      testCommands.set(id, testCommand);
      return copy(run);
    },
    getRun: (id: string) => (runs.has(id) ? copy(runs.get(id)!) : null),
    listRuns: (opts?: { includeTerminal?: boolean }) =>
      [...runs.values()].filter((r) => opts?.includeTerminal !== false || !['accepted', 'rejected'].includes(r.state)).map(copy).reverse(),
    listByState: (states: readonly RunState[]) => [...runs.values()].filter((r) => states.includes(r.state)).map(copy).reverse(),
    getTestCommand: (id: string) => testCommands.get(id) ?? null,
    transition(id: string, from: RunState | readonly RunState[], to: RunState, patch: Partial<Run> = {}): Run | null {
      if (s.closed) throw new Error('store closed');
      const list = typeof from === 'string' ? [from] : from;
      for (const f of list) if (!canTransition(f, to)) throw new Error(`illegal transition ${f} → ${to} for run ${id}`);
      const run = runs.get(id);
      if (!run || !list.includes(run.state)) return null;
      const prev = run.state;
      const { id: _i, state: _s, createdAt: _c, updatedAt: _u, ...p } = patch;
      Object.assign(run, structuredClone(p), { state: to, updatedAt: now() });
      s.appendEvent(id, 'state', `${prev} → ${to}`, { from: prev, to });
      return copy(run);
    },
    patch(id: string, patch: Partial<Run>): Run {
      if (s.closed) throw new Error('store closed');
      const run = runs.get(id);
      if (!run) throw new Error(`run ${id} not found`);
      const { id: _i, state: _s, createdAt: _c, updatedAt: _u, ...p } = patch;
      Object.assign(run, structuredClone(p), { updatedAt: now() });
      return copy(run);
    },
    appendEvent(runId: string, kind: RunEvent['kind'], text: string, data?: unknown): RunEvent {
      if (s.closed) throw new Error('store closed');
      const ev: RunEvent = { id: events.length + 1, runId, ts: Date.now(), kind, text, ...(data !== undefined ? { data } : {}) };
      events.push(ev);
      return structuredClone(ev);
    },
    listEvents: (runId: string, afterId = 0, limit = 1000) => events.filter((e) => e.runId === runId && e.id > afterId).slice(0, limit).map((e) => structuredClone(e)),
    getMeta: (k: string) => meta.get(k) ?? null,
    setMeta: (k: string, v: string) => void meta.set(k, v),
    close() {
      s.closed = true;
    },
  };
  return s as Store & typeof s;
}
