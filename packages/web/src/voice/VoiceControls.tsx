import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { stripNonSpeech } from '@conductor/shared';
import { useToast } from '../components/Toasts.tsx';
import { isMock } from '../useConductor.ts';
import { VoiceSession, type Caption, type VoiceState } from './session.ts';
import { Aurora, fit, type Phase } from './aurora.ts';

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

/**
 * Run `draw` every animation frame of `win` while `active`. Drawing goes straight to the
 * DOM/canvas, not React state. The pop-out passes its own window: a background tab's
 * frames stop, the always-on-top window's don't.
 */
function useFrame(active: boolean, draw: (t: number) => void, win: Window = window) {
  const ref = useRef(draw);
  ref.current = draw;
  useEffect(() => {
    if (!active) return;
    let warned = false;
    let id = win.requestAnimationFrame(function loop(t) {
      // A drawing bug must not freeze the animation: log once, keep going.
      try { ref.current(t); } catch (err) { if (!warned) { warned = true; console.error('[voice] frame failed', err); } }
      id = win.requestAnimationFrame(loop);
    });
    return () => win.cancelAnimationFrame(id);
  }, [active, win]);
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

// ─── aurora bar ──────────────────────────────────────────────────────────────

const PHASE_LABEL: Record<Phase, string> = {
  connecting: 'Tuning up',
  listening: 'Listening',
  hearing: 'Listening',
  thinking: 'Thinking',
  speaking: 'Speaking',
  muted: 'Muted',
  closing: 'Ending',
};

/** Normalized level above which a side counts as speaking, and how long it holds the floor after. */
const SPEAK_AT = 0.16;
/** Conductor pauses between words and sentences; hold its floor longer so the colour doesn't flicker. */
const HOLD_MS = { user: 450, conductor: 900 };

interface DocumentPictureInPicture { requestWindow(opts?: { width?: number; height?: number }): Promise<Window> }
const pipApi = (): DocumentPictureInPicture | undefined =>
  (window as unknown as { documentPictureInPicture?: DocumentPictureInPicture }).documentPictureInPicture;

/** Subtitles show the newest words: a long line keeps its tail, cut at a word. */
function tail(text: string, max = 150): string {
  if (text.length <= max) return text;
  const cut = text.slice(-max);
  return `…${cut.slice(cut.indexOf(' ') + 1)}`;
}

/** Spoken lines with the transcriber's "[clear throat]"-style tags removed; empty ones dropped. */
function spoken(captions: Caption[]): Caption[] {
  return captions.map((c) => ({ ...c, text: stripNonSpeech(c.text) })).filter((c) => c.text);
}

/**
 * The live conversation: a band of light along the bottom edge whose colour and motion are
 * the state (teal listening, brighter as you speak, violet thinking, magenta when Conductor
 * speaks, grey muted, amber connecting), one line of subtitles above it, and the controls
 * at its ends. Pops out into a small always-on-top orb where the browser allows it.
 */
export function VoiceDock() {
  const status = useVoice((s) => s.status);
  const muted = useVoice((s) => s.muted);
  const thinking = useVoice((s) => s.thinking);
  const captions = useVoice((s) => s.captions);
  const [mounted, setMounted] = useState(false);
  const [who, setWho] = useState<'user' | 'conductor' | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [pip, setPip] = useState<Window | null>(null);
  const band = useRef<HTMLCanvasElement>(null);
  const orb = useRef<HTMLCanvasElement>(null);
  const aurora = useRef<Aurora | null>(null);
  aurora.current ??= new Aurora();
  const heard = useRef({ user: 0, conductor: 0 });

  const open = status !== 'idle';
  const phase: Phase = status === 'connecting' ? 'connecting'
    : status === 'closing' || status === 'idle' ? 'closing'
    : who === 'conductor' ? 'speaking'
    : muted ? 'muted'
    : thinking ? 'thinking'
    : who === 'user' ? 'hearing'
    : 'listening';
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Stay mounted through the exit animation.
  useEffect(() => {
    if (status !== 'idle') { setMounted(true); return; }
    setExpanded(false);
    const t = setTimeout(() => setMounted(false), reducedMotion() ? 0 : 420);
    return () => clearTimeout(t);
  }, [status]);

  // Ending the conversation closes the pop-out; closing the pop-out does not end it.
  useEffect(() => { if (status === 'idle' && pip) pip.close(); }, [status, pip]);

  useFrame(mounted, (t) => {
    const a = aurora.current!;
    a.still = reducedMotion();
    const { user, conductor } = voice.levels();
    if (conductor > SPEAK_AT) heard.current.conductor = t;
    if (user > SPEAK_AT) heard.current.user = t;
    const now = t - heard.current.conductor < HOLD_MS.conductor ? 'conductor' : t - heard.current.user < HOLD_MS.user ? 'user' : null;
    setWho((prev) => (prev === now ? prev : now));
    const ph = phaseRef.current;
    const level = ph === 'speaking' ? conductor : ph === 'hearing' || ph === 'listening' ? user : 0;
    a.update(ph, level, t, voice.getState().status !== 'idle' && voice.getState().status !== 'closing');
    if (band.current && !pip) {
      const { w, h } = fit(band.current);
      a.drawBand(band.current.getContext('2d')!, w, h);
    }
    if (orb.current && pip) {
      const { w } = fit(orb.current, pip);
      a.drawOrb(orb.current.getContext('2d')!, w, Math.max(user, conductor));
    }
  }, pip ?? window);

  async function popOut() {
    const api = pipApi();
    if (!api || pip) return;
    try {
      const win = await api.requestWindow({ width: 220, height: 260 });
      copyStyles(document, win.document);
      win.document.title = 'Conductor';
      win.document.body.className = 'pip-body';
      win.addEventListener('keydown', (e) => {
        if (e.key === 'm') voice.toggleMute();
        else if (e.key === 'v' || e.key === 'Escape') voice.stop();
      });
      win.addEventListener('pagehide', () => setPip(null), { once: true });
      setPip(win);
    } catch (err) {
      console.warn('[voice] pop-out failed', err);
    }
  }

  if (!mounted) return null;
  const lines = spoken(captions);
  const latest = lines.at(-1) ?? null;
  const hint = status === 'connecting' ? 'Tuning up…' : 'Try “What needs me?”';
  const tint = phase === 'hearing' || (phase !== 'speaking' && latest?.role === 'user') ? 'user' : 'conductor';

  const mic = (
    <button
      className={`au-btn${muted ? ' au-btn--on' : ''}`}
      onClick={() => voice.toggleMute()}
      disabled={status !== 'live'}
      aria-pressed={muted}
      title={muted ? 'Unmute (m)' : 'Mute (m)'}
      aria-label={muted ? 'Unmute' : 'Mute'}
    >
      {muted ? <MicOffIcon /> : <MicIcon />}
    </button>
  );
  const end = (
    <button className="au-btn au-btn--end" onClick={() => voice.stop()} disabled={!open} title="End the conversation (v)" aria-label="End the conversation">
      <EndIcon />
    </button>
  );

  return (
    <>
      <div
        className={`aurora aurora--${phase}${open ? ' aurora--open' : ' aurora--leaving'}${pip ? ' aurora--popped' : ''}`}
        role="region"
        aria-label="Conversation with Conductor"
      >
        <canvas ref={band} className="aurora__light" aria-hidden />
        {expanded && lines.length > 0 ? (
          // The transcript takes the subtitle's place; clicking it folds back to one line.
          <button className="aurora__transcript" onClick={() => setExpanded(false)} aria-expanded title="Hide transcript" aria-label="Transcript">
            {lines.slice(-8).map((c, i, arr) => (
              <p key={c.id} className={`au-line au-line--${c.role}`}>
                <span className="au-line__who">{arr[i - 1]?.role === c.role ? '' : c.role === 'user' ? 'You' : 'Conductor'}</span>
                <span className="au-line__text">{c.text}</span>
              </p>
            ))}
          </button>
        ) : (
          <button
            className={`aurora__subtitle aurora__subtitle--${tint}${latest ? '' : ' aurora__subtitle--hint'}`}
            onClick={() => lines.length && setExpanded(true)}
            aria-expanded={false}
            title={lines.length ? 'Show transcript' : undefined}
            aria-live="polite"
          >
            <span key={latest?.id ?? 'hint'} className="aurora__subtitle-text">{latest ? tail(latest.text) : hint}</span>
          </button>
        )}
        <div className="aurora__bar">
          {mic}
          <span className="aurora__mark">Conductor</span>
          <span className="aurora__status">{pip ? 'In its own window' : PHASE_LABEL[phase]}</span>
          <span className="spacer" />
          {pipApi() && (
            pip
              ? <button className="au-btn" onClick={() => pip.close()} title="Bring Conductor back into the page" aria-label="Bring back"><PopInIcon /></button>
              : <button className="au-btn" onClick={() => void popOut()} disabled={!open} title="Pop out into a small floating window" aria-label="Pop out"><PopOutIcon /></button>
          )}
          {end}
        </div>
      </div>
      {pip && createPortal(
        <PipOrb phase={phase} line={latest ? tail(latest.text, 90) : hint} canvas={orb} mic={mic} end={end} />,
        pip.document.body,
      )}
    </>
  );
}

/** The pop-out: just the voice. A small orb of the same light, the latest line, mute and end. */
function PipOrb({ phase, line, canvas, mic, end }: { phase: Phase; line: string; canvas: React.RefObject<HTMLCanvasElement>; mic: ReactNode; end: ReactNode }) {
  return (
    <div className={`pip pip--${phase}`}>
      <canvas ref={canvas} className="pip__orb" title={line} />
      <p className="pip__status">{PHASE_LABEL[phase]}</p>
      <p className="pip__line" title={line}>{line}</p>
      <div className="pip__controls">{mic}{end}</div>
    </div>
  );
}

/** A Picture-in-Picture document starts empty: bring the page's styles along. */
function copyStyles(from: Document, to: Document) {
  for (const sheet of Array.from(from.styleSheets)) {
    try {
      const style = to.createElement('style');
      style.textContent = Array.from(sheet.cssRules).map((r) => r.cssText).join('\n');
      to.head.appendChild(style);
    } catch {
      if (!sheet.href) continue;
      const link = to.createElement('link');
      link.rel = 'stylesheet';
      link.href = sheet.href;
      to.head.appendChild(link);
    }
  }
}

const icon = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true };
const MicIcon = () => (
  <svg {...icon}><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></svg>
);
const MicOffIcon = () => (
  <svg {...icon}><path d="M15 9.3V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.6 2.8M12 18v3M3 3l18 18" /></svg>
);
const EndIcon = () => (
  <svg {...icon}><path d="M6 6l12 12M18 6L6 18" /></svg>
);
const PopOutIcon = () => (
  <svg {...icon}><path d="M14 4h6v6M20 4l-8 8M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4" /></svg>
);
const PopInIcon = () => (
  <svg {...icon}><path d="M4 14h6v6M10 14l-7 7M18 4H8a2 2 0 0 0-2 2v4M20 8v10a2 2 0 0 1-2 2h-4" /></svg>
);
