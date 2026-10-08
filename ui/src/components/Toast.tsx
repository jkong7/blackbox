import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

type Tone = 'good' | 'bad' | 'info';
interface ToastItem {
  id: number;
  text: ReactNode;
  tone: Tone;
}

const Ctx = createContext<(text: ReactNode, tone?: Tone) => void>(() => {});

export function useToast() {
  return useContext(Ctx);
}

let seq = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const push = useCallback((text: ReactNode, tone: Tone = 'info') => {
    const id = ++seq;
    setItems((xs) => [...xs.slice(-3), { id, text, tone }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), 3600);
  }, []);
  return (
    <Ctx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={'toast ' + t.tone}>
            {t.text}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}
