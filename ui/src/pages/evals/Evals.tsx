import { useState } from 'react';
import { PageHeader } from '../../components/Layout.tsx';
import { I } from '../../components/Icons.tsx';
import { useApi, useLive } from '../../hooks.ts';
import { useTitle, navigate } from '../../router.tsx';
import { EvaluatorsTable } from './EvaluatorsTable.tsx';
import { EvaluatorForm } from './EvaluatorForm.tsx';
import { RulesPanel } from './Rules.tsx';
import { ScoresFeed } from './ScoresFeed.tsx';
import { JudgePanel } from './JudgePanel.tsx';
import { JobsCard } from './JobsCard.tsx';
import type { EvaluatorRow } from './types.ts';
import './evals.css';

export function Evals() {
  useTitle('Evals');
  const live = useLive();
  const evaluators = useApi<{ items: EvaluatorRow[] }>('/api/evaluators', undefined, [live.tick]);
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Evals"
        right={
          <button className="btn primary sm" onClick={() => setCreating(true)} disabled={!!evaluators.error}>
            <I.plus size={12} />
            New evaluator
          </button>
        }
      />
      <div className="page">
        <JudgePanel />
        <div className="ev-layout">
          <div className="stack" style={{ gap: 16, minWidth: 0 }}>
            <EvaluatorsTable items={evaluators.data?.items} error={evaluators.error} loading={evaluators.loading} reload={evaluators.reload} onNew={() => setCreating(true)} />
            <RulesPanel evaluators={evaluators.data?.items ?? []} />
            <JobsCard />
          </div>
          <ScoresFeed />
        </div>
      </div>
      {creating && (
        <EvaluatorForm
          onClose={() => setCreating(false)}
          onSaved={(e) => {
            setCreating(false);
            evaluators.reload();
            navigate('/evals/' + e.id);
          }}
        />
      )}
    </>
  );
}
