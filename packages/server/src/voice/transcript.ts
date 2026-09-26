import { addFragment, stripNonSpeech, type Speaker, type TranscriptDelta, type TranscriptLine } from '@conductor/shared';

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

  /** The user's most recent line with actual words, or null. */
  lastUser(): TranscriptLine | null {
    for (let i = this.lines.length - 1; i >= 0; i--) {
      const l = this.lines[i]!;
      if (l.role === 'user' && stripNonSpeech(l.text)) return { ...l, text: stripNonSpeech(l.text) };
    }
    return null;
  }

  /** Last `n` spoken lines as `user: …` / `assistant: …`, for a backend prompt. Non-speech tags dropped. */
  render(n = 20): string {
    return this.lines.map((l) => ({ ...l, text: stripNonSpeech(l.text) })).filter((l) => l.text)
      .slice(-n).map((l) => `${l.role}: ${l.text}`).join('\n');
  }
}
