import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../src/api/server.ts';
import type { VoiceConfig } from '../src/voice/live.ts';
import { makeHarness } from './helpers/index.ts';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

const VOICE: VoiceConfig = { apiKey: 'sk-test', model: 'gpt-live-1', voice: 'marin', baseUrl: 'https://openai.test/v1' };

function server(voice: VoiceConfig, fetchImpl: typeof fetch) {
  const h = makeHarness();
  const app = buildServer({ supervisor: h.sup, store: h.store, git: h.git, serveWeb: false, voice, fetch: fetchImpl });
  cleanups.push(() => fs.rmSync(h.config.dataDir, { recursive: true, force: true }));
  cleanups.push(() => app.close());
  return app;
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
