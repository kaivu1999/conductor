import { useEffect, useMemo, useRef, useState } from 'react';
import { needsAttention } from '@conductor/shared';
import { Header } from './components/Header.tsx';
import { NewRunDialog, type NewRunPrefill } from './components/NewRunDialog.tsx';
import { RunDetail, type RunDetailHandle } from './components/RunDetail.tsx';
import { RunList } from './components/RunList.tsx';
import { ToastProvider } from './components/Toasts.tsx';
import { GROUP_ORDER, groupOf } from './stateMeta.ts';
import { store, useConductor, useNow } from './useConductor.ts';
import { useHashSelection } from './useHashSelection.ts';
import { toggleVoice, useVoice, voice, VoiceDock } from './voice/VoiceControls.tsx';

export function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  useEffect(() => { store.start(); }, []);
  const now = useNow(1000);
  const sorted = useConductor((s) => s.sorted);
  const runs = useConductor((s) => s.runs);
  const system = useConductor((s) => s.system);
  const conn = useConductor((s) => s.conn);
  const droppedAt = useConductor((s) => s.droppedAt);
  const nextRetryAt = useConductor((s) => s.nextRetryAt);
  const loaded = useConductor((s) => s.loaded);
  const [selectedId, select] = useHashSelection();
  const [filterNeeds, setFilterNeeds] = useState(false);
  const [newOpen, setNewOpen] = useState(false);
  // Set when Conductor's voice opens the dialog; `key` remounts it with the new pre-fill.
  const [prefill, setPrefill] = useState<{ key: number; fill: NewRunPrefill } | null>(null);
  const detail = useRef<RunDetailHandle>(null);
  const voiceLive = useVoice((s) => s.status === 'live');

  const needs = useMemo(() => sorted.filter((r) => needsAttention(r, now)), [sorted, now]);
  // Visual order = group order (matches what the list renders), used for j/k.
  const visible = useMemo(() => {
    const base = filterNeeds ? needs : sorted;
    return GROUP_ORDER.flatMap((g) => base.filter((r) => groupOf(r, now) === g));
  }, [sorted, needs, filterNeeds, now]);
  const selected = selectedId ? runs[selectedId] ?? null : null;
  const knownRepos = useMemo(() => [...new Set(sorted.map((r) => r.repoPath))], [sorted]);

  useEffect(() => { if (filterNeeds && needs.length === 0) setFilterNeeds(false); }, [filterNeeds, needs.length]);

  // Conductor's voice drives the screen: open the task it's talking about, or filter the list.
  useEffect(() => store.onVoiceCommand((cmd) => {
    if (cmd.kind === 'show_needs') { setFilterNeeds(cmd.on); return; }
    if (cmd.kind === 'new_run') {
      const { kind: _, ...fill } = cmd;
      setPrefill((p) => ({ key: (p?.key ?? 0) + 1, fill }));
      setNewOpen(true);
      return;
    }
    const run = store.getState().runs[cmd.runId];
    if (run && !needsAttention(run, Date.now())) setFilterNeeds(false);
    select(cmd.runId);
    requestAnimationFrame(() => document.querySelector(`[data-run-id="${cmd.runId}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }), [select]);

  // Title shows the count so a background tab still tells you when you're needed.
  useEffect(() => {
    document.title = needs.length ? `(${needs.length}) conductor` : 'conductor';
  }, [needs.length]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (newOpen || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      const idx = visible.findIndex((r) => r.id === selectedId);
      const move = (d: number) => {
        const next = visible[Math.max(0, Math.min(visible.length - 1, idx === -1 ? 0 : idx + d))];
        if (next) {
          select(next.id);
          requestAnimationFrame(() => document.querySelector(`[data-run-id="${next.id}"]`)?.scrollIntoView({ block: 'nearest' }));
        }
      };
      if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); move(1); }
      else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
      else if (e.key === 'Enter' && idx === -1 && visible[0]) select(visible[0].id);
      else if (e.key === 'n') { e.preventDefault(); setNewOpen(true); }
      else if (e.key === 'v') { e.preventDefault(); toggleVoice(); }
      else if (e.key === 'm' && voice.getState().status === 'live') { e.preventDefault(); voice.toggleMute(); }
      else if (e.key === 'a') {
        // Jump to the most urgent question if the current run isn't asking one.
        const target = selected?.state === 'waiting_input' ? selected : sorted.find((r) => r.state === 'waiting_input');
        if (target) { e.preventDefault(); select(target.id); requestAnimationFrame(() => detail.current?.focusAnswer()); }
      } else if (e.key === 'c' && selected && (selected.state === 'ready' || selected.state === 'conflict')) {
        e.preventDefault();
        detail.current?.focusContinue();
      } else if (e.key === 'Escape') select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, selectedId, select, newOpen, selected, sorted]);

  return (
    <div className={`app${conn === 'reconnecting' ? ' app--offline' : ''}`}>
      <Header
        system={system}
        needs={needs.length}
        filterNeeds={filterNeeds}
        onToggleNeeds={() => setFilterNeeds(!filterNeeds)}
        conn={conn}
        droppedAt={droppedAt}
        nextRetryAt={nextRetryAt}
        now={now}
        onRetry={() => store.retryNow()}
        onNew={() => setNewOpen(true)}
      />
      {conn === 'reconnecting' && (
        <div className="offline-bar">Lost connection to the conductor server — showing last known state. Reconnecting automatically…</div>
      )}
      <main className="panes">
        <aside className="pane pane--list">
          {!loaded ? <div className="muted pad">Loading runs…</div> : (
            <RunList
              runs={filterNeeds ? needs : sorted}
              now={now}
              selectedId={selectedId}
              onSelect={select}
              onlyNeeds={filterNeeds}
              onClearFilter={() => setFilterNeeds(false)}
              loaded={loaded}
              onNew={() => setNewOpen(true)}
            />
          )}
        </aside>
        <section className="pane pane--detail">
          {selected ? (
            <RunDetail ref={detail} key={selected.id} run={selected} now={now} onSelect={select} />
          ) : (
            <EmptyDetail loaded={loaded} missing={!!selectedId && loaded} needs={needs.length} total={sorted.length}
              onPickTop={() => { const top = needs[0] ?? sorted[0]; if (top) select(top.id); }} onNew={() => setNewOpen(true)} />
          )}
        </section>
      </main>
      <footer className="foot">
        <span><kbd>j</kbd>/<kbd>k</kbd> move</span>
        <span><kbd>a</kbd> answer</span>
        <span><kbd>n</kbd> new run</span>
        <span><kbd>v</kbd> talk</span>
        {voiceLive && <span><kbd>m</kbd> mute</span>}
        <span><kbd>esc</kbd> deselect</span>
        {system && <span className="spacer" />}
        {system && <span className="muted">v{system.version}</span>}
      </footer>
      <VoiceDock />
      {newOpen && (
        <NewRunDialog
          key={prefill?.key ?? 0}
          prefill={prefill?.fill}
          knownRepos={knownRepos}
          onClose={() => { setNewOpen(false); setPrefill(null); }}
          onCreated={(id) => { setNewOpen(false); setPrefill(null); setFilterNeeds(false); select(id); }}
        />
      )}
    </div>
  );
}

function EmptyDetail({ loaded, missing, needs, total, onPickTop, onNew }: {
  loaded: boolean; missing: boolean; needs: number; total: number; onPickTop(): void; onNew(): void;
}) {
  if (!loaded) return <div className="empty"><p className="muted">Connecting to conductor…</p></div>;
  return (
    <div className="empty">
      {missing && <p className="warn">That run no longer exists.</p>}
      {total === 0 ? (
        <>
          <h3>Run several coding agents at once</h3>
          <p className="muted">Each run gets an isolated git worktree and branch. You'll see here when one asks a question, fails, or is ready for review.</p>
          <button className="btn btn--primary" onClick={onNew}>Start your first run <kbd>n</kbd></button>
        </>
      ) : needs > 0 ? (
        <>
          <h3>{needs} {needs === 1 ? 'run needs' : 'runs need'} you</h3>
          <p className="muted">Pick one on the left, or jump to the most urgent.</p>
          <button className="btn btn--primary" onClick={onPickTop}>Open most urgent <kbd>j</kbd></button>
        </>
      ) : (
        <>
          <h3>All agents are fine</h3>
          <p className="muted">Nothing is waiting on you. Select a run to watch what it's doing, or start another.</p>
          <button className="btn" onClick={onNew}>New run <kbd>n</kbd></button>
        </>
      )}
    </div>
  );
}
