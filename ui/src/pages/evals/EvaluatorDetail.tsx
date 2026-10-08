import { useState } from 'react';
import { PageHeader } from '../../components/Layout.tsx';
import { I } from '../../components/Icons.tsx';
import { Empty, ErrorState, Kpi, Skel } from '../../components/ui.tsx';
import { useToast } from '../../components/Toast.tsx';
import { api } from '../../api.ts';
import { useApi, useLive } from '../../hooks.ts';
import { Link, navigate, useTitle } from '../../router.tsx';
import { fmtAgo, fmtInt, fmtPct, humanize } from '../../format.ts';
import { EvaluatorForm } from './EvaluatorForm.tsx';
import { RuleForm } from './Rules.tsx';
import { RunModal } from './RunModal.tsx';
import { TestOnTrace } from './TestOnTrace.tsx';
import { ScoresFeed } from './ScoresFeed.tsx';
import { CalibrationCard } from './Calibration.tsx';
import { DistributionCard } from './Distribution.tsx';
import { TypeChip } from './EvaluatorsTable.tsx';
import { CHECKS, VARIABLES, errText, type EvaluatorRow, type ScoreRow } from './types.ts';
import './evals.css';

function Highlighted({ text }: { text: string }) {
  const parts = text.split(/(\{\{\w+\}\})/g);
  return (
    <pre className="json ev-prompt-view">
      {parts.map((p, i) => (/^\{\{\w+\}\}$/.test(p) ? <span key={i} className="ev-var">{p}</span> : p))}
    </pre>
  );
}

function ConfigCard({ ev }: { ev: EvaluatorRow }) {
  const c = ev.config;
  return (
    <section className="card">
      <div className="card-head">
        <h2>{ev.type === 'llm_judge' ? 'Rubric' : 'Check'}</h2>
        <span className="sub">
          {ev.type === 'llm_judge' ? `${c.output === 'score' ? 'Score 0 to 1' : c.output === 'label' ? 'Labels' : 'Pass / fail'}${c.model ? ' · ' + c.model : ''}` : CHECKS.find((x) => x.id === c.check)?.label}
        </span>
      </div>
      <div className="card-body stack" style={{ gap: 12 }}>
        {ev.type === 'llm_judge' ? (
          <>
            {c.prompt ? (
              <div className="code-block" style={{ maxHeight: 360 }}>
                <Highlighted text={c.prompt} />
              </div>
            ) : (
              <div className="banner">
                <I.sparkle size={13} />
                <span>
                  Uses the built-in <span className="mono">{c.template}</span> rubric. Duplicate it to see and edit a copy of the prompt.
                </span>
              </div>
            )}
            {c.labels?.length ? (
              <div className="chips">
                <span className="muted" style={{ marginRight: 4 }}>Labels</span>
                {c.labels.map((l) => (
                  <span key={l} className={'chip sq ' + (c.pass_labels?.includes(l) ? 'good' : 'neutral')}>{l}</span>
                ))}
              </div>
            ) : null}
            {c.prompt && (
              <div className="chips">
                <span className="muted" style={{ marginRight: 4 }}>Variables</span>
                {VARIABLES.filter((v) => c.prompt!.includes(`{{${v.name}}}`)).map((v) => (
                  <span key={v.name} className="chip mono" title={v.hint}>{`{{${v.name}}}`}</span>
                ))}
              </div>
            )}
          </>
        ) : (
          <div className="kv">
            <div>check</div>
            <div>{c.check}</div>
            {Object.entries(c.params ?? {}).map(([k, v]) => (
              <div key={k} style={{ display: 'contents' }}>
                <div>{k}</div>
                <div>{Array.isArray(v) ? v.join(', ') : String(v)}</div>
              </div>
            ))}
            {!Object.keys(c.params ?? {}).length && (
              <>
                <div>params</div>
                <div className="muted">none</div>
              </>
            )}
          </div>
        )}
        <hr className="sep" />
        <TestOnTrace evaluator={ev.id} />
      </div>
    </section>
  );
}

export function EvaluatorDetail({ id }: { id: string }) {
  const live = useLive();
  const toast = useToast();
  const list = useApi<{ items: EvaluatorRow[] }>('/api/evaluators', undefined, [live.tick]);
  const scores = useApi<{ items: ScoreRow[] }>('/api/scores', { evaluator_id: id, limit: 1000 }, [live.tick]);
  const [editing, setEditing] = useState(false);
  const [running, setRunning] = useState(false);
  const [ruling, setRuling] = useState(false);
  const [confirmDel, setConfirmDel] = useState(false);
  const ev = list.data?.items.find((e) => e.id === id);
  useTitle(ev?.name ?? 'Evaluator');

  const del = async () => {
    try {
      await api.del(`/api/evaluators/${id}`);
      toast('Evaluator deleted');
      navigate('/evals');
    } catch (e) {
      toast(errText(e), 'bad');
    }
  };

  const crumbs = [{ to: '/evals', label: 'Evals' }];
  if (list.error) {
    return (
      <>
        <PageHeader title="Evaluator" crumbs={crumbs} />
        <div className="page">
          <div className="card">
            <ErrorState error={list.error} what="Evaluators" retry={list.reload} />
          </div>
        </div>
      </>
    );
  }
  if (!list.data) {
    return (
      <>
        <PageHeader title="Evaluator" crumbs={crumbs} />
        <div className="page">
          <Skel h={78} />
          <div className="ev-layout">
            <Skel h={320} />
            <Skel h={320} />
          </div>
        </div>
      </>
    );
  }
  if (!ev) {
    return (
      <>
        <PageHeader title="Evaluator" crumbs={crumbs} />
        <div className="page">
          <div className="card">
            <Empty title="Evaluator not found" body="It may have been deleted." actions={<Link to="/evals" className="btn sm">Back to evals</Link>} />
          </div>
        </div>
      </>
    );
  }

  const st = ev.stats;
  const sc = scores.data?.items;
  const avg = st?.avg;
  return (
    <>
      <PageHeader
        title={<span className="mono">{ev.name}</span>}
        crumbs={crumbs}
        right={
          <div className="row" style={{ gap: 6 }}>
            <button className="btn sm" onClick={() => setRunning(true)}>
              <I.play size={12} />
              Run on traces
            </button>
            <button className="btn sm" onClick={() => setRuling(true)}>
              <I.refresh size={12} />
              Add online rule
            </button>
            <button className="btn sm" onClick={() => setEditing(true)}>
              {ev.builtin ? <I.copy size={12} /> : <I.edit size={12} />}
              {ev.builtin ? 'Duplicate' : 'Edit'}
            </button>
            {!ev.builtin &&
              (confirmDel ? (
                <>
                  <button className="btn sm danger" onClick={del}>
                    Delete evaluator
                  </button>
                  <button className="btn sm ghost" onClick={() => setConfirmDel(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button className="btn sm ghost icon" onClick={() => setConfirmDel(true)} title="Delete" aria-label="Delete evaluator">
                  <I.trash size={12} />
                </button>
              ))}
          </div>
        }
      />
      <div className="page">
        <div className="row wrap" style={{ gap: 8 }}>
          <TypeChip e={ev} />
          <span className="chip sq neutral">Target: {humanize(ev.target)}</span>
          {ev.builtin ? <span className="chip sq neutral">Built-in</span> : null}
          {ev.description && <span className="dim">{ev.description}</span>}
        </div>
        <div className="kpis">
          <Kpi label="Runs" value={fmtInt(st?.runs ?? 0)} foot={st?.last_run ? `Last ${fmtAgo(st.last_run)}` : 'Never run'} />
          <Kpi label="Pass rate" value={st?.pass_rate == null ? '-' : fmtPct(st.pass_rate, 0)} tone={st?.pass_rate != null && st.pass_rate < 0.5 ? 'bad' : undefined} foot="Share of scores at or above 0.5" />
          <Kpi label="Average score" value={avg == null ? '-' : avg.toFixed(2)} foot="0 to 1" />
          <Kpi label="Failing traces" value={sc ? fmtInt(sc.filter((s) => s.value != null && s.value < 0.5).length) : '-'} loading={!sc && !scores.error} to={`/traces?score=${encodeURIComponent(ev.name)}:fail`} foot="Open in traces" />
        </div>
        <div className="ev-layout">
          <div className="stack" style={{ gap: 16, minWidth: 0 }}>
            <DistributionCard ev={ev} scores={sc} />
            <CalibrationCard evaluatorId={ev.id} />
            <ScoresFeed params={{ evaluator_id: ev.id }} title="Recent scores" limit={25} />
          </div>
          <ConfigCard ev={ev} />
        </div>
      </div>
      {editing && (
        <EvaluatorForm
          initial={ev}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setEditing(false);
            list.reload();
            if (saved.id !== ev.id) navigate('/evals/' + saved.id);
          }}
        />
      )}
      {running && <RunModal ev={ev} onClose={() => setRunning(false)} />}
      {ruling && (
        <RuleForm
          evaluators={list.data.items}
          presetEvaluator={ev.id}
          onClose={() => setRuling(false)}
          onSaved={() => setRuling(false)}
        />
      )}
    </>
  );
}
