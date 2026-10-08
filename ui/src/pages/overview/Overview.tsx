import { useMemo } from 'react';
import { PageHeader, LiveIndicator } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, Seg, SkelRows } from '../../components/ui.tsx';
import { FirstRun } from '../../components/FirstRun.tsx';
import { ColumnChart, AreaChart, fillBuckets } from '../../components/Charts.tsx';
import { useApi, useHealth, useLive } from '../../hooks.ts';
import { Link, setSearch, useLocation, useTitle } from '../../router.tsx';
import type { Facets, Overview as OverviewData, SeriesPoint, Window } from '../../api.ts';
import { fmtCompact, fmtCost } from '../../format.ts';
import { KpiRow } from './KpiRow.tsx';
import { ModelsTable, ToolsTable, AgentsTable } from './Tables.tsx';
import { IssuesList, ScoresSummary } from './Lists.tsx';

const WINDOWS: Window[] = ['1h', '24h', '7d', '30d'];
const WINDOW_MS: Record<Window, number> = { '1h': 3600e3, '24h': 86400e3, '7d': 7 * 86400e3, '30d': 30 * 86400e3 };

export function Overview() {
  useTitle('Overview');
  const { search } = useLocation();
  const win = (WINDOWS.includes(search.get('window') as Window) ? search.get('window') : '7d') as Window;
  const project = search.get('project') ?? '';
  const live = useLive();
  const { health } = useHealth();
  const facets = useApi<Facets>('/api/facets');
  const ov = useApi<OverviewData>('/api/overview', { window: win, project }, [live.tick]);
  const openIssues = useApi<{ items: { fingerprint: string }[] }>('/api/issues', { status: 'open', window: win, project }, [live.tick]);
  const d = ov.data;

  const series = useMemo(() => {
    if (!d) return [];
    const end = Date.now();
    const filled = fillBuckets<SeriesPoint>(d.series, end - WINDOW_MS[win], end, d.bucket_ms, (b) => ({ bucket: b, traces: 0, cost_usd: 0, errors: 0, tokens: 0, llm_calls: 0, signals: 0 }));
    return filled.map((p) => ({ ...p, ok: Math.max(0, p.traces - p.errors) }));
  }, [d, win]);

  const empty = health && health.spans === 0;
  const projects = facets.data?.projects ?? [];

  const right = (
    <div className="row" style={{ gap: 10 }}>
      <LiveIndicator />
      {projects.length > 1 && (
        <select className="select" value={project} onChange={(e) => setSearch({ project: e.target.value || null })} aria-label="Project">
          <option value="">All projects</option>
          {projects.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      )}
      <Seg value={win} options={WINDOWS} onChange={(w) => setSearch({ window: w === '7d' ? null : w })} label="Time window" />
    </div>
  );

  return (
    <>
      <PageHeader title="Overview" right={right} />
      <div className="page" style={{ opacity: ov.loading && d ? 0.7 : 1, transition: 'opacity .15s' }}>
        {empty ? (
          <FirstRun />
        ) : ov.error && !d ? (
          <Card>
            <ErrorState error={ov.error} retry={ov.reload} />
          </Card>
        ) : (
          <>
            <KpiRow t={d?.totals} openIssues={openIssues.data?.items.length} win={win} />
            <div className="grid-2">
              <Card
                title="Traces"
                sub={d ? `${fmtCompact(d.totals.traces)} in ${win}` : undefined}
                right={
                  <div className="legend">
                    <span>
                      <i style={{ background: 'var(--series-1)' }} />
                      Clean or flagged
                    </span>
                    <span>
                      <i style={{ background: 'var(--bad)' }} />
                      With errors
                    </span>
                  </div>
                }
              >
                {d ? (
                  <ColumnChart
                    data={series}
                    bucketMs={d.bucket_ms}
                    series={[
                      { key: 'ok', label: 'Without errors', color: 'var(--series-1)' },
                      { key: 'errors', label: 'With errors', color: 'var(--bad)' },
                    ]}
                    format={(v) => fmtCompact(v)}
                  />
                ) : (
                  <div className="skel" style={{ height: 160 }} />
                )}
              </Card>
              <Card title="Cost" sub={d ? `${fmtCost(d.totals.cost_usd)} in ${win}` : undefined}>
                {d ? <AreaChart data={series} k="cost_usd" label="Cost" color="var(--series-1)" bucketMs={d.bucket_ms} format={(v) => fmtCost(v)} /> : <div className="skel" style={{ height: 160 }} />}
              </Card>
            </div>
            <div className="grid-2">
              <Card title="Open issues" right={<Link className="link" to="/issues">View all</Link>} flush>
                {d ? <IssuesList issues={d.issues} /> : <SkelRows rows={5} cols={3} />}
              </Card>
              <Card title="Recent scores" sub={win} flush>
                {d ? <ScoresSummary scores={d.scores} /> : <SkelRows rows={5} cols={3} />}
              </Card>
            </div>
            <div className="grid-3">
              <Card title="Top models" flush>
                {d ? d.models.length ? <ModelsTable rows={d.models} /> : <Empty small title="No LLM calls" body="Model usage appears once LLM spans arrive." /> : <SkelRows rows={5} cols={3} />}
              </Card>
              <Card title="Top tools" flush>
                {d ? d.tools.length ? <ToolsTable rows={d.tools} /> : <Empty small title="No tool calls" body="Tool, MCP and memory calls appear here." /> : <SkelRows rows={5} cols={3} />}
              </Card>
              <Card title="Agents" flush>
                {d ? d.agents.length ? <AgentsTable rows={d.agents} /> : <Empty small title="No agents" body="Spans with an agent name group here." /> : <SkelRows rows={5} cols={3} />}
              </Card>
            </div>
          </>
        )}
      </div>
    </>
  );
}
