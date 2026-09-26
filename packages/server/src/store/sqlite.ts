import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { createRequire } from 'node:module';
import { randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canTransition, type Run, type RunEvent, type RunState } from '@conductor/shared';
import type { NewRun, Store } from '../contracts.ts';

// Loaded via require: Vite (vitest 2) doesn't recognise `node:sqlite` as a builtin and
// fails to resolve a static import of it.
const { DatabaseSync: Database } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');

// ─── schema ──────────────────────────────────────────────────────────────────

/** Append-only. Index i upgrades schema_version i -> i+1. Never edit a shipped entry. */
const MIGRATIONS: string[] = [
  `CREATE TABLE runs (
     id             TEXT PRIMARY KEY,
     repo_path      TEXT NOT NULL,
     repo_name      TEXT NOT NULL,
     task           TEXT NOT NULL,
     title          TEXT NOT NULL,
     base_branch    TEXT NOT NULL,
     base_commit    TEXT,
     branch         TEXT NOT NULL,
     worktree_path  TEXT,
     state          TEXT NOT NULL,
     activity       TEXT NOT NULL DEFAULT '',
     activity_at    INTEGER,
     session_id     TEXT,
     attempt        INTEGER NOT NULL DEFAULT 0,
     pid            INTEGER,
     pid_started_at INTEGER,
     cost_usd       REAL NOT NULL DEFAULT 0,
     turns          INTEGER NOT NULL DEFAULT 0,
     error          TEXT,
     summary        TEXT,
     diff_stat      TEXT,
     tests          TEXT,
     pending_question TEXT,
     overlaps       TEXT NOT NULL DEFAULT '[]',
     test_command   TEXT,
     created_at     INTEGER NOT NULL,
     started_at     INTEGER,
     finished_at    INTEGER,
     updated_at     INTEGER NOT NULL
   );
   CREATE INDEX runs_state ON runs(state);
   CREATE INDEX runs_created ON runs(created_at);
   CREATE TABLE run_events (
     id     INTEGER PRIMARY KEY AUTOINCREMENT,
     run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     ts     INTEGER NOT NULL,
     kind   TEXT NOT NULL,
     text   TEXT NOT NULL,
     data   TEXT
   );
   CREATE INDEX run_events_run ON run_events(run_id, id);`,
];

function migrate(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
  const row = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get() as { value: string } | undefined;
  const current = row ? Number(row.value) : 0;
  if (current > MIGRATIONS.length) {
    throw new Error(`database schema_version ${current} is newer than this conductor (${MIGRATIONS.length}); upgrade conductor`);
  }
  for (let v = current; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.prepare(`INSERT INTO meta(key, value) VALUES ('schema_version', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(v + 1));
    });
  }
}

function tx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

// ─── row <-> Run mapping (the only place that knows column names) ────────────

/** Run field -> [column, encode, decode]. JSON columns round-trip through text. */
const json = { enc: (v: unknown) => (v == null ? null : JSON.stringify(v)), dec: (v: unknown) => (v == null ? null : JSON.parse(String(v))) };
const plain = { enc: (v: unknown) => (v === undefined ? null : v) as SQLInputValue, dec: (v: unknown) => v };

const COLUMNS: Record<keyof Run, [string, typeof plain | typeof json]> = {
  id: ['id', plain],
  repoPath: ['repo_path', plain],
  repoName: ['repo_name', plain],
  task: ['task', plain],
  title: ['title', plain],
  baseBranch: ['base_branch', plain],
  baseCommit: ['base_commit', plain],
  branch: ['branch', plain],
  worktreePath: ['worktree_path', plain],
  state: ['state', plain],
  activity: ['activity', plain],
  activityAt: ['activity_at', plain],
  sessionId: ['session_id', plain],
  attempt: ['attempt', plain],
  pid: ['pid', plain],
  pidStartedAt: ['pid_started_at', plain],
  costUsd: ['cost_usd', plain],
  turns: ['turns', plain],
  error: ['error', plain],
  summary: ['summary', plain],
  diffStat: ['diff_stat', json],
  tests: ['tests', json],
  pendingQuestion: ['pending_question', json],
  overlaps: ['overlaps', json],
  createdAt: ['created_at', plain],
  startedAt: ['started_at', plain],
  finishedAt: ['finished_at', plain],
  updatedAt: ['updated_at', plain],
};

function rowToRun(row: Record<string, unknown>): Run {
  const run: Record<string, unknown> = {};
  for (const [field, [col, codec]] of Object.entries(COLUMNS)) run[field] = codec.dec(row[col]);
  run.overlaps ??= [];
  return run as unknown as Run;
}

/** Builds "col = ?" assignments for the given partial Run. Unknown keys are ignored. */
function assignments(patch: Partial<Run>): { sql: string[]; params: SQLInputValue[] } {
  const sql: string[] = [];
  const params: SQLInputValue[] = [];
  for (const [field, value] of Object.entries(patch)) {
    const spec = COLUMNS[field as keyof Run];
    if (!spec || value === undefined) continue;
    sql.push(`${spec[0]} = ?`);
    params.push(spec[1].enc(value) as SQLInputValue);
  }
  return { sql, params };
}

/** Fields callers may never write through patch/transition. */
function sanitize(patch: Partial<Run> | undefined): Partial<Run> {
  if (!patch) return {};
  const { id: _id, state: _state, createdAt: _c, updatedAt: _u, ...rest } = patch;
  return rest;
}

function rowToEvent(row: Record<string, unknown>): RunEvent {
  const ev: RunEvent = {
    id: Number(row.id),
    runId: String(row.run_id),
    ts: Number(row.ts),
    kind: row.kind as RunEvent['kind'],
    text: String(row.text),
  };
  if (row.data != null) ev.data = JSON.parse(String(row.data));
  return ev;
}

// ─── store ───────────────────────────────────────────────────────────────────

export function newRunId(): string {
  const bytes = randomBytes(6);
  let id = '';
  for (const b of bytes) id += (b % 36).toString(36);
  return `r_${id}`;
}

/** Monotonic-ish clock so updatedAt strictly increases even within one millisecond. */
function makeClock() {
  let last = 0;
  return () => (last = Math.max(Date.now(), last + 1));
}

export function createSqliteStore(dbPath: string): Store {
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`);
  migrate(db);
  const now = makeClock();
  let closed = false;

  const selectRun = db.prepare(`SELECT * FROM runs WHERE id = ?`);
  const insertEvent = db.prepare(`INSERT INTO run_events(run_id, ts, kind, text, data) VALUES (?, ?, ?, ?, ?)`);

  function getRun(id: string): Run | null {
    const row = selectRun.get(id);
    return row ? rowToRun(row) : null;
  }

  function mustGet(id: string): Run {
    const run = getRun(id);
    if (!run) throw new Error(`run ${id} not found`);
    return run;
  }

  function appendEvent(runId: string, kind: RunEvent['kind'], text: string, data?: unknown): RunEvent {
    const ts = Date.now();
    const res = insertEvent.run(runId, ts, kind, text, data === undefined ? null : JSON.stringify(data));
    const ev: RunEvent = { id: Number(res.lastInsertRowid), runId, ts, kind, text };
    if (data !== undefined) ev.data = data;
    return ev;
  }

  function createRun(input: NewRun): Run {
    const t = now();
    // Retry on the (astronomically rare) id collision rather than surfacing it.
    for (let i = 0; i < 5; i++) {
      const id = newRunId();
      if (getRun(id)) continue;
      db.prepare(
        `INSERT INTO runs (id, repo_path, repo_name, task, title, base_branch, branch, state, test_command, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
      ).run(id, input.repoPath, input.repoName, input.task, input.title, input.baseBranch, input.branch, input.testCommand, t, t);
      return mustGet(id);
    }
    throw new Error('could not allocate a unique run id');
  }

  function transition(id: string, from: RunState | readonly RunState[], to: RunState, patch?: Partial<Run>): Run | null {
    const fromList: readonly RunState[] = typeof from === 'string' ? [from] : from;
    if (fromList.length === 0) throw new Error('transition: `from` must list at least one state');
    for (const f of fromList) {
      if (!canTransition(f, to)) throw new Error(`illegal transition ${f} → ${to} for run ${id}`);
    }
    return tx(db, () => {
      const prev = selectRun.get(id) as { state: RunState } | undefined;
      if (!prev) return null;
      const { sql, params } = assignments(sanitize(patch));
      const res = db
        .prepare(
          `UPDATE runs SET ${['state = ?', ...sql, 'updated_at = ?'].join(', ')}
           WHERE id = ? AND state IN (${fromList.map(() => '?').join(', ')})`,
        )
        .run(to, ...params, now(), id, ...fromList);
      if (Number(res.changes) === 0) return null;
      appendEvent(id, 'state', `${prev.state} → ${to}`, { from: prev.state, to });
      return mustGet(id);
    });
  }

  function patch(id: string, p: Partial<Omit<Run, 'id' | 'state'>>): Run {
    const { sql, params } = assignments(sanitize(p as Partial<Run>));
    const res = db.prepare(`UPDATE runs SET ${[...sql, 'updated_at = ?'].join(', ')} WHERE id = ?`).run(...params, now(), id);
    if (Number(res.changes) === 0) throw new Error(`run ${id} not found`);
    return mustGet(id);
  }

  return {
    createRun,
    getRun,
    listRuns(opts) {
      const includeTerminal = opts?.includeTerminal ?? true;
      const rows = includeTerminal
        ? db.prepare(`SELECT * FROM runs ORDER BY created_at DESC, rowid DESC`).all()
        : db.prepare(`SELECT * FROM runs WHERE state NOT IN ('accepted', 'rejected') ORDER BY created_at DESC, rowid DESC`).all();
      return rows.map(rowToRun);
    },
    listByState(states) {
      if (states.length === 0) return [];
      return db
        .prepare(`SELECT * FROM runs WHERE state IN (${states.map(() => '?').join(', ')}) ORDER BY created_at DESC, rowid DESC`)
        .all(...states)
        .map(rowToRun);
    },
    getTestCommand(id) {
      const row = db.prepare(`SELECT test_command FROM runs WHERE id = ?`).get(id) as { test_command: string | null } | undefined;
      return row?.test_command ?? null;
    },
    transition,
    patch,
    appendEvent,
    listEvents(runId, afterId = 0, limit = 1000) {
      return db
        .prepare(`SELECT * FROM run_events WHERE run_id = ? AND id > ? ORDER BY id ASC LIMIT ?`)
        .all(runId, afterId, limit)
        .map(rowToEvent);
    },
    getMeta(key) {
      const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
      return row?.value ?? null;
    },
    setMeta(key, value) {
      db.prepare(`INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(key, value);
    },
    close() {
      if (closed) return;
      closed = true;
      db.close();
    },
  };
}
