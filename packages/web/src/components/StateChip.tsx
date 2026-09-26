import type { RunState } from '@conductor/shared';
import { STATE_META } from '../stateMeta.ts';

export function StateChip({ state, compact = false }: { state: RunState; compact?: boolean }) {
  const m = STATE_META[state];
  return (
    <span className={`chip chip--${m.tone}${compact ? ' chip--compact' : ''}`} title={m.label}>
      <span className="chip__icon" aria-hidden>{m.icon}</span>
      {!compact && <span className="chip__label">{m.label}</span>}
    </span>
  );
}
