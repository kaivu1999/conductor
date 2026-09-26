import type { ReactNode } from 'react';

/** Renders paragraphs, "- " / "* " / "1. " bullets, `code`, **bold**, and ``` fences. No HTML injection. */
export function Markdownish({ text }: { text: string }) {
  const blocks: ReactNode[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let i = 0;
  const flushPara = () => {
    if (para.length) blocks.push(<p key={blocks.length}>{inline(para.join(' '))}</p>);
    para = [];
  };
  const flushList = () => {
    if (list) {
      const items = list.items.map((it, j) => <li key={j}>{inline(it)}</li>);
      blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    }
    list = null;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trimStart().startsWith('```')) {
      flushPara(); flushList();
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith('```')) body.push(lines[i++]!);
      blocks.push(<pre key={blocks.length} className="md-pre">{body.join('\n')}</pre>);
      i++;
      continue;
    }
    const bullet = /^\s*(?:[-*•]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const ordered = bullet[1] !== undefined;
      if (!list || list.ordered !== ordered) { flushList(); list = { ordered, items: [] }; }
      list.items.push(bullet[2]!);
    } else if (/^\s*#{1,6}\s+/.test(line)) {
      flushPara(); flushList();
      blocks.push(<p key={blocks.length} className="md-h">{inline(line.replace(/^\s*#+\s+/, ''))}</p>);
    } else if (line.trim() === '') {
      flushPara(); flushList();
    } else if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ' ' + line.trim();
    } else {
      flushList();
      para.push(line.trim());
    }
    i++;
  }
  flushPara(); flushList();
  return <div className="md">{blocks}</div>;
}

function inline(s: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    if (m.index > last) out.push(s.slice(last, m.index));
    const tok = m[0];
    out.push(tok.startsWith('`') ? <code key={m.index}>{tok.slice(1, -1)}</code> : <strong key={m.index}>{tok.slice(2, -2)}</strong>);
    last = m.index + tok.length;
  }
  if (last < s.length) out.push(s.slice(last));
  return out;
}
