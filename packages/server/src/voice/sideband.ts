/**
 * Server-side WebSocket attached to a running GPT-Live session
 * (`wss://…/v1/live/sessions/{id}/attach`). Receives the same events as the browser and
 * sends context updates. Node's global WebSocket accepts an `headers` option (undici).
 */
import type { VoiceConfig } from './live.ts';

export interface LiveEvent { type: string; [k: string]: unknown }

export interface Sideband {
  send(event: LiveEvent): void;
  close(): void;
  readonly open: boolean;
}

export interface SidebandHandlers {
  onEvent(event: LiveEvent): void;
  /** The socket closed (either side). `reason` is set when it failed. */
  onClose(reason?: string): void;
}

/** Minimal WebSocket surface we use, so tests can pass a fake. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export const nodeWebSocket: WebSocketFactory = (url, headers) =>
  // The DOM typings don't know undici's non-standard `{ headers }` init.
  new (WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocketLike)(url, { headers });

const OPEN = 1;

export function attachSideband(cfg: VoiceConfig, sessionId: string, h: SidebandHandlers, connect: WebSocketFactory = nodeWebSocket): Sideband {
  const url = `${cfg.baseUrl.replace(/^http/, 'ws')}/live/sessions/${encodeURIComponent(sessionId)}/attach`;
  const ws = connect(url, { authorization: `Bearer ${cfg.apiKey}` });
  // Sends before the socket opens are queued, so a delegation that races the attach isn't lost.
  const queued: string[] = [];
  let closed = false;
  let failure: string | undefined;

  ws.onopen = () => {
    for (const data of queued.splice(0)) ws.send(data);
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== 'string') return;
    let parsed: LiveEvent;
    try { parsed = JSON.parse(ev.data) as LiveEvent; } catch { return; }
    if (parsed && typeof parsed.type === 'string') h.onEvent(parsed);
  };
  ws.onerror = (ev) => {
    failure = (ev as { message?: string })?.message ?? 'sideband socket error';
  };
  ws.onclose = (ev) => {
    if (closed) return;
    closed = true;
    h.onClose(failure ?? (ev.code === 1000 ? undefined : `closed with code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''}`));
  };

  return {
    send(event) {
      if (closed) return;
      const data = JSON.stringify(event);
      if (ws.readyState === OPEN) ws.send(data);
      else queued.push(data);
    },
    close() {
      if (closed) return;
      ws.close(1000);
    },
    get open() { return !closed; },
  };
}
