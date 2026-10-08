import { memo, type MouseEvent } from 'react';
import type { Trace } from '../../api.ts';
import { navigate } from '../../router.tsx';
import { SignalChip, ScoreChip, TraceStatus } from '../../components/Badges.tsx';
import { agoNs, fmtCompact, fmtCost, fmtMs, fmtTime, oneLine, scoreTone, scoreText } from '../../format.ts';

function TraceRowInner({ t, selected, fresh, onSignal }: { t: Trace; selected: boolean; fresh: boolean; onSignal: (s: string) => void }) {
  const tokens = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
  const promptSide = t.input_tokens + t.cache_read_tokens + t.cache_write_tokens;
  const hit = promptSide ? t.cache_read_tokens / promptSide : null;
  const agents = t.agent_names?.split(',').filter(Boolean) ?? [];
  const sigs = t.signals ?? [];
  const rank = { bad: 0, mid: 1, neutral: 2, good: 3 } as const;
  const scores = [...(t.scores ?? [])].sort((a, b) => rank[scoreTone(a)] - rank[scoreTone(b)]);
  const open = (e: MouseEvent) => {
    const url = '/traces/' + t.trace_id;
    if (e.metaKey || e.ctrlKey) window.open(url, '_blank');
    else navigate(url);
  };
  return (
    <tr className={'click' + (selected ? ' sel' : '') + (fresh ? ' new' : '')} onClick={open}>
      <td style={{ paddingRight: 0 }}>
        <TraceStatus errors={t.error_count} flagged={t.signal_count} label={false} />
      </td>
      <td className="num" title={new Date(t.start_ns / 1e6).toLocaleString()}>
        <div>{fmtTime(t.start_ns / 1e6)}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {agoNs(t.start_ns)}
        </div>
      </td>
      <td className="name-cell">
        <div className="ellipsis cell-main" style={{ maxWidth: 160 }}>
          {agents[0] ?? t.name ?? 'trace'}
          {agents.length > 1 && <span className="muted"> +{agents.length - 1}</span>}
        </div>
        <div className="muted mono ellipsis" style={{ fontSize: 11, maxWidth: 160 }}>
          {t.models?.split(',')[0] ?? t.name}
        </div>
      </td>
      <td className="preview">
        <div className="ellipsis">{oneLine(t.input_preview, 200) || <span className="muted">No input captured</span>}</div>
        <div className="ellipsis muted" style={{ fontSize: 12 }}>
          {oneLine(t.output_preview, 200)}
        </div>
      </td>
      <td onClick={(e) => (e.target as HTMLElement).closest('.btn-chip') && e.stopPropagation()}>
        <div className="chips nowrap" style={{ maxWidth: 190 }}>
          {sigs.slice(0, 1).map((s) => (
            <SignalChip
              key={s.type}
              type={s.type}
              severity={s.severity}
              onClick={() => {
                onSignal(s.type);
              }}
            />
          ))}
          {sigs.length > 1 && <span className="chip neutral">+{sigs.length - 1}</span>}
          {!sigs.length && <span className="faint">-</span>}
        </div>
      </td>
      <td>
        <div className="chips nowrap" style={{ maxWidth: 170 }}>
          {scores.slice(0, 1).map((s) => (
            <ScoreChip key={s.name} s={s} nameWidth={90} />
          ))}
          {scores.length > 1 && (
            <span className="chip neutral" title={scores.slice(1).map((s) => `${s.name}: ${scoreText(s)}`).join('\n')}>
              +{scores.length - 1}
            </span>
          )}
          {!scores.length && <span className="faint">-</span>}
        </div>
      </td>
      <td>
        <span className="steps num" title={`${t.llm_calls} LLM calls, ${t.tool_calls} tool calls, ${t.span_count} spans`}>
          <span>
            <i style={{ background: 'var(--k-llm)' }} />
            {t.llm_calls}
          </span>
          <span>
            <i style={{ background: 'var(--k-tool)' }} />
            {t.tool_calls}
          </span>
          {t.error_count > 0 && <span className="err-text">{t.error_count} err</span>}
        </span>
      </td>
      <td className="r num">
        <div>{fmtCompact(tokens)}</div>
        <div className="muted" style={{ fontSize: 11.5 }}>
          {hit == null ? '' : `${Math.round(hit * 100)}% cached`}
        </div>
      </td>
      <td className="r num">{fmtCost(t.cost_usd)}</td>
      <td className="r num">{fmtMs(t.duration_ms)}</td>
    </tr>
  );
}

export const TraceRow = memo(TraceRowInner);
