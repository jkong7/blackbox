import type { ReactNode } from 'react';
import { Link, useLocation } from '../router.tsx';
import { I, type IconName } from './Icons.tsx';
import { ThemeToggle } from './Theme.tsx';
import { useLive } from '../hooks.ts';

export const NAV: { to: string; label: string; icon: IconName; key: string; section?: string }[] = [
  { to: '/', label: 'Overview', icon: 'overview', key: 'o' },
  { to: '/traces', label: 'Traces', icon: 'traces', key: 't' },
  { to: '/sessions', label: 'Sessions', icon: 'sessions', key: 's' },
  { to: '/issues', label: 'Issues', icon: 'issues', key: 'i' },
  { to: '/agents', label: 'Agents & tools', icon: 'agents', key: 'a' },
  { to: '/evals', label: 'Evals', icon: 'evals', key: 'e', section: 'Evaluate' },
  { to: '/annotate', label: 'Annotate', icon: 'annotate', key: 'n' },
  { to: '/datasets', label: 'Datasets', icon: 'datasets', key: 'd' },
  { to: '/connect', label: 'Connect', icon: 'connect', key: 'c', section: 'Setup' },
];

function isActive(path: string, to: string) {
  if (to === '/') return path === '/';
  if (to === '/datasets') return path.startsWith('/datasets') || path.startsWith('/experiments');
  return path === to || path.startsWith(to + '/');
}

export function LiveIndicator() {
  const live = useLive();
  const cls = !live.connected ? '' : live.paused ? 'paused' : 'on';
  const text = !live.connected ? 'Offline' : live.paused ? 'Paused' : 'Live';
  return (
    <button className={'live ' + cls} onClick={() => live.setPaused(!live.paused)} title={live.connected ? (live.paused ? 'Live updates paused, click to resume' : 'Receiving live updates, click to pause') : 'Not connected to the event stream'}>
      <span className="pulse" />
      {text}
    </button>
  );
}

export function Sidebar({ openPalette, issueCount }: { openPalette: () => void; issueCount?: number }) {
  const { path } = useLocation();
  return (
    <nav className="sidebar" aria-label="Main">
      <Link to="/" className="brand">
        <span className="brand-mark" />
        <span className="name">blackbox</span>
        <span className="ver">0.1</span>
      </Link>
      <button className="search-trigger" onClick={openPalette} title="Search and jump (⌘K)">
        <I.search size={13} />
        <span>Search</span>
        <kbd>⌘K</kbd>
      </button>
      {NAV.map((n) => {
        const Ico = I[n.icon];
        return (
          <div key={n.to} style={{ display: 'contents' }}>
            {n.section && <div className="nav-section">{n.section}</div>}
            <Link to={n.to} className={'nav-item' + (isActive(path, n.to) ? ' active' : '')} title={`${n.label} (g then ${n.key})`}>
              <Ico size={14} />
              <span className="label">{n.label}</span>
              {n.to === '/issues' && issueCount ? <span className="count">{issueCount}</span> : null}
            </Link>
          </div>
        );
      })}
      <div className="sidebar-foot">
        <div style={{ padding: '2px 8px 4px' }}>
          <LiveIndicator />
        </div>
        <ThemeToggle />
      </div>
    </nav>
  );
}

export function PageHeader({ title, crumbs, right }: { title: ReactNode; crumbs?: { to: string; label: ReactNode }[]; right?: ReactNode }) {
  return (
    <header className="topbar">
      <div className="crumbs">
        {crumbs?.map((c, i) => (
          <span key={i} className="row" style={{ gap: 6 }}>
            <Link to={c.to}>{c.label}</Link>
            <I.chevronRight size={11} />
          </span>
        ))}
        <h1 className="ellipsis">{title}</h1>
      </div>
      <div className="spacer" />
      {right}
    </header>
  );
}
