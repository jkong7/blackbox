import { useState } from 'react';
import { api, type Facets, type RuleFilter } from '../../api.ts';
import { useApi } from '../../hooks.ts';
import { Empty, ErrorState, Field, Modal, Seg, SkelRows, Switch } from '../../components/ui.tsx';
import { useToast } from '../../components/Toast.tsx';
import { I } from '../../components/Icons.tsx';
import { Link } from '../../router.tsx';
import { fmtAgo, fmtMs, humanize } from '../../format.ts';
import { errText, type EvaluatorRow, type RuleRow } from './types.ts';

const FILTER_KEYS: (keyof RuleFilter)[] = ['project', 'agent', 'model', 'tool', 'status', 'signal', 'source', 'name_contains'];

function FilterChips({ filter }: { filter: RuleFilter | null }) {
  const entries = Object.entries(filter ?? {}).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return <span className="muted">All traces</span>;
  return (
    <div className="chips">
      {entries.map(([k, v]) => (
        <span key={k} className="chip sq">
          <span className="muted">{humanize(k)}</span>
          <span className="mono ellipsis" style={{ maxWidth: 140 }}>{String(v)}</span>
        </span>
      ))}
    </div>
  );
}

function SamplingSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [v, setV] = useState(value);
  const [dirty, setDirty] = useState(false);
  const shown = dirty ? v : value;
  const commit = () => {
    if (dirty && v !== value) onCommit(v);
    setDirty(false);
  };
  return (
    <div className="row ev-slider" style={{ gap: 8 }}>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={shown}
        aria-label="Sampling rate"
        onChange={(e) => {
          setDirty(true);
          setV(Number(e.target.value));
        }}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
      />
      <span className="num" style={{ width: 36, textAlign: 'right' }}>
        {Math.round(shown * 100)}%
      </span>
    </div>
  );
}

function DelayInput({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [raw, setRaw] = useState<string | null>(null);
  const commit = () => {
    if (raw == null) return;
    const s = Number(raw);
    if (isFinite(s) && s >= 0 && Math.round(s * 1000) !== value) onCommit(Math.round(s * 1000));
    setRaw(null);
  };
  return (
    <div className="row" style={{ gap: 4 }}>
      <input
        className="input num"
        style={{ width: 64, height: 24 }}
        value={raw ?? String(value / 1000)}
        onChange={(e) => setRaw(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        aria-label="Delay in seconds"
      />
      <span className="muted">s</span>
    </div>
  );
}

export function RulesPanel({ evaluators }: { evaluators: EvaluatorRow[] }) {
  const toast = useToast();
  const rules = useApi<{ items: RuleRow[] }>('/api/rules');
  const [creating, setCreating] = useState(false);
  const [confirmDel, setConfirmDel] = useState<string | null>(null);

  const patch = async (r: RuleRow, body: Partial<RuleRow>) => {
    rules.setData((d) => d && { items: d.items.map((x) => (x.id === r.id ? { ...x, ...body } : x)) });
    try {
      await api.patch(`/api/rules/${r.id}`, body);
    } catch (e) {
      toast(errText(e), 'bad');
      rules.reload();
    }
  };
  const backfill = async (r: RuleRow) => {
    try {
      const out = await api.post<{ queued: number }>(`/api/rules/${r.id}/backfill`, { limit: 100 });
      toast(`Queued ${out.queued} ${out.queued === 1 ? 'job' : 'jobs'} for ${r.name}`, 'good');
    } catch (e) {
      toast(errText(e), 'bad');
    }
  };
  const del = async (r: RuleRow) => {
    try {
      await api.del(`/api/rules/${r.id}`);
      setConfirmDel(null);
      rules.reload();
      toast('Rule deleted');
    } catch (e) {
      toast(errText(e), 'bad');
    }
  };

  const head = (
    <div className="card-head">
      <h2>Online rules</h2>
      <span className="sub">Score live traffic as it arrives</span>
      <div className="right">
        <button
          className="btn sm"
          onClick={() => setCreating(true)}
          disabled={!evaluators.length}
        >
          <I.plus size={12} />
          New rule
        </button>
      </div>
    </div>
  );

  let body;
  if (rules.error) body = <ErrorState error={rules.error} what="Online rules" retry={rules.reload} />;
  else if (!rules.data) body = <SkelRows rows={3} cols={6} />;
  else if (!rules.data.items.length)
    body = (
      <Empty
        small
        title="No online rules"
        body="A rule runs an evaluator on matching traces as they arrive, with sampling and a delay so the trace is complete first."
        actions={
          <button className="btn sm" onClick={() => setCreating(true)} disabled={!evaluators.length}>
            Create a rule
          </button>
        }
      />
    );
  else
    body = (
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 40 }}>On</th>
              <th>Rule</th>
              <th>Evaluator</th>
              <th>Filter</th>
              <th>Sampling</th>
              <th>Delay</th>
              <th className="r" />
            </tr>
          </thead>
          <tbody>
            {rules.data.items.map((r) => (
              <tr key={r.id}>
                <td>
                  <Switch on={!!r.enabled} onChange={(v) => patch(r, { enabled: v })} label={`Enable ${r.name}`} />
                </td>
                <td>
                  <div className="cell-main ellipsis" style={{ maxWidth: 220 }}>{r.name}</div>
                  <div className="muted" style={{ fontSize: 11.5 }}>
                    {r.target} · created {fmtAgo(r.created_at)}
                  </div>
                </td>
                <td>
                  <Link to={'/evals/' + r.evaluator_id} className="mono plain">
                    {r.evaluator_name ?? r.evaluator_id}
                  </Link>
                </td>
                <td className="wrap" style={{ maxWidth: 260 }}>
                  <FilterChips filter={r.filter} />
                </td>
                <td>
                  <SamplingSlider value={r.sampling} onCommit={(v) => patch(r, { sampling: v })} />
                </td>
                <td>
                  <DelayInput value={r.delay_ms} onCommit={(v) => patch(r, { delay_ms: v })} />
                </td>
                <td className="r">
                  <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                    <button className="btn sm" onClick={() => backfill(r)} title="Queue this rule over the last 100 matching traces">
                      <I.refresh size={12} />
                      Backfill
                    </button>
                    {confirmDel === r.id ? (
                      <>
                        <button className="btn sm danger" onClick={() => del(r)}>
                          Delete
                        </button>
                        <button className="btn sm ghost" onClick={() => setConfirmDel(null)}>
                          Keep
                        </button>
                      </>
                    ) : (
                      <button className="btn sm ghost icon" onClick={() => setConfirmDel(r.id)} aria-label={`Delete ${r.name}`} title="Delete rule">
                        <I.trash size={12} />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );

  return (
    <section className="card">
      {head}
      <div className="card-body flush">{body}</div>
      {creating && (
        <RuleForm
          evaluators={evaluators}
          onClose={() => setCreating(false)}
          onSaved={() => {
            setCreating(false);
            rules.reload();
          }}
        />
      )}
    </section>
  );
}

export function RuleForm({ evaluators, onClose, onSaved, presetEvaluator }: { evaluators: EvaluatorRow[]; onClose: () => void; onSaved: () => void; presetEvaluator?: string }) {
  const toast = useToast();
  const facets = useApi<Facets>('/api/facets');
  const [evaluatorId, setEvaluatorId] = useState(presetEvaluator ?? evaluators[0]?.id ?? '');
  const ev = evaluators.find((e) => e.id === evaluatorId);
  const [name, setName] = useState('');
  const [target, setTarget] = useState<string>(ev?.target ?? 'trace');
  const [filter, setFilter] = useState<RuleFilter>({});
  const [sampling, setSampling] = useState(1);
  const [delay, setDelay] = useState(5);
  const [enabled, setEnabled] = useState(true);
  const [backfill, setBackfill] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = facets.data;
  const options: Partial<Record<keyof RuleFilter, string[]>> = {
    project: f?.projects,
    agent: f?.agents,
    model: f?.models,
    tool: f?.tools,
    source: f?.sources,
    signal: f?.signal_types,
    status: ['error', 'ok'],
  };
  const setF = (k: keyof RuleFilter, v: string) => setFilter((x) => {
    const n = { ...x };
    if (v) n[k] = v;
    else delete n[k];
    return n;
  });
  const save = async () => {
    if (!evaluatorId) return;
    setBusy(true);
    setError(null);
    try {
      const rule = await api.post<RuleRow>('/api/rules', { name: name.trim() || `${ev?.name ?? 'rule'} online`, evaluator_id: evaluatorId, target, filter, sampling, delay_ms: Math.round(delay * 1000), enabled });
      if (backfill) {
        const out = await api.post<{ queued: number }>(`/api/rules/${rule.id}/backfill`, { limit: 100 });
        toast(`Rule created, ${out.queued} jobs queued`, 'good');
      } else toast('Rule created', 'good');
      onSaved();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New online rule"
      onClose={onClose}
      footer={
        <>
          {error && <span className="err-text" style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 12 }}>{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy || !evaluatorId}>
            {busy ? 'Creating' : 'Create rule'}
          </button>
        </>
      }
    >
      <div className="ev-form-grid">
        <Field label="Evaluator">
          <select
            className="select"
            value={evaluatorId}
            onChange={(e) => {
              setEvaluatorId(e.target.value);
              const t = evaluators.find((x) => x.id === e.target.value)?.target;
              if (t) setTarget(t);
            }}
          >
            {evaluators.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Name">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder={`${ev?.name ?? 'rule'} online`} />
        </Field>
      </div>
      <Field label="Target">
        <Seg value={target} onChange={setTarget} options={['trace', 'llm', 'tool', 'session']} />
      </Field>
      <div className="field">
        <span className="field-label">Filter</span>
        <div className="ev-filter-grid">
          {FILTER_KEYS.map((k) => {
            const opts = options[k];
            return (
              <div key={k} className="field">
                <span className="muted" style={{ fontSize: 11.5 }}>{humanize(k)}</span>
                {opts ? (
                  <select className="select" value={filter[k] ?? ''} onChange={(e) => setF(k, e.target.value)}>
                    <option value="">Any</option>
                    {opts.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="input" value={filter[k] ?? ''} onChange={(e) => setF(k, e.target.value)} placeholder="Any" />
                )}
              </div>
            );
          })}
        </div>
      </div>
      <div className="ev-form-grid">
        <Field label={`Sampling ${Math.round(sampling * 100)}%`} hint="Hashes the trace id, so a trace is kept or dropped as a whole">
          <input type="range" min={0} max={1} step={0.05} value={sampling} onChange={(e) => setSampling(Number(e.target.value))} />
        </Field>
        <Field label="Delay (seconds)" hint={`Waits ${fmtMs(delay * 1000)} after the trace goes quiet`}>
          <input className="input num" type="number" min={0} value={delay} onChange={(e) => setDelay(Math.max(0, Number(e.target.value)))} />
        </Field>
      </div>
      <div className="row" style={{ gap: 16 }}>
        <label className="row ev-bool">
          <Switch on={enabled} onChange={setEnabled} label="Enabled" />
          Enabled
        </label>
        <label className="row ev-bool">
          <Switch on={backfill} onChange={setBackfill} label="Backfill" />
          Backfill the last 100 matching traces
        </label>
      </div>
    </Modal>
  );
}
