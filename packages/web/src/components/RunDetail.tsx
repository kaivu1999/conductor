import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Run } from '@conductor/shared';
import { isLive } from '@conductor/shared';
import { clock, cost, duration, plural } from '../format.ts';
import { attentionReason, staleMinutes } from '../stateMeta.ts';
import { ActionBar, CONTINUE_STATES } from './ActionBar.tsx';
import { AnswerBox, type AnswerBoxHandle } from './AnswerBox.tsx';
import { ContinueBox, type ContinueBoxHandle } from './ContinueBox.tsx';
import { DiffStatBadge, TestBadge } from './Badges.tsx';
import { ReviewPanel } from './ReviewPanel.tsx';
import { StateChip } from './StateChip.tsx';
import { Timeline } from './Timeline.tsx';

type Tab = 'review' | 'activity';

const defaultTab = (r: Run): Tab => (['ready', 'conflict', 'accepted', 'accepting'].includes(r.state) ? 'review' : 'activity');

export interface RunDetailHandle { focusAnswer(): void; focusContinue(): void }

export const RunDetail = forwardRef<RunDetailHandle, { run: Run; now: number; onSelect(id: string): void }>(
  function RunDetail({ run, now, onSelect }, ref) {
    const [tab, setTab] = useState<Tab>(defaultTab(run));
    const [taskOpen, setTaskOpen] = useState(false);
    const answer = useRef<AnswerBoxHandle>(null);
    const follow = useRef<ContinueBoxHandle>(null);
    useImperativeHandle(ref, () => ({ focusAnswer: () => answer.current?.focus(), focusContinue: () => follow.current?.focus() }), []);

    // New run selected → reset tab. Same run moving into review → switch to review.
    const lastId = useRef(run.id);
    const lastState = useRef(run.state);
    useEffect(() => {
      if (lastId.current !== run.id) { setTab(defaultTab(run)); setTaskOpen(false); }
      else if (lastState.current !== run.state && defaultTab(run) === 'review') setTab('review');
      lastId.current = run.id;
      lastState.current = run.state;
    }, [run.id, run.state]); // eslint-disable-line react-hooks/exhaustive-deps

    const reason = attentionReason(run, now);
    const stale = staleMinutes(run, now);
    const end = run.finishedAt ?? (isLive(run.state) ? now : run.updatedAt);
    const multiLineTask = run.task.trim() !== run.title.trim();

    return (
      <article className="detail">
        <header className="detail__head">
          <div className="detail__titleRow">
            <StateChip state={run.state} />
            <h2 className="detail__title">{run.title}</h2>
          </div>
          {reason && <div className={`detail__reason detail__reason--${run.state}`}>{reason}</div>}
          {multiLineTask && (
            <div className={`detail__task${taskOpen ? ' open' : ''}`}>
              <button className="link" onClick={() => setTaskOpen(!taskOpen)}>{taskOpen ? '▾ Hide full task' : '▸ Show full task'}</button>
              {taskOpen && <pre className="detail__taskText">{run.task}</pre>}
            </div>
          )}
          <dl className="facts">
            <div><dt>Repo</dt><dd title={run.repoPath}>{run.repoName}</dd></div>
            <div><dt>Branch</dt><dd className="mono">{run.branch}</dd></div>
            <div><dt>Base</dt><dd className="mono">{run.baseBranch}{run.baseCommit ? `@${run.baseCommit.slice(0, 7)}` : ''}</dd></div>
            <div><dt>Attempt</dt><dd>#{run.attempt}</dd></div>
            <div><dt>Cost</dt><dd className="mono">{cost(run.costUsd)} · {plural(run.turns, 'turn')}</dd></div>
            <div><dt>Elapsed</dt><dd className="mono">{run.startedAt ? duration(end - run.startedAt) : '—'}</dd></div>
            <div><dt>Created</dt><dd>{clock(run.createdAt)}</dd></div>
            {run.finishedAt && <div><dt>Finished</dt><dd>{clock(run.finishedAt)}</dd></div>}
            {(run.diffStat || run.tests) && (
              <div><dt>Result</dt><dd className="facts__badges">
                {run.diffStat && <DiffStatBadge stat={run.diffStat} />}
                {run.tests && <TestBadge tests={run.tests} />}
              </dd></div>
            )}
          </dl>
          <ActionBar run={run} onAnswer={() => answer.current?.focus()} onContinue={() => follow.current?.focus()} />
        </header>

        {run.error && <ErrorBanner run={run} />}
        {stale && !run.error && (
          <div className="banner banner--warn">
            No agent activity for {duration(stale * 60_000)}. Last: <span className="mono">{run.activity || '—'}</span>.
            It may be stuck on a long command — check the Activity tab, send it a message, or Stop it.
          </div>
        )}

        {run.state === 'waiting_input' && run.pendingQuestion && (
          <AnswerBox key={run.pendingQuestion.id} ref={answer} run={run} now={now} />
        )}
        {CONTINUE_STATES.includes(run.state) && <ContinueBox key={run.id} ref={follow} run={run} />}

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'review'} className={`tab${tab === 'review' ? ' tab--on' : ''}`} onClick={() => setTab('review')}>
            Review {run.diffStat && <span className="tab__count">{run.diffStat.files}</span>}
          </button>
          <button role="tab" aria-selected={tab === 'activity'} className={`tab${tab === 'activity' ? ' tab--on' : ''}`} onClick={() => setTab('activity')}>
            Activity {isLive(run.state) && <span className="pulse-dot" />}
          </button>
        </div>
        <div className={`tabpanel tabpanel--${tab}`}>
          {tab === 'review' ? <ReviewPanel run={run} onSelect={onSelect} /> : <Timeline run={run} now={now} />}
        </div>
      </article>
    );
  },
);

function ErrorBanner({ run }: { run: Run }) {
  let next = '';
  switch (run.state) {
    case 'conflict':
      next = `Reject it, or resolve the conflict on branch ${run.branch}${run.worktreePath ? ` (worktree ${run.worktreePath})` : ''} and click Retry merge.`;
      break;
    case 'interrupted':
      next = run.sessionId ? 'Resume continues the same agent session in the same worktree.' : 'Restart runs the task again in the same worktree.';
      break;
    case 'failed':
      next = run.sessionId ? 'Resume to let the agent retry with its context, or Reject to discard.' : 'Restart, or Reject to discard.';
      break;
  }
  return (
    <div className={`banner ${run.state === 'interrupted' ? 'banner--warn' : 'banner--bad'}`}>
      <strong>{run.error}</strong>
      {next && <div className="banner__next">Next: {next}</div>}
    </div>
  );
}
