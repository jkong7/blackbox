import type { Calibration } from '../../api.ts';
import { useApi, useLive } from '../../hooks.ts';
import { Empty, ErrorState, Skel } from '../../components/ui.tsx';
import { Link } from '../../router.tsx';
import { fmtPct, oneLine, shortId } from '../../format.ts';

function kappaWord(k: number | null): { text: string; tone: string } {
  if (k == null) return { text: 'Not enough data', tone: 'neutral' };
  if (k >= 0.8) return { text: 'Near perfect agreement', tone: 'good' };
  if (k >= 0.6) return { text: 'Substantial agreement', tone: 'good' };
  if (k >= 0.4) return { text: 'Moderate agreement', tone: 'mid' };
  if (k >= 0.2) return { text: 'Fair agreement, do not trust yet', tone: 'serious' };
  return { text: 'Poor agreement, do not trust', tone: 'bad' };
}

function Metric({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="ev-metric" title={hint}>
      <div className="muted">{label}</div>
      <div className="num ev-metric-v">{value}</div>
    </div>
  );
}

export function CalibrationCard({ evaluatorId }: { evaluatorId: string }) {
  const live = useLive();
  const cal = useApi<Calibration>(`/api/evaluators/${evaluatorId}/calibration`, undefined, [live.tick]);
  const head = (
    <div className="card-head">
      <h2>Calibration</h2>
      <span className="sub">Judge verdicts vs human labels on the same traces</span>
    </div>
  );
  let body;
  if (cal.error) body = <ErrorState error={cal.error} what="Calibration" retry={cal.reload} />;
  else if (!cal.data)
    body = (
      <div className="card-body stack">
        <Skel h={120} />
        <Skel h={40} />
      </div>
    );
  else if (!cal.data.n)
    body = (
      <Empty
        small
        title="No overlap with human labels yet"
        body="Label traces this evaluator has scored in an annotation queue. Agreement, TPR, TNR and kappa appear once both a judge verdict and a human label exist for the same trace."
        actions={
          <Link to="/annotate" className="btn sm">
            Open annotation queues
          </Link>
        }
      />
    );
  else {
    const c = cal.data;
    const kw = kappaWord(c.kappa);
    const cell = (n: number, agree: boolean, label: string) => (
      <td className={'ev-cm-cell ' + (agree ? 'agree' : 'disagree')} title={label}>
        <div className="num ev-cm-n">{n}</div>
        <div className="muted ev-cm-l">{label}</div>
      </td>
    );
    body = (
      <div className="card-body stack" style={{ gap: 14 }}>
        <div className="ev-cal-top">
          <table className="ev-cm">
            <thead>
              <tr>
                <th />
                <th>Human pass</th>
                <th>Human fail</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Judge pass</th>
                {cell(c.tp, true, 'True pass')}
                {cell(c.fp, false, 'False pass')}
              </tr>
              <tr>
                <th>Judge fail</th>
                {cell(c.fn, false, 'False fail')}
                {cell(c.tn, true, 'True fail')}
              </tr>
            </tbody>
          </table>
          <div className="stack" style={{ gap: 10, flex: 1, minWidth: 200 }}>
            <div>
              <div className="row" style={{ gap: 8 }}>
                <span className="ev-kappa num">{c.kappa == null ? '-' : c.kappa.toFixed(2)}</span>
                <span className="muted">Cohen's kappa</span>
              </div>
              <span className={'chip ' + kw.tone} style={{ marginTop: 4 }}>{kw.text}</span>
            </div>
            <div className="ev-metrics">
              <Metric label="TPR" value={fmtPct(c.tpr, 0)} hint="Of runs humans passed, the share the judge also passed" />
              <Metric label="TNR" value={fmtPct(c.tnr, 0)} hint="Of runs humans failed, the share the judge also failed" />
              <Metric label="Precision" value={fmtPct(c.precision, 0)} hint="Of runs the judge passed, the share humans passed" />
              <Metric label="Accuracy" value={fmtPct(c.accuracy, 0)} hint="Share of runs where judge and human agree" />
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              {c.n} labeled {c.n === 1 ? 'trace' : 'traces'}
              {c.n < 30 ? '. Aim for 30 or more before trusting these numbers.' : ''}
            </div>
          </div>
        </div>
        <div>
          <div className="section-title" style={{ marginBottom: 6 }}>
            Disagreements <span className="muted num">{c.disagreements.length}</span>
          </div>
          {!c.disagreements.length ? (
            <div className="muted">Judge and humans agree on every labeled trace.</div>
          ) : (
            <div className="ev-disagree">
              {c.disagreements.slice(0, 50).map((d) => (
                <Link key={d.trace_id} to={'/traces/' + d.trace_id} className="ev-disagree-row">
                  <span className="mono link">{shortId(d.trace_id)}</span>
                  <span className="chip">
                    Judge <b>{d.judge_label ?? '-'}</b>
                  </span>
                  <span className="chip">
                    Human <b>{d.human_label ?? '-'}</b>
                  </span>
                  <span className="dim ellipsis" style={{ flex: 1, minWidth: 0 }}>{d.reasoning ? oneLine(d.reasoning, 200) : ''}</span>
                </Link>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }
  return (
    <section className="card">
      {head}
      {body}
    </section>
  );
}
