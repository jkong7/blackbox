import { useMemo } from 'react';
import { kindColor, KIND_LABEL } from '../../components/Kind.tsx';
import { fmtCost, fmtMs } from '../../format.ts';
import type { Kind } from '../../api.ts';
import { buildGraph, type GraphNode, type Tree } from './model.ts';

const W = 176;
const H = 50;
const COLG = 20;
const ROWG = 64;
const PAD = 24;

export function AgentGraph({ tree, active, onPick }: { tree: Tree; active: string | null; onPick: (n: GraphNode | null) => void }) {
  const { nodes, edges, pos, width, height } = useMemo(() => {
    const g = buildGraph(tree);
    const first = new Map<string, number>();
    for (const n of g.nodes) first.set(n.id, Math.min(...n.spanIds.map((id) => tree.byId.get(id)?.span.start_ns ?? 0)));
    const layers = new Map<number, GraphNode[]>();
    for (const n of g.nodes) {
      const l = layers.get(n.layer) ?? [];
      l.push(n);
      layers.set(n.layer, l);
    }
    const pos = new Map<string, { x: number; y: number }>();
    let maxCols = 0;
    for (const [, ns] of layers) maxCols = Math.max(maxCols, ns.length);
    const fullW = maxCols * W + (maxCols - 1) * COLG;
    for (const [layer, ns] of layers) {
      ns.sort((a, b) => (first.get(a.id) ?? 0) - (first.get(b.id) ?? 0));
      const rowW = ns.length * W + (ns.length - 1) * COLG;
      const x0 = PAD + (fullW - rowW) / 2;
      ns.forEach((n, i) => pos.set(n.id, { x: x0 + i * (W + COLG), y: PAD + layer * (H + ROWG) }));
    }
    const layerCount = Math.max(1, layers.size);
    return { nodes: g.nodes, edges: g.edges, pos, width: PAD * 2 + fullW + 60, height: PAD * 2 + layerCount * (H + ROWG) - ROWG + 10 };
  }, [tree]);

  if (!nodes.length) return <div className="empty">No spans to graph</div>;
  const maxCount = Math.max(1, ...edges.map((e) => e.count));

  return (
    <div className="graph-wrap" onClick={(e) => e.target === e.currentTarget && onPick(null)}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} style={{ maxWidth: '100%', height: 'auto' }} role="img" aria-label="Agent graph">
        <defs>
          <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse" orient="auto-start-reverse">
            <path d="M0,0 L8,4 L0,8 z" fill="var(--axis)" />
          </marker>
        </defs>
        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const forward = b.y > a.y;
          let d: string;
          let lx: number;
          let ly: number;
          if (forward) {
            const x1 = a.x + W / 2;
            const y1 = a.y + H;
            const x2 = b.x + W / 2;
            const y2 = b.y - 2;
            const my = (y1 + y2) / 2;
            d = `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`;
            lx = (x1 + x2) / 2 + 8;
            ly = my + 4;
          } else {
            const x1 = a.x + W;
            const y1 = a.y + H / 2 + 6;
            const x2 = b.x + W + 2;
            const y2 = b.y + H / 2 - 6;
            const bulge = Math.max(x1, x2) + 40;
            d = `M${x1},${y1} C${bulge},${y1} ${bulge},${y2} ${x2},${y2}`;
            lx = bulge - 8;
            ly = (y1 + y2) / 2 + 4;
          }
          const dim = active && e.from !== active && e.to !== active;
          return (
            <g key={e.from + e.to} opacity={dim ? 0.25 : 1}>
              <path className="gedge" d={d} strokeWidth={1 + (e.count / maxCount) * 2.5} markerEnd="url(#arrow)" />
              {e.count > 1 && (
                <text className="gedge-label" x={lx} y={ly} textAnchor="middle">
                  ×{e.count}
                </text>
              )}
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const c = kindColor(n.kind);
          const dim = active && active !== n.id && !edges.some((e) => (e.from === active && e.to === n.id) || (e.to === active && e.from === n.id));
          return (
            <g
              key={n.id}
              className={'gnode' + (active === n.id ? ' on' : '') + (n.errors ? ' err' : '')}
              transform={`translate(${p.x},${p.y})`}
              opacity={dim ? 0.35 : 1}
              onClick={() => onPick(active === n.id ? null : n)}
              tabIndex={0}
              role="button"
              aria-label={`${KIND_LABEL[n.kind as Kind] ?? n.kind} ${n.label}, ${n.calls} calls`}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onPick(active === n.id ? null : n)}
            >
              <rect className="box" width={W} height={H} rx={7} />
              <rect x={0} y={0} width={4} height={H} rx={2} fill={c} />
              <text x={14} y={20} style={{ fontWeight: 500 }}>
                {n.label.length > 24 ? n.label.slice(0, 23) + '…' : n.label}
              </text>
              <text className="meta" x={14} y={37}>
                {KIND_LABEL[n.kind as Kind] ?? n.kind} · {n.calls}× · {n.cost ? fmtCost(n.cost) : fmtMs(n.ms)}
                {n.errors ? ` · ${n.errors} err` : ''}
              </text>
              {n.errors > 0 && <circle cx={W - 12} cy={12} r={4} fill="var(--bad)" />}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
