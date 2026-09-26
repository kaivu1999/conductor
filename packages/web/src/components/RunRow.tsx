import type { Run } from '@conductor/shared';
import { isLive } from '@conductor/shared';
import { cost, duration, relTime } from '../format.ts';
import { staleMinutes } from '../stateMeta.ts';
import { StateChip } from './StateChip.tsx';
import { DiffStatBadge, OverlapIcon, TestBadge } from './Badges.tsx';

interface Props {
  run: Run;
  now: number;
  selected: boolean;
  onSelect(id: string): void;
}

export function RunRow({ run, now, selected, onSelect }: Props) {
  const stale = staleMinutes(run, now);
  const end = run.finishedAt ?? (isLive(run.state) || run.state === 'accepting' ? now : run.updatedAt);
  const elapsed = run.startedAt ? duration(end - run.startedAt) : null;
  const q = run.state === 'waiting_input' ? run.pendingQuestion : null;

  return (
    <li
      className={`row row--${run.state}${selected ? ' row--selected' : ''}`}
      onClick={() => onSelect(run.id)}
      data-run-id={run.id}
      aria-selected={selected}
    >
      <div className="row__top">
        <StateChip state={run.state} />
        <span className="row__title" title={run.task}>{run.title}</span>
        {run.overlaps.length > 0 && <OverlapIcon overlaps={run.overlaps} />}
      </div>

      <div className="row__repo">
        <span>{run.repoName}</span>
        <span className="sep">/</span>
        <span className="mono">{run.branch}</span>
        {run.attempt > 1 && <span className="row__attempt">attempt {run.attempt}</span>}
      </div>

      {q ? (
        <div className="row__question">
          <span className="row__q-mark">Q</span>
          <span className="row__q-text">{q.question}</span>
        </div>
      ) : run.state === 'queued' ? (
        <div className="row__activity muted">{run.activity || 'Waiting for a free slot'}</div>
      ) : (
        <div className={`row__activity${stale ? ' row__activity--stale' : ''}`}>
          <span className="row__activity-text">{run.error && !isLive(run.state) ? run.error : run.activity || '—'}</span>
          <span className="row__activity-when">
            {stale ? `no activity for ${duration(stale * 60_000)}` : relTime(run.activityAt, now)}
          </span>
        </div>
      )}

      <div className="row__meta">
        <span className="mono">{cost(run.costUsd)}</span>
        {elapsed && <span className="mono" title="Elapsed">{elapsed}</span>}
        {run.diffStat && <DiffStatBadge stat={run.diffStat} />}
        {run.tests && <TestBadge tests={run.tests} />}
      </div>
    </li>
  );
}
