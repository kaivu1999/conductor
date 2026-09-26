import { useEffect, useMemo, useRef, useState } from 'react';
import { slugify, type ProjectsInfo, type RepoInfo } from '@conductor/shared';
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

const baseName = (p: string) => p.split('/').filter(Boolean).pop() ?? p;
const isPath = (s: string) => s.startsWith('/') || s.startsWith('~');

/** What the dialog is pointed at: an existing repo, or a project that doesn't exist yet. */
type Target = { kind: 'repo'; path: string } | { kind: 'new'; name: string };

type Option =
  | { kind: 'repo'; path: string; name: string; recent: boolean }
  | { kind: 'path'; path: string }
  | { kind: 'new'; name: string };

/** Pre-fill, e.g. from Conductor's voice ("open the new run window for weather app"). */
export interface NewRunPrefill { repoPath?: string; newProject?: string; task?: string }

export function NewRunDialog({ onClose, onCreated, knownRepos, prefill }: {
  onClose(): void; onCreated(id: string): void; knownRepos: string[]; prefill?: NewRunPrefill;
}) {
  const store = useStore();
  const recent = useRef([...new Set([...loadRecent(), ...knownRepos])]).current;
  const initial: Target | null = prefill?.repoPath ? { kind: 'repo', path: prefill.repoPath }
    : prefill?.newProject ? { kind: 'new', name: prefill.newProject }
    : !prefill && recent[0] ? { kind: 'repo', path: recent[0] } : null;
  const [target, setTarget] = useState<Target | null>(initial);
  const [query, setQuery] = useState(initial?.kind === 'repo' ? baseName(initial.path) : initial?.name ?? '');
  const [listOpen, setListOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [projects, setProjects] = useState<ProjectsInfo | null>(null);
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [inspectErr, setInspectErr] = useState<string | null>(null);
  const [baseBranch, setBaseBranch] = useState('');
  const [task, setTask] = useState(prefill?.task ?? '');
  const [testCmd, setTestCmd] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const { pending, run: act, src } = useAction();
  const taskRef = useRef<HTMLTextAreaElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const inspected = useRef<string | null>(null);

  useEffect(() => { src.projects().then(setProjects, () => setProjects({ dir: null, projects: [] })); }, [src]);

  const options = useMemo((): Option[] => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const repos: Option[] = [];
    for (const p of projects?.projects ?? []) { seen.add(p.path); repos.push({ kind: 'repo', path: p.path, name: p.name, recent: recent.includes(p.path) }); }
    for (const p of recent) if (!seen.has(p)) repos.push({ kind: 'repo', path: p, name: baseName(p), recent: true });
    // Recently used first, then alphabetical.
    repos.sort((a, b) => a.kind === 'repo' && b.kind === 'repo' ? Number(b.recent) - Number(a.recent) || a.name.localeCompare(b.name) : 0);
    if (isPath(query.trim())) return [{ kind: 'path', path: query.trim() }];
    const matches = q ? repos.filter((o) => o.kind === 'repo' && (o.name.toLowerCase().includes(q) || o.path.toLowerCase().includes(q))) : repos;
    const slug = slugify(query);
    const exact = matches.some((o) => o.kind === 'repo' && o.name === slug);
    return [...matches.slice(0, 8), ...(projects?.dir && slug && !exact ? [{ kind: 'new' as const, name: slug }] : [])];
  }, [query, projects, recent]);

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

  function choose(o: Option) {
    setListOpen(false);
    if (o.kind === 'new') {
      setTarget({ kind: 'new', name: o.name });
      setQuery(o.name);
      setInfo(null);
      inspected.current = null;
      requestAnimationFrame(() => taskRef.current?.focus());
      return;
    }
    setTarget({ kind: 'repo', path: o.path });
    setQuery(o.kind === 'repo' ? o.name : o.path);
    void inspect(o.path);
  }

  useEffect(() => {
    if (initial?.kind === 'repo') void inspect(initial.path);
    else if (initial?.kind === 'new') taskRef.current?.focus();
    else { pickerRef.current?.focus(); setListOpen(true); }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isNew = target?.kind === 'new';
  const valid = isNew || (!!info && info.isGitRepo && !info.error);
  const canSubmit = !!target && valid && task.trim().length > 0 && !pending;
  const newPath = isNew && projects?.dir ? `${projects.dir}/${target.name}` : null;

  async function submit() {
    if (!canSubmit || !target) return;
    const r = await act('create', async () => {
      let repoPath: string;
      if (target.kind === 'new') repoPath = (await src.createProject(target.name)).path;
      else if (info) repoPath = info.path;
      else throw new Error('Pick a repository first.');
      return src.createRun({
        repoPath,
        task: task.trim(),
        ...(target.kind === 'repo' ? { baseBranch: baseBranch || undefined, testCommand: testCmd.trim() || undefined } : {}),
      });
    });
    if (r) { saveRecent(r.repoPath); onCreated(r.id); }
  }

  return (
    <div className="modal-bg" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div
        className="modal"
        role="dialog"
        aria-modal
        aria-label="New run"
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.stopPropagation(); if (listOpen) setListOpen(false); else onClose(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
        }}
      >
        <header className="modal__head">
          <h2>New run</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="field picker">
          <label className="field__label" htmlFor="project-picker">Project</label>
          <input
            id="project-picker"
            ref={pickerRef}
            role="combobox"
            aria-expanded={listOpen}
            aria-controls="project-options"
            aria-activedescendant={listOpen && options[active] ? `project-opt-${active}` : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            placeholder={projects?.dir ? 'Type a project name, or a new one to create it' : '/Users/you/code/my-repo'}
            onFocus={() => setListOpen(true)}
            onBlur={() => setTimeout(() => setListOpen(false), 120)}
            onChange={(e) => {
              setQuery(e.target.value);
              setTarget(null);
              setInfo(null);
              inspected.current = null;
              setActive(0);
              setListOpen(true);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') { e.preventDefault(); setListOpen(true); setActive((a) => Math.min(options.length - 1, a + 1)); }
              else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
              else if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && listOpen && options[active]) { e.preventDefault(); choose(options[active]!); }
            }}
          />
          {listOpen && options.length > 0 && (
            <ul className="picker__list" id="project-options" role="listbox">
              {options.map((o, i) => (
                <li
                  key={o.kind === 'new' ? `new:${o.name}` : o.path}
                  id={`project-opt-${i}`}
                  role="option"
                  aria-selected={i === active}
                  className={`picker__opt${i === active ? ' picker__opt--active' : ''}${o.kind === 'new' ? ' picker__opt--new' : ''}`}
                  onMouseDown={(e) => { e.preventDefault(); choose(o); }}
                  onMouseEnter={() => setActive(i)}
                >
                  {o.kind === 'new' ? (
                    <><span className="picker__name">+ Create new project “{o.name}”</span><span className="picker__path mono"><bdi>{projects?.dir}/{o.name}</bdi></span></>
                  ) : o.kind === 'path' ? (
                    <><span className="picker__name">Use this path</span><span className="picker__path mono"><bdi>{o.path}</bdi></span></>
                  ) : (
                    <><span className="picker__name">{o.name}{o.recent && <span className="picker__tag">recent</span>}</span><span className="picker__path mono"><bdi>{o.path}</bdi></span></>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="repo-info">
          {isNew ? (
            newPath
              ? <span className="good">＋ New git repo <span className="mono">{newPath}</span> on <span className="mono">main</span></span>
              : <span className="bad">✗ No projects folder is set (CONDUCTOR_PROJECTS_DIR).</span>
          ) : <>
            {!target && !query && projects?.dir && <span className="muted">Projects in <span className="mono">{projects.dir}</span></span>}
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
          </>}
        </div>

        {!isNew && valid && (
          <>
            <div className="field-row">
              <button className="link" onClick={() => setShowAdvanced(!showAdvanced)}>
                {showAdvanced ? '▾' : '▸'} Options: base <span className="mono">{baseBranch || '—'}</span>{testCmd ? `, tests: ${testCmd}` : ''}
              </button>
            </div>
            {showAdvanced && (
              <div className="field-row">
                <label className="field field--inline">
                  <span className="field__label">Base branch</span>
                  <select value={baseBranch} onChange={(e) => setBaseBranch(e.target.value)}>
                    {(info?.branches.length ? info.branches : [baseBranch || '—']).map((b) => (
                      <option key={b} value={b}>{b}{b === info?.currentBranch ? ' (current)' : ''}</option>
                    ))}
                  </select>
                </label>
                <label className="field field--inline field--grow">
                  <span className="field__label">Test command</span>
                  <input className="mono" value={testCmd} onChange={(e) => setTestCmd(e.target.value)}
                    placeholder={info?.detectedTestCommand ? `default: ${info.detectedTestCommand}` : 'e.g. pnpm test'} />
                </label>
              </div>
            )}
          </>
        )}

        <label className="field field--grow">
          <span className="field__label">{isNew ? 'What should it build?' : 'Task'}</span>
          <textarea
            ref={taskRef}
            className="task-input"
            value={task}
            onChange={(e) => setTask(e.target.value)}
            placeholder={isNew
              ? 'Describe the project: what it does, and the stack if you care. First line becomes the title.\n\ne.g. A Python CLI that shows the 5-day forecast for a city, with tests.'
              : 'What should the agent do? Be specific — first line becomes the title.\n\ne.g. Add a --since flag to `acme export` that filters audit logs by timestamp. Include tests.'}
          />
        </label>

        <footer className="modal__foot">
          <span className="muted small">
            {isNew
              ? 'One first task for a new project; once you merge it, run tasks in parallel.'
              : 'The agent works in its own worktree on a new branch; nothing touches your checkout until you accept.'}
          </span>
          <span className="spacer" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn--primary" disabled={!canSubmit} onClick={submit}>
            {pending ? 'Creating…' : isNew ? 'Create & start' : 'Start run'} <kbd>⌘↵</kbd>
          </button>
        </footer>
      </div>
    </div>
  );
}
