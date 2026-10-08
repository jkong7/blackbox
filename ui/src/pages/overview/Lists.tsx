import { Empty } from '../../components/ui.tsx';
import { navigate } from '../../router.tsx';
import type { Issue, Overview } from '../../api.ts';
import { fmtAgo, fmtCompact, fmtPct, humanize } from '../../format.ts';

export function IssuesList({ issues }: { issues: Issue[] }) {
  const open = issues.filter((i) => i.status === 'open');
  if (!open.length) return <Empty small title="No open issues" body="Signals like tool loops, runaway cost and hallucinated success group into issues here." />;
  return (
    <div className="table-wrap">
      <table className="tbl compact">
        <tbody>
          {open.slice(0, 8).map((i) => (
            <tr key={i.fingerprint} className="click" onClick={() => navigate('/traces?signal=' + encodeURIComponent(i.fingerprint))}>
              <td style={{ width: 16, paddingRight: 0 }}>
                <span className={'sev ' + i.severity} title={i.severity} />
              </td>
              <td className="ellipsis" style={{ maxWidth: 0, width: '100%' }}>
                <div className="ellipsis cell-main">{i.title}</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {humanize(i.type)}
                </div>
              </td>
              <td className="r num">
                <div>{fmtCompact(i.traces)} traces</div>
                <div className="muted" style={{ fontSize: 11.5 }}>
                  {fmtAgo(i.last_seen)}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ScoresSummary({ scores }: { scores: Overview['scores'] }) {
  if (!scores.length)
    return (
      <Empty
        small
        title="No scores yet"
        body={
          <>
            Scores arrive from evaluators, online rules, annotations and the SDK. Set up a judge in{' '}
            <a className="link" href="/evals" onClick={(e) => (e.preventDefault(), navigate('/evals'))}>
              Evals
            </a>
            .
          </>
        }
      />
    );
  return (
    <div className="table-wrap">
      <table className="tbl compact">
        <thead>
          <tr>
            <th>Score</th>
            <th className="r">Runs</th>
            <th className="r">Avg</th>
            <th style={{ width: '40%' }}>Pass rate</th>
          </tr>
        </thead>
        <tbody>
          {scores.map((s) => {
            const rate = s.n ? s.passes / s.n : 0;
            return (
              <tr key={s.name} className="click" onClick={() => navigate('/traces?score=' + encodeURIComponent(s.name + ':fail'))} title="Show failing traces">
                <td className="cell-main mono ellipsis" style={{ maxWidth: 180 }}>
                  {s.name}
                </td>
                <td className="r num dim">{fmtCompact(s.n)}</td>
                <td className="r num dim">{s.avg == null ? '-' : s.avg.toFixed(2)}</td>
                <td>
                  <div className="row" style={{ gap: 8 }}>
                    <div className="progress" style={{ flex: 1 }}>
                      <i style={{ width: `${rate * 100}%`, background: rate >= 0.8 ? 'var(--good)' : rate >= 0.5 ? 'var(--warn)' : 'var(--bad)' }} />
                    </div>
                    <span className="num" style={{ minWidth: 40, textAlign: 'right' }}>
                      {fmtPct(rate, 0)}
                    </span>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
