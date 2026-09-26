import type { Run } from './types.ts';

/**
 * "Which three should I look at right now?" Higher = more urgent.
 * Shared so the web list and (later) the voice layer agree on ordering.
 */
export function attentionScore(run: Run, now = Date.now()): number {
  const age = (t: number | null) => (t ? (now - t) / 60_000 : 0); // minutes
  switch (run.state) {
    case 'waiting_input': return 1000 + age(run.pendingQuestion?.askedAt ?? run.activityAt);
    case 'conflict': return 900;
    case 'failed': return 800;
    case 'interrupted': return 750;
    case 'ready': return 700 + age(run.finishedAt);
    case 'running':
    case 'testing':
    case 'starting': {
      const idle = age(run.activityAt ?? run.startedAt);
      return idle > 5 ? 600 + idle : 300; // stale running agents surface above healthy ones
    }
    case 'accepting': return 290;
    case 'queued': return 200;
    case 'cancelled': return 100;
    default: return 0; // accepted / rejected
  }
}

export function needsAttention(run: Run, now = Date.now()): boolean {
  return attentionScore(run, now) >= 600;
}

export function sortByAttention(runs: Run[], now = Date.now()): Run[] {
  return [...runs].sort((a, b) => attentionScore(b, now) - attentionScore(a, now) || b.createdAt - a.createdAt);
}
