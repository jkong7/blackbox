import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { api, type Params, type StreamEvent } from './api.ts';

export interface AsyncState<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => void;
  setData: (fn: (d: T | undefined) => T | undefined) => void;
}

export function useApi<T>(path: string | null, params?: Params, deps: unknown[] = []): AsyncState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(!!path);
  const [n, setN] = useState(0);
  const key = path ? path + JSON.stringify(params ?? {}) : '';
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    const ctl = new AbortController();
    setLoading(true);
    api
      .get<T>(path, params, ctl.signal)
      .then((d) => {
        setData(d);
        setError(null);
        setLoading(false);
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setError(e);
        setLoading(false);
      });
    return () => ctl.abort();
  }, [key, n, ...deps]);
  const reload = useCallback(() => setN((x) => x + 1), []);
  const set = useCallback((fn: (d: T | undefined) => T | undefined) => setData(fn), []);
  return { data, error, loading, reload, setData: set };
}

export interface LiveState {
  connected: boolean;
  tick: number;
  last: StreamEvent | null;
  paused: boolean;
  setPaused: (p: boolean) => void;
  subscribe: (fn: (e: StreamEvent) => void) => () => void;
}

export const LiveContext = createContext<LiveState>({
  connected: false,
  tick: 0,
  last: null,
  paused: false,
  setPaused: () => {},
  subscribe: () => () => {},
});

export function useLive() {
  return useContext(LiveContext);
}

export function useLiveProvider(): LiveState {
  const [connected, setConnected] = useState(false);
  const [tick, setTick] = useState(0);
  const [last, setLast] = useState<StreamEvent | null>(null);
  const [paused, setPaused] = useState(false);
  const subs = useRef(new Set<(e: StreamEvent) => void>());
  const timer = useRef<number | null>(null);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  useEffect(() => {
    let es: EventSource | null = null;
    let retry: number | null = null;
    const open = () => {
      es = new EventSource('/api/stream');
      es.onopen = () => setConnected(true);
      es.onerror = () => {
        setConnected(false);
        es?.close();
        retry = window.setTimeout(open, 3000);
      };
      es.onmessage = (m) => {
        let ev: StreamEvent;
        try {
          ev = JSON.parse(m.data);
        } catch {
          return;
        }
        setLast(ev);
        for (const s of subs.current) s(ev);
        if (pausedRef.current) return;
        if (timer.current) return;
        timer.current = window.setTimeout(() => {
          timer.current = null;
          setTick((t) => t + 1);
        }, 1200);
      };
    };
    open();
    return () => {
      es?.close();
      if (retry) clearTimeout(retry);
    };
  }, []);
  const subscribe = useCallback((fn: (e: StreamEvent) => void) => {
    subs.current.add(fn);
    return () => {
      subs.current.delete(fn);
    };
  }, []);
  return { connected, tick, last, paused, setPaused, subscribe };
}

export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, deps: unknown[] = [], enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const fn = map[e.key];
      if (fn) {
        e.preventDefault();
        fn(e);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [enabled, ...deps]);
}

export function useLocalStorage<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try {
      const s = localStorage.getItem(key);
      return s == null ? initial : (JSON.parse(s) as T);
    } catch {
      return initial;
    }
  });
  const set = useCallback(
    (x: T) => {
      setV(x);
      try {
        localStorage.setItem(key, JSON.stringify(x));
      } catch {
        return;
      }
    },
    [key],
  );
  return [v, set];
}

export function useNow(intervalMs = 30000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export interface Health {
  ok: boolean;
  spans: number;
  version: string;
}

export const HealthContext = createContext<{ health: Health | undefined; reload: () => void }>({ health: undefined, reload: () => {} });

export function useHealth() {
  return useContext(HealthContext);
}
