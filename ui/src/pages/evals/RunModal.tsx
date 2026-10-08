import { useState } from 'react';
import { api, type Facets, type Page, type Trace } from '../../api.ts';
import { useApi } from '../../hooks.ts';
import { Field, Modal, Seg } from '../../components/ui.tsx';
import { useToast } from '../../components/Toast.tsx';
import { errText, type EvaluatorRow } from './types.ts';

type Mode = 'recent' | 'ids';

export function RunModal({ ev, onClose }: { ev: EvaluatorRow; onClose: () => void }) {
  const toast = useToast();
  const facets = useApi<Facets>('/api/facets');
  const [mode, setMode] = useState<Mode>('recent');
  const [n, setN] = useState(20);
  const [agent, setAgent] = useState('');
  const [status, setStatus] = useState('');
  const [ids, setIds] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      let traceIds: string[];
      if (mode === 'ids') traceIds = ids.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      else {
        const r = await api.get<Page<Trace>>('/api/traces', { limit: n, agent: agent || undefined, status: status || undefined });
        traceIds = r.items.map((t) => t.trace_id);
      }
      if (!traceIds.length) {
        setError('No traces matched.');
        setBusy(false);
        return;
      }
      const out = await api.post<{ jobs: string[] }>(`/api/evaluators/${ev.id}/run`, { trace_ids: traceIds });
      toast(`Queued ${out.jobs.length} ${out.jobs.length === 1 ? 'job' : 'jobs'} for ${ev.name}`, 'good');
      onClose();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Run ${ev.name}`}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err-text" style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 12 }}>{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={run} disabled={busy}>
            {busy ? 'Queuing' : 'Queue jobs'}
          </button>
        </>
      }
    >
      <Seg<Mode> value={mode} onChange={setMode} options={[{ value: 'recent', label: 'Latest traces' }, { value: 'ids', label: 'Specific trace ids' }]} />
      {mode === 'recent' ? (
        <div className="ev-form-grid">
          <Field label="How many">
            <input className="input num" type="number" min={1} max={500} value={n} onChange={(e) => setN(Math.max(1, Math.min(500, Number(e.target.value) || 1)))} />
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
          <Field label="Status">
            <select className="select" value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">Any</option>
              <option value="error">With errors</option>
              <option value="ok">Without errors</option>
            </select>
          </Field>
        </div>
      ) : (
        <Field label="Trace ids" hint="Separated by spaces, commas or new lines">
          <textarea className="textarea mono" rows={6} value={ids} onChange={(e) => setIds(e.target.value)} />
        </Field>
      )}
      <div className="muted" style={{ fontSize: 12 }}>
        Jobs run in the background. {ev.type === 'llm_judge' ? 'Each one calls the judge and counts toward the daily cap.' : 'Code checks are free and fast.'}
      </div>
    </Modal>
  );
}
