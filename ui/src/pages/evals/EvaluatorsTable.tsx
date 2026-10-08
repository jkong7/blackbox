import { useState } from 'react';
import { Empty, ErrorState, Seg, SkelRows } from '../../components/ui.tsx';
import { I } from '../../components/Icons.tsx';
import { Link, navigate } from '../../router.tsx';
import { fmtAgo, fmtInt, fmtPct, oneLine } from '../../format.ts';
import type { EvaluatorRow } from './types.ts';

type Show = 'all' | 'llm_judge' | 'code' | 'custom';

export function TypeChip({ e }: { e: EvaluatorRow }) {
  return (
    <span className={'chip sq ' + (e.type === 'llm_judge' ? 'accent' : 'neutral')}>
      {e.type === 'llm_judge' ? <I.sparkle size={11} /> : <I.terminal size={11} />}
      {e.type === 'llm_judge' ? 'LLM judge' : 'Code'}
    </span>
  );
}

export function PassRate({ rate, runs }: { rate: number | null | undefined; runs: number }) {
  if (rate == null || !runs) return <span className="muted">-</span>;
  const tone = rate >= 0.8 ? 'var(--good)' : rate >= 0.5 ? 'var(--warn)' : 'var(--bad)';
  return (
    <div className="bar-cell">
      <span className="num">{fmtPct(rate, 0)}</span>
      <span className="bar">
        <i style={{ width: `${Math.max(2, rate * 100)}%`, background: tone }} />
      </span>
    </div>
  );
}

export function EvaluatorsTable({ items, error, loading, reload, onNew }: { items: EvaluatorRow[] | undefined; error: unknown; loading: boolean; reload: () => void; onNew: () => void }) {
  const [show, setShow] = useState<Show>('all');
  const list = (items ?? []).filter((e) => (show === 'all' ? true : show === 'custom' ? !e.builtin : e.type === show));
  let body;
  if (error) body = <ErrorState error={error} what="Evaluators" retry={reload} />;
  else if (!items && loading) body = <SkelRows rows={8} cols={6} />;
  else if (!list.length)
    body = (
      <Empty
        small
        title={show === 'custom' ? 'No custom evaluators yet' : 'No evaluators'}
        body="Write one binary judge per failure mode you have seen in real traces, or a code check for anything deterministic."
        actions={
          <button className="btn sm" onClick={onNew}>
            New evaluator
          </button>
        }
      />
    );
  else
    body = (
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th>Evaluator</th>
              <th>Type</th>
              <th>Target</th>
              <th className="r">Runs</th>
              <th className="r">Pass rate</th>
              <th className="r">Last run</th>
            </tr>
          </thead>
          <tbody>
            {list.map((e) => (
              <tr key={e.id} className="click" onClick={() => navigate('/evals/' + e.id)}>
                <td className="wrap" style={{ maxWidth: 0, width: '100%', minWidth: 220 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <Link to={'/evals/' + e.id} className="cell-main mono" onClick={(ev) => ev.stopPropagation()}>
                      {e.name}
                    </Link>
                    {e.builtin ? <span className="chip sq neutral" style={{ height: 18 }}>Built-in</span> : null}
                  </div>
                  {e.description && <div className="muted ellipsis" style={{ fontSize: 12 }}>{oneLine(e.description, 140)}</div>}
                </td>
                <td>
                  <TypeChip e={e} />
                </td>
                <td className="dim">{e.target}</td>
                <td className="r num">{fmtInt(e.stats?.runs ?? 0)}</td>
                <td className="r">
                  <PassRate rate={e.stats?.pass_rate} runs={e.stats?.runs ?? 0} />
                </td>
                <td className="r muted">{e.stats?.last_run ? fmtAgo(e.stats.last_run) : 'Never'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  return (
    <section className="card">
      <div className="card-head">
        <h2>Evaluators</h2>
        {items && <span className="sub">{items.length} total</span>}
        <div className="right">
          <Seg<Show> value={show} onChange={setShow} options={[{ value: 'all', label: 'All' }, { value: 'llm_judge', label: 'Judges' }, { value: 'code', label: 'Code' }, { value: 'custom', label: 'Custom' }]} />
        </div>
      </div>
      <div className="card-body flush">{body}</div>
    </section>
  );
}
