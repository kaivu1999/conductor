import type { DiffStat, Overlap, TestResult } from '@conductor/shared';
import { plural } from '../format.ts';

export function DiffStatBadge({ stat }: { stat: DiffStat }) {
  return (
    <span className="diffstat mono" title={stat.paths.join('\n') || undefined}>
      <span className="add">+{stat.insertions}</span> <span className="del">−{stat.deletions}</span>
      <span className="muted"> · {plural(stat.files, 'file')}</span>
    </span>
  );
}

export function TestBadge({ tests }: { tests: TestResult }) {
  return (
    <span className={`testbadge ${tests.passed ? 'testbadge--pass' : 'testbadge--fail'}`} title={`${tests.command} (exit ${tests.exitCode})`}>
      {tests.passed ? '✓ tests' : '✗ tests'}
    </span>
  );
}

export function overlapText(overlaps: Overlap[]): string {
  return overlaps.map((o) => `also changed by "${o.title}": ${o.paths.join(', ')}`).join('\n');
}

export function OverlapIcon({ overlaps }: { overlaps: Overlap[] }) {
  return (
    <span className="overlap-icon" title={overlapText(overlaps)} aria-label={overlapText(overlaps)}>
      ⚠
    </span>
  );
}
