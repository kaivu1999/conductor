/**
 * GPT-Live session minting. The browser sends its WebRTC offer here; we create the
 * session with our key and hand back the SDP answer, so the key never reaches the page.
 * See docs/VOICE_PLAN.md for the API facts this depends on.
 */
import { INSTRUCTIONS } from './instructions.ts';

export interface VoiceConfig {
  apiKey: string | undefined;
  model: string;
  voice: string;
  baseUrl: string;
}

export function loadVoiceConfig(env: NodeJS.ProcessEnv = process.env): VoiceConfig {
  return {
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    model: env.CONDUCTOR_VOICE_MODEL?.trim() || 'gpt-live-1',
    voice: env.CONDUCTOR_VOICE?.trim() || 'marin',
    baseUrl: 'https://api.openai.com/v1',
  };
}

export interface LiveSession {
  sessionId: string;
  sdp: string;
}

export class VoiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** POST /v1/live/sessions with the browser's offer. Throws VoiceError with a readable message. */
export async function createLiveSession(
  cfg: VoiceConfig,
  offerSdp: string,
  fetchImpl: typeof fetch = fetch,
): Promise<LiveSession> {
  if (!cfg.apiKey) throw new VoiceError('Voice needs OPENAI_API_KEY. Add it to .env at the repo root and restart conductor.', 409);
  let res: Response;
  try {
    res = await fetchImpl(`${cfg.baseUrl}/live/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        session: {
          model: cfg.model,
          instructions: INSTRUCTIONS,
          delegation: { type: 'client' },
          audio: { output: { voice: cfg.voice } },
        },
        transport: { type: 'webrtc', sdp: offerSdp },
      }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new VoiceError(`Could not reach OpenAI: ${err instanceof Error ? err.message : String(err)}`, 502);
  }
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
  if (!res.ok) {
    const msg = (json as { error?: { message?: string } } | null)?.error?.message ?? (text.slice(0, 300) || res.statusText);
    throw new VoiceError(`OpenAI refused the voice session (${res.status}): ${msg}`, 502);
  }
  const body = json as { session?: { id?: string }; transport?: { sdp?: string } } | null;
  const sessionId = body?.session?.id;
  const sdp = body?.transport?.sdp;
  if (!sessionId || !sdp) throw new VoiceError('OpenAI returned a voice session without an id or SDP answer.', 502);
  return { sessionId, sdp };
}
