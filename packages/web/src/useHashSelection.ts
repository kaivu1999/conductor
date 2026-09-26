import { useCallback, useEffect, useState } from 'react';

const read = () => {
  const h = decodeURIComponent(location.hash.slice(1));
  return h || null;
};

/** Selected run id mirrored in `#r_abc123`. */
export function useHashSelection(): [string | null, (id: string | null) => void] {
  const [id, setId] = useState<string | null>(read);
  useEffect(() => {
    const on = () => setId(read());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const select = useCallback((next: string | null) => {
    setId(next);
    const url = location.pathname + location.search + (next ? `#${next}` : '');
    history.replaceState(null, '', url);
  }, []);
  return [id, select];
}
