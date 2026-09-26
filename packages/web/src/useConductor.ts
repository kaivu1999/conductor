import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';
import { httpSource } from './api.ts';
import { createMockSource } from './mock.ts';
import { ConductorStore, type State } from './store.ts';

const useMock = new URLSearchParams(location.search).has('mock');

export const store = new ConductorStore(useMock ? createMockSource() : httpSource);
export const isMock = useMock;

export const StoreContext = createContext<ConductorStore>(store);

export function useStore(): ConductorStore {
  return useContext(StoreContext);
}

export function useConductor<T>(select: (s: State) => T): T {
  const s = useStore();
  return useSyncExternalStore(s.subscribe, () => select(s.getState()));
}

/** Current time, re-rendering every `intervalMs` (for relative timestamps). */
export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Async loader keyed by deps; returns { data, error, loading, reload }. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]) {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null, error: null, loading: true,
  });
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) => alive && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }),
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
