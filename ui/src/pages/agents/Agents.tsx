import type { AgentsResponse, MemoryResponse, ToolsResponse, Window } from '../../api.ts';
import { PageHeader } from '../../components/Layout.tsx';
import { BarCell, Card, Empty, ErrorState, Seg, SkelRows, Tabs } from '../../components/ui.tsx';
import { KindIcon, kindColor } from '../../components/Kind.tsx';
import { useApi, useLive } from '../../hooks.ts';
import { Link, navigate, setSearch, useLocation, useTitle } from '../../router.tsx';
import { agoNs, fmtAgo, fmtCompact, fmtCost, fmtMs, fmtPct, fmtTokens, humanize, oneLine, shortId } from '../../format.ts';
import './agents.css';

type Tab = 'agents' | 'tools' | 'mcp' | 'memory';

function rateTone(r: number) {
  return r >= 0.1 ? 'var(--bad)' : r >= 0.02 ? 'var(--serious)' : undefined;
}

function AgentsTab({ win }: { win: Window }) {
  const { tick } = useLive();
  const { data, error, reload } = useApi<AgentsResponse>('/api/agents', { window: win }, [tick]);
  if (error) return <Card><ErrorState error={error} what="Agents" retry={reload} /></Card>;
  const agents = data?.agents ?? [];
  const models = data?.models ?? [];
  const maxCpt = Math.max(0, ...agents.map((a) => a.cost_per_trace));
  const maxTraces = Math.max(0, ...agents.map((a) => a.traces));
  const maxCost = Math.max(0, ...models.map((m) => m.cost_usd));
  const maxCalls = Math.max(0, ...models.map((m) => m.calls));
  return (
    <>
      <Card title="Agents" sub={data ? `${agents.length}` : undefined} flush>
        {!data ? (
          <SkelRows rows={5} cols={8} />
        ) : agents.length === 0 ? (
          <Empty small title="No agents in this window" body="Agents are detected from gen_ai.agent.name, OpenInference agent spans and service names." />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th className="r">Traces</th>
                  <th className="r">Cost / trace</th>
                  <th className="r">Total cost</th>
                  <th className="r">Steps / trace</th>
                  <th className="r">LLM calls</th>
                  <th className="r">Tokens</th>
                  <th className="r">Errors</th>
                  <th className="r">Flagged</th>
                </tr>
              </thead>
              <tbody>
                {agents.map((a) => (
                  <tr key={a.agent} className="click" onClick={() => navigate('/traces?agent=' + encodeURIComponent(a.agent))}>
                    <td>
                      <span className="row">
                        <KindIcon kind="agent" />
                        <span className="cell-main">{a.agent}</span>
                      </span>
                    </td>
                    <td className="r">
                      <BarCell value={a.traces} max={maxTraces}>{fmtCompact(a.traces)}</BarCell>
                    </td>
                    <td className="r">
                      <BarCell value={a.cost_per_trace} max={maxCpt} color="var(--accent)">{fmtCost(a.cost_per_trace)}</BarCell>
                    </td>
                    <td className="r dim">{fmtCost(a.cost_usd)}</td>
                    <td className="r">{a.steps_per_trace.toFixed(1)}</td>
                    <td className="r dim">{fmtCompact(a.llm_calls)}</td>
                    <td className="r dim">{fmtTokens(a.tokens)}</td>
                    <td className="r" style={{ color: a.errors ? 'var(--bad)' : undefined }}>{a.errors}</td>
                    <td className="r">
                      {a.flagged_traces ? (
                        <Link to={`/traces?agent=${encodeURIComponent(a.agent)}&flagged=1`} className="plain" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--serious)' }}>
                          {a.flagged_traces} <span className="muted">({fmtPct(a.traces ? a.flagged_traces / a.traces : 0, 0)})</span>
                        </Link>
                      ) : (
                        <span className="muted">0</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Models" sub={data ? `${models.length}` : undefined} flush>
        {!data ? (
          <SkelRows rows={5} cols={9} />
        ) : models.length === 0 ? (
          <Empty small title="No LLM calls in this window" />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Model</th>
                  <th className="r">Calls</th>
                  <th className="r">Cost</th>
                  <th className="r">Input</th>
                  <th className="r">Output</th>
                  <th className="r">Cache read</th>
                  <th className="r">Cache hit</th>
                  <th className="r">Avg latency</th>
                  <th className="r">Avg TTFT</th>
                  <th className="r">Errors</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.model} className="click" onClick={() => navigate('/traces?model=' + encodeURIComponent(m.model))}>
                    <td>
                      <span className="row">
                        <KindIcon kind="llm" />
                        <span className="cell-main mono">{m.model}</span>
                        {m.provider && <span className="muted">{m.provider}</span>}
                      </span>
                    </td>
                    <td className="r">
                      <BarCell value={m.calls} max={maxCalls}>{fmtCompact(m.calls)}</BarCell>
                    </td>
                    <td className="r">
                      <BarCell value={m.cost_usd} max={maxCost} color="var(--accent)">{fmtCost(m.cost_usd)}</BarCell>
                    </td>
                    <td className="r dim">{fmtTokens(m.input_tokens)}</td>
                    <td className="r dim">{fmtTokens(m.output_tokens)}</td>
                    <td className="r dim">{fmtTokens(m.cache_read_tokens)}</td>
                    <td className="r">
                      <BarCell value={m.cache_hit_ratio ?? 0} max={1} color="var(--c-cache-read)">{fmtPct(m.cache_hit_ratio, 0)}</BarCell>
                    </td>
                    <td className="r">{fmtMs(m.avg_ms)}</td>
                    <td className="r dim">{fmtMs(m.avg_ttft_ms)}</td>
                    <td className="r" style={{ color: m.errors ? 'var(--bad)' : undefined }}>{m.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </>
  );
}

function ToolsTab({ win, mcpOnly }: { win: Window; mcpOnly?: boolean }) {
  const { tick } = useLive();
  const { data, error, reload } = useApi<ToolsResponse>('/api/tools', { window: win }, [tick]);
  if (error) return <Card><ErrorState error={error} what="Tools" retry={reload} /></Card>;
  const tools = (data?.tools ?? []).filter((t) => !mcpOnly || t.kind === 'mcp' || t.mcp_server);
  const maxCalls = Math.max(0, ...tools.map((t) => t.calls));
  const maxP95 = Math.max(0, ...tools.map((t) => t.p95_ms ?? 0));
  const table = (
    <Card title={mcpOnly ? 'MCP tools' : 'Tools'} sub={data ? `${tools.length}` : undefined} flush>
      {!data ? (
        <SkelRows rows={8} cols={8} />
      ) : tools.length === 0 ? (
        <Empty small title={mcpOnly ? 'No MCP tool calls' : 'No tool calls in this window'} body={mcpOnly ? 'Wrap a server with blackbox mcp -- <cmd> to record every JSON-RPC message.' : undefined} />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Tool</th>
                <th className="r">Calls</th>
                <th className="r">Traces</th>
                <th className="r">Error rate</th>
                <th className="r">p50</th>
                <th className="r">p95</th>
                <th className="r">Max</th>
                <th>Last error</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((t) => (
                <tr key={t.tool} className="click" onClick={() => navigate('/traces?tool=' + encodeURIComponent(t.tool))}>
                  <td>
                    <span className="row">
                      <KindIcon kind={t.kind} />
                      <span className="cell-main mono">{t.tool}</span>
                      {t.mcp_server && <span className="chip sq neutral">{t.mcp_server}</span>}
                      {t.memory_op && <span className="chip sq neutral">{t.memory_op}</span>}
                    </span>
                  </td>
                  <td className="r">
                    <BarCell value={t.calls} max={maxCalls} color={kindColor(t.kind)}>{fmtCompact(t.calls)}</BarCell>
                  </td>
                  <td className="r dim">{fmtCompact(t.traces)}</td>
                  <td className="r">
                    <span style={{ color: rateTone(t.error_rate) }}>{t.errors ? fmtPct(t.error_rate) : <span className="muted">0%</span>}</span>
                    {t.errors > 0 && <span className="muted"> · {t.errors}</span>}
                  </td>
                  <td className="r">{fmtMs(t.p50_ms)}</td>
                  <td className="r">
                    <BarCell value={t.p95_ms ?? 0} max={maxP95}>{fmtMs(t.p95_ms)}</BarCell>
                  </td>
                  <td className="r dim">{fmtMs(t.max_ms)}</td>
                  <td className="wrap">
                    {t.last_error ? <span className="err-text last-err" title={t.last_error}>{oneLine(t.last_error, 90)}</span> : <span className="muted">-</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
  if (!mcpOnly) return table;
  const servers = data?.servers ?? [];
  const drift = data?.drift ?? [];
  const defs = data?.definitions ?? [];
  const maxTok = Math.max(0, ...servers.map((s) => s.definition_tokens));
  return (
    <>
      <Card title="MCP servers" sub={data ? `${servers.length}` : undefined} flush>
        {!data ? (
          <SkelRows rows={3} cols={7} />
        ) : servers.length === 0 ? (
          <Empty small title="No MCP servers recorded" body="Run your server through blackbox mcp -- <cmd> to capture calls, tool definitions and their token cost." />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th>Server</th>
                  <th className="r">Calls</th>
                  <th className="r">Error rate</th>
                  <th className="r">Tools used</th>
                  <th className="r">Tools defined</th>
                  <th className="r">Definition tokens</th>
                  <th className="r">Avg latency</th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => (
                  <tr key={s.server}>
                    <td>
                      <span className="row">
                        <KindIcon kind="mcp" />
                        <span className="cell-main mono">{s.server}</span>
                      </span>
                    </td>
                    <td className="r">{fmtCompact(s.calls)}</td>
                    <td className="r">
                      <span style={{ color: rateTone(s.error_rate) }}>{fmtPct(s.error_rate)}</span>
                      {s.errors > 0 && <span className="muted"> · {s.errors}</span>}
                    </td>
                    <td className="r">{s.tools}</td>
                    <td className="r">{s.defined_tools}</td>
                    <td className="r">
                      <BarCell value={s.definition_tokens} max={maxTok} color="var(--k-mcp)">{fmtTokens(s.definition_tokens)}</BarCell>
                    </td>
                    <td className="r dim">{fmtMs(s.avg_ms)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Tool definition drift" sub={data ? (drift.length ? `${drift.length} changed` : 'none') : undefined} flush>
        {!data ? (
          <SkelRows rows={2} cols={3} />
        ) : drift.length === 0 ? (
          <Empty small title="No drift" body="Every MCP tool definition has kept the same hash since it was first seen. A changed description is how rug pull and tool poisoning attacks land." />
        ) : (
          <div className="drift-list">
            {drift.map((d) => {
              const versions = defs.filter((x) => x.server === d.server && x.name === d.name).sort((a, b) => a.first_seen - b.first_seen);
              return (
                <div key={d.server + d.name} className="drift">
                  <div className="row drift-head">
                    <span className="chip sq bad">Changed</span>
                    <span className="mono cell-main">
                      {d.server}/{d.name}
                    </span>
                    <span className="muted">{d.versions} versions</span>
                  </div>
                  <div className="drift-versions">
                    {versions.map((v, i) => (
                      <div key={v.hash} className={'drift-v' + (i === versions.length - 1 ? ' latest' : '')}>
                        <div className="row drift-v-meta">
                          <span className="mono">v{i + 1}</span>
                          <span className="mono muted">{shortId(v.hash, 16)}</span>
                          <span className="muted">first seen {fmtAgo(v.first_seen)}</span>
                          <span className="muted">last seen {fmtAgo(v.last_seen)}</span>
                          {v.tokens != null && <span className="muted">{fmtTokens(v.tokens)} tokens</span>}
                          {i === versions.length - 1 && <span className="chip sq serious">Latest</span>}
                        </div>
                        <div className="drift-desc">{v.description ?? <span className="muted">No description</span>}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>
      {table}
    </>
  );
}

function MemoryTab({ win }: { win: Window }) {
  const { tick } = useLive();
  const { data, error, reload } = useApi<MemoryResponse>('/api/memory', { window: win, limit: 100 }, [tick]);
  if (error) return <Card><ErrorState error={error} what="Memory ledger" retry={reload} /></Card>;
  const unused = (data?.sessions ?? []).filter((s) => s.writes > 0 && s.reads === 0).length;
  return (
    <>
      <div className="kpis">
        {!data
          ? Array.from({ length: 4 }).map((_, i) => (
              <div className="kpi" key={i}>
                <div className="label">&nbsp;</div>
                <div className="skel" style={{ width: '50%', height: 22 }} />
                <div className="foot">&nbsp;</div>
              </div>
            ))
          : [
              ...data.summary.map((s) => (
                <div className="kpi" key={s.op ?? 'unknown'}>
                  <div className="label">
                    <KindIcon kind="memory" size={14} />
                    {humanize(s.op ?? 'unknown')}
                  </div>
                  <div className="value num">{fmtCompact(s.n)}</div>
                  <div className="foot" style={{ color: s.errors ? 'var(--bad)' : undefined }}>{s.errors ? `${s.errors} errors` : 'no errors'}</div>
                </div>
              )),
              <div className="kpi" key="unused">
                <div className="label">Written, never read</div>
                <div className={'value num' + (unused ? ' bad' : '')}>{unused}</div>
                <div className="foot">sessions with writes and no reads</div>
              </div>,
            ]}
      </div>
      {data && data.summary.length === 0 ? (
        <Card>
          <Empty title="No memory operations" body="Memory spans come from OTel memory operations, tools named like memory, mem0, remember or recall, and MCP servers named like memory." />
        </Card>
      ) : (
        <div className="grid-2 mem-grid">
          <Card title="Per session" sub="writes vs reads" flush>
            {!data ? (
              <SkelRows rows={6} cols={4} />
            ) : (
              <div className="table-wrap mem-scroll">
                <table className="tbl compact">
                  <thead>
                    <tr>
                      <th>Session</th>
                      <th className="r">Writes</th>
                      <th className="r">Reads</th>
                      <th className="r">Deletes</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.sessions.map((s) => (
                      <tr key={s.session_id} className="click" onClick={() => navigate('/sessions/' + encodeURIComponent(s.session_id))}>
                        <td className="mono">{s.session_id}</td>
                        <td className="r">{s.writes}</td>
                        <td className="r">{s.reads}</td>
                        <td className="r dim">{s.deletes}</td>
                        <td>{s.writes > 0 && s.reads === 0 ? <span className="chip sq warn" title="Memory was written in this session but never read back">Memory unused</span> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Card title="Recent operations" sub={data ? `${data.ops.length}` : undefined} flush>
            {!data ? (
              <SkelRows rows={6} cols={4} />
            ) : (
              <div className="table-wrap mem-scroll">
                <table className="tbl compact">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Op</th>
                      <th>Tool</th>
                      <th>Content</th>
                      <th className="r">Trace</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ops.map((o) => (
                      <tr key={o.span_id} className="click" onClick={() => navigate(`/traces/${o.trace_id}?span=${o.span_id}`)}>
                        <td className="dim">{agoNs(o.start_ns)}</td>
                        <td>
                          <span className={'chip sq ' + (o.status === 'error' ? 'bad' : 'neutral')}>{o.memory_op ?? '-'}</span>
                        </td>
                        <td className="mono dim">{o.tool_name ?? o.name}</td>
                        <td className="wrap">
                          <div className="mem-content mono" title={(o.input_preview ?? '') + '\n' + (o.output_preview ?? '')}>
                            {oneLine(o.input_preview, 90)}
                            {o.output_preview && <span className="muted"> → {oneLine(o.output_preview, 70)}</span>}
                          </div>
                        </td>
                        <td className="r mono link">{shortId(o.trace_id)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

export function Agents() {
  useTitle('Agents & tools');
  const { search } = useLocation();
  const win = (search.get('window') as Window) || '7d';
  const tab = (search.get('tab') as Tab) || 'agents';
  return (
    <>
      <PageHeader
        title="Agents & tools"
        right={<Seg<Window> label="Window" value={win} options={['1h', '24h', '7d', '30d']} onChange={(v) => setSearch({ window: v === '7d' ? null : v })} />}
      />
      <div className="agents-tabs">
        <Tabs<Tab>
          value={tab}
          onChange={(v) => setSearch({ tab: v === 'agents' ? null : v })}
          tabs={[
            { id: 'agents', label: 'Agents & models' },
            { id: 'tools', label: 'Tools' },
            { id: 'mcp', label: 'MCP servers' },
            { id: 'memory', label: 'Memory ledger' },
          ]}
        />
      </div>
      <div className="page">
        {tab === 'agents' && <AgentsTab win={win} />}
        {tab === 'tools' && <ToolsTab win={win} />}
        {tab === 'mcp' && <ToolsTab win={win} mcpOnly />}
        {tab === 'memory' && <MemoryTab win={win} />}
      </div>
    </>
  );
}
