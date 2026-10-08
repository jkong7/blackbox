import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PageHeader, LiveIndicator } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, SearchInput, Seg, SkelRows } from '../../components/ui.tsx';
import { FirstRun } from '../../components/FirstRun.tsx';
import { KindIcon, KIND_LABEL } from '../../components/Kind.tsx';
import { api, type Facets, type Page, type Signal, type Trace, type Kind } from '../../api.ts';
import { useApi, useHealth, useLive, useHotkeys } from '../../hooks.ts';
import { navigate, setSearch, useLocation, useTitle } from '../../router.tsx';
import { fmtCompact, humanize } from '../../format.ts';
import { FilterMenu } from './FilterMenu.tsx';
import { TraceRow } from './TraceRow.tsx';
import './traces.css';

const FILTER_KEYS = ['status', 'flagged', 'model', 'agent', 'tool', 'kind', 'source', 'signal', 'project', 'score', 'session', 'user', 'window'] as const;
const PAGE = 60;
const CAP = 2000;

export function Traces() {
  useTitle('Traces');
  const { search } = useLocation();
  const live = useLive();
  const { health } = useHealth();
  const facets = useApi<Facets>('/api/facets', undefined, [live.tick]);
  const qParam = search.get('q') ?? '';
  const sort = (search.get('sort') ?? 'time') as 'time' | 'cost' | 'duration';
  const [q, setQ] = useState(qParam);
  const [items, setItems] = useState<Trace[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [fresh, setFresh] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState(-1);
  const [sigLabel, setSigLabel] = useState<string | null>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const params = useMemo(() => {
    const p: Record<string, string> = {};
    for (const k of FILTER_KEYS) {
      const v = search.get(k);
      if (v) p[k] = v;
    }
    if (qParam) p.q = qParam;
    if (sort !== 'time') p.sort = sort;
    return p;
  }, [search.toString()]);
  const key = JSON.stringify(params);

  useEffect(() => setQ(qParam), [qParam]);
  useEffect(() => {
    const t = setTimeout(() => {
      if (q !== qParam) setSearch({ q: q.trim() ? q : null });
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    api
      .get<Page<Trace>>('/api/traces', { ...params, limit: PAGE }, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total ?? null);
        setNext(r.next);
        setError(null);
        setLoading(false);
        setSel(-1);
        setFresh(new Set());
      })
      .catch((e) => {
        if (ctl.signal.aborted) return;
        setError(e);
        setLoading(false);
      });
    return () => ctl.abort();
  }, [key]);

  useEffect(() => {
    if (!live.tick || sort !== 'time') return;
    const ctl = new AbortController();
    api
      .get<Page<Trace>>('/api/traces', { ...params, limit: PAGE }, ctl.signal)
      .then((r) => {
        setTotal(r.total ?? null);
        setItems((cur) => {
          const byId = new Map(r.items.map((t) => [t.trace_id, t]));
          const known = new Set(cur.map((t) => t.trace_id));
          const added = r.items.filter((t) => !known.has(t.trace_id));
          if (added.length) setFresh(new Set(added.map((t) => t.trace_id)));
          const updated = cur.map((t) => byId.get(t.trace_id) ?? t);
          return [...added, ...updated];
        });
      })
      .catch(() => {});
    return () => ctl.abort();
  }, [live.tick]);

  useEffect(() => {
    const fp = params.signal;
    if (!fp || facets.data?.signal_types.includes(fp)) {
      setSigLabel(null);
      return;
    }
    api
      .get<{ items: Signal[] }>('/api/signals', { fingerprint: fp, limit: 1 })
      .then((r) => setSigLabel(r.items[0]?.title ?? null))
      .catch(() => setSigLabel(null));
  }, [params.signal, facets.data]);

  const loadMore = useCallback(() => {
    if (!next || loadingMore || items.length >= CAP) return;
    setLoadingMore(true);
    api
      .get<Page<Trace>>('/api/traces', { ...params, limit: PAGE, cursor: next })
      .then((r) => {
        setItems((cur) => {
          const known = new Set(cur.map((t) => t.trace_id));
          return [...cur, ...r.items.filter((t) => !known.has(t.trace_id))];
        });
        setNext(r.next);
        setLoadingMore(false);
      })
      .catch(() => setLoadingMore(false));
  }, [next, loadingMore, items.length, key]);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && loadMore(), { rootMargin: '600px' });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  useHotkeys(
    {
      j: () => setSel((s) => Math.min(items.length - 1, s + 1)),
      k: () => setSel((s) => Math.max(0, s - 1)),
      ArrowDown: () => setSel((s) => Math.min(items.length - 1, s + 1)),
      ArrowUp: () => setSel((s) => Math.max(0, s - 1)),
      Enter: () => sel >= 0 && items[sel] && navigate('/traces/' + items[sel].trace_id),
      Escape: () => setSel(-1),
    },
    [items, sel],
  );

  useEffect(() => {
    if (sel < 0) return;
    document.querySelector('.trace-table tr.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  const f = facets.data;
  const set = (k: string) => (v: string | null) => setSearch({ [k]: v });
  const opts = (xs: string[] | undefined) => (xs ?? []).map((x) => ({ value: x, label: x }));
  const signalOpts = [...(f?.signal_types ?? []).map((x) => ({ value: x, label: humanize(x) }))];
  if (params.signal && !signalOpts.some((o) => o.value === params.signal)) signalOpts.unshift({ value: params.signal, label: sigLabel ?? 'Issue ' + params.signal.slice(0, 8) });
  const activeCount = FILTER_KEYS.filter((k) => params[k]).length + (qParam ? 1 : 0);

  if (health && health.spans === 0) {
    return (
      <>
        <PageHeader title="Traces" />
        <div className="page">
          <FirstRun />
        </div>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Traces"
        right={
          <div className="row" style={{ gap: 12 }}>
            <span className="muted num">{total == null ? '' : `${fmtCompact(total)} ${total === 1 ? 'trace' : 'traces'}`}</span>
            <LiveIndicator />
            <Seg
              value={sort}
              label="Sort"
              options={[
                { value: 'time', label: 'Newest' },
                { value: 'cost', label: 'Cost' },
                { value: 'duration', label: 'Duration' },
              ]}
              onChange={(v) => setSearch({ sort: v === 'time' ? null : v })}
            />
          </div>
        }
      />
      <div className="page" style={{ gap: 12 }}>
        <div className="trace-toolbar">
          <div style={{ width: 300 }}>
            <SearchInput value={q} onChange={setQ} placeholder="Search inputs, outputs, names…  /" pageSearch />
          </div>
          <FilterMenu label="Status" value={params.status ?? ''} options={[{ value: 'error', label: 'Error' }, { value: 'ok', label: 'No errors' }]} onChange={set('status')} />
          <FilterMenu label="Flagged" value={params.flagged ?? ''} options={[{ value: '1', label: 'Has signals' }]} onChange={set('flagged')} />
          <FilterMenu label="Signal" value={params.signal ?? ''} options={signalOpts} onChange={set('signal')} />
          <FilterMenu label="Agent" value={params.agent ?? ''} options={opts(f?.agents)} onChange={set('agent')} />
          <FilterMenu label="Model" value={params.model ?? ''} options={opts(f?.models)} onChange={set('model')} />
          <FilterMenu label="Tool" value={params.tool ?? ''} options={opts(f?.tools)} onChange={set('tool')} />
          <FilterMenu
            label="Kind"
            value={params.kind ?? ''}
            options={(f?.kinds ?? []).map((k) => ({ value: k, label: KIND_LABEL[k as Kind] ?? k }))}
            onChange={set('kind')}
            render={(o) => (
              <span className="row" style={{ gap: 6 }}>
                <KindIcon kind={o.value} size={16} />
                {o.label}
              </span>
            )}
          />
          <FilterMenu label="Source" value={params.source ?? ''} options={opts(f?.sources)} onChange={set('source')} />
          {(f?.projects.length ?? 0) > 1 && <FilterMenu label="Project" value={params.project ?? ''} options={opts(f?.projects)} onChange={set('project')} />}
          {(f?.score_names.length ?? 0) > 0 && <FilterMenu label="Score" value={params.score ?? ''} options={(f?.score_names ?? []).flatMap((n) => [{ value: n + ':fail', label: `${n} failed` }, { value: n + ':pass', label: `${n} passed` }])} onChange={set('score')} />}
          {params.session && <FilterMenu label="Session" value={params.session} options={[{ value: params.session, label: params.session }]} onChange={set('session')} />}
          {params.window && <FilterMenu label="Window" value={params.window} options={['1h', '24h', '7d', '30d'].map((w) => ({ value: w, label: 'Last ' + w }))} onChange={set('window')} />}
          {activeCount > 0 && (
            <button className="btn ghost sm" onClick={() => navigate('/traces')}>
              Clear
            </button>
          )}
        </div>
        <Card flush>
          {error && !items.length ? (
            <ErrorState error={error} />
          ) : loading && !items.length ? (
            <SkelRows rows={14} cols={8} />
          ) : !items.length ? (
            <Empty title="No traces match" body={activeCount ? 'Try removing a filter or widening the search.' : 'Traces appear here as soon as an agent sends spans.'} actions={activeCount ? <button className="btn sm" onClick={() => navigate('/traces')}>Clear filters</button> : undefined} />
          ) : (
            <div className="table-wrap" style={{ opacity: loading ? 0.6 : 1, transition: 'opacity .15s' }}>
              <table className="tbl trace-table">
                <thead>
                  <tr>
                    <th style={{ width: 24 }} />
                    <th>Time</th>
                    <th>Name</th>
                    <th>Input</th>
                    <th>Signals</th>
                    <th>Scores</th>
                    <th>Steps</th>
                    <th className="r">Tokens</th>
                    <th className={'r sortable' + (sort === 'cost' ? ' sorted' : '')} onClick={() => setSearch({ sort: sort === 'cost' ? null : 'cost' })}>
                      Cost
                    </th>
                    <th className={'r sortable' + (sort === 'duration' ? ' sorted' : '')} onClick={() => setSearch({ sort: sort === 'duration' ? null : 'duration' })}>
                      Duration
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((t, i) => (
                    <TraceRow key={t.trace_id} t={t} selected={i === sel} fresh={fresh.has(t.trace_id)} onSignal={(s) => setSearch({ signal: s })} />
                  ))}
                </tbody>
              </table>
              <div ref={sentinel} className="sentinel" />
              <div className="table-foot">
                {loadingMore ? 'Loading more…' : next && items.length < CAP ? <button className="btn sm" onClick={loadMore}>Load more</button> : items.length >= CAP ? `Showing the first ${fmtCompact(CAP)}. Narrow the filters to see more.` : `${fmtCompact(items.length)} shown`}
                <span style={{ marginLeft: 'auto' }}>
                  <kbd>j</kbd> <kbd>k</kbd> move · <kbd>↵</kbd> open · <kbd>/</kbd> search
                </span>
              </div>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
