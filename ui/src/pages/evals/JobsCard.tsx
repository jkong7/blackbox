import { useApi, useLive } from '../../hooks.ts';
import { Empty, ErrorState, Seg, SkelRows } from '../../components/ui.tsx';
import { Link } from '../../router.tsx';
import { fmtAgo, oneLine, shortId } from '../../format.ts';
import { useState } from 'react';
import type { JobCounts, JobRow } from './types.ts';

type St = 'all' | 'queued' | 'running' | 'failed';

const TONE: Record<string, string> = { done: 'good', failed: 'bad', running: 'accent', queued: 'neutral', skipped: 'neutral' };

export function JobsCard() {
  const live = useLive();
  const [st, setSt] = useState<St>('all');
  const jobs = useApi<{ items: JobRow[]; counts: JobCounts }>('/api/jobs', { limit: 12, status: st === 'all' ? undefined : st }, [live.tick]);
  let body;
  if (jobs.error) body = <ErrorState error={jobs.error} what="The job queue" retry={jobs.reload} />;
  else if (!jobs.data) body = <SkelRows rows={5} cols={4} />;
  else if (!jobs.data.items.length) body = <Empty small title={st === 'all' ? 'No jobs yet' : `No ${st} jobs`} body={st === 'all' ? 'Rules, backfills and manual runs create jobs here.' : undefined} />;
  else
    body = (
      <div className="table-wrap">
        <table className="tbl compact">
          <tbody>
            {jobs.data.items.map((j) => (
              <tr key={j.id}>
                <td style={{ width: 80 }}>
                  <span className={'chip ' + (TONE[j.status] ?? 'neutral')}>{j.status}</span>
                </td>
                <td className="mono">{j.evaluator_name ?? shortId(j.evaluator_id, 12)}</td>
                <td>
                  {j.trace_id ? (
                    <Link to={'/traces/' + j.trace_id} className="mono link" style={{ fontSize: 11.5 }}>
                      {shortId(j.trace_id)}
                    </Link>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
                <td className="wrap err-text" style={{ fontSize: 12 }}>{j.error ? oneLine(j.error, 120) : ''}</td>
                <td className="r muted">{fmtAgo(j.finished_at ?? j.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <section className="card">
      <div className="card-head">
        <h2>Jobs</h2>
        <div className="right">
          <Seg<St> value={st} onChange={setSt} options={[{ value: 'all', label: 'All' }, { value: 'queued', label: 'Queued' }, { value: 'running', label: 'Running' }, { value: 'failed', label: 'Failed' }]} />
        </div>
      </div>
      <div className="card-body flush">{body}</div>
    </section>
  );
}
