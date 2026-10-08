import { PageHeader } from '../../components/Layout.tsx';
import { useApi } from '../../hooks.ts';
import { navigate, useLocation, useTitle } from '../../router.tsx';
import { QueuePicker, type QueueRow } from './QueuePicker.tsx';
import { Review } from './Review.tsx';
import './annotate.css';

export function Annotate() {
  const { search } = useLocation();
  const queue = search.get('queue');
  useTitle(queue ? `Annotate ${queue}` : 'Annotate');
  const queues = useApi<{ items: QueueRow[] }>('/api/annotations/queues');
  const list = queues.data?.items;
  return (
    <>
      <PageHeader
        title={queue ?? 'Annotate'}
        crumbs={queue ? [{ to: '/annotate', label: 'Annotate' }] : undefined}
        right={
          queue && list && list.length > 1 ? (
            <select className="select" style={{ height: 26 }} value={queue} onChange={(e) => navigate('/annotate?queue=' + encodeURIComponent(e.target.value))} aria-label="Switch queue">
              {list.map((q) => (
                <option key={q.queue} value={q.queue}>
                  {q.queue} ({q.pending} pending)
                </option>
              ))}
            </select>
          ) : null
        }
      />
      <div className="page">
        {queue ? <Review key={queue} queue={queue} queues={list} reloadQueues={queues.reload} /> : <QueuePicker queues={list} error={queues.error} reload={queues.reload} />}
      </div>
    </>
  );
}
