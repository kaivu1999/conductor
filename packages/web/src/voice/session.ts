/**
 * Browser half of the voice layer: mic + speaker over WebRTC, captions from the
 * `oai-events` data channel. It only carries audio and draws text. It never acts on
 * delegations; the server's sideband connection owns those (docs/VOICE_PLAN.md).
 */
import { addFragment, type TranscriptDelta, type TranscriptLine } from '@conductor/shared';
import { ApiError } from '../api.ts';

export type VoiceStatus = 'idle' | 'connecting' | 'live' | 'closing';

export type Caption = TranscriptLine;

export interface VoiceState {
  status: VoiceStatus;
  captions: Caption[];
  error: string | null;
  /** Mic muted, as confirmed by the session (`session.input_audio.muted`). */
  muted: boolean;
  /** Between a delegation and its result reaching the voice: Conductor is working something out. */
  thinking: boolean;
}

/** Loudness of each side right now, 0..1, normalized to that side's own recent range. */
export interface Levels { user: number; conductor: number }

const MAX_CAPTIONS = 10;
const CLOSE_TIMEOUT_MS = 3000;
/** Clear a stuck "thinking" if the result never arrives. */
const THINKING_TIMEOUT_MS = 30_000;
/** levels() is called by several animations per frame; measure at most this often. */
const LEVEL_EVERY_MS = 12;

function rms(an: AnalyserNode, buf: Float32Array<ArrayBuffer>): number {
  an.getFloatTimeDomainData(buf);
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
  return Math.sqrt(sum / buf.length);
}

/**
 * Automatic gain for one audio source, so a quiet laptop mic and a loud headset both
 * move the visuals. Tracks the room's noise floor (drops fast, rises slowly) and a
 * recent peak (jumps up, decays over a few seconds), and maps RMS between them to 0..1.
 */
export class LevelMeter {
  private floor = -1;
  private peak = 0;
  private value = 0;

  next(raw: number): number {
    if (this.floor < 0) this.floor = raw;
    this.floor += (raw - this.floor) * (raw < this.floor ? 0.25 : 0.002);
    this.peak = Math.max(raw, this.peak * 0.996);
    const lo = this.floor * 1.6 + 0.0015;
    // Never stretch a whisper of noise to full scale.
    const hi = Math.max(this.peak, lo * 3, 0.012);
    const v = Math.min(1, Math.max(0, (raw - lo) / (hi - lo)));
    this.value += (v - this.value) * (v > this.value ? 0.55 : 0.18);
    return this.value;
  }
}

export class VoiceSession {
  private state: VoiceState = { status: 'idle', captions: [], error: null, muted: false, thinking: false };
  private listeners = new Set<() => void>();
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private mic: MediaStream | null = null;
  private audio: HTMLAudioElement | null = null;
  private captionId = 1;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  private ctx: AudioContext | null = null;
  private userAn: AnalyserNode | null = null;
  private conductorAn: AnalyserNode | null = null;
  private buf = new Float32Array(new ArrayBuffer(1024 * 4));
  private meters = { user: new LevelMeter(), conductor: new LevelMeter() };
  private lastLevels: Levels = { user: 0, conductor: 0 };
  private levelsAt = 0;

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
    this.set({ status: 'connecting', captions: [], error: null, muted: false, thinking: false });
    try {
      // Created inside the click, so the browser lets it run.
      this.ctx = new AudioContext();
      this.mic = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.userAn = this.analyser(this.mic);
      this.meters = { user: new LevelMeter(), conductor: new LevelMeter() };
      const pc = new RTCPeerConnection();
      this.pc = pc;
      this.audio = new Audio();
      this.audio.autoplay = true;
      pc.ontrack = (e) => {
        const stream = e.streams[0] ?? new MediaStream([e.track]);
        // Playback stays on the <audio> element (Chrome only feeds a remote stream to Web
        // Audio while it is also playing); the analyser just listens.
        if (this.audio) this.audio.srcObject = stream;
        this.conductorAn = this.analyser(stream);
      };
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

  /** Current loudness of the user's mic and of Conductor's voice. Cheap; call per frame. */
  levels(): Levels {
    const now = performance.now();
    if (now - this.levelsAt < LEVEL_EVERY_MS) return this.lastLevels;
    this.levelsAt = now;
    const user = this.userAn ? this.meters.user.next(rms(this.userAn, this.buf)) : 0;
    const conductor = this.conductorAn ? this.meters.conductor.next(rms(this.conductorAn, this.buf)) : 0;
    this.lastLevels = { user: this.state.muted ? 0 : user, conductor };
    return this.lastLevels;
  }

  /** Mute or unmute the mic. The session confirms; the local track is cut at once regardless. */
  setMuted(muted: boolean): void {
    if (this.state.status !== 'live' || this.dc?.readyState !== 'open') return;
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    this.dc.send(JSON.stringify({ type: muted ? 'session.input_audio.mute' : 'session.input_audio.unmute' }));
  }

  toggleMute(): void {
    this.setMuted(!this.state.muted);
  }

  private analyser(stream: MediaStream): AnalyserNode | null {
    if (!this.ctx) return null;
    const an = this.ctx.createAnalyser();
    an.fftSize = 1024;
    an.smoothingTimeConstant = 0.6;
    this.ctx.createMediaStreamSource(stream).connect(an);
    return an;
  }

  private setThinking(on: boolean) {
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = on ? setTimeout(() => this.set({ thinking: false }), THINKING_TIMEOUT_MS) : null;
    if (this.state.thinking !== on) this.set({ thinking: on });
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
      case 'session.delegation.created':
        this.setThinking(true);
        break;
      case 'session.commentary.appended':
        this.setThinking(false);
        break;
      case 'session.input_audio.muted':
        this.set({ muted: true });
        break;
      case 'session.input_audio.unmuted':
        for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = true;
        this.set({ muted: false });
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
    this.set({ captions: addFragment(this.state.captions, role, d, this.captionId++, MAX_CAPTIONS) });
  }

  private fail(message: string) {
    this.teardown();
    this.set({ error: message });
  }

  private teardown() {
    if (this.closeTimer) clearTimeout(this.closeTimer);
    this.closeTimer = null;
    if (this.thinkingTimer) clearTimeout(this.thinkingTimer);
    this.thinkingTimer = null;
    this.dc?.close();
    this.pc?.close();
    for (const t of this.mic?.getTracks() ?? []) t.stop();
    if (this.audio) this.audio.srcObject = null;
    this.dc = null;
    this.pc = null;
    this.mic = null;
    this.audio = null;
    void this.ctx?.close();
    this.ctx = null;
    this.userAn = null;
    this.conductorAn = null;
    this.set({ status: 'idle', muted: false, thinking: false });
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
