import { useState } from 'react';
import type { Run } from '@conductor/shared';
import { useToast } from './components/Toasts.tsx';
import { useStore } from './useConductor.ts';

/** Wraps a mutating call: tracks pending, upserts the returned run, toasts the server's error verbatim. */
export function useAction() {
  const store = useStore();
  const toast = useToast();
  const [pending, setPending] = useState<string | null>(null);
  async function run(name: string, fn: () => Promise<Run>): Promise<Run | null> {
    setPending(name);
    try {
      const r = await fn();
      store.upsert(r);
      return r;
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e));
      return null;
    } finally {
      setPending(null);
    }
  }
  return { pending, run, src: store.src };
}
