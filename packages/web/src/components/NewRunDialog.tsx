import { useEffect, useRef, useState } from 'react';
import type { RepoInfo } from '@conductor/shared';
import { useStore } from '../useConductor.ts';
import { useAction } from '../useRunActions.ts';

const LS_KEY = 'conductor.recentRepos';

function loadRecent(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch { return []; }
}
function saveRecent(path: string) {
  try { localStorage.setItem(LS_KEY, JSON.stringify([path, ...loadRecent().filter((p) => p !== path)].slice(0, 10))); } catch { /* ignore */ }
}

export function NewRunDialog({ onClose, onCreated, knownRepos }: { onClose(): void; onCreated(id: string): void; knownRepos: string[] }) {
  const store = useStore();
  const recent = useRef([...new Set([...loadRecent(), ...knownRepos])]).current;
  const [path, setPath] = useState(recent[0] ?? '');
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [task, setTask] = useState('');
  const [testCmd, setTestCmd] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { pending, run: act, src } = useAction();
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const pathRef = useRef<HTMLInputElement>(null);
  const inspected = useRef<string | null>(null);

  const valid = !!info && info.isGitRepo && !info.error;

  async function inspect(p: string) {
    const trimmed = p.trim();
    if (!trimmed || inspected.current === trimmed) return;
    inspected.current = trimmed;
    setInspecting(true);
    setInspectErr(null);
    try {
      const r = await store.src.inspectRepo(trimmed);
      if (inspected.current !== trimmed) return;
      setInfo(r);
      setBaseBranch(r.currentBranch ?? r.branches[0] ?? '');
      if (r.isGitRepo && !r.error) requestAnimationFrame(() => taskRef.current?.focus());
    } catch (e) {
      setInfo(null);
      setInspectErr(e instanceof Error ? e.message : String(e));
    } finally {
      setInspecting(false);
    }
  }

  useEffect(() => {
    if (path) void inspect(path);
    else pathRef.current?.focus();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const canSubmit = valid && task.trim().length > 0 && !pending;
  async function submit() {
    if (!canSubmit || !info) return;
    const r = await act('create', () => src.createRun({
      repoPath: info.path,
      task: task.trim(),
      baseBranch: baseBranch || undefined,
      testCommand: testCmd.trim() || undefined,
    }));
    if (r) { saveRecent(info.path); onCreated(r.id); }
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal
        aria-label="New run"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); onClose(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
        }}
      >
        <header className="modal__head">
          <h2>New run</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <label className="field">
          <span className="field__label">Repository path</span>
          <input
            ref={pathRef}
            className="mono"
            list="recent-repos"
            value={path}
            placeholder="/Users/you/code/my-repo"
            spellCheck={false}
            onChange={(e) => { setPath(e.target.value); if (inspected.current !== e.target.value.trim()) { setInfo(null); inspected.current = null; } }}
            onBlur={() => inspect(path)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) { e.preventDefault(); void inspect(path); } }}
          />
          <datalist id="recent-repos">{recent.map((p) => <option key={p} value={p} />)}</datalist>
        </label>

        <div className="repo-info">
          {inspecting && <span className="muted">Checking repository…</span>}
          {inspectErr && <span className="bad">✗ {inspectErr}</span>}
          {info && !inspecting && (info.error || !info.isGitRepo ? (
            <span className="bad">✗ {info.error ?? 'Not a git repository.'}</span>
          ) : (
            <>
              <span className="good">✓ git repo <strong>{info.name}</strong></span>
              <span className="muted">on <span className="mono">{info.currentBranch ?? '(detached)'}</span></span>
              {info.dirty && <span className="warn" title="Runs branch from the committed base; uncommitted changes in your working copy are NOT included.">⚠ uncommitted changes (not included)</span>}
              <span className="muted">tests: {info.detectedTestCommand ? <span className="mono">{info.detectedTestCommand}</span> : 'none detected'}</span>
            </>
          ))}
        </div>

        <div className="field-row">
          <label className="field field--inline">
            <span className="field__label">Base branch</span>
            <select value={baseBranch} disabled={!valid} onChange={(e) => setBaseBranch(e.target.value)}>
              {(info?.branches.length ? info.branches : [baseBranch || '—']).map((b) => (
                <option key={b} value={b}>{b}{b === info?.currentBranch ? ' (current)' : ''}</option>
              ))}
            </select>
          </label>
          <button className="link" onClick={() => setShowAdvanced(!showAdvanced)}>
            {showAdvanced ? '▾' : '▸'} Test command{testCmd ? `: ${testCmd}` : ''}
          </button>
        </div>
        {showAdvanced && (
          <label className="field">
            <span className="field__label">Test command override</span>
            <input className="mono" value={testCmd} onChange={(e) => setTestCmd(e.target.value)}
              placeholder={info?.detectedTestCommand ? `default: ${info.detectedTestCommand}` : 'e.g. pnpm test'} />
          </label>
        )}

        <label className="field field--grow">
          <span className="field__label">Task</span>
          <textarea
            ref={taskRef}
            className="task-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={'What should the agent do? Be specific — first line becomes the title.\n\ne.g. Add a --since flag to `acme export` that filters audit logs by timestamp. Include tests.'}
          />
        </label>

        <footer className="modal__foot">
          <span className="muted small">The agent works in its own worktree on a new branch; nothing touches your checkout until you accept.</span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!canSubmit} onClick={submit}>
            {pending ? 'Creating…' : 'Start run'} <kbd>⌘↵</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
