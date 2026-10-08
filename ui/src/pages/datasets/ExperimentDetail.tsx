import { Fragment, useMemo, useState } from 'react';
import { PageHeader } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, Kpi, Seg, Skel, SkelRows, Tabs } from '../../components/ui.tsx';
import { JsonView } from '../../components/JsonView.tsx';
import { ScoreChip } from '../../components/Badges.tsx';
import { I } from '../../components/Icons.tsx';
import { type Dataset } from '../../api.ts';
import { useApi, useLive } from '../../hooks.ts';
import { Link, setSearch, useLocation, useTitle } from '../../router.tsx';
import { fmtAgo, fmtCost, fmtDateTime, fmtMs, fmtPct, shortId } from '../../format.ts';
import {
  asText,
  fmtDelta,
  fmtScore,
  StatusChip,
  targetText,
  targetType,
  unwrap,
  VERDICT_LABEL,
  VerdictChip,
  type CompareResult,
  type CompareSide,
  type ExperimentRow,
  type RunRow,
  type Verdict,
} from './shared.tsx';
import './datasets.css';

type Tab = 'runs' | 'compare';

export function ExperimentDetail({ id }: { id: string }) {
  const live = useLive();
  const { search } = useLocation();
  const res = useApi<{ experiment: ExperimentRow; runs: RunRow[] }>('/api/experiments/' + encodeURIComponent(id), undefined, [live.tick]);
  const exp = res.data?.experiment;
  const ds = useApi<{ dataset: Dataset }>(exp ? '/api/datasets/' + encodeURIComponent(exp.dataset_id) : null);
  const siblings = useApi<{ items: ExperimentRow[] }>(exp ? '/api/experiments' : null, exp ? { dataset_id: exp.dataset_id } : undefined, [live.tick]);
  const baseline = search.get('baseline') || exp?.baseline_id || '';
  const tab: Tab = (search.get('tab') as Tab) || (baseline ? 'compare' : 'runs');
  useTitle(exp?.name ?? 'Experiment');

  const others = (siblings.data?.items ?? []).filter((e) => e.id !== id);

  const header = (
    <PageHeader
      title={exp?.name ?? shortId(id, 16)}
      crumbs={[
        { to: '/datasets', label: 'Datasets' },
        ...(exp ? [{ to: '/datasets/' + encodeURIComponent(exp.dataset_id) + '?tab=experiments', label: ds.data?.dataset.name ?? shortId(exp.dataset_id, 12) }] : []),
      ]}
      right={exp && <StatusChip status={exp.status} />}
    />
  );

  if (res.error) {
    return (
      <>
        {header}
        <div className="page">
          <Card>
            {res.error instanceof Error && /experiment not found/.test(res.error.message) ? (
              <Empty title="Experiment not found" body="It may have been deleted." actions={<Link to="/datasets" className="btn">All datasets</Link>} />
            ) : (
              <ErrorState error={res.error} what="Experiments" retry={res.reload} />
            )}
          </Card>
        </div>
      </>
    );
  }

  const s = exp?.summary;
  const runs = res.data?.runs ?? [];
  const progress = s?.total ? (s.done ?? 0) / s.total : exp?.status === 'done' ? 1 : 0;
  const scoreEntries = Object.entries(s?.scores ?? {});

  return (
    <>
      {header}
      <div className="page">
        <div className="ds-head">
          {exp ? (
            <div className="row wrap muted" style={{ gap: 14, fontSize: 12 }}>
              <span className="row" style={{ gap: 6 }}>
                <I.terminal size={13} />
                <span className="chip sq neutral">{targetType(exp.target)}</span>
                <span className="mono dim ellipsis" style={{ maxWidth: 520 }} title={targetText(exp.target)}>
                  {targetText(exp.target)}
                </span>
              </span>
              <span className="mono">{exp.id}</span>
              <span title={fmtDateTime(exp.created_at)}>Started {fmtAgo(exp.created_at)}</span>
              {exp.finished_at && <span>Took {fmtMs(exp.finished_at - exp.created_at)}</span>}
            </div>
          ) : (
            <Skel w={420} h={12} />
          )}
          {exp?.error && <div className="banner warn">{exp.error}</div>}
          {exp && (exp.status === 'running' || exp.status === 'pending') && (
            <div className="row" style={{ gap: 10 }}>
              <div className="progress" style={{ flex: 1, maxWidth: 420 }}>
                <i style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <span className="muted num">
                {s?.done ?? 0} of {s?.total ?? '?'} items
              </span>
            </div>
          )}
        </div>
        <div className="kpis">
          <Kpi loading={!exp} label="Runs" value={s?.runs ?? 0} foot={s?.total != null ? `of ${s.total} items` : undefined} />
          <Kpi loading={!exp} label="Errors" value={s?.errors ?? 0} tone={s?.errors ? 'bad' : undefined} foot={s?.runs ? fmtPct((s.errors ?? 0) / s.runs) + ' of runs' : undefined} />
          <Kpi loading={!exp} label="Avg latency" value={fmtMs(s?.avg_latency_ms)} />
          <Kpi loading={!exp} label="Target cost" value={fmtCost(s?.target_cost_usd ?? 0)} foot={`Judge ${fmtCost(s?.judge_cost_usd ?? 0)}`} />
          {scoreEntries.map(([name, v]) => (
            <Kpi key={name} label={name} value={v.pass_rate == null ? fmtScore(v.avg) : fmtPct(v.pass_rate)} foot={v.pass_rate == null ? `avg of ${v.n}` : `pass rate, avg ${fmtScore(v.avg)}`} />
          ))}
        </div>
        <section className="card">
          <Tabs<Tab>
            value={tab}
            onChange={(t) => setSearch({ tab: t })}
            tabs={[
              { id: 'runs', label: 'Runs', badge: runs.length || undefined },
              { id: 'compare', label: 'Compare' },
            ]}
            right={
              tab === 'compare' && (
                <span className="row" style={{ gap: 6 }}>
                  <span className="muted">Baseline</span>
                  <select className="select" style={{ height: 26, maxWidth: 260 }} value={baseline} onChange={(e) => setSearch({ baseline: e.target.value || null, tab: 'compare' })}>
                    <option value="">Choose a run</option>
                    {others.map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.id === exp?.baseline_id ? ' (set baseline)' : ''}
                      </option>
                    ))}
                  </select>
                </span>
              )
            }
          />
          {tab === 'runs' ? (
            !res.data ? <SkelRows rows={6} cols={6} /> : <RunsTable runs={runs} status={exp?.status ?? ''} />
          ) : (
            <CompareView id={id} baseline={baseline} hasOthers={others.length > 0} tick={live.tick} />
          )}
        </section>
      </div>
    </>
  );
}

function Output({ v, error }: { v: unknown; error?: string | null }) {
  if (error) return <div className="ds-out err-text mono">{error}</div>;
  const u = unwrap(v);
  if (u == null) return <div className="muted">No output</div>;
  if (typeof u === 'string') return <div className="ds-out prose">{u}</div>;
  return <JsonView value={u} maxHeight={280} openDepth={2} />;
}

function RunsTable({ runs, status }: { runs: RunRow[]; status: string }) {
  const [open, setOpen] = useState<string | null>(null);
  if (!runs.length) {
    return <Empty title={status === 'running' || status === 'pending' ? 'Waiting for the first run' : 'No runs recorded'} body={status === 'running' || status === 'pending' ? 'Results stream in as each item finishes.' : 'The dataset had no items when this experiment ran.'} />;
  }
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th style={{ width: 36 }}>#</th>
            <th>Input</th>
            <th>Output</th>
            <th>Scores</th>
            <th className="r">Latency</th>
            <th className="r">Cost</th>
            <th>Trace</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r, i) => (
            <Fragment key={r.id}>
              <tr className={'click' + (open === r.id ? ' sel' : '')} onClick={() => setOpen(open === r.id ? null : r.id)}>
                <td className="muted num">{i + 1}</td>
                <td className="ellipsis cell-main" style={{ maxWidth: 300 }}>
                  {asText(r.input, 120)}
                </td>
                <td className="ellipsis" style={{ maxWidth: 360 }}>
                  {r.error ? (
                    <span className="err-text">
                      <I.alert size={12} style={{ verticalAlign: -2 }} /> {r.error}
                    </span>
                  ) : (
                    <span className="dim">{asText(r.output, 140) || <span className="muted">empty</span>}</span>
                  )}
                </td>
                <td>
                  <div className="chips nowrap" style={{ maxWidth: 300 }}>
                    {r.scores.length === 0 && <span className="muted">-</span>}
                    {r.scores.map((sc) => (
                      <ScoreChip key={sc.id} s={sc} title={`${sc.name}: ${sc.reasoning ?? ''}`} />
                    ))}
                  </div>
                </td>
                <td className="r">{fmtMs(r.latency_ms)}</td>
                <td className="r">{fmtCost(r.cost_usd)}</td>
                <td>
                  {r.trace_id ? (
                    <Link to={'/traces/' + r.trace_id} className="link mono" onClick={(e) => e.stopPropagation()}>
                      {shortId(r.trace_id)}
                    </Link>
                  ) : (
                    <span className="muted">-</span>
                  )}
                </td>
              </tr>
              {open === r.id && (
                <tr className="ds-expand">
                  <td />
                  <td colSpan={6}>
                    <div className="ds-expand-grid three">
                      <div className="stack" style={{ gap: 4 }}>
                        <div className="field-label">Input</div>
                        <JsonView value={r.input} maxHeight={280} />
                      </div>
                      <div className="stack" style={{ gap: 4 }}>
                        <div className="field-label">Expected</div>
                        {r.expected == null ? <div className="muted">No expected output</div> : <JsonView value={r.expected} maxHeight={280} />}
                      </div>
                      <div className="stack" style={{ gap: 4 }}>
                        <div className="field-label">Output</div>
                        <Output v={r.output} error={r.error} />
                      </div>
                    </div>
                    {r.scores.length > 0 && (
                      <div className="ds-reasons">
                        {r.scores.map((sc) => (
                          <div key={sc.id} className="ds-reason">
                            <ScoreChip s={sc} />
                            <span className="dim">{sc.reasoning || <span className="muted">No reasoning</span>}</span>
                            {sc.judge_model && <span className="muted mono">{sc.judge_model}</span>}
                          </div>
                        ))}
                      </div>
                    )}
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CompareView({ id, baseline, hasOthers, tick }: { id: string; baseline: string; hasOthers: boolean; tick: number }) {
  const res = useApi<CompareResult>(baseline ? `/api/experiments/${encodeURIComponent(id)}/compare` : null, { baseline }, [tick]);
  const [filter, setFilter] = useState<'all' | Verdict>('all');

  const counts = useMemo(() => {
    const c: Record<Verdict, number> = { improved: 0, regressed: 0, tie: 0, tradeoff: 0 };
    for (const r of res.data?.rows ?? []) c[r.verdict]++;
    return c;
  }, [res.data]);

  if (!baseline) {
    return (
      <Empty
        icon={<I.layers size={20} />}
        title="Pick a baseline to compare"
        body={hasOthers ? 'Choose another experiment on this dataset in the Baseline menu above. Every item is graded improved, regressed, tie or tradeoff against it.' : 'This is the only experiment on its dataset. Run another one, then compare the two here.'}
      />
    );
  }
  if (res.error) return <ErrorState error={res.error} what="Compare" retry={res.reload} />;
  if (!res.data) return <SkelRows rows={5} cols={4} h={64} />;

  const rows = res.data.rows.filter((r) => filter === 'all' || r.verdict === filter);
  const summary = Object.entries(res.data.summary);
  const aName = res.data.baseline?.name ?? 'Baseline';
  const bName = res.data.experiment?.name ?? 'This run';

  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="ds-cmp-summary">
        {summary.length === 0 ? (
          <div className="muted" style={{ padding: '4px 0' }}>
            No shared scores between the two runs. Verdicts fall back to errors only.
          </div>
        ) : (
          summary.map(([name, v]) => {
            const d = v.a_avg != null && v.b_avg != null ? v.b_avg - v.a_avg : null;
            return (
              <div key={name} className="ds-cmp-card">
                <div className="muted ellipsis" style={{ fontSize: 11.5, fontWeight: 500 }}>
                  {name}
                </div>
                <div className="row" style={{ gap: 8, alignItems: 'baseline' }}>
                  <span className="num dim">{fmtScore(v.a_avg)}</span>
                  <I.chevronRight size={11} style={{ color: 'var(--muted)' }} />
                  <span className="num" style={{ fontSize: 18, fontWeight: 600 }}>
                    {fmtScore(v.b_avg)}
                  </span>
                  {d != null && (
                    <span className={'num ds-delta ' + (d > 1e-9 ? 'up' : d < -1e-9 ? 'down' : '')}>
                      {fmtDelta(v.a_avg, v.b_avg)}
                    </span>
                  )}
                </div>
                <div className="row muted num" style={{ gap: 10, fontSize: 11.5 }}>
                  <span>
                    <span className="sev" style={{ background: 'var(--good)', marginRight: 4 }} />
                    {v.improved} improved
                  </span>
                  <span>
                    <span className="sev" style={{ background: 'var(--bad)', marginRight: 4 }} />
                    {v.regressed} regressed
                  </span>
                  <span>{v.ties} tie</span>
                </div>
              </div>
            );
          })
        )}
      </div>
      <div className="row ds-cmp-bar">
        <Seg<'all' | Verdict>
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: `All ${res.data.rows.length}` },
            ...(['improved', 'regressed', 'tradeoff', 'tie'] as Verdict[]).map((v) => ({ value: v, label: `${VERDICT_LABEL[v]} ${counts[v]}` })),
          ]}
        />
        <span className="muted" style={{ marginLeft: 'auto' }}>
          Left: <b className="dim">{aName}</b>. Right: <b className="dim">{bName}</b>.
        </span>
      </div>
      {rows.length === 0 ? (
        <Empty small title={`No ${filter === 'all' ? '' : VERDICT_LABEL[filter as Verdict].toLowerCase() + ' '}items`} body="Try another verdict filter." />
      ) : (
        <div className="ds-cmp-rows">
          {rows.map((r, i) => (
            <CompareRowView key={r.item_id} index={i} row={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScoreDeltas({ a, b }: { a: CompareSide | null; b: CompareSide | null }) {
  const names = [...new Set([...Object.keys(a?.scores ?? {}), ...Object.keys(b?.scores ?? {})])];
  if (!names.length) return null;
  return (
    <div className="chips">
      {names.map((n) => {
        const x = a?.scores[n] ?? null;
        const y = b?.scores[n] ?? null;
        const d = x != null && y != null ? y - x : null;
        const tone = d == null ? 'neutral' : d > 1e-9 ? 'good' : d < -1e-9 ? 'bad' : 'neutral';
        return (
          <span key={n} className={'chip ' + tone} title={`${n}: ${fmtScore(x)} to ${fmtScore(y)}`}>
            {n}
            <b className="num">
              {fmtScore(x)} → {fmtScore(y)}
            </b>
            {d != null && Math.abs(d) > 1e-9 && <span className="num">{fmtDelta(x, y)}</span>}
          </span>
        );
      })}
    </div>
  );
}

function SideMeta({ s }: { s: CompareSide | null }) {
  if (!s) return null;
  return (
    <span className="row muted num" style={{ gap: 10, fontSize: 11.5 }}>
      <span>{fmtMs(s.latency_ms)}</span>
      {s.cost_usd != null && <span>{fmtCost(s.cost_usd)}</span>}
      {s.trace_id && (
        <Link to={'/traces/' + s.trace_id} className="link mono">
          {shortId(s.trace_id)}
        </Link>
      )}
    </span>
  );
}

function CompareRowView({ row, index }: { row: CompareResult['rows'][number]; index: number }) {
  return (
    <div className={'ds-cmp-row v-' + row.verdict}>
      <div className="ds-cmp-top">
        <span className="muted num">{index + 1}</span>
        <VerdictChip v={row.verdict} />
        <span className="ellipsis cell-main" style={{ fontWeight: 500, minWidth: 0, flex: 1 }} title={asText(row.input, 1000)}>
          {asText(row.input, 240)}
        </span>
        <ScoreDeltas a={row.a} b={row.b} />
      </div>
      {row.expected != null && (
        <div className="ds-cmp-expected">
          <span className="muted">Expected</span>
          <span className="dim ellipsis">{asText(row.expected, 300)}</span>
        </div>
      )}
      <div className="ds-cmp-sides">
        <div className="ds-cmp-side">
          <div className="row" style={{ gap: 8 }}>
            <span className="field-label">Baseline</span>
            <SideMeta s={row.a} />
          </div>
          {row.a ? <Output v={row.a.output} error={row.a.error} /> : <div className="muted">Not run in the baseline</div>}
        </div>
        <div className="ds-cmp-side">
          <div className="row" style={{ gap: 8 }}>
            <span className="field-label">This run</span>
            <SideMeta s={row.b} />
          </div>
          {row.b ? <Output v={row.b.output} error={row.b.error} /> : <div className="muted">Not run in this experiment</div>}
        </div>
      </div>
    </div>
  );
}
