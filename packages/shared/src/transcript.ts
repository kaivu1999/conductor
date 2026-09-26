/**
 * Folding GPT-Live transcript fragments into speaker lines. Shared by the browser
 * captions and the server's transcript buffer so both split the conversation the same way.
 */

export type Speaker = 'user' | 'assistant';

export interface TranscriptLine {
  id: number;
  role: Speaker;
  text: string;
  /** Session-relative ms, from the fragments' `start_ms` / `end_ms`. */
  startMs: number;
  endMs: number;
}

/** Payload of `session.input_transcript.delta` / `session.output_transcript.delta`. */
export interface TranscriptDelta { delta: string; start_ms?: number; end_ms?: number }

/** Fragments from the same speaker within this gap join one line. */
export const JOIN_GAP_MS = 1200;

/**
 * Fold one fragment into `lines` (returns a new array, keeping at most `max` lines).
 * Full duplex means lines interleave (a backchannel mid-sentence), so a fragment joins the
 * speaker's latest line unless there was a pause, or the other side spoke a whole line in between.
 */
export function addFragment(lines: TranscriptLine[], role: Speaker, d: TranscriptDelta, nextId: number, max = Infinity): TranscriptLine[] {
  const start = d.start_ms ?? Number.MAX_SAFE_INTEGER;
  const end = d.end_ms ?? d.start_ms ?? 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const c = lines[i]!;
    if (c.role !== role) continue;
    const turnBetween = lines.slice(i + 1).some((o) => o.startMs >= c.endMs && o.endMs <= start);
    if (turnBetween || start - c.endMs > JOIN_GAP_MS) break;
    const next = lines.slice();
    next[i] = { ...c, text: c.text + d.delta, endMs: Math.max(c.endMs, end) };
    return next;
  }
  const line = { id: nextId, role, text: d.delta.trimStart(), startMs: d.start_ms ?? end, endMs: end };
  return [...lines, line].slice(-max);
}

/**
 * Drop non-speech tags the transcriber inserts ("[clear throat]", "(laughs)"), including one
 * cut off at the end of a line that's still arriving ("[clear throat").
 */
export function stripNonSpeech(text: string): string {
  return text.replace(/\[[^\]]*(\]|$)|\([^)]*(\)|$)/g, ' ').replace(/\s+/g, ' ').trim();
}
