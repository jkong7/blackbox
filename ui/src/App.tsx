import { useEffect, useRef, useState, type ReactNode } from 'react';
import { match, navigate, useLocation } from './router.tsx';
import { Sidebar, NAV } from './components/Layout.tsx';
import { CommandPalette } from './components/CommandPalette.tsx';
import { HealthContext, LiveContext, useApi, useLiveProvider, type Health } from './hooks.ts';
import { ToastProvider } from './components/Toast.tsx';
import { Overview } from './pages/overview/Overview.tsx';
import { Traces } from './pages/traces/Traces.tsx';
import { TraceDetailPage } from './pages/trace/TraceDetail.tsx';
import { Sessions } from './pages/sessions/Sessions.tsx';
import { SessionDetailPage } from './pages/sessions/SessionDetail.tsx';
import { Issues } from './pages/issues/Issues.tsx';
import { Agents } from './pages/agents/Agents.tsx';
import { Evals } from './pages/evals/Evals.tsx';
import { EvaluatorDetail } from './pages/evals/EvaluatorDetail.tsx';
import { Annotate } from './pages/annotate/Annotate.tsx';
import { Datasets } from './pages/datasets/Datasets.tsx';
import { DatasetDetail } from './pages/datasets/DatasetDetail.tsx';
import { ExperimentDetail } from './pages/datasets/ExperimentDetail.tsx';
import { Connect } from './pages/connect/Connect.tsx';
import { PageHeader } from './components/Layout.tsx';
import { Empty } from './components/ui.tsx';
import type { Issue } from './api.ts';

const ROUTES: [string, (p: Record<string, string>) => ReactNode][] = [
  ['/', () => <Overview />],
  ['/traces', () => <Traces />],
  ['/traces/:id', (p) => <TraceDetailPage id={p.id} />],
  ['/sessions', () => <Sessions />],
  ['/sessions/:id', (p) => <SessionDetailPage id={p.id} />],
  ['/issues', () => <Issues />],
  ['/agents', () => <Agents />],
  ['/evals', () => <Evals />],
  ['/evals/:id', (p) => <EvaluatorDetail id={p.id} />],
  ['/annotate', () => <Annotate />],
  ['/datasets', () => <Datasets />],
  ['/datasets/:id', (p) => <DatasetDetail id={p.id} />],
  ['/experiments/:id', (p) => <ExperimentDetail id={p.id} />],
  ['/connect', () => <Connect />],
];

function NotFound() {
  return (
    <>
      <PageHeader title="Not found" />
      <div className="page">
        <Empty title="Nothing here" body="This page does not exist." actions={<button className="btn" onClick={() => navigate('/')}>Go to overview</button>} />
      </div>
    </>
  );
}

export function App() {
  const live = useLiveProvider();
  const { path } = useLocation();
  const [palette, setPalette] = useState(false);
  const health = useApi<Health>('/api/health', undefined, [live.tick]);
  const issues = useApi<{ items: Issue[] }>('/api/issues', { status: 'open' }, [live.tick]);
  const gPending = useRef(0);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
        return;
      }
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/' && !palette) {
        const el = document.querySelector<HTMLInputElement>('[data-page-search]');
        if (el) {
          e.preventDefault();
          el.focus();
          return;
        }
      }
      if (e.key === 'g') {
        gPending.current = Date.now();
        return;
      }
      if (Date.now() - gPending.current < 900) {
        const n = NAV.find((x) => x.key === e.key);
        gPending.current = 0;
        if (n) {
          e.preventDefault();
          navigate(n.to);
        }
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [palette]);

  let page: ReactNode = null;
  for (const [pattern, render] of ROUTES) {
    const m = match(pattern, path);
    if (m) {
      page = render(m);
      break;
    }
  }

  const openCount = issues.data?.items.length;

  return (
    <LiveContext.Provider value={live}>
      <HealthContext.Provider value={{ health: health.data, reload: health.reload }}>
        <ToastProvider>
          <div className="app">
            <Sidebar openPalette={() => setPalette(true)} issueCount={openCount} />
            <main className="main" key={path.split('/')[1]}>
              {page ?? <NotFound />}
            </main>
          </div>
          {palette && <CommandPalette onClose={() => setPalette(false)} />}
        </ToastProvider>
      </HealthContext.Provider>
    </LiveContext.Provider>
  );
}
