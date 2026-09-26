/**
 * Two-step confirmation for destructive voice actions, enforced in code so the model can't
 * skip it. The first call returns a question plus a token. The action runs only when called
 * again with that token, within the TTL, and only if the user said yes out loud after the
 * question was issued.
 */
import { randomBytes } from 'node:crypto';
import { stripNonSpeech } from '@conductor/shared';
import type { Transcript } from './transcript.ts';

export type ConfirmAction = 'accept_merge' | 'accept_branch' | 'reject' | 'cancel' | 'create_project';

interface Pending { action: ConfirmAction; runId: string; expiresAt: number; afterLineId: number }

const YES = /\b(yes|yeah|yep|yup|sure|confirm(ed)?|correct|go ahead|do it|please do|ok(ay)?|affirmative|absolutely|definitely)\b/i;
const NO = /\b(no|nope|nah|don'?t|do not|wait|hold on|stop|never ?mind|not yet)\b/i;

/** Did the user clearly say yes, and not also no/wait? */
export function saidYes(text: string): boolean {
  return YES.test(text) && !NO.test(text);
}

export type Redeem = { ok: true } | { ok: false; reason: string };

export class ConfirmGate {
  private pending = new Map<string, Pending>();

  constructor(private readonly ttlMs = 60_000, private readonly now: () => number = Date.now) {}

  /**
   * Issue a token for this action; the user must answer after the transcript's current last line.
   * `runId` is whatever the action targets: a run id, or a project name.
   */
  issue(action: ConfirmAction, runId: string, transcript: Transcript): string {
    const token = `c_${randomBytes(4).toString('hex')}`;
    const lines = transcript.all();
    this.pending.set(token, { action, runId, expiresAt: this.now() + this.ttlMs, afterLineId: lines.at(-1)?.id ?? 0 });
    return token;
  }

  /** Spend a token. Single use; it must match the action and run it was issued for. */
  redeem(token: string, action: ConfirmAction, runId: string, transcript: Transcript): Redeem {
    const p = this.pending.get(token);
    if (!p || p.action !== action || p.runId !== runId) {
      return { ok: false, reason: 'That confirmation token is not valid for this action. Ask the user again (call without a token).' };
    }
    if (this.now() > p.expiresAt) {
      this.pending.delete(token);
      return { ok: false, reason: 'The confirmation expired. Ask the user again (call without a token).' };
    }
    // The yes must come from the user, after the question was put to them.
    // Only lines with words count: a cough or "[clear throat]" is not an answer.
    const reply = transcript.all().filter((l) => l.role === 'user' && l.id > p.afterLineId).map((l) => stripNonSpeech(l.text)).filter(Boolean).at(-1);
    if (!reply) return { ok: false, reason: 'The user has not answered the confirmation yet. Wait for a clear yes.' };
    if (!saidYes(reply)) {
      this.pending.delete(token);
      return { ok: false, reason: `The user did not clearly confirm (they said "${reply}"). Do not proceed unless they ask again.` };
    }
    this.pending.delete(token);
    return { ok: true };
  }
}
