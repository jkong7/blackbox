import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { api, type Page, type Trace, type Session } from '../api.ts';
import { navigate } from '../router.tsx';
import { NAV } from './Layout.tsx';
import { I } from './Icons.tsx';
import { agoNs, fmtCost, oneLine, shortId } from '../format.ts';
import { useTheme } from './Theme.tsx';

interface Item {
  id: string;
  group: string;
  label: string;
  meta?: string;
  icon: ReactNode;
  run: () => void;
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const [traces, setTraces] = useState<Trace[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [, setTheme] = useTheme();
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = q.trim();
    if (!term) {
      setTraces([]);
      setSessions([]);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api.get<Page<Trace>>('/api/traces', { q: term, limit: 8 }, ctl.signal).then((r) => setTraces(r.items)).catch(() => {});
      api.get<Page<Session>>('/api/sessions', { q: term, limit: 4 }, ctl.signal).then((r) => setSessions(r.items)).catch(() => {});
    }, 140);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q]);

  const items = useMemo<Item[]>(() => {
    const term = q.trim().toLowerCase();
    const out: Item[] = [];
    const pages = NAV.filter((n) => !term || n.label.toLowerCase().includes(term));
    for (const n of pages) {
      const Ico = I[n.icon];
      out.push({ id: 'p' + n.to, group: 'Pages', label: n.label, meta: `g ${n.key}`, icon: <Ico size={14} />, run: () => navigate(n.to) });
    }
    if (/^[0-9a-f-]{8,}$/i.test(term)) {
      out.push({ id: 'tid', group: 'Jump', label: `Open trace ${term}`, icon: <I.traces size={14} />, run: () => navigate('/traces/' + term) });
    }
    if (term.length >= 1) {
      out.push({ id: 'search', group: 'Jump', label: `Search traces for "${q.trim()}"`, icon: <I.search size={14} />, run: () => navigate('/traces?q=' + encodeURIComponent(q.trim())) });
    }
    for (const t of traces) {
      out.push({ id: 't' + t.trace_id, group: 'Traces', label: oneLine(t.input_preview || t.name || t.trace_id, 90), meta: `${shortId(t.trace_id)} · ${fmtCost(t.cost_usd)} · ${agoNs(t.start_ns)}`, icon: <I.traces size={14} />, run: () => navigate('/traces/' + t.trace_id) });
    }
    for (const s of sessions) {
      out.push({ id: 's' + s.session_id, group: 'Sessions', label: oneLine(s.first_input || s.session_id, 90), meta: `${s.trace_count} turns · ${agoNs(s.end_ns)}`, icon: <I.sessions size={14} />, run: () => navigate('/sessions/' + encodeURIComponent(s.session_id)) });
    }
    const actions: Item[] = [
      { id: 'a-light', group: 'Actions', label: 'Switch to light theme', icon: <I.sun size={14} />, run: () => setTheme('light') },
      { id: 'a-dark', group: 'Actions', label: 'Switch to dark theme', icon: <I.moon size={14} />, run: () => setTheme('dark') },
      { id: 'a-sys', group: 'Actions', label: 'Use system theme', icon: <I.system size={14} />, run: () => setTheme('system') },
      { id: 'a-err', group: 'Actions', label: 'Show traces with errors', icon: <I.alert size={14} />, run: () => navigate('/traces?status=error') },
      { id: 'a-flag', group: 'Actions', label: 'Show flagged traces', icon: <I.flag size={14} />, run: () => navigate('/traces?flagged=1') },
    ];
    for (const a of actions) if (!term || a.label.toLowerCase().includes(term)) out.push(a);
    return out;
  }, [q, traces, sessions, setTheme]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(items.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const it = items[sel];
      if (it) {
        it.run();
        onClose();
      }
    } else if (e.key === 'Escape') {
      onClose();
    }
  };

  let lastGroup = '';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="palette" role="dialog" aria-label="Command palette">
        <input autoFocus placeholder="Jump to a page, search traces by text or id…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={onKey} />
        <div className="list" ref={listRef}>
          {items.length === 0 && <div className="empty sm">No matches</div>}
          {items.map((it, i) => {
            const head = it.group !== lastGroup ? <div className="group">{it.group}</div> : null;
            lastGroup = it.group;
            return (
              <div key={it.id}>
                {head}
                <div
                  className={'item' + (i === sel ? ' on' : '')}
                  onMouseMove={() => setSel(i)}
                  onClick={() => {
                    it.run();
                    onClose();
                  }}
                >
                  <span className="muted" style={{ display: 'flex' }}>
                    {it.icon}
                  </span>
                  <span className="ellipsis">{it.label}</span>
                  {it.meta && <span className="meta mono">{it.meta}</span>}
                </div>
              </div>
            );
          })}
        </div>
        <div className="foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>↵</kbd> open
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
