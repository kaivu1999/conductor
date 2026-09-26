import { useState } from 'react';
import type { Run } from '@conductor/shared';
import { GROUP_LABEL, GROUP_ORDER, groupOf, type Group } from '../stateMeta.ts';
import { RunRow } from './RunRow.tsx';

interface Props {
  runs: Run[]; // attention-sorted
  now: number;
  selectedId: string | null;
  onSelect(id: string): void;
  onlyNeeds: boolean;
  onClearFilter(): void;
  loaded: boolean;
  onNew(): void;
}

export function RunList({ runs, now, selectedId, onSelect, onlyNeeds, onClearFilter, loaded, onNew }: Props) {
  const [doneOpen, setDoneOpen] = useState(false);
  const groups = new Map<Group, Run[]>(GROUP_ORDER.map((g) => [g, []]));
  for (const r of runs) groups.get(groupOf(r, now))!.push(r);
  // Keep the selected done-run visible even when the group is collapsed.
  const selectedInDone = groups.get('done')!.some((r) => r.id === selectedId);

  if (loaded && runs.length === 0) {
    return (
      <div className="list-empty">
        <p>No runs yet.</p>
        <p className="muted">Start an agent on a task in one of your repos. Each run gets its own git worktree, so they can't step on each other.</p>
        <button className="btn btn--primary" onClick={onNew}>New run <kbd>n</kbd></button>
      </div>
    );
  }

  return (
    <nav className="list" aria-label="Runs">
      {onlyNeeds && (
        <div className="list__filter">
          Showing only runs that need you
          <button className="link" onClick={onClearFilter}>Show all</button>
        </div>
      )}
      {GROUP_ORDER.map((g) => {
        const items = groups.get(g)!;
        if (onlyNeeds && g !== 'needs') return null;
        if (items.length === 0) {
          if (g === 'needs' && loaded) return <div key={g} className="group__allclear">✓ Nothing needs you right now</div>;
          return null;
        }
        const collapsible = g === 'done';
        const open = !collapsible || doneOpen;
        const shown = open ? items : items.filter((r) => r.id === selectedId);
        return (
          <section key={g} className={`group group--${g}`}>
            <header
              className={`group__head${collapsible ? ' group__head--toggle' : ''}`}
              onClick={collapsible ? () => setDoneOpen(!doneOpen) : undefined}
            >
              {collapsible && <span className="caret">{open ? '▾' : '▸'}</span>}
              <span>{GROUP_LABEL[g]}</span>
              <span className="group__count">{items.length}</span>
            </header>
            {(open || selectedInDone) && (
              <ul className="rows">
                {shown.map((r) => (
                  <RunRow key={r.id} run={r} now={now} selected={r.id === selectedId} onSelect={onSelect} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </nav>
  );
}
