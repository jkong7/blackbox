import { HistogramChart } from '../../components/Charts.tsx';
import { Empty } from '../../components/ui.tsx';
import type { EvaluatorRow, ScoreRow } from './types.ts';

export function bins(ev: EvaluatorRow, scores: ScoreRow[]): { label: string; value: number }[] {
  const out = ev.config.output;
  if (ev.type === 'llm_judge' && out === 'label') {
    const m = new Map<string, number>();
    for (const l of ev.config.labels ?? []) m.set(l, 0);
    for (const s of scores) {
      const k = s.label ?? 'none';
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return [...m.entries()].map(([label, value]) => ({ label, value }));
  }
  const numeric = scores.filter((s) => s.value != null);
  const distinct = new Set(numeric.map((s) => s.value));
  if (out === 'score' || [...distinct].some((v) => v !== 0 && v !== 1)) {
    const b = Array.from({ length: 10 }, (_, i) => ({ label: (i / 10).toFixed(1), value: 0 }));
    for (const s of numeric) b[Math.min(9, Math.floor((s.value as number) * 10))].value++;
    return b;
  }
  const pass = numeric.filter((s) => (s.value as number) >= 0.5).length;
  const res = [
    { label: 'pass', value: pass },
    { label: 'fail', value: numeric.length - pass },
  ];
  const skipped = scores.length - numeric.length;
  if (skipped) res.push({ label: 'skipped', value: skipped });
  return res;
}

export function DistributionCard({ ev, scores }: { ev: EvaluatorRow; scores: ScoreRow[] | undefined }) {
  const data = scores ? bins(ev, scores) : [];
  return (
    <section className="card">
      <div className="card-head">
        <h2>Score distribution</h2>
        {scores && <span className="sub">{scores.length} latest scores</span>}
      </div>
      <div className="card-body">
        {!scores ? (
          <div className="skel" style={{ height: 140 }} />
        ) : !scores.length ? (
          <Empty small title="No scores yet" body="Run this evaluator on a few traces or attach it to an online rule." />
        ) : (
          <HistogramChart bins={data} height={140} format={(v) => `${v} ${v === 1 ? 'score' : 'scores'}`} />
        )}
      </div>
    </section>
  );
}
