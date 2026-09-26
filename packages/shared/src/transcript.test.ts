import { describe, expect, it } from 'vitest';
import { addFragment, stripNonSpeech, type Speaker, type TranscriptLine } from './transcript.ts';

function fold(frags: [Speaker, string, number, number][], max?: number): string[] {
  let lines: TranscriptLine[] = [];
  frags.forEach(([role, delta, s, e], i) => { lines = addFragment(lines, role, { delta, start_ms: s, end_ms: e }, i + 1, max); });
  return lines.map((l) => `${l.role}: ${l.text}`);
}

describe('addFragment', () => {
  it('joins fragments of one utterance', () => {
    expect(fold([['user', 'What', 0, 200], ['user', ' needs me?', 250, 800]])).toEqual(['user: What needs me?']);
  });

  it('keeps a sentence whole across an overlapping backchannel', () => {
    expect(fold([
      ['assistant', 'Two tasks', 1500, 1900],
      ['user', 'mm-hm', 1950, 2100],
      ['assistant', ' need you.', 2000, 2500],
    ])).toEqual(['assistant: Two tasks need you.', 'user: mm-hm']);
  });

  it('starts a new line after the other side took a whole turn', () => {
    expect(fold([
      ['user', 'What needs me?', 0, 800],
      ['assistant', 'Two tasks.', 1000, 1400],
      ['user', 'Which?', 1500, 1800],
    ])).toEqual(['user: What needs me?', 'assistant: Two tasks.', 'user: Which?']);
  });

  it('starts a new line after a pause', () => {
    expect(fold([['user', 'Hi', 0, 300], ['user', 'Hello?', 3000, 3400]])).toEqual(['user: Hi', 'user: Hello?']);
  });

  it('keeps only the last `max` lines', () => {
    expect(fold([['user', 'a', 0, 1], ['user', 'b', 5000, 5001], ['user', 'c', 10000, 10001]], 2)).toEqual(['user: b', 'user: c']);
  });
});

describe('stripNonSpeech', () => {
  it.each([
    ['[clear throat] What needs me?', 'What needs me?'],
    ['details [clear throat', 'details'],
    ['Merge it (laughs) please', 'Merge it please'],
    ['[cough]', ''],
    ['plain words', 'plain words'],
  ])('%s', (input, out) => expect(stripNonSpeech(input)).toBe(out));
});
