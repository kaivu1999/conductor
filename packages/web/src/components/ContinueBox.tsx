import { forwardRef, useImperativeHandle, useRef, useState } from 'react';
import type { Run } from '@conductor/shared';
import { useAction } from '../useRunActions.ts';

export interface ContinueBoxHandle { focus(): void }

/**
 * Send a finished (or conflicted) run back to its agent with more instructions. The agent
 * resumes its own session in the same worktree, so it keeps its context and earlier work.
 */
export const ContinueBox = forwardRef<ContinueBoxHandle, { run: Run }>(function ContinueBox({ run }, ref) {
  const [text, setText] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const { pending, run: act, src } = useAction();
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  const send = async () => {
    if (!text.trim() || pending) return;
    const r = await act('continue', () => src.continueRun(run.id, text.trim()));
    if (r) setText('');
  };

  return (
    <section className="continue" aria-label="Continue this run">
      <div className="continue__head">
        <span className="continue__title">Not quite there? Keep going.</span>
        <span className="muted">
          {run.state === 'conflict'
            ? `The agent gets the conflict details; ask it to rebase onto ${run.baseBranch}.`
            : 'The agent resumes with its context and the work so far.'}
        </span>
      </div>
      <div className="continue__free">
        <textarea
          ref={input}
          rows={2}
          value={text}
          placeholder={run.state === 'conflict'
            ? `Tell the agent what to change…  e.g. Rebase onto ${run.baseBranch} and resolve the conflict.`
            : 'Tell the agent what to change…  e.g. Also add a toggle in the header.'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send(); }
            else if (e.key === 'Escape') input.current?.blur();
          }}
        />
        <button className="btn" disabled={!text.trim() || !!pending} onClick={send}>
          {pending ? 'Sending…' : 'Continue'} <kbd>⌘↵</kbd>
        </button>
      </div>
    </section>
  );
});
