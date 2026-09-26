/**
 * The one place the supervisor writes to the Store. Every write is followed by an
 * emission so SSE clients never see stale state, and every op becomes a no-op once the
 * store is closed (late agent callbacks after shutdown must not crash the process).
 */
import { EventEmitter } from 'node:events';
import type { Run, RunEvent, RunState } from '@conductor/shared';
import type { Store } from '../contracts.ts';
import { errorMessage, type Logger } from './errors.ts';

export interface Writer {
  readonly emitter: EventEmitter;
  get(id: string): Run | null;
  /** CAS state change. null = the run was not in `from` (someone else won): callers must bail. */
  transition(id: string, from: RunState | readonly RunState[], to: RunState, patch?: Partial<Run>): Run | null;
  patch(id: string, patch: Partial<Omit<Run, 'id' | 'state'>>): Run | null;
  event(runId: string, kind: RunEvent['kind'], text: string, data?: unknown): RunEvent | null;
  /** Emit a run snapshot without writing (used for throttled activity). */
  emitRun(run: Run): void;
  close(): void;
  readonly closed: boolean;
}

export function createWriter(store: Store, log: Logger): Writer {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  let closed = false;
  /** Per run: highest event id already emitted. Lets us find the 'state' event store.transition appends. */
  const cursor = new Map<string, number>();

  function emit(name: 'run' | 'event', payload: Run | RunEvent): void {
    // A broken listener (e.g. a dead SSE socket) must never break a state write.
    for (const l of emitter.listeners(name)) {
      try {
        (l as (p: unknown) => void)(payload);
      } catch (err) {
        log.error(`listener for '${name}' threw: ${errorMessage(err)}`);
      }
    }
  }

  function emitEvent(ev: RunEvent): void {
    cursor.set(ev.runId, Math.max(cursor.get(ev.runId) ?? 0, ev.id));
    emit('event', ev);
  }

  /** Event id before a transition; for a run we haven't seen yet this boot, page to the end once. */
  function lastEventId(runId: string): number {
    let after = cursor.get(runId);
    if (after !== undefined) return after;
    after = 0;
    for (;;) {
      const page = store.listEvents(runId, after, 1000);
      if (page.length) after = page[page.length - 1]!.id;
      if (page.length < 1000) break;
    }
    cursor.set(runId, after);
    return after;
  }

  function guard<T>(what: string, fn: () => T, fallback: T): T {
    if (closed) return fallback;
    try {
      return fn();
    } catch (err) {
      if (closed) return fallback; // store closed underneath us during shutdown
      throw new Error(`${what}: ${errorMessage(err)}`, { cause: err });
    }
  }

  return {
    emitter,
    get closed() {
      return closed;
    },
    get: (id) => guard('read run', () => store.getRun(id), null),
    transition(id, from, to, patch) {
      return guard(`transition ${id} → ${to}`, () => {
        const since = lastEventId(id);
        const run = store.transition(id, from, to, patch);
        if (!run) {
          const cur = store.getRun(id);
          log.info(`run ${id}: skipped ${[from].flat().join('|')} → ${to}; it is ${cur?.state ?? 'gone'} (someone else changed it first)`);
          return null;
        }
        for (const ev of store.listEvents(id, since, 100)) emitEvent(ev);
        emit('run', run);
        return run;
      }, null);
    },
    patch(id, p) {
      return guard(`update ${id}`, () => {
        const run = store.patch(id, p);
        emit('run', run);
        return run;
      }, null);
    },
    event(runId, kind, text, data) {
      return guard(`append event to ${runId}`, () => {
        const ev = store.appendEvent(runId, kind, text, data);
        emitEvent(ev);
        return ev;
      }, null);
    },
    emitRun(run) {
      if (!closed) emit('run', run);
    },
    close() {
      closed = true;
    },
  };
}
