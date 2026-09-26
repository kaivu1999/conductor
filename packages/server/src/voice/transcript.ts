import { addFragment, type Speaker, type TranscriptDelta, type TranscriptLine } from '@conductor/shared';

/** Keep enough history for "yes", "the second one", and "no, Thursday". */
const MAX_LINES = 200;

/** The conversation so far, as speaker lines. Built from the sideband's transcript deltas. */
export class Transcript {
  private lines: TranscriptLine[] = [];
  private nextId = 1;

  add(role: Speaker, d: TranscriptDelta): void {
    if (typeof d.delta !== 'string' || !d.delta) return;
    this.lines = addFragment(this.lines, role, d, this.nextId++, MAX_LINES);
  }

  all(): readonly TranscriptLine[] {
    return this.lines;
  }

  /** The user's most recent line, or null. */
  lastUser(): TranscriptLine | null {
    for (let i = this.lines.length - 1; i >= 0; i--) if (this.lines[i]!.role === 'user') return this.lines[i]!;
    return null;
  }

  /** Last `n` lines as `user: …` / `assistant: …`, for a backend prompt. */
  render(n = 20): string {
    return this.lines.slice(-n).map((l) => `${l.role}: ${l.text.trim()}`).join('\n');
  }
}
