import { useMemo, useState } from 'react';
import { PageHeader } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, Field, Modal, SearchInput, SkelRows } from '../../components/ui.tsx';
import { I } from '../../components/Icons.tsx';
import { useToast } from '../../components/Toast.tsx';
import { api, isMissing, type Dataset } from '../../api.ts';
import { useApi, useLive } from '../../hooks.ts';
import { navigate, useTitle } from '../../router.tsx';
import { fmtAgo, fmtInt } from '../../format.ts';
import { StatusChip, type ExperimentRow } from './shared.tsx';
import './datasets.css';

export function Datasets() {
  useTitle('Datasets');
  const live = useLive();
  const ds = useApi<{ items: Dataset[] }>('/api/datasets', undefined, [live.tick]);
  const ex = useApi<{ items: ExperimentRow[] }>('/api/experiments', undefined, [live.tick]);
  const [creating, setCreating] = useState(false);
  const [q, setQ] = useState('');

  const byDataset = useMemo(() => {
    const m = new Map<string, ExperimentRow[]>();
    for (const e of ex.data?.items ?? []) {
      const l = m.get(e.dataset_id) ?? [];
      l.push(e);
      m.set(e.dataset_id, l);
    }
    return m;
  }, [ex.data]);

  const items = (ds.data?.items ?? []).filter((d) => !q || d.name.toLowerCase().includes(q.toLowerCase()) || (d.description ?? '').toLowerCase().includes(q.toLowerCase()));
  const missing = isMissing(ds.error);

  return (
    <>
      <PageHeader
        title="Datasets & experiments"
        right={
          !missing && (
            <button className="btn primary" onClick={() => setCreating(true)}>
              <I.plus /> New dataset
            </button>
          )
        }
      />
      <div className="page">
        <Card
          title="Datasets"
          sub={ds.data ? `${ds.data.items.length} total` : undefined}
          right={ds.data && ds.data.items.length > 0 && <SearchInput value={q} onChange={setQ} placeholder="Filter datasets" width={220} />}
          flush
        >
          {ds.error ? (
            <ErrorState error={ds.error} what="Datasets" retry={ds.reload} />
          ) : !ds.data ? (
            <SkelRows rows={4} cols={5} />
          ) : ds.data.items.length === 0 ? (
            <Empty
              icon={<I.datasets size={20} />}
              title="No datasets yet"
              body="A dataset is a fixed set of inputs, with optional expected outputs, that you run experiments against. Create one here, paste JSONL, or add traces from the trace view."
              actions={
                <button className="btn primary" onClick={() => setCreating(true)}>
                  <I.plus /> New dataset
                </button>
              }
            />
          ) : items.length === 0 ? (
            <Empty small title="No datasets match" body={`Nothing matches "${q}".`} />
          ) : (
            <div className="table-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Description</th>
                    <th className="r">Items</th>
                    <th className="r">Experiments</th>
                    <th>Latest experiment</th>
                    <th className="r">Created</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((d) => {
                    const exps = byDataset.get(d.id) ?? [];
                    const latest = exps[0];
                    return (
                      <tr key={d.id} className="click" onClick={() => navigate('/datasets/' + encodeURIComponent(d.id))}>
                        <td className="cell-main">{d.name}</td>
                        <td className="dim ellipsis" style={{ maxWidth: 360 }}>
                          {d.description || <span className="muted">-</span>}
                        </td>
                        <td className="r">{fmtInt(d.item_count ?? 0)}</td>
                        <td className="r">{exps.length}</td>
                        <td>
                          {latest ? (
                            <span className="row" style={{ gap: 8 }}>
                              <StatusChip status={latest.status} />
                              <span className="ellipsis" style={{ maxWidth: 220 }}>
                                {latest.name}
                              </span>
                            </span>
                          ) : (
                            <span className="muted">None yet</span>
                          )}
                        </td>
                        <td className="r muted">{fmtAgo(d.created_at)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
      {creating && <CreateDataset onClose={() => setCreating(false)} />}
    </>
  );
}

function CreateDataset({ onClose }: { onClose: () => void }) {
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async () => {
    if (!name.trim()) {
      setErr('Name is required.');
      return;
    }
    setBusy(true);
    setErr('');
    try {
      const d = await api.post<Dataset>('/api/datasets', { name: name.trim(), description: description.trim() || undefined });
      toast(`Created dataset ${d.name}`, 'good');
      onClose();
      navigate('/datasets/' + encodeURIComponent(d.id));
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Modal
      title="New dataset"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" disabled={busy} onClick={submit}>
            Create dataset
          </button>
        </>
      }
    >
      <form
        className="stack"
        style={{ gap: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Name" hint="Unique, for example support-golden or refund-edge-cases.">
          <input className="input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="support-golden" />
        </Field>
        <Field label="Description">
          <textarea className="textarea" rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What these items cover and where they came from" />
        </Field>
        {err && <div className="err-text">{err}</div>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}
