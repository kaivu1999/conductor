import { useState } from 'react';
import type { Run } from '@conductor/shared';
import { durationPrecise } from '../format.ts';
import { useAsync, useStore } from '../useConductor.ts';
import { DiffView } from './DiffView.tsx';
import { Markdownish } from './Markdownish.tsx';

export function ReviewPanel({ run, onSelect }: { run: Run; onSelect(id: string): void }) {
  const store = useStore();
  // Refetch the diff when the run's content changes (updatedAt moves on every snapshot; diffStat is the cheaper proxy).
  const statKey = run.diffStat ? `${run.diffStat.files}:${run.diffStat.insertions}:${run.diffStat.deletions}` : 'none';
  const diff = useAsync(() => store.src.diff(run.id), [run.id, statKey, run.state === 'ready']);
  const overlapPaths = new Set(run.overlaps.flatMap((o) => o.paths));

  return (
    <div className="review">
      <section className="card">
        <h3 className="card__title">Agent summary</h3>
        {run.summary ? <Markdownish text={run.summary} /> : <p className="muted">The agent hasn't written a summary{run.state === 'running' ? ' yet' : ''}.</p>}
      </section>

      {run.tests && <TestCard run={run} />}

      {run.overlaps.length > 0 && (
        <section className="card card--warn">
          <h3 className="card__title">⚠ Overlaps with other runs</h3>
          <p className="muted">Merging both may conflict. Review them together.</p>
          <ul className="overlaps">
            {run.overlaps.map((o) => (
              <li key={o.runId}>
                <button className="link" onClick={() => onSelect(o.runId)}>{o.title}</button>
                <span className="muted"> also changed </span>
                <span className="mono">{o.paths.join(', ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card card--flush">
        <h3 className="card__title pad-x">Changes</h3>
        {diff.loading && !diff.data && <div className="muted pad">Loading diff…</div>}
        {diff.error && (
          <div className="banner banner--bad">
            {diff.error} <button className="link" onClick={diff.reload}>Retry</button>
          </div>
        )}
        {diff.data && <DiffView key={diff.data.head + run.id} diff={diff.data} overlapPaths={overlapPaths} />}
      </section>
    </div>
  );
}

function TestCard({ run }: { run: Run }) {
  const t = run.tests!;
  const [open, setOpen] = useState(!t.passed);
  return (
    <section className={`card ${t.passed ? 'card--pass' : 'card--fail'}`}>
      <div className="test__head" onClick={() => setOpen(!open)}>
        <span className={`testbadge ${t.passed ? 'testbadge--pass' : 'testbadge--fail'}`}>{t.passed ? '✓ Tests passed' : `✗ Tests failed (exit ${t.exitCode})`}</span>
        <code className="test__cmd">{t.command}</code>
        <span className="muted mono">{durationPrecise(t.durationMs)}</span>
        <span className="spacer" />
        <button className="link">{open ? 'Hide output' : 'Show output'}</button>
      </div>
      {open && <pre className="test__out">{t.output || '(no output)'}</pre>}
    </section>
  );
}
