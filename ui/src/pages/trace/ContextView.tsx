import { useState } from 'react';
import type { Span } from '../../api.ts';
import { Tooltip } from '../../components/Charts.tsx';
import { Empty, Seg } from '../../components/ui.tsx';
import { fmtCompact, fmtInt, fmtPct } from '../../format.ts';
import { promptTokens } from './model.ts';

const PARTS = [
  { k: 'input_tokens', label: 'Input', c: 'var(--c-input)' },
  { k: 'cache_read_tokens', label: 'Cache read', c: 'var(--c-cache-read)' },
  { k: 'cache_write_tokens', label: 'Cache write', c: 'var(--c-cache-write)' },
  { k: 'output_tokens', label: 'Output', c: 'var(--c-output)' },
] as const;

export function ContextView({ spans, windows, selected, onSelect }: { spans: Span[]; windows: Record<string, number | null>; selected: string | null; onSelect: (id: string) => void }) {
  const llms = spans.filter((s) => s.kind === 'llm').sort((a, b) => a.start_ns - b.start_ns);
  const [hover, setHover] = useState<{ s: Span; x: number; y: number } | null>(null);
  const [mode, setMode] = useState<'auto' | 'fit' | 'window'>('auto');
  if (!llms.length) return <Empty title="No LLM calls in this trace" body="The context track shows how each call's prompt fills the model context window." />;
  const used = (s: Span) => promptTokens(s) + (s.output_tokens ?? 0);
  const knownWindows = llms.map((s) => (s.model ? windows[s.model] : null)).filter((x): x is number => !!x);
  const maxUsed = Math.max(1, ...llms.map(used));
  const peak = llms.reduce((best, s) => {
    const w = s.model ? windows[s.model] : null;
    const r = w ? used(s) / w : 0;
    return r > best.r ? { r, s } : best;
  }, { r: 0, s: null as Span | null });
  const fullScale = Math.max(maxUsed, ...knownWindows);
  const m = mode === 'auto' ? (maxUsed / fullScale < 0.25 ? 'fit' : 'window') : mode;
  const scale = m === 'fit' ? maxUsed * 1.04 : fullScale;
  const totalPrompt = llms.reduce((a, s) => a + promptTokens(s), 0);
  const totalRead = llms.reduce((a, s) => a + (s.cache_read_tokens ?? 0), 0);
  const models = [...new Set(llms.map((s) => s.model).filter(Boolean))] as string[];

  return (
    <div className="panel-scroll">
      <div className="row wrap" style={{ gap: 18 }}>
        <div className="td-stat">
          <span className="l">LLM calls</span>
          <span className="v">{llms.length}</span>
        </div>
        <div className="td-stat">
          <span className="l">Peak context</span>
          <span className="v" style={{ color: peak.r > 0.8 ? 'var(--bad)' : undefined }}>{peak.r ? fmtPct(peak.r, 0) : fmtCompact(maxUsed)}</span>
        </div>
        <div className="td-stat">
          <span className="l">Growth</span>
          <span className="v">
            {fmtCompact(used(llms[0]))} to {fmtCompact(used(llms[llms.length - 1]))}
          </span>
        </div>
        <div className="td-stat">
          <span className="l">Prompt cached</span>
          <span className="v">{totalPrompt ? fmtPct(totalRead / totalPrompt, 0) : '-'}</span>
        </div>
        <div className="td-stat">
          <span className="l">Window</span>
          <span className="v">{models.map((m) => (windows[m] ? `${fmtCompact(windows[m]!)} (${m})` : `unknown (${m})`)).join(', ')}</span>
        </div>
      </div>
      <div className="row" style={{ gap: 12 }}>
      <div className="legend" style={{ flex: 1 }}>
        {PARTS.map((p) => (
          <span key={p.k}>
            <i style={{ background: p.c }} />
            {p.label}
          </span>
        ))}
        <span>
          <i className="line" style={{ background: 'var(--bad)', width: 2, height: 10 }} />
          80% of window
        </span>
      </div>
        <Seg
          value={m}
          label="Scale"
          onChange={(v) => setMode(v)}
          options={[
            { value: 'fit', label: 'Fit to peak' },
            { value: 'window', label: 'Full window' },
          ]}
        />
      </div>
      <div className="stack" style={{ gap: 2 }}>
        {llms.map((s, i) => {
          const w = s.model ? windows[s.model] : null;
          const u = used(s);
          return (
            <div
              key={s.span_id}
              className={'ctx-row' + (s.span_id === selected ? ' sel' : '')}
              onClick={() => onSelect(s.span_id)}
              onPointerMove={(e) => setHover({ s, x: e.clientX, y: e.clientY })}
              onPointerLeave={() => setHover(null)}
            >
              <span className="muted num" style={{ fontSize: 11.5 }}>
                #{i + 1}
              </span>
              <div className="ctx-track">
                {PARTS.map((p) => {
                  const v = (s[p.k] as number | null) ?? 0;
                  return v ? <i key={p.k} style={{ width: `${(v / scale) * 100}%`, background: p.c }} /> : null;
                })}
                {w && w * 0.8 <= scale && <span className="ctx-mark" style={{ left: `${((w * 0.8) / scale) * 100}%` }} />}
              </div>
              <span className="num" style={{ fontSize: 12, textAlign: 'right', color: w && u / w > 0.8 ? 'var(--bad)' : 'var(--text-2)' }}>
                {fmtCompact(u)}
                {w ? <span className="muted"> · {fmtPct(u / w, 0)}</span> : null}
              </span>
            </div>
          );
        })}
      </div>
      {hover && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="tip-title">
            {hover.s.model ?? hover.s.name}
            {hover.s.model && windows[hover.s.model] ? ` · ${fmtCompact(windows[hover.s.model]!)} window` : ''}
          </div>
          {PARTS.map((p) => (
            <div className="tip-row" key={p.k}>
              <span className="lk" style={{ background: p.c }} />
              <b>{fmtInt((hover.s[p.k] as number | null) ?? 0)}</b>
              <span className="lbl">{p.label}</span>
            </div>
          ))}
        </Tooltip>
      )}
    </div>
  );
}
