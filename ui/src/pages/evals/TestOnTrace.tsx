import { useState } from 'react';
import { api, isMissing, type Page, type Trace } from '../../api.ts';
import { useApi } from '../../hooks.ts';
import { ScoreChip } from '../../components/Badges.tsx';
import { I } from '../../components/Icons.tsx';
import { Link } from '../../router.tsx';
import { fmtCost, oneLine, shortId } from '../../format.ts';
import { errText } from './types.ts';

interface TestScore {
  name: string;
  value: number | null;
  label: string | null;
  reasoning: string | null;
  judge_model?: string | null;
  cost_usd?: number | null;
  trace_id?: string | null;
}

export function TestOnTrace({ evaluator, disabled }: { evaluator: unknown; disabled?: boolean }) {
  const recent = useApi<Page<Trace>>('/api/traces', { limit: 30 });
  const [traceId, setTraceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TestScore | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    const id = traceId.trim() || recent.data?.items[0]?.trace_id;
    if (!id) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await api.post<{ score: TestScore }>('/api/evaluators/test', { evaluator, trace_id: id });
      setResult({ ...r.score, trace_id: r.score.trace_id ?? id });
    } catch (e) {
      setError(isMissing(e) && errText(e) === 'not found' ? 'The test endpoint is not available yet.' : errText(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="ev-test">
      <div className="row" style={{ gap: 6 }}>
        <span className="field-label">Test on a trace</span>
        <span className="muted" style={{ fontSize: 11.5 }}>
          Runs once, result is not stored
        </span>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <input className="input mono" style={{ flex: 1 }} list="ev-recent-traces" placeholder={recent.data?.items[0] ? `trace id (default: latest ${shortId(recent.data.items[0].trace_id)})` : 'trace id'} value={traceId} onChange={(e) => setTraceId(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && run()} />
        <datalist id="ev-recent-traces">
          {recent.data?.items.map((t) => (
            <option key={t.trace_id} value={t.trace_id}>
              {oneLine(t.input_preview || t.name, 70)}
            </option>
          ))}
        </datalist>
        <button className="btn" onClick={run} disabled={busy || disabled}>
          <I.play size={12} />
          {busy ? 'Running' : 'Run test'}
        </button>
      </div>
      {error && <div className="err-text" style={{ fontSize: 12 }}>{error}</div>}
      {busy && <div className="skel" style={{ height: 52 }} />}
      {result && (
        <div className="ev-test-result">
          <div className="row" style={{ gap: 8 }}>
            <ScoreChip s={{ name: result.name, value: result.value, label: result.label }} />
            {result.trace_id && (
              <Link to={'/traces/' + result.trace_id} className="mono link" style={{ fontSize: 11.5 }}>
                {shortId(result.trace_id, 12)}
              </Link>
            )}
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
              {result.judge_model ?? 'code check'}
              {result.cost_usd ? ` · ${fmtCost(result.cost_usd)}` : ''}
            </span>
          </div>
          {result.reasoning && <div className="prose dim" style={{ fontSize: 12.5 }}>{result.reasoning}</div>}
        </div>
      )}
    </div>
  );
}
