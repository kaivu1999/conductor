import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.ts';
import type { VoiceConfig } from '../src/voice/live.ts';
import { createVoiceManager, type VoiceBackend } from '../src/voice/manager.ts';
import type { LiveEvent, WebSocketLike } from '../src/voice/sideband.ts';
import { makeHarness } from './helpers/index.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const VOICE: VoiceConfig = { apiKey: 'sk-test', model: 'gpt-live-1', voice: 'marin', baseUrl: 'https://openai.test/v1' };

function server(voice: VoiceConfig, fetchImpl: typeof fetch) {
  const h = makeHarness();
  const manager = createVoiceManager({ config: voice, fetch: fetchImpl, connect: () => new FakeSocket(), closeTimeoutMs: 10, log: quiet });
  const app = buildServer({ supervisor: h.sup, store: h.store, git: h.git, serveWeb: false, voice: manager });
  cleanups.push(() => fs.rmSync(h.config.dataDir, { recursive: true, force: true }));
  cleanups.push(() => app.close());
  return app;
}

const quiet = { info() {}, warn() {}, error() {} };

/** In-memory stand-in for the sideband WebSocket. */
class FakeSocket implements WebSocketLike {
  static last: FakeSocket;
  readyState = 0;
  sent: LiveEvent[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url = '', readonly headers: Record<string, string> = {}) { FakeSocket.last = this; }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close(code = 1000) { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
  // server side
  accept() { this.readyState = 1; this.onopen?.({}); }
  emit(ev: LiveEvent) { this.onmessage?.({ data: JSON.stringify(ev) }); }
}

const reply = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('POST /api/voice/session', () => {
  it('creates a client-delegation session with the offer and returns the answer', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ session: { id: 'live_1' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } }), { status: 201 });
    }) as unknown as typeof fetch;
    const app = server(VOICE, fetchImpl);

    const res = await app.inject({ method: 'POST', url: '/api/voice/session', payload: { sdp: 'v=0 offer' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ sessionId: 'live_1', sdp: 'v=0 answer' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://openai.test/v1/live/sessions');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.transport).toEqual({ type: 'webrtc', sdp: 'v=0 offer' });
    expect(body.session).toMatchObject({ model: 'gpt-live-1', delegation: { type: 'client' }, audio: { output: { voice: 'marin' } } });
    expect(body.session.audio.format).toBeUndefined();
    expect(body.session.instructions).toContain('Delegation policy');
  });

  it('explains a missing key without calling OpenAI', async () => {
    let called = false;
    const app = server({ ...VOICE, apiKey: undefined }, (async () => { called = true; }) as unknown as typeof fetch);
    const res = await app.inject({ method: 'POST', url: '/api/voice/session', payload: { sdp: 'v=0' } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/OPENAI_API_KEY/);
    expect(called).toBe(false);
  });

  it('surfaces OpenAI errors as 502 with their message', async () => {
    const app = server(VOICE, reply(401, { error: { message: 'Incorrect API key provided' } }));
    const res = await app.inject({ method: 'POST', url: '/api/voice/session', payload: { sdp: 'v=0' } });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('OpenAI refused the voice session (401): Incorrect API key provided');
  });

  it('rejects a missing offer', async () => {
    const app = server(VOICE, reply(201, {}));
    const res = await app.inject({ method: 'POST', url: '/api/voice/session', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/sdp/);
  });
});

describe('voice manager', () => {
  const answer = reply(201, { session: { id: 'live_9' }, transport: { type: 'webrtc', sdp: 'v=0 answer' } });
  const settle = () => new Promise((r) => setTimeout(r, 20));

  function manager(delegate?: VoiceBackend['delegate']) {
    const m = createVoiceManager({
      config: VOICE, fetch: answer, backend: delegate && { delegate }, settleMs: 0, closeTimeoutMs: 50, log: quiet,
      connect: (url, headers) => new FakeSocket(url, headers),
    });
    cleanups.push(() => m.closeAll());
    return m;
  }

  it('attaches the sideband to the new session with the key', async () => {
    const m = manager();
    await m.open('v=0 offer');
    expect(FakeSocket.last.url).toBe('wss://openai.test/v1/live/sessions/live_9/attach');
    expect(FakeSocket.last.headers.authorization).toBe('Bearer sk-test');
    expect(m.get('live_9')).toBeDefined();
  });

  it('answers a client delegation from the transcript with commentary', async () => {
    const m = manager();
    await m.open('v=0');
    const ws = FakeSocket.last;
    ws.accept();
    ws.emit({ type: 'session.input_transcript.delta', delta: 'What needs', start_ms: 0, end_ms: 300 });
    ws.emit({ type: 'session.input_transcript.delta', delta: ' me?', start_ms: 320, end_ms: 600 });
    ws.emit({ type: 'session.output_transcript.delta', delta: 'Let me check.', start_ms: 700, end_ms: 1100 });
    ws.emit({ type: 'session.delegation.created', offset_ms: 650, delegation: { id: 'item_1', type: 'delegation', target: 'client' } });
    await settle();
    expect(ws.sent).toEqual([{
      type: 'session.commentary.append', event_id: expect.any(String), delegation_id: 'item_1',
      content: 'Backend stub: I heard "What needs me?". The task tools aren\'t connected yet.',
    }]);
    expect(m.get('live_9')!.transcript.render()).toBe('user: What needs me?\nassistant: Let me check.');
  });

  it('queues a result that is ready before the socket opens', async () => {
    const m = manager(async () => 'done');
    await m.open('v=0');
    const ws = FakeSocket.last;
    ws.emit({ type: 'session.delegation.created', offset_ms: 0, delegation: { id: 'item_2', target: 'client' } });
    await settle();
    expect(ws.sent).toEqual([]);
    ws.accept();
    expect(ws.sent.map((e) => e.content)).toEqual(['done']);
  });

  it('speaks a failure instead of going silent, and ignores non-client delegations', async () => {
    const m = manager(async () => { throw new Error('supervisor is down'); });
    await m.open('v=0');
    const ws = FakeSocket.last;
    ws.accept();
    ws.emit({ type: 'session.delegation.created', offset_ms: 0, delegation: { id: 'item_3', target: 'responses' } });
    ws.emit({ type: 'session.delegation.created', offset_ms: 0, delegation: { id: 'item_4', target: 'client' } });
    await settle();
    expect(ws.sent).toMatchObject([{ delegation_id: 'item_4', content: "That didn't work: supervisor is down" }]);
  });

  it('forgets a session when it closes', async () => {
    const m = manager();
    await m.open('v=0');
    FakeSocket.last.accept();
    FakeSocket.last.emit({ type: 'session.closed', usage: {} });
    expect(m.get('live_9')).toBeUndefined();
  });

  it('closeAll sends session.close and tears down after the timeout', async () => {
    const m = manager();
    await m.open('v=0');
    const ws = FakeSocket.last;
    ws.accept();
    await m.closeAll();
    expect(ws.sent.map((e) => e.type)).toEqual(['session.close']);
    expect(ws.readyState).toBe(3);
    expect(m.get('live_9')).toBeUndefined();
  });
});
