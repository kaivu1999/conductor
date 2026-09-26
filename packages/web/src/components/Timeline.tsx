import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Run, RunEvent } from '@conductor/shared';
import { isLive } from '@conductor/shared';
import { clock, relTime } from '../format.ts';
import { useConductor, useStore } from '../useConductor.ts';
import { useAction } from '../useRunActions.ts';

const ICON: Record<RunEvent['kind'], string> = {
  state: '→', tool: '⚙', text: '✎', question: '?', answer: '↩', test: '⚗', error: '!', system: '·',
};

export function Timeline({ run, now }: { run: Run; now: number }) {
  const store = useStore();
  const events = useConductor((s) => s.events[run.id]);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  useEffect(() => {
    setError(null);
    pinned.current = true;
    store.loadEvents(run.id).catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [run.id, store]);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [events?.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (el) pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const live = isLive(run.state);

  return (
    <div className="timeline">
      <div className="timeline__scroll" ref={scroller} onScroll={onScroll}>
        {error && <div className="banner banner--bad">{error}</div>}
        {!events && !error && <div className="muted pad">Loading activity…</div>}
        {events?.length === 0 && <div className="muted pad">No activity yet.</div>}
        <ol className="events">
          {events?.map((e) => <EventItem key={e.id} e={e} now={now} />)}
        </ol>
        {live && run.state !== 'waiting_input' && (
          <div className="timeline__now">
            <span className="pulse-dot" /> {run.activity || 'Working…'}
          </div>
        )}
      </div>
      {live && <MessageInput run={run} />}
    </div>
  );
}

function EventItem({ e, now }: { e: RunEvent; now: number }) {
  if (e.kind === 'question' || e.kind === 'answer') {
    return (
      <li className={`ev ev--chat ev--${e.kind}`}>
        <div className="bubble">
          <div className="bubble__who">{e.kind === 'question' ? 'Agent asked' : 'You'}</div>
          <div className="bubble__text">{e.text}</div>
        </div>
        <time className="ev__time" title={clock(e.ts)}>{relTime(e.ts, now)}</time>
      </li>
    );
  }
  return (
    <li className={`ev ev--${e.kind}`}>
      <span className="ev__icon" aria-hidden>{ICON[e.kind]}</span>
      <span className="ev__text">{e.text}</span>
      <time className="ev__time" title={clock(e.ts)}>{relTime(e.ts, now)}</time>
    </li>
  );
}

function MessageInput({ run }: { run: Run }) {
  const [text, setText] = useState('');
  const { pending, run: act, src } = useAction();
  const send = async () => {
    if (!text.trim() || pending) return;
    const r = await act('message', () => src.message(run.id, text.trim()));
    if (r) setText('');
  };
  return (
    <div className="msg">
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); void send(); } }}
        placeholder="Send a message to the agent (steer it mid-run)…"
      />
      <button className="btn" disabled={!text.trim() || !!pending} onClick={send}>{pending ? 'Sending…' : 'Send'}</button>
    </div>
  );
}
