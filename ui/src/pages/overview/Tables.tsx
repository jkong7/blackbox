import { BarCell } from '../../components/ui.tsx';
import { KindIcon } from '../../components/Kind.tsx';
import { navigate } from '../../router.tsx';
import type { Overview } from '../../api.ts';
import { fmtCompact, fmtCost, fmtMs, fmtPct } from '../../format.ts';

export function ModelsTable({ rows }: { rows: Overview['models'] }) {
  const max = Math.max(...rows.map((r) => r.cost_usd ?? 0));
  return (
    <div className="table-wrap">
      <table className="tbl compact">
        <thead>
          <tr>
            <th>Model</th>
            <th className="r">Calls</th>
            <th className="r">Avg</th>
            <th className="r">Cost</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((m) => (
            <tr key={m.model} className="click" onClick={() => navigate('/traces?model=' + encodeURIComponent(m.model))}>
              <td className="ellipsis" style={{ maxWidth: 180 }}>
                <span className="row" style={{ gap: 7 }}>
                  <KindIcon kind="llm" size={16} />
                  <span className="mono ellipsis">{m.model}</span>
                </span>
              </td>
              <td className="r num">
                {fmtCompact(m.calls)}
                {m.errors > 0 && <span className="err-text"> · {m.errors}</span>}
              </td>
              <td className="r num dim">{fmtMs(m.avg_ms)}</td>
              <td className="r num">
                <BarCell value={m.cost_usd ?? 0} max={max} color="var(--k-llm)">
                  {fmtCost(m.cost_usd)}
                </BarCell>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ToolsTable({ rows }: { rows: Overview['tools'] }) {
  const max = Math.max(...rows.map((r) => r.calls));
  return (
    <div className="table-wrap">
      <table className="tbl compact">
        <thead>
          <tr>
            <th>Tool</th>
            <th className="r">Errors</th>
            <th className="r">Avg</th>
            <th className="r">Calls</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((t) => (
            <tr key={t.tool} className="click" onClick={() => navigate('/traces?tool=' + encodeURIComponent(t.tool))}>
              <td className="ellipsis" style={{ maxWidth: 180 }}>
                <span className="row" style={{ gap: 7 }}>
                  <KindIcon kind={t.kind} size={16} />
                  <span className="mono ellipsis">{t.tool}</span>
                  {t.mcp_server && <span className="muted" style={{ fontSize: 11 }}>{t.mcp_server}</span>}
                </span>
              </td>
              <td className={'r num' + (t.errors ? ' err-text' : ' muted')}>{t.errors ? fmtPct(t.errors / t.calls, 0) : '0'}</td>
              <td className="r num dim">{fmtMs(t.avg_ms)}</td>
              <td className="r num">
                <BarCell value={t.calls} max={max} color={`var(--k-${t.kind})`}>
                  {fmtCompact(t.calls)}
                </BarCell>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function AgentsTable({ rows }: { rows: Overview['agents'] }) {
  const max = Math.max(...rows.map((r) => r.traces));
  return (
    <div className="table-wrap">
      <table className="tbl compact">
        <thead>
          <tr>
            <th>Agent</th>
            <th className="r">Cost</th>
            <th className="r">Errors</th>
            <th className="r">Traces</th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 8).map((a) => (
            <tr key={a.agent} className="click" onClick={() => navigate('/traces?agent=' + encodeURIComponent(a.agent))}>
              <td className="ellipsis" style={{ maxWidth: 180 }}>
                <span className="row" style={{ gap: 7 }}>
                  <KindIcon kind="agent" size={16} />
                  <span className="ellipsis">{a.agent}</span>
                </span>
              </td>
              <td className="r num dim">{fmtCost(a.cost_usd)}</td>
              <td className={'r num' + (a.errors ? ' err-text' : ' muted')}>{a.errors}</td>
              <td className="r num">
                <BarCell value={a.traces} max={max} color="var(--k-agent)">
                  {fmtCompact(a.traces)}
                </BarCell>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
