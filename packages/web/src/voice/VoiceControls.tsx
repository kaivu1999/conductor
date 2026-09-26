import { useEffect, useSyncExternalStore } from 'react';
import { useToast } from '../components/Toasts.tsx';
import { isMock } from '../useConductor.ts';
import { VoiceSession, type VoiceState } from './session.ts';

export const voice = new VoiceSession();

export function useVoice<T>(select: (s: VoiceState) => T): T {
  return useSyncExternalStore(voice.subscribe, () => select(voice.getState()));
}

const LABEL = { idle: 'Voice', connecting: 'Connecting…', live: 'Listening', closing: 'Ending…' } as const;

/** Header mic button. Click toggles the session; errors surface as toasts. */
export function VoiceButton() {
  const status = useVoice((s) => s.status);
  const error = useVoice((s) => s.error);
  const toast = useToast();
  useEffect(() => { if (error) toast(error); }, [error, toast]);
  // Don't leave the mic open if the page goes away.
  useEffect(() => {
    const bye = () => voice.stop();
    window.addEventListener('pagehide', bye);
    return () => window.removeEventListener('pagehide', bye);
  }, []);

  const on = status !== 'idle';
  return (
    <button
      className={`btn voice-btn voice-btn--${status}`}
      onClick={() => (on ? voice.stop() : void voice.start())}
      disabled={isMock || status === 'closing'}
      title={isMock ? 'Voice needs the conductor server' : on ? 'End the voice session' : 'Talk to conductor'}
      aria-pressed={on}
    >
      <span className="voice-btn__dot" />
      {LABEL[status]}
    </button>
  );
}

/** The last few lines of the conversation, shown only while a session is open. */
export function Captions() {
  const status = useVoice((s) => s.status);
  const captions = useVoice((s) => s.captions);
  if (status === 'idle') return null;
  return (
    <div className="captions" aria-live="polite">
      {captions.length === 0 ? (
        <span className="muted">{status === 'live' ? 'Say something — "what needs me?"' : 'Connecting…'}</span>
      ) : (
        captions.map((c) => (
          <div key={c.id} className={`caption caption--${c.role}`}>
            <span className="caption__who">{c.role === 'user' ? 'you' : 'conductor'}</span>
            <span className="caption__text">{c.text}</span>
          </div>
        ))
      )}
    </div>
  );
}
