import { useEffect, useMemo, useState } from 'react';
import { api, type Explanation, type Signal, type TraceDetail } from '../../api.ts';
import { useApi, useHotkeys, useLive } from '../../hooks.ts';
import { PageHeader } from '../../components/Layout.tsx';
import { Empty, ErrorState, Skel, SkelRows, Tabs } from '../../components/ui.tsx';
import { I } from '../../components/Icons.tsx';
import { KindIcon } from '../../components/Kind.tsx';
import { ApiError } from '../../api.ts';
import { navigate, setSearch, useLocation, useTitle } from '../../router.tsx';
import { humanize, shortId } from '../../format.ts';
import { buildTree, firstUserInput, flatten, signalSpanIds, withAncestors, type GraphNode } from './model.ts';
import { SpanTree } from './SpanTree.tsx';
import { SpanDetail } from './SpanDetail.tsx';
import { AgentGraph } from './AgentGraph.tsx';
import { ContextView } from './ContextView.tsx';
import { SignalsScores } from './SignalsScores.tsx';
import { TraceHeader, type Action } from './Header.tsx';
import { AddToDatasetModal, AnnotateModal, RunEvaluatorModal, ExplainCard } from './Actions.tsx';
import './trace.css';

type View = 'tree' | 'graph' | 'context' | 'signals';

export function TraceDetailPage({ id }: { id: string }) {
  useTitle('Trace ' + shortId(id));
  const live = useLive();
  const { search } = useLocation();
  const res = useApi<TraceDetail>('/api/traces/' + encodeURIComponent(id));
  const d = res.data;
  const view = (['tree', 'graph', 'context', 'signals'].includes(search.get('view') ?? '') ? search.get('view') : 'tree') as View;
  const spanParam = search.get('span');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [activeSignal, setActiveSignal] = useState<string | null>(null);
  const [nodeFilter, setNodeFilter] = useState<GraphNode | null>(null);
  const [modal, setModal] = useState<Action | null>(null);
  const [explain, setExplain] = useState<Explanation | null>(null);
  const [explaining, setExplaining] = useState(false);
  const [explainErr, setExplainErr] = useState<unknown>(null);

  useEffect(() => {
    return live.subscribe((ev) => {
      if (live.paused) return;
      if (ev.ids.includes(id) || ev.type === 'scores') res.reload();
    });
  }, [id, live.paused]);

  useEffect(() => {
    setExplain(null);
    setExplainErr(null);
    setActiveSignal(null);
    setNodeFilter(null);
    setCollapsed(new Set());
    api
      .get<Explanation>(`/api/traces/${encodeURIComponent(id)}/explain`)
      .then(setExplain)
      .catch(() => {});
  }, [id]);

  const tree = useMemo(() => (d ? buildTree(d.spans) : null), [d]);
  const sigMap = useMemo(() => {
    const m = new Map<string, Signal[]>();
    if (!d || !tree) return m;
    for (const s of d.signals) {
      for (const sid of signalSpanIds(s, tree.byId)) {
        const xs = m.get(sid) ?? [];
        xs.push(s);
        m.set(sid, xs);
      }
    }
    return m;
  }, [d, tree]);

  const highlight = useMemo(() => {
    if (!d || !tree) return null;
    if (activeSignal) {
      const s = d.signals.find((x) => x.id === activeSignal);
      if (s) {
        const ids = signalSpanIds(s, tree.byId);
        return ids.length ? new Set(ids) : null;
      }
    }
    if (nodeFilter) return new Set(nodeFilter.spanIds);
    return null;
  }, [activeSignal, nodeFilter, d, tree]);

  const keep = useMemo(() => (nodeFilter && tree ? withAncestors(tree, nodeFilter.spanIds) : null), [nodeFilter, tree]);
  const rows = useMemo(() => (tree ? flatten(tree, collapsed, keep) : []), [tree, collapsed, keep]);

  const selectedId = spanParam && tree?.byId.has(spanParam) ? spanParam : (tree?.roots[0]?.span.span_id ?? null);
  const selected = selectedId && tree ? tree.byId.get(selectedId)?.span ?? null : null;

  const select = (sid: string) => setSearch({ span: sid });
  const setView = (v: View) => setSearch({ view: v === 'tree' ? null : v });

  const expandTo = (ids: string[]) => {
    if (!tree) return;
    const anc = withAncestors(tree, ids);
    setCollapsed((c) => {
      const n = new Set(c);
      for (const a of anc) if (!ids.includes(a)) n.delete(a);
      return n;
    });
  };

  const pickSignal = (s: Signal) => {
    if (activeSignal === s.id) {
      setActiveSignal(null);
      return;
    }
    setActiveSignal(s.id);
    setNodeFilter(null);
    if (!tree) return;
    const ids = signalSpanIds(s, tree.byId);
    expandTo(ids);
    if (ids[0]) select(ids[0]);
    if (view !== 'tree') setView('tree');
  };

  const goSpan = (sid: string) => {
    expandTo([sid]);
    select(sid);
    if (view === 'graph') setView('tree');
  };

  const doExplain = async () => {
    setView('signals');
    setExplaining(true);
    setExplainErr(null);
    try {
      setExplain(await api.post<Explanation>(`/api/traces/${encodeURIComponent(id)}/explain`));
    } catch (e) {
      setExplainErr(e);
    } finally {
      setExplaining(false);
    }
  };

  const onAction = (a: Action) => {
    if (a === 'explain') void doExplain();
    else setModal(a);
  };

  const move = (delta: number) => {
    if (!rows.length) return;
    const i = rows.findIndex((r) => r.span.span_id === selectedId);
    const n = Math.min(rows.length - 1, Math.max(0, (i < 0 ? 0 : i) + delta));
    select(rows[n].span.span_id);
  };

  useHotkeys(
    {
      ArrowDown: () => move(1),
      ArrowUp: () => move(-1),
      j: () => move(1),
      k: () => move(-1),
      ArrowLeft: () => {
        if (!selectedId || !tree) return;
        const n = tree.byId.get(selectedId);
        if (n && n.children.length && !collapsed.has(selectedId)) setCollapsed(new Set(collapsed).add(selectedId));
        else if (n?.span.parent_id && tree.byId.has(n.span.parent_id)) select(n.span.parent_id);
      },
      ArrowRight: () => {
        if (!selectedId) return;
        if (collapsed.has(selectedId)) {
          const c = new Set(collapsed);
          c.delete(selectedId);
          setCollapsed(c);
        } else move(1);
      },
      '1': () => setView('tree'),
      '2': () => setView('graph'),
      '3': () => setView('context'),
      '4': () => setView('signals'),
      '[': () => d?.session_nav.prev && navigate('/traces/' + d.session_nav.prev),
      ']': () => d?.session_nav.next && navigate('/traces/' + d.session_nav.next),
      Escape: () => {
        setActiveSignal(null);
        setNodeFilter(null);
      },
    },
    [rows, selectedId, collapsed, tree, d, view],
  );

  const crumbs = [{ to: '/traces', label: 'Traces' }];
  if (res.error && !d) {
    const notFound = res.error instanceof ApiError && res.error.status === 404;
    return (
      <>
        <PageHeader title={shortId(id, 16)} crumbs={crumbs} />
        <div className="page">
          {notFound ? (
            <Empty title="Trace not found" body={`No trace with id ${id}. It may have been deleted or not flushed yet.`} actions={<button className="btn" onClick={() => navigate('/traces')}>Back to traces</button>} />
          ) : (
            <ErrorState error={res.error} retry={res.reload} />
          )}
        </div>
      </>
    );
  }

  const toggle = (sid: string) => {
    const c = new Set(collapsed);
    if (c.has(sid)) c.delete(sid);
    else c.add(sid);
    setCollapsed(c);
  };

  const activeSig = d?.signals.find((s) => s.id === activeSignal);
  const spanSignals = selected ? sigMap.get(selected.span_id) ?? [] : [];
  const spanScores = selected && d ? d.scores.filter((s) => s.span_id === selected.span_id || (!s.span_id && selected.span_id === tree?.roots[0]?.span.span_id)) : [];

  return (
    <div className="td-page">
      <PageHeader title={<span className="mono" style={{ fontSize: 13 }}>{shortId(id, 16)}</span>} crumbs={crumbs} />
      {d && tree ? (
        <TraceHeader d={d} firstInput={firstUserInput(d.spans, tree)} onAction={onAction} explaining={explaining} />
      ) : (
        <div className="td-header">
          <Skel w={280} h={18} />
          <Skel w="60%" h={13} />
          <Skel w="45%" h={12} />
        </div>
      )}
      <div className="td-split">
        <div className="td-left">
          <Tabs<View>
            value={view}
            onChange={setView}
            tabs={[
              { id: 'tree', label: 'Tree', icon: <I.tree size={13} />, badge: d?.spans.length },
              { id: 'graph', label: 'Graph', icon: <I.graph size={13} /> },
              { id: 'context', label: 'Context', icon: <I.layers size={13} />, badge: d?.trace.llm_calls },
              { id: 'signals', label: 'Signals & scores', icon: <I.flag size={13} />, badge: d ? d.signals.length + d.scores.length || undefined : undefined },
            ]}
            right={<span className="muted tabs-hint" style={{ fontSize: 11.5 }}><kbd>↑</kbd> <kbd>↓</kbd> spans · <kbd>1</kbd>-<kbd>4</kbd> views</span>}
          />
          {(activeSig || nodeFilter) && view === 'tree' && (
            <div className="hl-bar">
              {activeSig ? (
                <>
                  <span className={'sev ' + activeSig.severity} />
                  <span className="ellipsis">
                    <b style={{ fontWeight: 500 }}>{humanize(activeSig.type)}</b>
                    <span className="dim"> · {activeSig.title}</span>
                  </span>
                </>
              ) : (
                nodeFilter && (
                  <>
                    <KindIcon kind={nodeFilter.kind} size={16} />
                    <span className="ellipsis">
                      Filtered to <b style={{ fontWeight: 500 }}>{nodeFilter.label}</b> <span className="dim">({nodeFilter.calls} spans)</span>
                    </span>
                  </>
                )
              )}
              <button
                className="btn ghost sm"
                style={{ marginLeft: 'auto' }}
                onClick={() => {
                  setActiveSignal(null);
                  setNodeFilter(null);
                }}
              >
                Clear <kbd>esc</kbd>
              </button>
            </div>
          )}
          <div className="td-left-body">
            {!d || !tree ? (
              <SkelRows rows={12} cols={4} h={30} />
            ) : view === 'tree' ? (
              rows.length ? <SpanTree tree={tree} rows={rows} selected={selectedId} onSelect={select} collapsed={collapsed} onToggle={toggle} signalsBySpan={sigMap} highlight={highlight} /> : <Empty title="No spans" />
            ) : view === 'graph' ? (
              <AgentGraph
                tree={tree}
                active={nodeFilter?.id ?? null}
                onPick={(n) => {
                  setNodeFilter(n);
                  setActiveSignal(null);
                  if (n) {
                    setView('tree');
                    if (n.spanIds[0]) select(n.spanIds[0]);
                  }
                }}
              />
            ) : view === 'context' ? (
              <ContextView spans={d.spans} windows={d.context_windows} selected={selectedId} onSelect={select} />
            ) : (
              <div className="panel-scroll" style={{ padding: 0 }}>
                {(explain || explaining || explainErr != null) && (
                  <div style={{ padding: '14px 16px 0' }}>
                    <ExplainCard ex={explain} loading={explaining} error={explainErr} onSpan={goSpan} />
                  </div>
                )}
                <SignalsScores signals={d.signals} scores={d.scores} annotations={d.annotations} tree={tree} activeSignal={activeSignal} onSignal={pickSignal} onSpan={goSpan} />
              </div>
            )}
          </div>
        </div>
        <div className="td-right">
          {selected && tree ? (
            <SpanDetail key={selected.span_id} span={selected} offsetMs={(selected.start_ns - tree.start) / 1e6} signals={spanSignals} scores={spanScores} onSignal={pickSignal} activeSignal={activeSignal} />
          ) : d ? (
            <Empty title="Select a span" body="Pick a span in the tree to see its messages, tool calls, input and output." />
          ) : (
            <div style={{ padding: 16 }} className="stack">
              <Skel w={200} h={18} />
              <Skel h={6} />
              <Skel h={120} />
              <Skel h={80} />
            </div>
          )}
        </div>
      </div>
      {modal === 'dataset' && <AddToDatasetModal traceId={id} onClose={() => setModal(null)} />}
      {modal === 'annotate' && <AnnotateModal traceId={id} onClose={() => setModal(null)} />}
      {modal === 'evaluate' && <RunEvaluatorModal traceId={id} onClose={() => setModal(null)} onQueued={() => setTimeout(res.reload, 4000)} />}
    </div>
  );
}
