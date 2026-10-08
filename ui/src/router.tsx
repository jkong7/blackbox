import { useEffect, useSyncExternalStore, type AnchorHTMLAttributes, type MouseEvent } from 'react';

const listeners = new Set<() => void>();

function notify() {
  for (const l of listeners) l();
}

if (typeof window !== 'undefined') window.addEventListener('popstate', notify);

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function snapshot() {
  return location.pathname + location.search;
}

export function navigate(to: string, opts: { replace?: boolean } = {}) {
  if (to === snapshot()) return;
  if (opts.replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  notify();
  if (!opts.replace) window.scrollTo(0, 0);
}

export function useLocation() {
  const loc = useSyncExternalStore(subscribe, snapshot);
  const i = loc.indexOf('?');
  const path = i < 0 ? loc : loc.slice(0, i);
  const search = new URLSearchParams(i < 0 ? '' : loc.slice(i + 1));
  return { path, search, href: loc };
}

export function match(pattern: string, path: string): Record<string, string> | null {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out: Record<string, string> = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

export function useSearchParam(key: string): [string, (v: string | null) => void] {
  const { path, search } = useLocation();
  const value = search.get(key) ?? '';
  const set = (v: string | null) => {
    const next = new URLSearchParams(location.search);
    if (v === null || v === '') next.delete(key);
    else next.set(key, v);
    const q = next.toString();
    navigate(path + (q ? '?' + q : ''), { replace: true });
  };
  return [value, set];
}

export function setSearch(updates: Record<string, string | null>, replace = true) {
  const next = new URLSearchParams(location.search);
  for (const [k, v] of Object.entries(updates)) {
    if (v === null || v === '') next.delete(k);
    else next.set(k, v);
  }
  const q = next.toString();
  navigate(location.pathname + (q ? '?' + q : ''), { replace });
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, ...rest }: LinkProps) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}

export function useTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} · blackbox` : 'blackbox';
  }, [title]);
}
