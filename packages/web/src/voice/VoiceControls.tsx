import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { useToast } from '../components/Toasts.tsx';
import { isMock } from '../useConductor.ts';
import { VoiceSession, type VoiceState } from './session.ts';

export const voice = new VoiceSession();

export function useVoice<T>(select: (s: VoiceState) => T): T {
  return useSyncExternalStore(voice.subscribe, () => select(voice.getState()));
}

/** Toggle the voice session (header button, `v`). */
export function toggleVoice(): void {
  if (isMock) return;
  const { status } = voice.getState();
  if (status === 'idle') void voice.start();
  else voice.stop();
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

/** Run `draw` every animation frame while `active`. Drawing goes straight to the DOM/canvas, not React state. */
function useFrame(active: boolean, draw: (t: number) => void) {
  const ref = useRef(draw);
  ref.current = draw;
  useEffect(() => {
    if (!active) return;
    let id = requestAnimationFrame(function loop(t) {
      ref.current(t);
      id = requestAnimationFrame(loop);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);
}

// ─── header button ───────────────────────────────────────────────────────────

/** Per-bar shape of the glyph, so a single level still looks like a waveform. */
const GLYPH = [0.45, 0.8, 1, 0.7, 0.5];
const BUTTON_LABEL = { idle: 'Talk', connecting: 'Connecting', live: 'Live', closing: 'Ending' } as const;

/** Header button: a five-bar waveform that breathes when idle and follows the audio when live. */
export function VoiceButton() {
  const status = useVoice((s) => s.status);
  const muted = useVoice((s) => s.muted);
  const error = useVoice((s) => s.error);
  const toast = useToast();
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  useEffect(() => { if (error) toast(error); }, [error, toast]);
  // Don't leave the mic open if the page goes away.
  useEffect(() => {
    const bye = () => voice.stop();
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  const live = status === 'live';
  useFrame(live, (t) => {
    const { user, conductor } = voice.levels();
    const v = Math.max(user, conductor);
    bars.current.forEach((el, i) => {
      if (!el) return;
      const wobble = 0.75 + 0.25 * Math.sin(t / 90 + i * 1.7);
      el.style.transform = `scaleY(${Math.max(0.18, Math.min(1, v * 2.2 * GLYPH[i]! * wobble))})`;
    });
  });
  // Hand the bars back to CSS when not live.
  useEffect(() => { if (!live) for (const el of bars.current) if (el) el.style.transform = ''; }, [live]);

  const on = status !== 'idle';
  return (
    <button
      className={`voice-btn voice-btn--${status}${muted ? ' voice-btn--muted' : ''}`}
      onClick={toggleVoice}
      disabled={isMock || status === 'closing'}
      title={isMock ? 'Voice needs the conductor server' : on ? 'End the conversation (v)' : 'Talk to Conductor (v)'}
      aria-pressed={on}
      aria-label={on ? 'End voice conversation' : 'Talk to Conductor'}
    >
      <span className="wave-glyph" aria-hidden>
        {GLYPH.map((_, i) => (
          <span key={i} ref={(el) => { bars.current[i] = el; }} style={{ '--i': i } as CSSProperties} />
        ))}
      </span>
      <span className="voice-btn__label">{BUTTON_LABEL[status]}</span>
      {status === 'idle' && <kbd>v</kbd>}
    </button>
  );
}

// ─── dock ────────────────────────────────────────────────────────────────────

type Phase = 'connecting' | 'listening' | 'hearing' | 'thinking' | 'speaking' | 'muted' | 'closing';
const PHASE_LABEL: Record<Phase, string> = {
  connecting: 'Connecting',
  listening: 'Listening',
  hearing: 'Listening',
  thinking: 'Thinking…',
  speaking: 'Conductor is speaking',
  muted: 'Muted',
  closing: 'Ending',
};

const USER_RGB = [92, 200, 255]; // --review
const CONDUCTOR_RGB = [124, 140, 255]; // --accent
const SPEAK_THRESHOLD = 0.06;
const SPEAK_HOLD_MS = 350;
const SAMPLE_MS = 70;
const BAR_W = 3;
const BAR_GAP = 2;

interface Sample { v: number; who: 'user' | 'conductor' }

/**
 * The open state: a floating dock with a scrolling waveform of the conversation (cyan is
 * you, indigo is Conductor), what's happening now, and the last few lines.
 */
export function VoiceDock() {
  const status = useVoice((s) => s.status);
  const muted = useVoice((s) => s.muted);
  const thinking = useVoice((s) => s.thinking);
  const captions = useVoice((s) => s.captions);
  const [mounted, setMounted] = useState(false);
  const [speaking, setSpeaking] = useState<'user' | 'conductor' | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const history = useRef<Sample[]>([]);
  const lastSample = useRef(0);
  const lastHeard = useRef({ user: 0, conductor: 0 });

  // Stay mounted through the exit animation.
  useEffect(() => {
    if (status !== 'idle') { setMounted(true); return; }
    const t = setTimeout(() => { setMounted(false); history.current = []; }, reducedMotion() ? 0 : 320);
    return () => clearTimeout(t);
  }, [status]);

  const open = status !== 'idle';
  const phase: Phase = status === 'connecting' ? 'connecting'
    : status === 'closing' || status === 'idle' ? 'closing'
    : speaking === 'conductor' ? 'speaking'
    : muted ? 'muted'
    : thinking ? 'thinking'
    : speaking === 'user' ? 'hearing'
    : 'listening';

  useFrame(mounted, (t) => {
    const cv = canvas.current;
    if (!cv) return;
    const { user, conductor } = voice.levels();
    if (user > SPEAK_THRESHOLD) lastHeard.current.user = t;
    if (conductor > SPEAK_THRESHOLD) lastHeard.current.conductor = t;
    const now: 'user' | 'conductor' | null = t - lastHeard.current.conductor < SPEAK_HOLD_MS ? 'conductor'
      : t - lastHeard.current.user < SPEAK_HOLD_MS ? 'user' : null;
    setSpeaking((prev) => (prev === now ? prev : now));

    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    const n = Math.floor(w / (BAR_W + BAR_GAP));
    if (t - lastSample.current >= SAMPLE_MS) {
      lastSample.current = t;
      history.current.push({ v: Math.max(user, conductor), who: conductor >= user ? 'conductor' : 'user' });
      if (history.current.length > n) history.current.splice(0, history.current.length - n);
    }

    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    // A faint five-line staff behind the music.
    g.fillStyle = 'rgba(255,255,255,0.045)';
    for (let i = 0; i < 5; i++) g.fillRect(0, Math.round(h * (0.18 + i * 0.16)), w, 1);

    const mid = h / 2;
    const hist = history.current;
    const offset = n - hist.length; // new bars enter from the right
    const sweep = voice.getState().thinking && !reducedMotion() ? ((t / 1400) % 1) * n : -1;
    for (let i = 0; i < n; i++) {
      const s = hist[i - offset];
      const x = i * (BAR_W + BAR_GAP);
      const age = i / n; // 0 = oldest (left), 1 = now (right)
      const baton = sweep >= 0 ? Math.exp(-(((i - sweep) / 5) ** 2)) : 0;
      const v = Math.max(s?.v ?? 0, baton * 0.22);
      if (v < 0.02) {
        g.fillStyle = `rgba(169,175,184,${0.1 + 0.12 * age})`;
        g.fillRect(x, mid - 1, BAR_W, 2);
        continue;
      }
      const bh = Math.max(2, Math.pow(v, 0.7) * h * 0.86);
      const [r, gg, b] = s && s.v >= baton * 0.22 && s.who === 'user' ? USER_RGB : CONDUCTOR_RGB;
      g.fillStyle = `rgba(${r},${gg},${b},${0.28 + 0.72 * age})`;
      roundBar(g, x, mid - bh / 2, BAR_W, bh);
    }
  });

  if (!mounted) return null;
  const lines = captions.slice(-3);
  return (
    <div
      className={`dock dock--${phase}${open ? ' dock--open' : ' dock--leaving'}`}
      role="region"
      aria-label="Conductor voice conversation"
    >
      <div className="dock__head">
        <span className="dock__mark">Conductor</span>
        <span className="dock__status" aria-live="polite"><i />{PHASE_LABEL[phase]}</span>
        <span className="spacer" />
        <button
          className={`dock__btn${muted ? ' dock__btn--on' : ''}`}
          onClick={() => voice.toggleMute()}
          disabled={status !== 'live'}
          aria-pressed={muted}
          title={muted ? 'Unmute (m)' : 'Mute (m)'}
        >
          {muted ? <MicOffIcon /> : <MicIcon />}
          <span>{muted ? 'Unmute' : 'Mute'}</span>
          <kbd>m</kbd>
        </button>
        <button className="dock__btn dock__btn--end" onClick={() => voice.stop()} disabled={!open} title="End the conversation (v)">
          <EndIcon /><span>End</span>
        </button>
      </div>
      <div className="dock__wave"><canvas ref={canvas} /></div>
      <div className="dock__captions" aria-live="polite">
        {lines.length === 0 ? (
          <p className="dock__hint">{status === 'connecting' ? 'Tuning up…' : <>Try <q>What needs me?</q> or <q>What’s running?</q></>}</p>
        ) : (
          lines.map((c, i) => (
            <p key={c.id} className={`line line--${c.role}`}>
              {/* Name the speaker once per run of lines. */}
              <span className="line__who">{lines[i - 1]?.role === c.role ? '' : c.role === 'user' ? 'You' : 'Conductor'}</span>
              <span className="line__text">{c.text}</span>
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function roundBar(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const r = Math.min(w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.fill();
}

const icon = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const MicIcon = () => (
  <svg {...icon}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
const MicOffIcon = () => (
  <svg {...icon}><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" /></svg>
);
const EndIcon = () => (
  <svg {...icon}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
