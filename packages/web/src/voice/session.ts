/**
 * Browser half of the voice layer: mic + speaker over WebRTC, captions from the
 * `oai-events` data channel. It only carries audio and draws text. It never acts on
 * delegations; the server's sideband connection owns those (docs/VOICE_PLAN.md).
 */
import { ApiError } from '../api.ts';

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'closing';

export interface Caption {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  startMs: number;
  /** Session-relative ms of the last fragment; a new fragment close after it extends this line. */
  endMs: number;
}

export interface VoiceState {
  status: VoiceStatus;
  captions: Caption[];
  error: string | null;
}

const MAX_CAPTIONS = 6;
/** Fragments from the same speaker within this gap join one caption line. */
const JOIN_GAP_MS = 1200;
const CLOSE_TIMEOUT_MS = 3000;

interface TranscriptDelta { delta: string; start_ms?: number; end_ms?: number }

/**
 * Fold one transcript fragment into the caption list. Pure, for tests.
 * Full duplex means lines interleave (a backchannel mid-sentence), so a fragment joins the
 * speaker's latest line unless there was a pause, or the other side spoke a whole line in between.
 */
export function addFragment(captions: Caption[], role: Caption['role'], d: TranscriptDelta, nextId: number): Caption[] {
  const start = d.start_ms ?? Number.MAX_SAFE_INTEGER;
  const end = d.end_ms ?? d.start_ms ?? 0;
  for (let i = captions.length - 1; i >= 0; i--) {
    const c = captions[i]!;
    if (c.role !== role) continue;
    const turnBetween = captions.slice(i + 1).some((o) => o.startMs >= c.endMs && o.endMs <= start);
    if (turnBetween || start - c.endMs > JOIN_GAP_MS) break;
    const next = captions.slice();
    next[i] = { ...c, text: c.text + d.delta, endMs: Math.max(c.endMs, end) };
    return next;
  }
  const line = { id: nextId, role, text: d.delta.trimStart(), startMs: d.start_ms ?? end, endMs: end };
  return [...captions, line].slice(-MAX_CAPTIONS);
}

export class VoiceSession {
  private state: VoiceState = { status: 'idle', captions: [], error: null };
  private listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private captionId = 1;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getState = (): VoiceState => this.state;

  private set(patch: Partial<VoiceState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  async start(): Promise<void> {
    if (this.state.status !== 'idle') return;
    this.set({ status: 'connecting', captions: [], error: null });
    try {
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.audio = new Audio();
      this.audio.autoplay = true;
      pc.ontrack = (e) => { if (this.audio) this.audio.srcObject = e.streams[0] ?? new MediaStream([e.track]); };
      pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') this.fail('Voice connection dropped.');
      };
      for (const track of this.mic.getAudioTracks()) pc.addTrack(track, this.mic);
      // The data channel must exist before the offer so it is negotiated in the SDP.
      const dc = pc.createDataChannel('oai-events');
      this.dc = dc;
      dc.onmessage = (e: MessageEvent<string>) => this.onEvent(e.data);

      await pc.setLocalDescription(await pc.createOffer());
      await iceGatheringComplete(pc);
      const answer = await postOffer(pc.localDescription!.sdp);
      if (this.pc !== pc) return; // stopped while we waited
      await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp });
      // Status goes live on `session.started`, not here.
    } catch (err) {
      this.fail(err instanceof DOMException && err.name === 'NotAllowedError'
        ? 'Microphone access was denied. Allow it in the browser to use voice.'
        : err instanceof Error ? err.message : String(err));
    }
  }

  /** Ask the session to close gracefully; tear down locally if it doesn't confirm in time. */
  stop(): void {
    if (this.state.status === 'idle' || this.state.status === 'closing') return;
    if (this.dc?.readyState === 'open') {
      this.set({ status: 'closing' });
      this.dc.send(JSON.stringify({ type: 'session.close' }));
      this.closeTimer = setTimeout(() => this.teardown(), CLOSE_TIMEOUT_MS);
    } else {
      this.teardown();
    }
  }

  private onEvent(raw: string) {
    let ev: { type?: string; [k: string]: unknown };
    try { ev = JSON.parse(raw); } catch { return; }
    switch (ev.type) {
      case 'session.started':
        this.set({ status: 'live' });
        break;
      case 'session.input_transcript.delta':
        this.caption('user', ev as unknown as TranscriptDelta);
        break;
      case 'session.output_transcript.delta':
        this.caption('assistant', ev as unknown as TranscriptDelta);
        break;
      case 'session.closed':
        this.teardown();
        break;
      case 'error': {
        const msg = (ev.error as { message?: string } | undefined)?.message ?? 'Voice session error.';
        console.warn('[voice] error event', ev);
        this.set({ error: msg });
        break;
      }
      default:
        if (import.meta.env.DEV) console.debug('[voice]', ev.type, ev);
    }
  }

  private caption(role: Caption['role'], d: TranscriptDelta) {
    if (typeof d.delta !== 'string' || !d.delta) return;
    this.set({ captions: addFragment(this.state.captions, role, d, this.captionId++) });
  }

  private fail(message: string) {
    this.teardown();
    this.set({ error: message });
  }

  private teardown() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    this.dc?.close();
    this.pc?.close();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    if (this.audio) this.audio.srcObject = null;
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audio = null;
    this.set({ status: 'idle' });
  }
}

function iceGatheringComplete(pc: RTCPeerConnection, timeoutMs = 5000): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => { if (pc.iceGatheringState === 'complete') done(); };
    // Proceed with whatever candidates we have rather than hang on a slow STUN server.
    const timer = setTimeout(done, timeoutMs);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

async function postOffer(sdp: string): Promise<{ sessionId: string; sdp: string }> {
  let res: Response;
  try {
    res = await fetch('/api/voice/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sdp }),
    });
  } catch {
    throw new ApiError('Cannot reach conductor server — is it running?', 0);
  }
  const json = await res.json().catch(() => null) as { error?: string; sessionId?: string; sdp?: string } | null;
  if (!res.ok || !json?.sdp) throw new ApiError(json?.error ?? `Voice session failed: ${res.status}`, res.status);
  return { sessionId: json.sessionId!, sdp: json.sdp };
}
