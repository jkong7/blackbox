import type { Annotation, Score, Signal } from '../../api.ts';
import { Empty } from '../../components/ui.tsx';
import { ScoreChip, SeverityLabel } from '../../components/Badges.tsx';
import { JsonView } from '../../components/JsonView.tsx';
import { fmtAgo, fmtCost, humanize } from '../../format.ts';
import { displayName, type Tree } from './model.ts';

export function SignalsScores({ signals, scores, annotations, tree, activeSignal, onSignal, onSpan }: { signals: Signal[]; scores: Score[]; annotations: Annotation[]; tree: Tree; activeSignal: string | null; onSignal: (s: Signal) => void; onSpan: (id: string) => void }) {
  return (
    <div className="panel-scroll">
      <div className="sd-section-title">Signals</div>
      {!signals.length && <Empty small title="No signals" body="Detectors found nothing unusual in this run: no loops, runaway cost, refusals or risky flows." />}
      {signals.map((s) => {
        const span = s.span_id ? tree.byId.get(s.span_id)?.span : undefined;
        return (
          <div key={s.id} className={'sig-card click' + (activeSignal === s.id ? ' on' : '')} onClick={() => onSignal(s)}>
            <div className="row" style={{ gap: 10 }}>
              <SeverityLabel severity={s.severity} />
              <span className="chip sq neutral">{humanize(s.type)}</span>
              {span && (
                <button
                  className="btn ghost sm"
                  style={{ marginLeft: 'auto' }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onSpan(span.span_id);
                  }}
                >
                  {displayName(span)}
                </button>
              )}
            </div>
            <div className="t">{s.title}</div>
            {s.detail != null && typeof s.detail === 'object' && Object.keys(s.detail as object).length > 0 && (
              <div>
                <JsonView value={s.detail} openDepth={2} maxHeight={220} copy={false} />
              </div>
            )}
          </div>
        );
      })}
      <div className="sd-section-title" style={{ marginTop: 8 }}>
        Scores
      </div>
      {!scores.length && <Empty small title="No scores" body="Run an evaluator on this trace or add it to an annotation queue to grade it." />}
      {scores.map((s) => {
        const span = s.span_id ? tree.byId.get(s.span_id)?.span : undefined;
        return (
          <div key={s.id} className="sig-card">
            <div className="row" style={{ gap: 8 }}>
              <ScoreChip s={s} />
              <span className="chip neutral">{s.source}</span>
              {s.judge_model && <span className="muted mono" style={{ fontSize: 11 }}>{s.judge_model}</span>}
              {s.cost_usd ? <span className="muted num">{fmtCost(s.cost_usd)}</span> : null}
              <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                {fmtAgo(s.created_at)}
              </span>
              {span && (
                <button className="btn ghost sm" onClick={() => onSpan(span.span_id)}>
                  {displayName(span)}
                </button>
              )}
            </div>
            {s.reasoning && <div className="prose dim" style={{ fontSize: 12.5 }}>{s.reasoning}</div>}
          </div>
        );
      })}
      {annotations.length > 0 && (
        <>
          <div className="sd-section-title" style={{ marginTop: 8 }}>
            Human labels
          </div>
          {annotations.map((a) => (
            <div key={a.id} className="sig-card">
              <div className="row" style={{ gap: 8 }}>
                <span className={'chip ' + (a.label === 'pass' ? 'good' : a.label === 'fail' ? 'bad' : 'neutral')}>{a.label ?? a.status}</span>
                <span className="muted">{a.queue}</span>
                {a.failure_mode && <span className="chip sq neutral">{a.failure_mode}</span>}
              </div>
              {a.comment && <div className="prose dim">{a.comment}</div>}
            </div>
          ))}
        </>
      )}
    </div>
  );
}
