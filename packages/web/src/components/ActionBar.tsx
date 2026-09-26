import { useEffect, useRef, useState } from 'react';
import type { Run } from '@conductor/shared';
import { TRANSITIONS, canTransition, isLive } from '@conductor/shared';
import { useAction } from '../useRunActions.ts';

/** Finished runs you can send back to the agent with more instructions (Continue). */
export const CONTINUE_STATES: readonly Run['state'][] = ['ready', 'conflict'];

/** Buttons derived from TRANSITIONS so the UI never offers an illegal move. */
export function ActionBar({ run, onAnswer, onContinue }: { run: Run; onAnswer(): void; onContinue(): void }) {
  const { pending, run: act, src } = useAction();
  const next = TRANSITIONS[run.state];
  const canAccept = canTransition(run.state, 'accepting');
  const canReject = canTransition(run.state, 'rejected');
  // ready/conflict → queued is Continue (with instructions, below), not a plain restart.
  const canRestart = canTransition(run.state, 'queued') && !CONTINUE_STATES.includes(run.state);
  const canContinue = CONTINUE_STATES.includes(run.state);
  const canCancel = next.includes('cancelled');
  const busy = !!pending;
  const testsFailed = run.tests && !run.tests.passed;

  const confirmThen = (msg: string, fn: () => void) => () => { if (window.confirm(msg)) fn(); };

  return (
    <div className="actions">
      {run.state === 'waiting_input' && (
        <button className="btn btn--ask" onClick={onAnswer}>Answer <kbd>a</kbd></button>
      )}
      {canAccept && (
        <AcceptMenu
          disabled={busy}
          label={pending === 'accept' ? 'Merging…' : run.state === 'conflict' ? 'Retry merge' : 'Accept & merge'}
          warn={!!testsFailed}
          neutral={run.state === 'conflict'}
          baseBranch={run.baseBranch}
          branch={run.branch}
          onPick={(mode) => {
            if (testsFailed && mode === 'merge' && !window.confirm(`Tests failed on this run. Merge into ${run.baseBranch} anyway?`)) return;
            void act('accept', () => src.accept(run.id, mode));
          }}
        />
      )}
      {canContinue && (
        <button className="btn" disabled={busy} onClick={onContinue} title="Send it back to the agent with more instructions">
          Continue… <kbd>c</kbd>
        </button>
      )}
      {canRestart && (
        <button className="btn btn--primary" disabled={busy} onClick={() => act('restart', () => src.restart(run.id))}>
          {pending === 'restart' ? 'Restarting…' : run.sessionId ? 'Resume' : 'Restart'}
        </button>
      )}
      {canReject && (
        <button className="btn btn--danger-ghost" disabled={busy}
          onClick={confirmThen(`Reject "${run.title}"? The branch ${run.branch} and its worktree will be discarded.`,
            () => void act('reject', () => src.reject(run.id)))}>
          Reject
        </button>
      )}
      {canCancel && (
        <button className="btn btn--danger-ghost" disabled={busy}
          onClick={confirmThen(`Cancel "${run.title}"? The agent will be stopped (the worktree is kept; you can restart later).`,
            () => void act('cancel', () => src.cancel(run.id)))}>
          {pending === 'cancel' ? 'Cancelling…' : isLive(run.state) ? 'Stop' : 'Cancel'}
        </button>
      )}
    </div>
  );
}

function AcceptMenu({ label, disabled, warn, neutral, onPick, baseBranch, branch }: {
  label: string; disabled: boolean; warn: boolean; neutral: boolean; baseBranch: string; branch: string; onPick(mode: 'merge' | 'branch'): void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const tone = neutral ? '' : warn ? 'btn--warn' : 'btn--good';
  return (
    <div className="split" ref={ref}>
      <button className={`btn ${tone} split__main`} disabled={disabled} onClick={() => onPick('merge')}
        title={`Merge ${branch} into ${baseBranch}`}>
        {label}
      </button>
      <button className={`btn ${tone} split__caret`} disabled={disabled} onClick={() => setOpen(!open)} aria-label="More accept options">▾</button>
      {open && (
        <div className="menu">
          <button className="menu__item" onClick={() => { setOpen(false); onPick('merge'); }}>
            <strong>Merge into {baseBranch}</strong>
            <span className="muted">Merge the branch and clean up the worktree</span>
          </button>
          <button className="menu__item" onClick={() => { setOpen(false); onPick('branch'); }}>
            <strong>Keep branch only</strong>
            <span className="muted">Leave <code>{branch}</code> for you to merge or open a PR</span>
          </button>
        </div>
      )}
    </div>
  );
}
