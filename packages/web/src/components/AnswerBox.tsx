import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { Run } from '@conductor/shared';
import { relTime } from '../format.ts';
import { useAction } from '../useRunActions.ts';

export interface AnswerBoxHandle { focus(): void }

export const AnswerBox = forwardRef<AnswerBoxHandle, { run: Run; now: number }>(function AnswerBox({ run, now }, ref) {
  const q = run.pendingQuestion!;
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const { pending, run: act, src } = useAction();
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const send = async (answer: string) => {
    if (!answer.trim() || pending) return;
    const r = await act('answer', () => src.answer(run.id, q.id, answer.trim()));
    if (r) setText('');
  };

  return (
    <section className="answer" aria-label="Agent question">
      <div className="answer__head">
        <span className="answer__badge">? The agent is waiting for you</span>
        <span className="muted">asked {relTime(q.askedAt, now)}</span>
      </div>
      <p className="answer__q">{q.question}</p>
      {q.options && q.options.length > 0 && (
        <div className="answer__options">
          {q.options.map((o, i) => (
            <button key={o} className="btn btn--option" disabled={!!pending} onClick={() => send(o)}>
              <kbd>{i + 1}</kbd> {o}
            </button>
          ))}
        </div>
      )}
      <div className="answer__free">
        <textarea
          ref={input}
          rows={2}
          value={text}
          placeholder={q.options?.length ? 'Or type your own answer…  (Enter to send, Shift+Enter for newline)' : 'Type your answer…  (Enter to send, Shift+Enter for newline)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send(text); }
            else if (!text && q.options && /^[1-9]$/.test(e.key)) {
              const opt = q.options[Number(e.key) - 1];
              if (opt) { e.preventDefault(); void send(opt); }
            } else if (e.key === 'Escape') input.current?.blur();
          }}
        />
        <button className="btn btn--ask" disabled={!text.trim() || !!pending} onClick={() => send(text)}>
          {pending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </section>
  );
});
