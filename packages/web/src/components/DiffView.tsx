import { memo, useMemo, useState } from 'react';
import type { FileDiff, RunDiff } from '@conductor/shared';
import { parsePatch, patchLineCount } from '../diff.ts';

const LARGE = 400;
const STATUS_LETTER: Record<FileDiff['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R' };

interface Props {
  diff: RunDiff;
  overlapPaths: Set<string>;
}

export function DiffView({ diff, overlapPaths }: Props) {
  // Default: expand every file that isn't large; large files start collapsed.
  const [open, setOpen] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(diff.files.map((f) => [f.path, diff.files.length <= 8 && patchLineCount(f.patch) <= LARGE])),
  );
  const toggle = (p: string) => setOpen((o) => ({ ...o, [p]: !o[p] }));
  const allOpen = diff.files.every((f) => open[f.path]);

  if (diff.files.length === 0) return <div className="muted pad">No file changes on this branch.</div>;

  const totalAdd = diff.files.reduce((a, f) => a + f.insertions, 0);
  const totalDel = diff.files.reduce((a, f) => a + f.deletions, 0);

  return (
    <div className="diff">
      <div className="diff__summary">
        <span>{diff.files.length} files changed</span>
        <span className="mono"><span className="add">+{totalAdd}</span> <span className="del">−{totalDel}</span></span>
        <span className="muted mono">{diff.base.slice(0, 7)}…{diff.head.slice(0, 7)}</span>
        <span className="spacer" />
        <button className="link" onClick={() => setOpen(Object.fromEntries(diff.files.map((f) => [f.path, !allOpen])))}>
          {allOpen ? 'Collapse all' : 'Expand all'}
        </button>
      </div>
      <ul className="filelist">
        {diff.files.map((f) => (
          <li key={f.path}>
            <a className="filelist__item" href={`#file-${f.path}`} onClick={(e) => {
              e.preventDefault();
              setOpen((o) => ({ ...o, [f.path]: true }));
              requestAnimationFrame(() => document.getElementById(`file-${f.path}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' }));
            }}>
              <span className={`status status--${f.status}`}>{STATUS_LETTER[f.status]}</span>
              <span className="mono filelist__path">{f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}</span>
              {overlapPaths.has(f.path) && <span className="overlap-icon" title="Also changed by another run">⚠</span>}
              <span className="mono filelist__counts"><span className="add">+{f.insertions}</span> <span className="del">−{f.deletions}</span></span>
            </a>
          </li>
        ))}
      </ul>
      {diff.files.map((f) => (
        <FileBlock key={f.path} file={f} open={!!open[f.path]} onToggle={() => toggle(f.path)} overlap={overlapPaths.has(f.path)} />
      ))}
    </div>
  );
}

const FileBlock = memo(function FileBlock({ file, open, onToggle, overlap }: { file: FileDiff; open: boolean; onToggle(): void; overlap: boolean }) {
  const lineCount = useMemo(() => patchLineCount(file.patch), [file.patch]);
  return (
    <section className="file" id={`file-${file.path}`}>
      <header className="file__head" onClick={onToggle}>
        <span className="caret">{open ? '▾' : '▸'}</span>
        <span className={`status status--${file.status}`}>{STATUS_LETTER[file.status]}</span>
        <span className="mono file__path">{file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        {overlap && <span className="overlap-icon" title="Also changed by another run">⚠</span>}
        <span className="spacer" />
        <span className="mono"><span className="add">+{file.insertions}</span> <span className="del">−{file.deletions}</span></span>
      </header>
      {open ? <Patch patch={file.patch} /> : lineCount > LARGE ? (
        <button className="file__collapsed" onClick={onToggle}>Large diff ({lineCount} lines) collapsed — click to show</button>
      ) : null}
    </section>
  );
});

function Patch({ patch }: { patch: string }) {
  const { hunks, binary } = useMemo(() => parsePatch(patch), [patch]);
  if (binary) return <div className="muted pad">Binary file changed.</div>;
  if (hunks.length === 0) return <div className="muted pad">No textual changes (mode change or empty file).</div>;
  return (
    <div className="patch-scroll">
      <table className="patch">
        <tbody>
          {hunks.map((h, hi) => [
            <tr key={`h${hi}`} className="patch__hunk">
              <td className="ln" colSpan={2} />
              <td className="code">{h.header}<span className="patch__ctx"> {h.context}</span></td>
            </tr>,
            ...h.lines.map((l, li) => (
              <tr key={`${hi}-${li}`} className={`patch__${l.kind}`}>
                <td className="ln">{l.oldNo ?? ''}</td>
                <td className="ln">{l.newNo ?? ''}</td>
                <td className="code">
                  <span className="sigil">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : l.kind === 'note' ? '\\' : ' '}</span>
                  {l.text}
                </td>
              </tr>
            )),
          ])}
        </tbody>
      </table>
    </div>
  );
}
