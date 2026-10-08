import type { TraceDetail } from '../../api.ts';
import { I } from '../../components/Icons.tsx';
import { CopyButton } from '../../components/ui.tsx';
import { Link } from '../../router.tsx';
import { fmtCompact, fmtCost, fmtDateTime, fmtMs, fmtPct, oneLine, shortId } from '../../format.ts';

export type Action = 'dataset' | 'annotate' | 'evaluate' | 'explain';

export function TraceHeader({ d, firstInput, onAction, explaining }: { d: TraceDetail; firstInput: string | null; onAction: (a: Action) => void; explaining: boolean }) {
  const t = d.trace;
  const tokens = t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens;
  const prompt = t.input_tokens + t.cache_read_tokens + t.cache_write_tokens;
  const hit = prompt ? t.cache_read_tokens / prompt : null;
  const agents = t.agent_names?.split(',').filter(Boolean) ?? [];
  const models = t.models?.split(',').filter(Boolean) ?? [];
  const outcome = t.error_count > 0 ? 'error' : d.signals.length > 0 ? 'flagged' : 'clean';
  const outcomeText = outcome === 'error' ? `${t.error_count} ${t.error_count === 1 ? 'error' : 'errors'}` : outcome === 'flagged' ? `Flagged · ${d.signals.length} ${d.signals.length === 1 ? 'signal' : 'signals'}` : 'Clean';
  const nav = d.session_nav;
  return (
    <div className="td-header">
      <div className="td-title-row">
        <div className="stack" style={{ gap: 6, minWidth: 0, flex: 1 }}>
          <h1 className="td-title">
            <span className="ellipsis">{agents.length ? agents.join(', ') : t.name ?? 'Trace'}</span>
            <span className={'outcome ' + outcome}>
              <span className={'status-dot ' + (outcome === 'clean' ? 'ok' : outcome)} />
              {outcomeText}
            </span>
          </h1>
          {firstInput && (
            <div className="td-input" title={firstInput}>
              <span className="q">User</span>
              {oneLine(firstInput, 400)}
            </div>
          )}
        </div>
        <div className="td-actions">
          <CopyButton text={t.trace_id} label="Copy id" />
          <button className="btn sm" onClick={() => onAction('dataset')} title="Add this trace to a dataset">
            <I.datasets size={13} />
            Add to dataset
          </button>
          <button className="btn sm" onClick={() => onAction('annotate')} title="Send to an annotation queue">
            <I.annotate size={13} />
            Annotate
          </button>
          <button className="btn sm" onClick={() => onAction('evaluate')} title="Run an evaluator on this trace">
            <I.evals size={13} />
            Run evaluator
          </button>
          <button className="btn sm primary" onClick={() => onAction('explain')} disabled={explaining} title="Ask a judge to explain what happened and why">
            <I.sparkle size={13} />
            {explaining ? 'Explaining…' : 'Explain this run'}
          </button>
        </div>
      </div>
      <div className="td-stats">
        <span className="td-stat">
          <span className="l">Cost</span>
          <span className="v">{fmtCost(t.cost_usd)}</span>
        </span>
        <span className="td-stat">
          <span className="l">Duration</span>
          <span className="v">{fmtMs(t.duration_ms)}</span>
        </span>
        <span className="td-stat">
          <span className="l">Tokens</span>
          <span className="v">{fmtCompact(tokens)}</span>
          {hit != null && <span className="muted">{fmtPct(hit, 0)} cached</span>}
        </span>
        <span className="td-stat">
          <span className="l">Steps</span>
          <span className="v">
            {t.llm_calls} LLM · {t.tool_calls} tool
          </span>
        </span>
        {models.length > 0 && (
          <span className="td-stat">
            <span className="l">{models.length === 1 ? 'Model' : 'Models'}</span>
            <span className="v mono" style={{ fontSize: 12 }}>
              {models.join(', ')}
            </span>
          </span>
        )}
        <span className="td-stat">
          <span className="l">Started</span>
          <span className="v">{fmtDateTime(t.start_ns / 1e6)}</span>
        </span>
        {t.user_id && (
          <span className="td-stat">
            <span className="l">User</span>
            <span className="v">{t.user_id}</span>
          </span>
        )}
        {t.session_id && (
          <span className="td-stat">
            <span className="l">Session</span>
            <span className="row" style={{ gap: 2 }}>
              <Link to={nav.prev ? '/traces/' + nav.prev : '#'} className={'btn ghost sm icon' + (nav.prev ? '' : ' disabled')} aria-disabled={!nav.prev} title="Previous turn in session ([)" onClick={(e) => !nav.prev && e.preventDefault()} style={{ opacity: nav.prev ? 1 : 0.35 }}>
                <I.chevronLeft size={12} />
              </Link>
              <Link to={'/sessions/' + encodeURIComponent(t.session_id)} className="link mono" style={{ fontSize: 12 }}>
                {shortId(t.session_id, 18)}
              </Link>
              <Link to={nav.next ? '/traces/' + nav.next : '#'} className="btn ghost sm icon" aria-disabled={!nav.next} title="Next turn in session (])" onClick={(e) => !nav.next && e.preventDefault()} style={{ opacity: nav.next ? 1 : 0.35 }}>
                <I.chevronRight size={12} />
              </Link>
            </span>
          </span>
        )}
      </div>
    </div>
  );
}
