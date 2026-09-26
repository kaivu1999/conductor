import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

interface Toast { id: number; text: string; kind: 'error' | 'info' }
type Push = (text: string, kind?: Toast['kind']) => void;

const ToastCtx = createContext<Push>(() => {});
export const useToast = () => useContext(ToastCtx);

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const dismiss = (id: number) => setToasts((t) => t.filter((x) => x.id !== id));
  const push = useCallback<Push>((text, kind = 'error') => {
    const id = nextId++;
    setToasts((t) => [...t.slice(-3), { id, text, kind }]);
    setTimeout(() => dismiss(id), kind === 'error' ? 9000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            <span className="toast__text">{t.text}</span>
            <button className="toast__x" onClick={() => dismiss(t.id)} aria-label="Dismiss">×</button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
