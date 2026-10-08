import { useApi, useLive } from '../../hooks.ts';
import { Empty, ErrorState, SkelRows } from '../../components/ui.tsx';
import { ScoreChip } from '../../components/Badges.tsx';
import { Link } from '../../router.tsx';
import { fmtAgo, fmtCost, oneLine, shortId } from '../../format.ts';
import type { Params } from '../../api.ts';
import type { ScoreRow } from './types.ts';

const SOURCE_LABEL: Record<string, string> = { judge: 'Judge', code: 'Code', human: 'Human', sdk: 'SDK' };

export function ScoresFeed({ params, limit = 30, title = 'Recent scores', compact }: { params?: Params; limit?: number; title?: string; compact?: boolean }) {
  const live = useLive();
  const scores = useApi<{ items: ScoreRow[] }>('/api/scores', { limit, ...params }, [live.tick]);
  let body;
  if (scores.error) body = <ErrorState error={scores.error} what="Scores" retry={scores.reload} />;
  else if (!scores.data) body = <SkelRows rows={6} cols={4} />;
  else if (!scores.data.items.length) body = <Empty small title="No scores yet" body="Scores appear here when a rule, a manual run, an experiment or a human label grades a trace." />;
  else
    body = (
      <div className="ev-feed">
        {scores.data.items.map((s) => (
          <div key={s.id} className="ev-feed-row">
            <div className="row" style={{ gap: 8, minWidth: 0 }}>
              <ScoreChip s={s} />
              <span className="chip sq neutral">{SOURCE_LABEL[s.source] ?? s.source}</span>
              {s.trace_id && (
                <Link to={'/traces/' + s.trace_id} className="mono link" style={{ fontSize: 11.5 }}>
                  {shortId(s.trace_id)}
                </Link>
              )}
              <span className="muted num" style={{ marginLeft: 'auto', fontSize: 11.5, whiteSpace: 'nowrap' }}>
                {s.cost_usd ? fmtCost(s.cost_usd) + ' · ' : ''}
                {fmtAgo(s.created_at)}
              </span>
            </div>
            {!compact && s.reasoning && <div className="dim ev-feed-reason">{oneLine(s.reasoning, 220)}</div>}
          </div>
        ))}
      </div>
    );
  return (
    <section className="card">
      <div className="card-head">
        <h2>{title}</h2>
        {scores.data && <span className="sub">{scores.data.items.length} latest</span>}
      </div>
      <div className="card-body flush">{body}</div>
    </section>
  );
}
