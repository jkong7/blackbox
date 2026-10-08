import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';

export function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    setW(el.clientWidth);
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return n * exp;
}

export function Tooltip({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x + 14, top: y + 14 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    let left = x + 14;
    let top = y + 14;
    if (left + r.width > window.innerWidth - 8) left = x - r.width - 14;
    if (top + r.height > window.innerHeight - 8) top = y - r.height - 14;
    setPos({ left, top });
  }, [x, y, children]);
  return createPortal(
    <div ref={ref} className="tip" style={pos}>
      {children}
    </div>,
    document.body,
  );
}

export interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

function fmtBucket(ms: number, bucketMs: number): string {
  const d = new Date(ms);
  if (bucketMs >= 86400e3) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  if (bucketMs >= 3600e3) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function tickLabel(ms: number, spanMs: number): string {
  const d = new Date(ms);
  if (spanMs > 2 * 86400e3) return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

export function fillBuckets<T extends { bucket: number }>(rows: T[], start: number, end: number, bucketMs: number, blank: (b: number) => T): T[] {
  const by = new Map(rows.map((r) => [r.bucket, r]));
  const out: T[] = [];
  const first = Math.floor(start / bucketMs) * bucketMs;
  for (let b = first; b <= end; b += bucketMs) out.push(by.get(b) ?? blank(b));
  return out;
}

export function ColumnChart<T extends { bucket: number }>({ data, series, bucketMs, height = 160, format, stacked = true }: { data: T[]; series: SeriesDef[]; bucketMs: number; height?: number; format: (v: number) => string; stacked?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const padL = 44;
  const padB = 20;
  const padT = 6;
  const plotW = Math.max(0, width - padL - 4);
  const plotH = height - padB - padT;
  const val = (d: T, k: string) => Number((d as Record<string, unknown>)[k] ?? 0) || 0;
  const totals = data.map((d) => (stacked ? series.reduce((a, s) => a + val(d, s.key), 0) : Math.max(...series.map((s) => val(d, s.key)))));
  const max = niceMax(Math.max(0, ...totals));
  const n = data.length;
  const slot = n ? plotW / n : 0;
  const barW = Math.max(1, Math.min(24, slot - 2));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks = [0, max / 2, max];
  const spanMs = n ? data[n - 1].bucket - data[0].bucket : 0;
  const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const i = Math.min(n - 1, Math.max(0, Math.floor((e.clientX - r.left) / slot)));
    setHover({ i, x: e.clientX, y: e.clientY });
  };
  return (
    <div className="chart" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={series.map((s) => s.label).join(', ') + ' over time'}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line className={i === 0 ? 'baseline' : 'gridline'} x1={padL} x2={width - 4} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3.5} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          {data.map((d, i) => {
            const cx = padL + i * slot + slot / 2;
            let acc = 0;
            const segs = series.map((s, si) => {
              const v = val(d, s.key);
              if (v <= 0) return null;
              const y0 = stacked ? y(acc) : y(0);
              acc += v;
              const y1 = stacked ? y(acc) : y(v);
              const top = stacked ? series.slice(si + 1).every((x) => val(d, x.key) <= 0) : true;
              const h = Math.max(1, y0 - y1 - (stacked && si > 0 ? 2 : 0));
              const yy = y1;
              const r = top ? Math.min(3, barW / 2, h) : 0;
              const x0 = cx - barW / 2;
              const path = r
                ? `M${x0},${yy + h} V${yy + r} Q${x0},${yy} ${x0 + r},${yy} H${x0 + barW - r} Q${x0 + barW},${yy} ${x0 + barW},${yy + r} V${yy + h} Z`
                : `M${x0},${yy + h} V${yy} H${x0 + barW} V${yy + h} Z`;
              return <path key={s.key} d={path} fill={s.color} opacity={hover && hover.i !== i ? 0.55 : 1} />;
            });
            return <g key={d.bucket}>{segs}</g>;
          })}
          {data.map((d, i) =>
            i % xTickEvery === 0 ? (
              <text key={'t' + d.bucket} className="tick" x={padL + i * slot + slot / 2} y={height - 5} textAnchor="middle">
                {tickLabel(d.bucket, spanMs)}
              </text>
            ) : null,
          )}
          <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover && data[hover.i] && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="tip-title">{fmtBucket(data[hover.i].bucket, bucketMs)}</div>
          {series.map((s) => (
            <div className="tip-row" key={s.key}>
              <span className="lk" style={{ background: s.color }} />
              <b>{format(val(data[hover.i], s.key))}</b>
              <span className="lbl">{s.label}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}

export function AreaChart<T extends { bucket: number }>({ data, k, label, color, bucketMs, height = 160, format }: { data: T[]; k: string; label: string; color: string; bucketMs: number; height?: number; format: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const padL = 44;
  const padB = 20;
  const padT = 6;
  const plotW = Math.max(0, width - padL - 8);
  const plotH = height - padB - padT;
  const vals = data.map((d) => Number((d as Record<string, unknown>)[k] ?? 0) || 0);
  const max = niceMax(Math.max(0, ...vals));
  const n = data.length;
  const x = (i: number) => padL + (n <= 1 ? plotW / 2 : (i / (n - 1)) * plotW);
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const line = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z` : '';
  const ticks = [0, max / 2, max];
  const spanMs = n ? data[n - 1].bucket - data[0].bucket : 0;
  const xTickEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 90))));
  const onMove = (e: PointerEvent<SVGRectElement>) => {
    const r = (e.currentTarget as SVGRectElement).getBoundingClientRect();
    const rel = (e.clientX - r.left) / Math.max(1, r.width);
    const i = Math.min(n - 1, Math.max(0, Math.round(rel * (n - 1))));
    setHover({ i, x: e.clientX, y: e.clientY });
  };
  return (
    <div className="chart" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={label + ' over time'}>
          {ticks.map((t, i) => (
            <g key={i}>
              <line className={i === 0 ? 'baseline' : 'gridline'} x1={padL} x2={width - 8} y1={y(t)} y2={y(t)} />
              <text className="tick" x={padL - 6} y={y(t) + 3.5} textAnchor="end">
                {format(t)}
              </text>
            </g>
          ))}
          <path d={area} fill={color} opacity={0.1} />
          <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {data.map((d, i) =>
            i % xTickEvery === 0 ? (
              <text key={'t' + d.bucket} className="tick" x={x(i)} y={height - 5} textAnchor="middle">
                {tickLabel(d.bucket, spanMs)}
              </text>
            ) : null,
          )}
          {hover && (
            <g>
              <line x1={x(hover.i)} x2={x(hover.i)} y1={padT} y2={padT + plotH} stroke="var(--axis)" strokeWidth={1} />
              <circle cx={x(hover.i)} cy={y(vals[hover.i])} r={4} fill={color} stroke="var(--surface)" strokeWidth={2} />
            </g>
          )}
          <rect x={padL} y={padT} width={plotW} height={plotH} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
        </svg>
      )}
      {hover && data[hover.i] && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="tip-title">{fmtBucket(data[hover.i].bucket, bucketMs)}</div>
          <div className="tip-row">
            <span className="lk" style={{ background: color }} />
            <b>{format(vals[hover.i])}</b>
            <span className="lbl">{label}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

export function Sparkline({ values, color = 'var(--text-2)', width = 80, height = 20 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return <svg width={width} height={height} />;
  const max = Math.max(...values, 1e-9);
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * (width - 2) + 1).toFixed(1)},${(height - 2 - (v / max) * (height - 4)).toFixed(1)}`);
  return (
    <svg width={width} height={height} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

export function HistogramChart({ bins, height = 120, color = 'var(--series-1)', format = (v: number) => String(v) }: { bins: { label: string; value: number }[]; height?: number; color?: string; format?: (v: number) => string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
  const padB = 18;
  const padT = 14;
  const plotH = height - padB - padT;
  const max = Math.max(1, ...bins.map((b) => b.value));
  const n = bins.length;
  const slot = n ? width / n : 0;
  const barW = Math.max(2, Math.min(24, slot - 4));
  return (
    <div className="chart" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height}>
          <line className="baseline" x1={0} x2={width} y1={padT + plotH} y2={padT + plotH} />
          {bins.map((b, i) => {
            const h = (b.value / max) * plotH;
            const cx = i * slot + slot / 2;
            const yy = padT + plotH - h;
            const r = Math.min(3, h, barW / 2);
            const x0 = cx - barW / 2;
            return (
              <g key={i} onPointerMove={(e) => setHover({ i, x: e.clientX, y: e.clientY })} onPointerLeave={() => setHover(null)}>
                <rect x={i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
                {h > 0 && <path d={`M${x0},${yy + h} V${yy + r} Q${x0},${yy} ${x0 + r},${yy} H${x0 + barW - r} Q${x0 + barW},${yy} ${x0 + barW},${yy + r} V${yy + h} Z`} fill={color} opacity={hover && hover.i !== i ? 0.6 : 1} />}
                <text className="tick" x={cx} y={height - 4} textAnchor="middle">
                  {b.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      {hover && bins[hover.i] && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="tip-row">
            <span className="lk" style={{ background: color }} />
            <b>{format(bins[hover.i].value)}</b>
            <span className="lbl">{bins[hover.i].label}</span>
          </div>
        </Tooltip>
      )}
    </div>
  );
}

export function useInterval(fn: () => void, ms: number | null) {
  const saved = useRef(fn);
  saved.current = fn;
  useEffect(() => {
    if (ms == null) return;
    const t = setInterval(() => saved.current(), ms);
    return () => clearInterval(t);
  }, [ms]);
}
