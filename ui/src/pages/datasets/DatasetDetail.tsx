import { Fragment, useEffect, useMemo, useState } from 'react';
import { PageHeader } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, Field, Modal, Seg, Skel, SkelRows, Tabs } from '../../components/ui.tsx';
import { JsonView } from '../../components/JsonView.tsx';
import { I } from '../../components/Icons.tsx';
import { useToast } from '../../components/Toast.tsx';
import { api, isMissing, type Dataset, type DatasetItem, type Evaluator } from '../../api.ts';
import { useApi, useLive } from '../../hooks.ts';
import { Link, navigate, setSearch, useLocation, useTitle } from '../../router.tsx';
import { fmtAgo, fmtMs, fmtPct, shortId } from '../../format.ts';
import { asText, evaluatorIds, parseItemsText, StatusChip, targetText, targetType, type ExperimentRow } from './shared.tsx';
import './datasets.css';

type Tab = 'items' | 'experiments';

export function DatasetDetail({ id }: { id: string }) {
  const live = useLive();
  const { search } = useLocation();
  const tab = (search.get('tab') as Tab) || 'items';
  const res = useApi<{ dataset: Dataset; items: DatasetItem[] }>('/api/datasets/' + encodeURIComponent(id), undefined, [live.tick]);
  const exps = useApi<{ items: ExperimentRow[] }>('/api/experiments', { dataset_id: res.data?.dataset.id ?? id }, [live.tick]);
  const [adding, setAdding] = useState(false);
  const [running, setRunning] = useState(false);
  const ds = res.data?.dataset;
  useTitle(ds?.name ?? 'Dataset');

  const header = (
    <PageHeader
      title={ds?.name ?? shortId(id, 16)}
      crumbs={[{ to: '/datasets', label: 'Datasets' }]}
      right={
        ds && (
          <>
            <DeleteDataset id={ds.id} name={ds.name} />
            <button className="btn" onClick={() => setAdding(true)}>
              <I.plus /> Add items
            </button>
            <button className="btn primary" onClick={() => setRunning(true)} disabled={!res.data?.items.length} title={res.data?.items.length ? 'Run an experiment over every item' : 'Add items first'}>
              <I.play /> New experiment
            </button>
          </>
        )
      }
    />
  );

  if (res.error) {
    return (
      <>
        {header}
        <div className="page">
          <Card>
            {isMissing(res.error) && !(res.error instanceof Error && /dataset not found/.test(res.error.message)) ? (
              <ErrorState error={res.error} what="Datasets" />
            ) : (
              <Empty title="Dataset not found" body="It may have been deleted." actions={<Link to="/datasets" className="btn">All datasets</Link>} />
            )}
          </Card>
        </div>
      </>
    );
  }

  const items = res.data?.items ?? [];
  const expItems = exps.data?.items ?? [];

  return (
    <>
      {header}
      <div className="page">
        <div className="ds-head">
          {ds ? (
            <>
              <div className="dim">{ds.description || <span className="muted">No description</span>}</div>
              <div className="row muted" style={{ gap: 14, fontSize: 12 }}>
                <span className="mono">{ds.id}</span>
                <span>Created {fmtAgo(ds.created_at)}</span>
                <span>
                  {items.length} {items.length === 1 ? 'item' : 'items'}
                </span>
                <span>
                  {expItems.length} {expItems.length === 1 ? 'experiment' : 'experiments'}
                </span>
              </div>
            </>
          ) : (
            <>
              <Skel w={320} h={12} />
              <Skel w={240} h={10} />
            </>
          )}
        </div>
        <section className="card">
          <Tabs<Tab>
            value={tab}
            onChange={(t) => setSearch({ tab: t === 'items' ? null : t })}
            tabs={[
              { id: 'items', label: 'Items', badge: items.length || undefined },
              { id: 'experiments', label: 'Experiments', badge: expItems.length || undefined },
            ]}
          />
          {tab === 'items' ? (
            !res.data ? <SkelRows rows={6} cols={5} /> : <ItemsTable datasetId={res.data.dataset.id} items={items} onChange={res.reload} onAdd={() => setAdding(true)} />
          ) : exps.error ? (
            <ErrorState error={exps.error} what="Experiments" retry={exps.reload} />
          ) : !exps.data ? (
            <SkelRows rows={4} cols={6} />
          ) : (
            <ExperimentsTable items={expItems} onNew={items.length ? () => setRunning(true) : undefined} />
          )}
        </section>
      </div>
      {adding && ds && (
        <AddItems
          datasetId={ds.id}
          onClose={() => setAdding(false)}
          onDone={() => {
            setAdding(false);
            res.reload();
          }}
        />
      )}
      {running && ds && <NewExperiment dataset={ds} itemCount={items.length} experiments={expItems} onClose={() => setRunning(false)} />}
    </>
  );
}

function ItemsTable({ datasetId, items, onChange, onAdd }: { datasetId: string; items: DatasetItem[]; onChange: () => void; onAdd: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState<string | null>(null);
  const [limit, setLimit] = useState(200);
  if (!items.length) {
    return (
      <Empty
        icon={<I.inbox size={20} />}
        title="This dataset is empty"
        body="Paste JSON or JSONL items with an input and an optional expected output, or add traces from the Traces view with Add to dataset."
        actions={
          <button className="btn primary" onClick={onAdd}>
            <I.plus /> Add items
          </button>
        }
      />
    );
  }
  const del = async (itemId: string) => {
    try {
      await api.del(`/api/datasets/${encodeURIComponent(datasetId)}/items/${encodeURIComponent(itemId)}`);
      toast('Item removed', 'good');
      onChange();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };
  return (
    <div className="table-wrap">
      <table className="tbl ds-items">
        <thead>
          <tr>
            <th style={{ width: 36 }}>#</th>
            <th>Input</th>
            <th>Expected</th>
            <th>Source</th>
            <th className="r">Added</th>
            <th style={{ width: 40 }} />
          </tr>
        </thead>
        <tbody>
          {items.slice(0, limit).map((it, i) => (
            <Fragment key={it.id}>
              <tr className={'click' + (open === it.id ? ' sel' : '')} onClick={() => setOpen(open === it.id ? null : it.id)}>
                <td className="muted num">{i + 1}</td>
                <td className="ellipsis cell-main" style={{ maxWidth: 420 }}>
                  {asText(it.input, 160) || <span className="muted">empty</span>}
                </td>
                <td className="ellipsis dim" style={{ maxWidth: 360 }}>
                  {it.expected == null ? <span className="muted">-</span> : asText(it.expected, 140)}
                </td>
                <td>
                  {it.source_trace_id ? (
                    <Link to={'/traces/' + it.source_trace_id} className="link mono" onClick={(e) => e.stopPropagation()}>
                      {shortId(it.source_trace_id)}
                    </Link>
                  ) : (
                    <span className="muted">Manual</span>
                  )}
                </td>
                <td className="r muted">{fmtAgo(it.created_at)}</td>
                <td className="r">
                  <ConfirmIcon onConfirm={() => del(it.id)} label="Remove item" />
                </td>
              </tr>
              {open === it.id && (
                <tr className="ds-expand">
                  <td />
                  <td colSpan={5}>
                    <div className="ds-expand-grid">
                      <div className="stack" style={{ gap: 4 }}>
                        <div className="field-label">Input</div>
                        <JsonView value={it.input} maxHeight={320} />
                      </div>
                      <div className="stack" style={{ gap: 4 }}>
                        <div className="field-label">Expected</div>
                        {it.expected == null ? <div className="muted">No expected output</div> : <JsonView value={it.expected} maxHeight={320} />}
                      </div>
                      {it.metadata != null && (
                        <div className="stack" style={{ gap: 4, gridColumn: '1 / -1' }}>
                          <div className="field-label">Metadata</div>
                          <JsonView value={it.metadata} openDepth={1} maxHeight={240} />
                        </div>
                      )}
                    </div>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      {items.length > limit && (
        <div className="row" style={{ justifyContent: 'center', padding: 10 }}>
          <button className="btn sm" onClick={() => setLimit(limit + 200)}>
            Show {Math.min(200, items.length - limit)} more of {items.length - limit}
          </button>
        </div>
      )}
    </div>
  );
}

function ConfirmIcon({ onConfirm, label }: { onConfirm: () => void; label: string }) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 2500);
    return () => clearTimeout(t);
  }, [armed]);
  return armed ? (
    <button
      className="btn sm danger"
      onClick={(e) => {
        e.stopPropagation();
        onConfirm();
      }}
    >
      Remove
    </button>
  ) : (
    <button
      className="btn ghost sm icon"
      title={label}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        setArmed(true);
      }}
    >
      <I.trash />
    </button>
  );
}

function DeleteDataset({ id, name }: { id: string; name: string }) {
  const toast = useToast();
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const t = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(t);
  }, [armed]);
  const del = async () => {
    try {
      await api.del('/api/datasets/' + encodeURIComponent(id));
      toast(`Deleted ${name}`, 'good');
      navigate('/datasets');
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    }
  };
  return armed ? (
    <button className="btn danger" onClick={del}>
      Confirm delete
    </button>
  ) : (
    <button className="btn ghost icon" title="Delete dataset" aria-label="Delete dataset" onClick={() => setArmed(true)}>
      <I.trash />
    </button>
  );
}

function ExperimentsTable({ items, onNew }: { items: ExperimentRow[]; onNew?: () => void }) {
  if (!items.length) {
    return (
      <Empty
        icon={<I.play size={20} />}
        title="No experiments on this dataset"
        body="An experiment runs a target (a shell command, an HTTP endpoint or a model) over every item, scores each output with the evaluators you choose, and can be compared with a baseline run."
        actions={
          onNew && (
            <button className="btn primary" onClick={onNew}>
              <I.play /> New experiment
            </button>
          )
        }
      />
    );
  }
  const names = new Map(items.map((e) => [e.id, e.name]));
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th>Target</th>
            <th>Scores</th>
            <th className="r">Runs</th>
            <th className="r">Errors</th>
            <th className="r">Avg latency</th>
            <th>Baseline</th>
            <th className="r">Created</th>
          </tr>
        </thead>
        <tbody>
          {items.map((e) => {
            const s = e.summary;
            const scores = Object.entries(s?.scores ?? {});
            return (
              <tr key={e.id} className="click" onClick={() => navigate('/experiments/' + encodeURIComponent(e.id))}>
                <td className="cell-main ellipsis" style={{ maxWidth: 240 }}>
                  {e.name}
                </td>
                <td>
                  <StatusChip status={e.status} />
                </td>
                <td className="mono ellipsis dim" style={{ maxWidth: 240 }} title={targetText(e.target)}>
                  <span className="muted">{targetType(e.target)} </span>
                  {targetText(e.target)}
                </td>
                <td>
                  <div className="chips nowrap" style={{ maxWidth: 320 }}>
                    {scores.length === 0 && <span className="muted">{evaluatorIds(e.evaluator_ids).length ? 'Pending' : 'No evaluators'}</span>}
                    {scores.map(([name, v]) => (
                      <span key={name} className={'chip ' + (v.pass_rate == null ? 'neutral' : v.pass_rate >= 0.75 ? 'good' : v.pass_rate < 0.5 ? 'bad' : 'mid')}>
                        {name} <b className="num">{v.pass_rate == null ? (v.avg == null ? '-' : v.avg.toFixed(2)) : fmtPct(v.pass_rate, 0)}</b>
                      </span>
                    ))}
                  </div>
                </td>
                <td className="r">{s?.total != null && s.done != null && s.done < s.total ? `${s.done}/${s.total}` : (s?.runs ?? '-')}</td>
                <td className="r" style={{ color: s?.errors ? 'var(--bad)' : undefined }}>
                  {s?.errors ?? '-'}
                </td>
                <td className="r">{fmtMs(s?.avg_latency_ms)}</td>
                <td className="ellipsis dim" style={{ maxWidth: 160 }}>
                  {e.baseline_id ? (names.get(e.baseline_id) ?? shortId(e.baseline_id)) : <span className="muted">-</span>}
                </td>
                <td className="r muted">{fmtAgo(e.created_at)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

const ITEMS_EXAMPLE = `{"input": "Where is my order #A1042?", "expected": "Shipped, arrives Thursday"}
{"input": {"question": "Refund for a torn jacket"}, "expected": "Escalate refunds over $200"}`;

function AddItems({ datasetId, onClose, onDone }: { datasetId: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'paste' | 'traces'>('paste');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    setErr('');
    let body: unknown;
    if (mode === 'paste') {
      const p = parseItemsText(text);
      if ('error' in p) {
        setErr(p.error);
        return;
      }
      body = p;
    } else {
      const ids = text.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
      if (!ids.length) {
        setErr('Paste at least one trace id.');
        return;
      }
      body = { trace_ids: ids };
    }
    setBusy(true);
    try {
      const r = await api.post<{ added: number }>(`/api/datasets/${encodeURIComponent(datasetId)}/items`, body);
      toast(`Added ${r.added} ${r.added === 1 ? 'item' : 'items'}`, 'good');
      onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Add items"
      wide
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy || !text.trim()} onClick={submit}>
            Add items
          </button>
        </>
      }
    >
      <Seg<'paste' | 'traces'>
        value={mode}
        onChange={(m) => {
          setMode(m);
          setErr('');
        }}
        options={[
          { value: 'paste', label: 'JSON or JSONL' },
          { value: 'traces', label: 'From trace ids' },
        ]}
      />
      {mode === 'paste' ? (
        <Field label="Items" hint="One JSON object per line, or a JSON array. Each object has input and optionally expected and metadata. A line that is not an object becomes the input as is.">
          <textarea className="textarea mono" rows={12} value={text} onChange={(e) => setText(e.target.value)} placeholder={ITEMS_EXAMPLE} autoFocus spellCheck={false} />
        </Field>
      ) : (
        <Field label="Trace ids" hint="Separated by spaces, commas or new lines. Each trace becomes an item: the user goal as input, the final answer as expected, and the tool sequence as expected trajectory metadata.">
          <textarea className="textarea mono" rows={8} value={text} onChange={(e) => setText(e.target.value)} placeholder="b315fcd44e1639c887977f8f23f4a202" autoFocus spellCheck={false} />
        </Field>
      )}
      {err && <div className="err-text">{err}</div>}
    </Modal>
  );
}

type TargetKind = 'command' | 'http' | 'llm';

function NewExperiment({ dataset, itemCount, experiments, onClose }: { dataset: Dataset; itemCount: number; experiments: ExperimentRow[]; onClose: () => void }) {
  const toast = useToast();
  const evs = useApi<{ items: Evaluator[] }>('/api/evaluators');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<TargetKind>('command');
  const [command, setCommand] = useState('');
  const [url, setUrl] = useState('');
  const [model, setModel] = useState('');
  const [system, setSystem] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [baseline, setBaseline] = useState(experiments.find((e) => e.status === 'done')?.id ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const groups = useMemo(() => {
    const all = evs.data?.items ?? [];
    return [
      { label: 'Code checks', items: all.filter((e) => e.type === 'code') },
      { label: 'LLM judges', items: all.filter((e) => e.type === 'llm_judge') },
    ].filter((g) => g.items.length);
  }, [evs.data]);

  const toggle = (id: string) => {
    const n = new Set(chosen);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    setChosen(n);
  };

  const submit = async () => {
    setErr('');
    let target: unknown;
    if (kind === 'command') {
      if (!command.trim()) return setErr('Command is required.');
      target = { type: 'command', command: command.trim() };
    } else if (kind === 'http') {
      if (!/^https?:\/\//.test(url.trim())) return setErr('URL must start with http:// or https://');
      target = { type: 'http', url: url.trim() };
    } else {
      target = { type: 'llm', model: model.trim() || undefined, system: system.trim() || undefined };
    }
    setBusy(true);
    try {
      const ex = await api.post<ExperimentRow>('/api/experiments', {
        dataset_id: dataset.id,
        name: name.trim() || undefined,
        target,
        evaluator_ids: [...chosen],
        baseline_id: baseline || undefined,
      });
      toast(`Started ${ex.name}`, 'good');
      onClose();
      navigate('/experiments/' + encodeURIComponent(ex.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`New experiment on ${dataset.name}`}
      wide
      onClose={onClose}
      footer={
        <>
          <span className="muted" style={{ marginRight: 'auto', alignSelf: 'center' }}>
            Runs {itemCount} {itemCount === 1 ? 'item' : 'items'}, {chosen.size} {chosen.size === 1 ? 'evaluator' : 'evaluators'}
          </span>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            <I.play /> Run experiment
          </button>
        </>
      }
    >
      <Field label="Name" hint="Optional. Defaults to the dataset name and the current time.">
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="prompt v2, sonnet" autoFocus />
      </Field>
      <div className="field">
        <span className="field-label">Target</span>
        <Seg<TargetKind>
          value={kind}
          onChange={setKind}
          options={[
            { value: 'command', label: 'Shell command' },
            { value: 'http', label: 'HTTP endpoint' },
            { value: 'llm', label: 'Model' },
          ]}
        />
      </div>
      {kind === 'command' && (
        <Field label="Command" hint="Runs once per item with the item input as JSON on stdin and in $BLACKBOX_INPUT. Stdout is the output; JSON is parsed. Print {trace_id} to link a trace.">
          <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} placeholder="node agent.js --prompt v2" spellCheck={false} />
        </Field>
      )}
      {kind === 'http' && (
        <Field label="URL" hint="Receives POST {input} for each item. The response body, or its output field, is the output. Optional cost_usd and trace_id fields are recorded.">
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://localhost:3000/agent" spellCheck={false} />
        </Field>
      )}
      {kind === 'llm' && (
        <div className="ds-two">
          <Field label="Model" hint="Leave empty to use the judge model.">
            <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-sonnet-5-5" spellCheck={false} />
          </Field>
          <Field label="System prompt">
            <textarea className="textarea" rows={3} value={system} onChange={(e) => setSystem(e.target.value)} placeholder="You are a support agent for Northwind Outfitters." />
          </Field>
        </div>
      )}
      <div className="field">
        <span className="field-label">Evaluators</span>
        {evs.error ? (
          <div className="muted">{isMissing(evs.error) ? 'Evaluators are not available yet; the experiment will record outputs only.' : 'Could not load evaluators.'}</div>
        ) : !evs.data ? (
          <Skel h={60} />
        ) : !groups.length ? (
          <div className="muted">No evaluators defined. The experiment will record outputs only.</div>
        ) : (
          <div className="ds-evals">
            {groups.map((g) => (
              <div key={g.label} className="stack" style={{ gap: 4 }}>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {g.label}
                </div>
                <div className="ds-ev-grid">
                  {g.items.map((e) => (
                    <label key={e.id} className={'ds-ev' + (chosen.has(e.id) ? ' on' : '')} title={e.description ?? undefined}>
                      <input type="checkbox" checked={chosen.has(e.id)} onChange={() => toggle(e.id)} />
                      <span className="ellipsis">{e.name}</span>
                      {e.target !== 'trace' && <span className="muted ds-ev-target">{e.target}</span>}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <Field label="Baseline" hint="Each item is graded improved, regressed, tie or tradeoff against the baseline run.">
        <select className="select" value={baseline} onChange={(e) => setBaseline(e.target.value)}>
          <option value="">No baseline</option>
          {experiments.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name} ({e.status})
            </option>
          ))}
        </select>
      </Field>
      {err && <div className="err-text">{err}</div>}
    </Modal>
  );
}
