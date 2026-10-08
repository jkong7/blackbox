import { useState } from 'react';
import type { Signal, Span } from '../../api.ts';
import { KindIcon } from '../../components/Kind.tsx';
import { fmtCost, fmtMs, oneLine } from '../../format.ts';
import { toolCallsOf } from './extract.ts';

function label(s: Span): string {
  if (s.kind === 'llm') return s.model ?? s.name;
  if (s.kind === 'tool' || s.kind === 'mcp' || s.kind === 'memory') return s.tool_name ?? s.name;
  if (s.kind === 'agent' || s.kind === 'handoff') return s.agent_name ?? s.name;
  return s.name;
}

function detail(s: Span): string {
  if (s.kind === 'llm') {
    const calls = toolCallsOf(s);
    if (calls.length) return 'calls ' + calls.join(', ');
    return oneLine(s.output_preview, 140);
  }
  return oneLine(s.input_preview, 140);
}

function Step({ s, i, signals }: { s: Span; i: number; signals: Signal[] }) {
  const [open, setOpen] = useState(false);
  const err = s.status === 'error';
  const canOpen = s.kind !== 'llm' && (s.output_preview || s.status_message);
  return (
    <div className={'an-step' + (err ? ' err' : '')}>
      <div className="an-step-row" onClick={() => canOpen && setOpen(!open)} style={{ cursor: canOpen ? 'pointer' : 'default' }}>
        <span className="muted num an-step-i">{i + 1}</span>
        <KindIcon kind={s.kind} size={18} />
        <span className="mono an-step-name">{label(s)}</span>
        <span className="dim ellipsis an-step-detail">{detail(s)}</span>
        {signals.map((g) => (
          <span key={g.id} className={'sev ' + g.severity} title={g.title} />
        ))}
        {err && <span className="chip bad" style={{ height: 18 }}>error</span>}
        <span className="muted num an-step-meta">
          {s.cost_usd ? fmtCost(s.cost_usd) + ' · ' : ''}
          {fmtMs(s.duration_ms)}
        </span>
      </div>
      {open && (
        <div className="an-step-body">
          {s.status_message && <div className="err-text mono" style={{ fontSize: 12 }}>{s.status_message}</div>}
          {s.output_preview && <div className="mono dim prose" style={{ fontSize: 12 }}>{s.output_preview}</div>}
        </div>
      )}
    </div>
  );
}

export function Trajectory({ spans, signals }: { spans: Span[]; signals: Signal[] }) {
  const [all, setAll] = useState(false);
  const cap = 40;
  const shown = all ? spans : spans.slice(0, cap);
  if (!spans.length) return <div className="muted" style={{ padding: 12 }}>No steps recorded below the root span.</div>;
  return (
    <div className="an-traj">
      {shown.map((s, i) => (
        <Step key={s.span_id} s={s} i={i} signals={signals.filter((g) => g.span_id === s.span_id)} />
      ))}
      {spans.length > cap && !all && (
        <button className="btn ghost sm" style={{ margin: 6 }} onClick={() => setAll(true)}>
          Show all {spans.length} steps
        </button>
      )}
    </div>
  );
}
