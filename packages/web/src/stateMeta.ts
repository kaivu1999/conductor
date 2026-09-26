import type { Run, RunState } from '@conductor/shared';
import { isLive, needsAttention } from '@conductor/shared';
import { duration, minutesSince } from './format.ts';

export interface StateMeta {
  label: string;
  icon: string;
  /** CSS class suffix: chip--<tone> */
  tone: 'ask' | 'bad' | 'warn' | 'review' | 'work' | 'idle' | 'good' | 'muted';
}

export const STATE_META: Record<RunState, StateMeta> = {
  waiting_input: { label: 'Needs answer', icon: '?', tone: 'ask' },
  conflict: { label: 'Conflict', icon: '⇄', tone: 'bad' },
  failed: { label: 'Failed', icon: '✕', tone: 'bad' },
  interrupted: { label: 'Interrupted', icon: '⏸', tone: 'warn' },
  ready: { label: 'Ready', icon: '◉', tone: 'review' },
  running: { label: 'Running', icon: '●', tone: 'work' },
  starting: { label: 'Starting', icon: '◌', tone: 'work' },
  testing: { label: 'Testing', icon: '⚗', tone: 'work' },
  accepting: { label: 'Merging', icon: '⤵', tone: 'work' },
  queued: { label: 'Queued', icon: '…', tone: 'idle' },
  accepted: { label: 'Accepted', icon: '✓', tone: 'good' },
  rejected: { label: 'Rejected', icon: '⊘', tone: 'muted' },
  cancelled: { label: 'Cancelled', icon: '■', tone: 'muted' },
};

export type Group = 'needs' | 'working' | 'queued' | 'done';
export const GROUP_LABEL: Record<Group, string> = { needs: 'Needs you', working: 'Working', queued: 'Queued', done: 'Done' };
export const GROUP_ORDER: Group[] = ['needs', 'working', 'queued', 'done'];

export function groupOf(run: Run, now: number): Group {
  if (needsAttention(run, now)) return 'needs';
  if (run.state === 'queued') return 'queued';
  if (isLive(run.state) || run.state === 'accepting') return 'working';
  return 'done';
}

export const STALE_MIN = 5; // matches attention.ts threshold

export function staleMinutes(run: Run, now: number): number | null {
  if (!['running', 'starting', 'testing'].includes(run.state)) return null;
  const m = minutesSince(run.activityAt ?? run.startedAt, now);
  return m > STALE_MIN ? m : null;
}

/** Why this run is in "Needs you" — the one-phrase call to action. */
export function attentionReason(run: Run, now: number): string | null {
  switch (run.state) {
    case 'waiting_input': return 'Waiting for your answer';
    case 'conflict': return 'Merge conflict — resolve or reject';
    case 'failed': return 'Failed — restart or reject';
    case 'interrupted': return run.sessionId ? 'Interrupted — resume it' : 'Interrupted — restart it';
    case 'ready': return run.tests && !run.tests.passed ? 'Done, but tests fail — review' : 'Done — review & accept';
    default: {
      const s = staleMinutes(run, now);
      return s ? `No activity for ${duration(s * 60_000)} — stuck?` : null;
    }
  }
}
