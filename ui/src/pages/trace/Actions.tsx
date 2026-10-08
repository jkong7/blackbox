import { useState } from 'react';
import { api, isMissing, type Dataset, type Evaluator, type Explanation } from '../../api.ts';
import { useApi } from '../../hooks.ts';
import { Modal, Field, ErrorState, Skel } from '../../components/ui.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Link } from '../../router.tsx';
import { humanize } from '../../format.ts';

function errText(e: unknown, what: string) {
  if (isMissing(e)) return `${what} is not available on this server yet`;
  return e instanceof Error ? e.message : String(e);
}

export function AddToDatasetModal({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const ds = useApi<{ items: Dataset[] }>('/api/datasets');
  const toast = useToast();
  const [pick, setPick] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const items = ds.data?.items ?? [];
  const target = pick || (items[0]?.id ?? '');
  const submit = async () => {
    setBusy(true);
    try {
      let id = target;
      let label = items.find((d) => d.id === id)?.name ?? '';
      if (target === '__new' || !items.length) {
        const created = await api.post<Dataset>('/api/datasets', { name: name.trim() });
        id = created.id;
        label = created.name;
      }
      await api.post(`/api/datasets/${id}/items`, { trace_ids: [traceId] });
      toast(
        <span>
          Added to <Link to={'/datasets/' + id} className="link">{label}</Link>
        </span>,
        'good',
      );
      onClose();
    } catch (e) {
      toast(errText(e, 'Datasets'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const creating = target === '__new' || !items.length;
  return (
    <Modal
      title="Add to dataset"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !!ds.error || (creating && !name.trim())} onClick={submit}>
            Add trace
          </button>
        </>
      }
    >
      {ds.error ? (
        <ErrorState error={ds.error} what="Datasets" />
      ) : !ds.data ? (
        <Skel h={28} />
      ) : (
        <>
          {items.length > 0 && (
            <Field label="Dataset">
              <select className="select" value={target} onChange={(e) => setPick(e.target.value)}>
                {items.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} ({d.item_count ?? 0} items)
                  </option>
                ))}
                <option value="__new">New dataset…</option>
              </select>
            </Field>
          )}
          {creating && (
            <Field label="New dataset name">
              <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. refund-edge-cases" onKeyDown={(e) => e.key === 'Enter' && name.trim() && submit()} />
            </Field>
          )}
          <div className="muted">The trace's first user input becomes the item input and its final output the expected value. You can edit both later.</div>
        </>
      )}
    </Modal>
  );
}

export function AnnotateModal({ traceId, onClose }: { traceId: string; onClose: () => void }) {
  const queues = useApi<{ items: { queue: string; pending: number; done: number }[] }>('/api/annotations/queues');
  const toast = useToast();
  const [queue, setQueue] = useState('');
  const [busy, setBusy] = useState(false);
  const q = queue.trim() || queues.data?.items[0]?.queue || 'default';
  const submit = async () => {
    setBusy(true);
    try {
      await api.post('/api/annotations', { trace_ids: [traceId], queue: q });
      toast(
        <span>
          Sent to <Link to={'/annotate?queue=' + encodeURIComponent(q)} className="link">{q}</Link>
        </span>,
        'good',
      );
      onClose();
    } catch (e) {
      toast(errText(e, 'Annotation queues'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Send to annotation queue"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || (!!queues.error && !isMissing(queues.error))} onClick={submit}>
            Send
          </button>
        </>
      }
    >
      <Field label="Queue" hint="Pick an existing queue or type a new name.">
        <input className="input" autoFocus list="bb-queues" value={queue} placeholder={queues.data?.items[0]?.queue ?? 'default'} onChange={(e) => setQueue(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} />
        <datalist id="bb-queues">
          {queues.data?.items.map((x) => (
            <option key={x.queue} value={x.queue}>
              {x.pending} pending
            </option>
          ))}
        </datalist>
      </Field>
      {queues.error != null && isMissing(queues.error) && <div className="muted">Annotation queues are not available on this server yet.</div>}
    </Modal>
  );
}

export function RunEvaluatorModal({ traceId, onClose, onQueued }: { traceId: string; onClose: () => void; onQueued: () => void }) {
  const ev = useApi<{ items: Evaluator[] }>('/api/evaluators');
  const toast = useToast();
  const [pick, setPick] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const items = (ev.data?.items ?? []).filter((e) => e.target === 'trace' || e.target === 'session');
  const submit = async () => {
    setBusy(true);
    try {
      let n = 0;
      for (const id of pick) {
        const r = await api.post<{ jobs: string[] }>(`/api/evaluators/${id}/run`, { trace_id: traceId });
        n += r.jobs?.length ?? 0;
      }
      toast(`Queued ${n} evaluation ${n === 1 ? 'job' : 'jobs'}. Scores appear here when they finish.`, 'good');
      onQueued();
      onClose();
    } catch (e) {
      toast(errText(e, 'Evaluators'), 'bad');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Run evaluator"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !pick.length} onClick={submit}>
            Run {pick.length > 1 ? pick.length + ' evaluators' : ''}
          </button>
        </>
      }
    >
      {ev.error ? (
        <ErrorState error={ev.error} what="Evaluators" />
      ) : !ev.data ? (
        <Skel h={80} />
      ) : !items.length ? (
        <div className="muted">
          No trace evaluators yet. Create one in <Link to="/evals" className="link">Evals</Link>.
        </div>
      ) : (
        <div className="stack" style={{ gap: 2 }}>
          {items.map((e) => (
            <label key={e.id} className="row" style={{ padding: '6px 4px', borderRadius: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={pick.includes(e.id)} onChange={(x) => setPick(x.target.checked ? [...pick, e.id] : pick.filter((p) => p !== e.id))} />
              <span className="mono" style={{ fontWeight: 500 }}>{e.name}</span>
              <span className="chip neutral">{e.type === 'llm_judge' ? 'LLM judge' : 'Code'}</span>
              <span className="muted ellipsis" style={{ minWidth: 0 }}>{e.description}</span>
            </label>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function ExplainCard({ ex, onSpan, loading, error }: { ex: Explanation | null; onSpan: (id: string) => void; loading: boolean; error: unknown }) {
  if (loading)
    return (
      <div className="explain">
        <div className="row" style={{ gap: 8 }}>
          <span className="sd-section-title" style={{ margin: 0 }}>Explaining this run</span>
          <span className="muted">The judge is reading the whole trajectory…</span>
        </div>
        <Skel h={12} />
        <Skel h={12} w="80%" />
        <Skel h={12} w="60%" />
      </div>
    );
  if (error)
    return (
      <div className="explain">
        <span className="sd-section-title" style={{ margin: 0 }}>Explain this run</span>
        <span className={isMissing(error) ? 'muted' : 'err-text'}>{errText(error, 'Run explanation')}</span>
      </div>
    );
  if (!ex) return null;
  const suggestions = Array.isArray(ex.suggestions) ? ex.suggestions : ex.suggestions ? [ex.suggestions] : [];
  return (
    <div className="explain">
      <div className="row" style={{ gap: 8 }}>
        <span className="sd-section-title" style={{ margin: 0 }}>Run explanation</span>
        {ex.outcome && <span className={'chip ' + (/success|pass|complete/i.test(ex.outcome) ? 'good' : /fail|error/i.test(ex.outcome) ? 'bad' : 'warn')}>{humanize(ex.outcome)}</span>}
        {ex.judge_model && <span className="muted mono" style={{ marginLeft: 'auto', fontSize: 11 }}>{ex.judge_model}</span>}
      </div>
      <div className="prose">{ex.summary}</div>
      {ex.root_cause && (
        <div>
          <span className="muted">Root cause: </span>
          {ex.root_cause}
        </div>
      )}
      {ex.failure_modes?.length > 0 && (
        <div className="stack" style={{ gap: 4 }}>
          {ex.failure_modes.map((f, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', gap: 8 }}>
              <span className="chip sq serious">{humanize(f.mode)}</span>
              <span className="dim" style={{ flex: 1 }}>{f.evidence}</span>
              {f.span_id && (
                <button className="btn ghost sm" onClick={() => onSpan(f.span_id!)}>
                  Go to span
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {suggestions.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18 }} className="dim">
          {suggestions.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
