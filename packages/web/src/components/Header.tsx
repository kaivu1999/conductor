import type { SystemInfo } from '@conductor/shared';
import { bytes } from '../format.ts';
import type { ConnState } from '../store.ts';
import { isMock } from '../useConductor.ts';

const DISK_WARN = 5 * 1024 ** 3;

interface Props {
  system: SystemInfo | null;
  needs: number;
  filterNeeds: boolean;
  onToggleNeeds(): void;
  conn: ConnState;
  droppedAt: number | null;
  nextRetryAt: number | null;
  now: number;
  onRetry(): void;
  onNew(): void;
}

export function Header({ system, needs, filterNeeds, onToggleNeeds, conn, droppedAt, nextRetryAt, now, onRetry, onNew }: Props) {
  const disk = system?.disk.totalBytes ?? null;
  return (
    <header className="top">
      <div className="top__brand">conductor{isMock && <span className="mock-tag">mock data</span>}</div>

      <button
        className={`needs${needs > 0 ? ' needs--on' : ''}${filterNeeds ? ' needs--filtering' : ''}`}
        onClick={onToggleNeeds}
        title={filterNeeds ? 'Show all runs' : 'Show only runs that need you'}
        disabled={needs === 0 && !filterNeeds}
      >
        {needs > 0 ? <>Needs you: <strong>{needs}</strong></> : 'Nothing needs you'}
        {filterNeeds && <span className="needs__x">×</span>}
      </button>

      <span className="spacer" />

      {system && (
        <div className="top__stats">
          <span title="Live agents / concurrency limit">
            <span className="stat__num">{system.liveCount}</span>/{system.maxConcurrent} live
          </span>
          {system.queuedCount > 0 && <span><span className="stat__num">{system.queuedCount}</span> queued</span>}
          {disk !== null && (
            <span className={disk > DISK_WARN ? 'warn' : ''} title={`Worktrees in ${system.disk.worktreeRoot}${disk > DISK_WARN ? ' — reject or accept finished runs to free space' : ''}`}>
              {disk > DISK_WARN && '⚠ '}{bytes(disk)} worktrees
            </span>
          )}
        </div>
      )}

      <Conn conn={conn} droppedAt={droppedAt} nextRetryAt={nextRetryAt} now={now} onRetry={onRetry} />

      <button className="btn btn--primary" onClick={onNew}>New run <kbd>n</kbd></button>
    </header>
  );
}

function Conn({ conn, droppedAt, nextRetryAt, now, onRetry }: { conn: ConnState; droppedAt: number | null; nextRetryAt: number | null; now: number; onRetry(): void }) {
  if (conn === 'live') return <span className="conn conn--live" title="Connected — updates are live"><span className="conn__dot" />live</span>;
  if (conn === 'connecting') return <span className="conn conn--connecting"><span className="conn__dot" />connecting…</span>;
  const down = droppedAt ? Math.round((now - droppedAt) / 1000) : 0;
  const retryIn = nextRetryAt ? Math.max(0, Math.ceil((nextRetryAt - now) / 1000)) : 0;
  return (
    <span className="conn conn--down" title="Lost connection to the conductor server. Data shown may be stale.">
      <span className="conn__dot" />
      reconnecting… <span className="muted">({down}s{retryIn > 0 ? `, retry in ${retryIn}s` : ''})</span>
      <button className="link" onClick={onRetry}>retry now</button>
    </span>
  );
}
