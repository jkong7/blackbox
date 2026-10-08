import { useState } from 'react';
import { api, type Facets, type Page, type Trace } from '../../api.ts';
import { useApi } from '../../hooks.ts';
import { Empty, ErrorState, Field, Seg, SkelRows } from '../../components/ui.tsx';
import { useToast } from '../../components/Toast.tsx';
import { I } from '../../components/Icons.tsx';
import { navigate } from '../../router.tsx';
import { fmtInt, fmtPct } from '../../format.ts';

export interface QueueRow {
  queue: string;
  pending: number;
  done: number;
}

type Source = 'flagged' | 'error' | 'latest';

function AddToQueue({ queues, onAdded }: { queues: QueueRow[]; onAdded: (q: string) => void }) {
  const toast = useToast();
  const facets = useApi<Facets>('/api/facets');
  const [queue, setQueue] = useState(queues[0]?.queue ?? 'default');
  const [source, setSource] = useState<Source>('flagged');
  const [agent, setAgent] = useState('');
  const [n, setN] = useState(25);
  const [busy, setBusy] = useState(false);
  const add = async () => {
    setBusy(true);
    try {
      const r = await api.get<Page<Trace>>('/api/traces', { limit: n, agent: agent || undefined, flagged: source === 'flagged' ? 1 : undefined, status: source === 'error' ? 'error' : undefined });
      if (!r.items.length) {
        toast('No traces matched', 'bad');
        return;
      }
      const q = queue.trim() || 'default';
      const out = await api.post<{ added: number }>('/api/annotations', { trace_ids: r.items.map((t) => t.trace_id), queue: q });
      toast(out.added ? `Added ${out.added} ${out.added === 1 ? 'trace' : 'traces'} to ${q}` : 'Those traces are already in the queue', out.added ? 'good' : 'info');
      onAdded(q);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card">
      <div className="card-head">
        <h2>Add traces to a queue</h2>
        <span className="sub">Review real runs, then turn what you see into judges</span>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        <div className="an-add-grid">
          <Field label="Queue">
            <input className="input mono" list="an-queues" value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="default" />
            <datalist id="an-queues">
              {queues.map((q) => (
                <option key={q.queue} value={q.queue} />
              ))}
            </datalist>
          </Field>
          <Field label="Traces">
            <Seg<Source> value={source} onChange={setSource} options={[{ value: 'flagged', label: 'Flagged' }, { value: 'error', label: 'Errors' }, { value: 'latest', label: 'Latest' }]} />
          </Field>
          <Field label="Agent">
            <select className="select" value={agent} onChange={(e) => setAgent(e.target.value)}>
              <option value="">Any</option>
              {facets.data?.agents.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="How many">
            <input className="input num" type="number" min={1} max={500} value={n} onChange={(e) => setN(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
          </Field>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="btn primary sm" onClick={add} disabled={busy}>
            <I.plus size={12} />
            {busy ? 'Adding' : 'Add to queue'}
          </button>
        </div>
      </div>
    </section>
  );
}

export function QueuePicker({ queues, error, reload }: { queues: QueueRow[] | undefined; error: unknown; reload: () => void }) {
  if (error) {
    return (
      <div className="card">
        <ErrorState error={error} what="Annotation queues" retry={reload} />
      </div>
    );
  }
  return (
    <div className="an-picker">
      <section className="card">
        <div className="card-head">
          <h2>Queues</h2>
          {queues && <span className="sub">{queues.length} total</span>}
        </div>
        <div className="card-body flush">
          {!queues ? (
            <SkelRows rows={3} cols={4} />
          ) : !queues.length ? (
            <Empty small title="No annotation queues yet" body="Add traces to a queue to start labeling. Human pass and fail labels calibrate every judge." />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Queue</th>
                    <th className="r">Pending</th>
                    <th className="r">Done</th>
                    <th style={{ width: 200 }}>Progress</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {queues.map((q) => {
                    const total = q.pending + q.done;
                    const pct = total ? q.done / total : 0;
                    return (
                      <tr key={q.queue} className="click" onClick={() => navigate('/annotate?queue=' + encodeURIComponent(q.queue))}>
                        <td className="cell-main mono">{q.queue}</td>
                        <td className="r num">{fmtInt(q.pending)}</td>
                        <td className="r num">{fmtInt(q.done)}</td>
                        <td>
                          <div className="row" style={{ gap: 8 }}>
                            <div className="progress" style={{ flex: 1 }}>
                              <i style={{ width: `${pct * 100}%` }} />
                            </div>
                            <span className="num muted" style={{ width: 40, textAlign: 'right' }}>{fmtPct(pct, 0)}</span>
                          </div>
                        </td>
                        <td className="r">
                          <button className={'btn sm' + (q.pending ? ' primary' : '')} onClick={(e) => { e.stopPropagation(); navigate('/annotate?queue=' + encodeURIComponent(q.queue)); }}>
                            {q.pending ? 'Start reviewing' : 'Open'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      <AddToQueue
        queues={queues ?? []}
        onAdded={(q) => {
          reload();
          navigate('/annotate?queue=' + encodeURIComponent(q));
        }}
      />
    </div>
  );
}
