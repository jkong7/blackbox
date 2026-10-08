import { useEffect, useRef, useState } from 'react';
import type { Signal } from '../../api.ts';
import { KindIcon, kindColor } from '../../components/Kind.tsx';
import { I } from '../../components/Icons.tsx';
import { fmtCost, fmtMs, fmtTokens } from '../../format.ts';
import { displayName, spanTokens, subtitle, type Tree, type TreeNode } from './model.ts';

const ROW = 30;

function ticks(totalMs: number): number[] {
  return [0, 0.25, 0.5, 0.75, 1].map((f) => f * totalMs);
}

export function SpanTree({ tree, rows, selected, onSelect, collapsed, onToggle, signalsBySpan, highlight }: {
  tree: Tree;
  rows: TreeNode[];
  selected: string | null;
  onSelect: (id: string) => void;
  collapsed: Set<string>;
  onToggle: (id: string) => void;
  signalsBySpan: Map<string, Signal[]>;
  highlight: Set<string> | null;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(600);
  const totalMs = Math.max(1e-6, (tree.end - tree.start) / 1e6);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setHeight(el.clientHeight));
    ro.observe(el);
    setHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !selected) return;
    const i = rows.findIndex((r) => r.span.span_id === selected);
    if (i < 0) return;
    const top = i * ROW;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW - el.clientHeight;
  }, [selected, rows]);

  const from = Math.max(0, Math.floor(scroll / ROW) - 10);
  const to = Math.min(rows.length, Math.ceil((scroll + height) / ROW) + 10);

  return (
    <div className="span-tree">
      <div className="st-head">
        <div className="st-label">Span</div>
        <div className="st-num">Tokens</div>
        <div className="st-num">Cost</div>
        <div className="st-wf">
          {ticks(totalMs).map((t, i) => (
            <span key={i} style={{ left: `${(i / 4) * 100}%` }} className={i === 0 ? 'first' : i === 4 ? 'last' : ''}>
              {t === 0 ? '0' : fmtMs(t)}
            </span>
          ))}
        </div>
      </div>
      <div className="st-body" ref={scroller} onScroll={(e) => setScroll(e.currentTarget.scrollTop)} role="tree" aria-label="Span tree">
        <div style={{ height: rows.length * ROW, position: 'relative' }}>
          {rows.slice(from, to).map((n, k) => {
            const i = from + k;
            const s = n.span;
            const sigs = signalsBySpan.get(s.span_id) ?? [];
            const left = ((s.start_ns - tree.start) / 1e6 / totalMs) * 100;
            const dur = s.duration_ms ?? (s.end_ns ? (s.end_ns - s.start_ns) / 1e6 : 0);
            const width = (dur / totalMs) * 100;
            const isSel = s.span_id === selected;
            const hl = highlight?.has(s.span_id);
            const dim = highlight && !hl;
            const tok = spanTokens(s);
            const isCollapsed = collapsed.has(s.span_id);
            const sub = subtitle(s);
            const worst = sigs.find((x) => x.severity === 'high') ?? sigs.find((x) => x.severity === 'medium') ?? sigs[0];
            return (
              <div
                key={s.span_id}
                role="treeitem"
                aria-selected={isSel}
                aria-expanded={n.children.length ? !isCollapsed : undefined}
                className={'st-row' + (isSel ? ' sel' : '') + (hl ? ' hl' : '') + (dim ? ' dim' : '') + (s.status === 'error' ? ' err' : '')}
                style={{ top: i * ROW }}
                onClick={() => onSelect(s.span_id)}
              >
                <div className="st-label">
                  <span style={{ width: n.depth * 14, flex: 'none' }} />
                  {n.children.length ? (
                    <button
                      className="st-caret"
                      onClick={(e) => {
                        e.stopPropagation();
                        onToggle(s.span_id);
                      }}
                      aria-label={isCollapsed ? 'Expand' : 'Collapse'}
                    >
                      {isCollapsed ? <I.chevronRight size={11} /> : <I.chevronDown size={11} />}
                    </button>
                  ) : (
                    <span className="st-caret" />
                  )}
                  <KindIcon kind={s.kind} size={18} />
                  <span className="st-name ellipsis">{displayName(s)}</span>
                  {sub && <span className="st-sub ellipsis">{sub}</span>}
                  {isCollapsed && n.children.length > 0 && <span className="chip neutral" style={{ height: 16, fontSize: 10.5 }}>{n.children.length}</span>}
                  {s.status === 'error' && <span className="st-err" title={s.status_message ?? 'Error'}>error</span>}
                  {worst && <span className={'sev ' + worst.severity} title={sigs.map((x) => x.title).join('\n')} />}
                </div>
                <div className="st-num">{tok ? fmtTokens(tok) : ''}</div>
                <div className="st-num">{s.cost_usd ? fmtCost(s.cost_usd) : isCollapsed && n.subtreeCost ? <span className="muted">{fmtCost(n.subtreeCost)}</span> : ''}</div>
                <div className="st-wf">
                  <span
                    className="st-bar"
                    style={{
                      left: `${Math.min(99.5, left)}%`,
                      width: `max(2px, ${Math.min(100 - left, width)}%)`,
                      background: s.status === 'error' ? 'var(--bad)' : kindColor(s.kind),
                    }}
                  />
                  <span className="st-dur" style={left + width > 72 ? { right: `calc(${100 - left}% + 6px)` } : { left: `calc(${left + width}% + 6px)` }}>
                    {fmtMs(dur)}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
