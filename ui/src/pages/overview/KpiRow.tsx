import { Kpi } from '../../components/ui.tsx';
import type { OverviewTotals } from '../../api.ts';
import { fmtCompact, fmtCost, fmtMs, fmtPct } from '../../format.ts';

export function KpiRow({ t, openIssues, win }: { t: OverviewTotals | undefined; openIssues: number | undefined; win: string }) {
  const loading = !t;
  const tokens = t ? t.input_tokens + t.output_tokens + t.cache_read_tokens + t.cache_write_tokens : 0;
  return (
    <div className="kpis kpis-8">
      <Kpi loading={loading} label="Traces" value={fmtCompact(t?.traces)} foot={t && `${fmtCompact(t.sessions)} sessions · ${fmtCompact(t.spans)} spans`} to={`/traces?window=${win}`} />
      <Kpi loading={loading} label="Cost" value={fmtCost(t?.cost_usd)} foot={t && `${fmtCompact(t.llm_calls)} LLM calls`} />
      <Kpi loading={loading} label="Cost per clean trace" value={fmtCost(t?.cost_per_clean_trace)} foot={t && `${fmtCompact(t.clean_traces)} clean of ${fmtCompact(t.traces)}`} />
      <Kpi loading={loading} label="Error rate" value={fmtPct(t?.error_rate)} tone={t && t.error_rate > 0.05 ? 'bad' : undefined} foot={t && `${fmtCompact(t.error_traces)} traces with errors`} to="/traces?status=error" />
      <Kpi loading={loading} label="Latency p50 / p95" value={t ? `${fmtMs(t.p50_ms)} / ${fmtMs(t.p95_ms)}` : ''} foot={t && `LLM ${fmtMs(t.llm_p50_ms)} / ${fmtMs(t.llm_p95_ms)}`} />
      <Kpi loading={loading} label="Cache hit ratio" value={fmtPct(t?.cache_hit_ratio)} foot={t && `${fmtCompact(t.cache_read_tokens)} read · ${fmtCompact(t.cache_write_tokens)} written`} />
      <Kpi loading={loading} label="Tokens" value={fmtCompact(tokens)} foot={t && `${fmtCompact(t.input_tokens)} in · ${fmtCompact(t.output_tokens)} out`} />
      <Kpi loading={loading} label="Open issues" value={openIssues == null ? '-' : String(openIssues)} tone={openIssues ? 'bad' : undefined} foot="grouped by fingerprint" to="/issues" />
    </div>
  );
}
