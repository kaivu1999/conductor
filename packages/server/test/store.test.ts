import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../src/store/sqlite.ts';
import type { NewRun, Store } from '../src/contracts.ts';

const input = (over: Partial<NewRun> = {}): NewRun => ({
  repoPath: '/tmp/repo', repoName: 'repo', task: 'Add a thing\nwith details', title: 'Add a thing',
  baseBranch: 'main', branch: 'conductor/x', testCommand: 'npm test', ...over,
});

describe('sqlite store', () => {
  let dir: string;
  let dbPath: string;
  let store: Store;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'conductor-store-'));
    dbPath = join(dir, 'nested', 'conductor.db');
    store = createSqliteStore(dbPath);
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, gets and lists runs', () => {
    const a = store.createRun(input({ title: 'a' }));
    const b = store.createRun(input({ title: 'b' }));
    expect(a.id).toMatch(/^r_[0-9a-z]{6}$/);
    expect(a).toMatchObject({
      state: 'queued', title: 'a', baseCommit: null, worktreePath: null, activity: '', attempt: 0,
      costUsd: 0, turns: 0, diffStat: null, tests: null, pendingQuestion: null, overlaps: [],
    });
    expect(store.getRun(a.id)).toEqual(a);
    expect(store.getRun('r_nope00')).toBeNull();
    expect(store.listRuns().map((r) => r.id)).toEqual([b.id, a.id]);
    expect(store.getTestCommand(a.id)).toBe('npm test');
    expect(store.getTestCommand(store.createRun(input({ testCommand: null })).id)).toBeNull();
  });

  it('performs a legal transition, applies patch, appends a state event', () => {
    const r = store.createRun(input());
    const t = store.transition(r.id, 'queued', 'starting', { attempt: 1, startedAt: 123, worktreePath: '/w' });
    expect(t).toMatchObject({ state: 'starting', attempt: 1, startedAt: 123, worktreePath: '/w' });
    expect(t!.updatedAt).toBeGreaterThan(r.updatedAt);
    const ev = store.listEvents(r.id);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: 'state', text: 'queued → starting' });
  });

  it('throws on an illegal transition and changes nothing', () => {
    const r = store.createRun(input());
    expect(() => store.transition(r.id, 'queued', 'accepted')).toThrow(/illegal transition/);
    expect(() => store.transition(r.id, ['queued', 'ready'], 'starting')).toThrow(/ready → starting/);
    expect(store.getRun(r.id)!.state).toBe('queued');
    expect(store.listEvents(r.id)).toHaveLength(0);
  });

  it('CAS: only one of two transitions from queued wins', () => {
    const r = store.createRun(input());
    const first = store.transition(r.id, 'queued', 'starting');
    const second = store.transition(r.id, 'queued', 'cancelled');
    expect(first?.state).toBe('starting');
    expect(second).toBeNull();
    expect(store.getRun(r.id)!.state).toBe('starting');
    expect(store.listEvents(r.id)).toHaveLength(1);
    expect(store.transition('r_missing', 'queued', 'starting')).toBeNull();
  });

  it('CAS across two connections to the same file', () => {
    const other = createSqliteStore(dbPath);
    try {
      const r = store.createRun(input());
      const results = [store.transition(r.id, 'queued', 'starting'), other.transition(r.id, 'queued', 'cancelled')];
      expect(results.filter(Boolean)).toHaveLength(1);
    } finally {
      other.close();
    }
  });

  it('accepts a list of from-states', () => {
    const r = store.createRun(input());
    store.transition(r.id, 'queued', 'starting');
    expect(store.transition(r.id, ['starting', 'running'], 'failed', { error: 'boom' })).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('patch never changes state, round-trips JSON fields, bumps updatedAt', () => {
    const r = store.createRun(input());
    const p = store.patch(r.id, {
      state: 'accepted', activity: 'Editing src/a.ts', costUsd: 0.25,
      diffStat: { files: 1, insertions: 2, deletions: 3, paths: ['a'] },
      pendingQuestion: { id: 'q1', question: 'which?', options: ['x', 'y'], askedAt: 5 },
      overlaps: [{ runId: 'r_other1', title: 't', paths: ['a'] }],
    } as never);
    expect(p.state).toBe('queued');
    expect(p.activity).toBe('Editing src/a.ts');
    expect(p.diffStat).toEqual({ files: 1, insertions: 2, deletions: 3, paths: ['a'] });
    expect(p.pendingQuestion?.options).toEqual(['x', 'y']);
    expect(p.overlaps).toHaveLength(1);
    expect(p.updatedAt).toBeGreaterThan(r.updatedAt);
    expect(store.patch(r.id, { pendingQuestion: null }).pendingQuestion).toBeNull();
    expect(() => store.patch('r_missing', { activity: 'x' })).toThrow(/not found/);
  });

  it('transition patch cannot smuggle a different state', () => {
    const r = store.createRun(input());
    const t = store.transition(r.id, 'queued', 'starting', { state: 'accepted' } as never);
    expect(t!.state).toBe('starting');
  });

  it('lists events in order with afterId and limit', () => {
    const r = store.createRun(input());
    const e1 = store.appendEvent(r.id, 'system', 'one');
    const e2 = store.appendEvent(r.id, 'tool', 'two', { path: 'a.ts' });
    const e3 = store.appendEvent(r.id, 'text', 'three');
    expect(store.listEvents(r.id).map((e) => e.text)).toEqual(['one', 'two', 'three']);
    expect(store.listEvents(r.id, e1.id).map((e) => e.id)).toEqual([e2.id, e3.id]);
    expect(store.listEvents(r.id, 0, 2).map((e) => e.id)).toEqual([e1.id, e2.id]);
    expect(store.listEvents(r.id, e1.id)[0]!.data).toEqual({ path: 'a.ts' });
    expect(store.listEvents(r.id)[0]).not.toHaveProperty('data');
  });

  it('listByState and includeTerminal filter', () => {
    const a = store.createRun(input());
    const b = store.createRun(input());
    store.transition(a.id, 'queued', 'cancelled');
    store.transition(a.id, 'cancelled', 'rejected');
    expect(store.listByState(['queued']).map((r) => r.id)).toEqual([b.id]);
    expect(store.listByState([])).toEqual([]);
    expect(store.listRuns({ includeTerminal: false }).map((r) => r.id)).toEqual([b.id]);
    expect(store.listRuns()).toHaveLength(2);
  });

  it('meta get/set', () => {
    expect(store.getMeta('boot')).toBeNull();
    store.setMeta('boot', '1');
    store.setMeta('boot', '2');
    expect(store.getMeta('boot')).toBe('2');
    expect(store.getMeta('schema_version')).toBe('1');
  });

  it('survives close and reopen', () => {
    const r = store.createRun(input());
    store.transition(r.id, 'queued', 'starting', { sessionId: 's1' });
    store.appendEvent(r.id, 'system', 'hello');
    store.setMeta('k', 'v');
    store.close();
    store = createSqliteStore(dbPath);
    expect(store.getRun(r.id)).toMatchObject({ state: 'starting', sessionId: 's1' });
    expect(store.listEvents(r.id).map((e) => e.kind)).toEqual(['state', 'system']);
    expect(store.getMeta('k')).toBe('v');
    expect(store.transition(r.id, 'starting', 'running')?.state).toBe('running');
  });
});
