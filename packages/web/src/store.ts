import type { Run, RunEvent, StreamEvent, SystemInfo } from '@conductor/shared';
import { sortByAttention } from '@conductor/shared';
import type { DataSource } from './api.ts';

export type ConnState = 'connecting' | 'live' | 'reconnecting';

export interface State {
  runs: Record<string, Run>;
  /** Attention-sorted snapshot; recomputed on every run change and on a 30s timer. */
  sorted: Run[];
  /** Timelines, only for runs whose events have been fetched. */
  events: Record<string, RunEvent[]>;
  system: SystemInfo | null;
  conn: ConnState;
  /** When the stream last dropped (for "reconnecting for 12s"). */
  droppedAt: number | null;
  nextRetryAt: number | null;
  loaded: boolean;
}

type Listener = () => void;

const BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

export class ConductorStore {
  private state: State = {
    runs: {}, sorted: [], events: {}, system: null, conn: 'connecting',
    droppedAt: null, nextRetryAt: null, loaded: false,
  };
  private listeners = new Set<Listener>();
  private closeStream: (() => void) | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resortTimer: ReturnType<typeof setInterval> | null = null;
  private attempt = 0;
  private started = false;

  constructor(readonly src: DataSource) {}

  getState = (): State => this.state;

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  private set(patch: Partial<State>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private setRuns(runs: Record<string, Run>) {
    this.set({ runs, sorted: sortByAttention(Object.values(runs)) });
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.connect();
    // Staleness changes attention scores even with no incoming events.
    this.resortTimer = setInterval(() => this.set({ sorted: sortByAttention(Object.values(this.state.runs)) }), 30_000);
  }

  stop() {
    this.started = false;
    this.closeStream?.();
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.resortTimer) clearInterval(this.resortTimer);
  }

  private connect() {
    this.closeStream?.();
    this.closeStream = this.src.stream({
      onOpen: () => {
        this.attempt = 0;
        this.set({ conn: 'live', droppedAt: null, nextRetryAt: null });
        void this.resync();
      },
      onEvent: (ev) => this.apply(ev),
      onDrop: () => this.scheduleReconnect(),
    });
  }

  private scheduleReconnect() {
    if (!this.started) return;
    const delay = BACKOFF_MS[Math.min(this.attempt, BACKOFF_MS.length - 1)]!;
    this.attempt++;
    const now = Date.now();
    this.set({ conn: 'reconnecting', droppedAt: this.state.droppedAt ?? now, nextRetryAt: now + delay });
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Retry immediately (user clicked "retry now"). */
  retryNow() {
    if (this.state.conn !== 'reconnecting') return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.connect();
  }

  /** Full refetch after (re)connect: runs, system, and any timelines we're showing. */
  private async resync() {
    try {
      const [runs, system] = await Promise.all([this.src.listRuns(), this.src.system().catch(() => this.state.system)]);
      const map: Record<string, Run> = {};
      for (const r of runs) map[r.id] = r;
      this.set({ system, loaded: true });
      this.setRuns(map);
      for (const id of Object.keys(this.state.events)) void this.loadEvents(id, true);
    } catch {
      /* stream will drop too if the server is gone; the reconnect loop covers it */
    }
  }

  private apply(ev: StreamEvent) {
    switch (ev.type) {
      case 'run':
        this.upsert(ev.run);
        break;
      case 'event': {
        const list = this.state.events[ev.event.runId];
        if (!list) return; // timeline not loaded; will be fetched fresh when opened
        if (list.some((e) => e.id === ev.event.id)) return;
        this.set({ events: { ...this.state.events, [ev.event.runId]: [...list, ev.event] } });
        break;
      }
      case 'system':
        this.set({ system: ev.system });
        break;
    }
  }

  upsert(run: Run) {
    const prev = this.state.runs[run.id];
    if (prev && prev.updatedAt > run.updatedAt) return; // out-of-order snapshot
    this.setRuns({ ...this.state.runs, [run.id]: run });
  }

  /** Fetch a run's timeline. With `incremental`, only fetch events after the last one we have. */
  async loadEvents(id: string, incremental = false) {
    const have = this.state.events[id];
    const after = incremental && have?.length ? have[have.length - 1]!.id : undefined;
    const fetched = await this.src.events(id, after);
    const cur = this.state.events[id] ?? [];
    const merged = after === undefined ? fetched : [...cur];
    if (after !== undefined) {
      const seen = new Set(cur.map((e) => e.id));
      for (const e of fetched) if (!seen.has(e.id)) merged.push(e);
    }
    // Keep live-appended events that raced ahead of the fetch.
    if (after === undefined) {
      const seen = new Set(merged.map((e) => e.id));
      for (const e of cur) if (!seen.has(e.id)) merged.push(e);
    }
    merged.sort((a, b) => a.id - b.id);
    this.set({ events: { ...this.state.events, [id]: merged } });
  }
}
