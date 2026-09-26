/** Minimal unified-diff parser: file headers are skipped, hunks become typed lines with old/new numbers. */
export type DiffLine =
  | { kind: 'ctx' | 'add' | 'del'; text: string; oldNo: number | null; newNo: number | null }
  | { kind: 'note'; text: string; oldNo: null; newNo: null };

export interface Hunk {
  header: string; // "@@ -12,14 +12,22 @@"
  context: string; // trailing section heading after the second @@
  lines: DiffLine[];
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

export function parsePatch(patch: string): { hunks: Hunk[]; binary: boolean } {
  const hunks: Hunk[] = [];
  let cur: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  let binary = false;
  const lines = patch.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  for (const line of lines) {
    const m = HUNK_RE.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[3]);
      cur = { header: `@@ -${m[1]}${m[2] !== undefined ? ',' + m[2] : ''} +${m[3]}${m[4] !== undefined ? ',' + m[4] : ''} @@`, context: m[5] ?? '', lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) {
      if (line.startsWith('Binary files') || line.startsWith('GIT binary patch')) binary = true;
      continue; // diff --git / index / --- / +++ / mode lines
    }
    const c = line[0];
    const text = line.slice(1);
    if (c === '+') cur.lines.push({ kind: 'add', text, oldNo: null, newNo: newNo++ });
    else if (c === '-') cur.lines.push({ kind: 'del', text, oldNo: oldNo++, newNo: null });
    else if (c === '\\') cur.lines.push({ kind: 'note', text: line.slice(2), oldNo: null, newNo: null });
    else if (c === ' ' || line === '') cur.lines.push({ kind: 'ctx', text, oldNo: oldNo++, newNo: newNo++ });
    else if (line.startsWith('diff --git')) cur = null; // concatenated patches
  }
  return { hunks, binary };
}

export function patchLineCount(patch: string): number {
  let n = 0;
  for (let i = 0; i < patch.length; i++) if (patch.charCodeAt(i) === 10) n++;
  return n;
}
