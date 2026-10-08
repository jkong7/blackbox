import { useApi, useLive } from '../../hooks.ts';
import { Kpi } from '../../components/ui.tsx';
import { fmtCost, fmtInt } from '../../format.ts';
import { isMissing } from '../../api.ts';
import type { JobCounts, JobRow, JudgeStatusRow } from './types.ts';

const PROVIDER: Record<string, string> = { anthropic: 'Anthropic API', 'claude-cli': 'Claude CLI', mock: 'Mock judge', none: 'Not configured' };

export function JudgePanel() {
  const live = useLive();
  const judge = useApi<JudgeStatusRow>('/api/judge/status', undefined, [live.tick]);
  const jobs = useApi<{ items: JobRow[]; counts: JobCounts }>('/api/jobs', { limit: 1 }, [live.tick]);
  const missing = isMissing(judge.error) && isMissing(jobs.error);
  if (missing) {
    return (
      <div className="banner">
        <span className="sev low" />
        The evals engine is not running on this server yet. Evaluators, rules and scores will appear here once it is.
      </div>
    );
  }
  const j = judge.data;
  const c = jobs.data?.counts;
  const cap = j?.daily_cap_usd ?? null;
  const pct = j && cap ? Math.min(1, j.spend_today_usd / cap) : 0;
  const tone = pct >= 0.9 ? 'var(--bad)' : pct >= 0.7 ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="kpis">
      <Kpi
        label="Judge"
        loading={!j && !judge.error}
        value={<span style={{ fontSize: 15 }}>{j ? (PROVIDER[j.provider] ?? j.provider) : '-'}</span>}
        foot={j ? <span className={j.provider === 'none' ? 'err-text' : 'mono'}>{j.provider === 'none' ? 'Set ANTHROPIC_API_KEY or install claude' : (j.model ?? 'default model')}</span> : 'Unavailable'}
      />
      <Kpi
        label="Judge spend today"
        loading={!j && !judge.error}
        value={j ? fmtCost(j.spend_today_usd) : '-'}
        foot={
          j && cap ? (
            <div className="stack" style={{ gap: 4 }}>
              <div className="progress" title={`${Math.round(pct * 100)}% of the daily cap`}>
                <i style={{ width: `${pct * 100}%`, background: tone }} />
              </div>
              <span>of {fmtCost(cap)} daily cap</span>
            </div>
          ) : (
            'No daily cap'
          )
        }
      />
      <Kpi label="Jobs queued" loading={!c && !jobs.error} value={c ? fmtInt(c.queued) : '-'} foot={c ? `${fmtInt(c.running)} running` : ' '} />
      <Kpi label="Jobs done" loading={!c && !jobs.error} value={c ? fmtInt(c.done) : '-'} foot={c && c.skipped ? `${fmtInt(c.skipped)} skipped` : ' '} />
      <Kpi label="Jobs failed" loading={!c && !jobs.error} tone={c && c.failed > 0 ? 'bad' : undefined} value={c ? fmtInt(c.failed) : '-'} foot={c && c.failed > 0 ? 'See the jobs list for errors' : 'No failures'} />
    </div>
  );
}
