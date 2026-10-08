import { useSyncExternalStore } from 'react';
import { I } from './Icons.tsx';

type Mode = 'system' | 'light' | 'dark';

function read(): Mode {
  try {
    const t = localStorage.getItem('bb-theme');
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}
const subs = new Set<() => void>();
let current: Mode = typeof window === 'undefined' ? 'system' : read();

function apply(mode: Mode) {
  current = mode;
  const root = document.documentElement;
  if (mode === 'system') delete root.dataset.theme;
  else root.dataset.theme = mode;
  try {
    if (mode === 'system') localStorage.removeItem('bb-theme');
    else localStorage.setItem('bb-theme', mode);
  } catch {
    current = mode;
  }
  for (const s of subs) s();
}

export function useTheme(): [Mode, (m: Mode) => void] {
  const mode = useSyncExternalStore(
    (fn) => {
      subs.add(fn);
      return () => {
        subs.delete(fn);
      };
    },
    () => current,
  );
  return [mode, apply];
}


export function ThemeToggle() {
  const [mode, setMode] = useTheme();
  const next: Record<Mode, Mode> = { system: 'light', light: 'dark', dark: 'system' };
  const Ico = mode === 'light' ? I.sun : mode === 'dark' ? I.moon : I.system;
  const label = mode === 'system' ? 'System theme' : mode === 'light' ? 'Light theme' : 'Dark theme';
  return (
    <button className="nav-item" style={{ border: 0, background: 'none', cursor: 'pointer', width: '100%' }} onClick={() => setMode(next[mode])} title={`${label} (click to switch)`}>
      <Ico size={14} />
      <span className="label">{label}</span>
    </button>
  );
}
