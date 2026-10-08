import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Annotation, type TraceDetail } from '../../api.ts';
import { useApi } from '../../hooks.ts';
import { Empty, ErrorState, Skel } from '../../components/ui.tsx';
import { ScoreChip, SignalChip, TraceStatus } from '../../components/Badges.tsx';
import { useToast } from '../../components/Toast.tsx';
import { Link, navigate } from '../../router.tsx';
import { agoNs, fmtCost, fmtMs, fmtTokens, shortId } from '../../format.ts';
import { Trajectory } from './Trajectory.tsx';
import { finalOutput, trajectory, userInput } from './extract.ts';
import type { QueueRow } from './QueuePicker.tsx';

type Item = Annotation & { input_preview?: string | null; name?: string | null };

const MODES = ['hallucinated success', 'ignored user constraint', 'wrong tool', 'tool loop', 'gave up early', 'missing verification', 'wrong answer', 'unsafe action', 'forgot context'];

function TracePanel({ traceId }: { traceId: string }) {
  const t = useApi<TraceDetail>(`/api/traces/${traceId}`);
  if (t.error) return <div className="card"><ErrorState error={t.error} what="This trace" retry={t.reload} /></div>;
  if (!t.data || t.data.trace.trace_id !== traceId) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <Skel h={90} />
        <Skel h={260} />
        <Skel h={90} />
      </div>
    );
  }
  const d = t.data;
  const input = userInput(d);
  const output = finalOutput(d);
  const steps = trajectory(d);
  const judged = d.scores.filter((s) => s.source !== 'human');
  const tr = d.trace;
  return (
    <div className="stack" style={{ gap: 12 }}>
      <div className="row wrap an-meta">
        <TraceStatus errors={tr.error_count} flagged={tr.signal_count} />
        <span className="mono dim">{tr.agent_names ?? tr.name}</span>
        <span className="muted">·</span>
        <span className="num dim">{fmtMs(tr.duration_ms)}</span>
        <span className="muted">·</span>
        <span className="num dim">{fmtCost(tr.cost_usd)}</span>
        <span className="muted">·</span>
        <span className="num dim">{fmtTokens(tr.input_tokens + tr.output_tokens + tr.cache_read_tokens + tr.cache_write_tokens)} tokens</span>
        <span className="muted">·</span>
        <span className="dim">{agoNs(tr.start_ns)}</span>
        <Link to={'/traces/' + tr.trace_id} className="link mono" style={{ marginLeft: 'auto', fontSize: 12 }}>
          {shortId(tr.trace_id, 12)} full trace
        </Link>
      </div>
      <section className="card">
        <div className="card-head">
          <h3>User input</h3>
        </div>
        <div className="card-body prose an-text">{input ?? <span className="muted">No user input recorded</span>}</div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Trajectory</h3>
          <span className="sub">
            {tr.llm_calls} LLM · {tr.tool_calls} tool
          </span>
        </div>
        <div className="card-body flush">
          <Trajectory spans={steps} signals={d.signals} />
        </div>
      </section>
      <section className="card">
        <div className="card-head">
          <h3>Final output</h3>
        </div>
        <div className="card-body prose an-text">{output ?? <span className="muted">No final output recorded</span>}</div>
      </section>
      {(d.signals.length > 0 || judged.length > 0) && (
        <section className="card">
          <div className="card-head">
            <h3>What the machines think</h3>
            <span className="sub">Signals and judge scores, for reference</span>
          </div>
          <div className="card-body stack" style={{ gap: 10 }}>
            {d.signals.map((g) => (
              <div key={g.id} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <SignalChip type={g.type} severity={g.severity} />
                <span className="dim" style={{ fontSize: 12.5 }}>{g.title}</span>
              </div>
            ))}
            {judged.map((s) => (
              <div key={s.id} className="stack" style={{ gap: 4 }}>
                <div className="row" style={{ gap: 8 }}>
                  <ScoreChip s={s} />
                  <span className="muted" style={{ fontSize: 11.5 }}>{s.source}{s.judge_model ? ' · ' + s.judge_model : ''}</span>
                </div>
                {s.reasoning && <div className="dim an-reason">{s.reasoning}</div>}
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function Review({ queue, queues, reloadQueues }: { queue: string; queues: QueueRow[] | undefined; reloadQueues: () => void }) {
  const toast = useToast();
  const pending = useApi<{ items: Item[] }>('/api/annotations', { queue, status: 'pending', limit: 1000 });
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const [skipped, setSkipped] = useState<string[]>([]);
  const [mode, setMode] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [tally, setTally] = useState({ pass: 0, fail: 0 });
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const modeRef = useRef<HTMLInputElement>(null);

  const q = queues?.find((x) => x.queue === queue);
  const items = pending.data?.items ?? [];
  const remaining = items.filter((a) => !handled.has(a.id));
  const fresh = remaining.filter((a) => !skipped.includes(a.id));
  const current = fresh[0] ?? null;
  const onlySkipped = !current && remaining.length > 0;
  const total = (q?.pending ?? items.length) + (q?.done ?? 0);
  const doneCount = q?.done ?? 0;
  const progress = total ? doneCount / total : 0;

  useEffect(() => {
    setMode('');
    setComment('');
  }, [current?.id]);

  const label = async (l: 'pass' | 'fail') => {
    if (!current || busy) return;
    setBusy(true);
    try {
      await api.post(`/api/annotations/${current.id}`, { label: l, comment: comment.trim() || undefined, failure_mode: mode.trim() || undefined });
      setHandled((h) => new Set(h).add(current.id));
      setSkipped((s) => s.filter((x) => x !== current.id));
      setTally((t) => ({ ...t, [l]: t[l] + 1 }));
      reloadQueues();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'bad');
    } finally {
      setBusy(false);
    }
  };
  const skip = () => {
    if (!current) return;
    setSkipped((s) => [...s, current.id]);
  };

  const keys = useMemo(
    () => ({
      p: () => label('pass'),
      f: () => label('fail'),
      n: skip,
      c: () => commentRef.current?.focus(),
      m: () => modeRef.current?.focus(),
    }),
    [current?.id, mode, comment, busy],
  );

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT');
      if (typing) {
        if (e.key === 'Escape') (t as HTMLElement).blur();
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          (t as HTMLElement).blur();
        }
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const fn = (keys as Record<string, () => void>)[e.key];
      if (fn) {
        e.preventDefault();
        fn();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [keys]);

  const header = (
    <div className="an-progress">
      <div className="row" style={{ gap: 10 }}>
        <span className="mono" style={{ fontWeight: 600 }}>{queue}</span>
        <span className="muted num">
          {doneCount} of {total} labeled
        </span>
        {(tally.pass > 0 || tally.fail > 0) && (
          <span className="muted num">
            this session: <span style={{ color: 'var(--good)' }}>{tally.pass} pass</span>, <span style={{ color: 'var(--bad)' }}>{tally.fail} fail</span>
          </span>
        )}
        {skipped.length > 0 && <span className="muted num">{skipped.length} skipped</span>}
      </div>
      <div className="progress" style={{ marginTop: 6 }}>
        <i style={{ width: `${progress * 100}%` }} />
      </div>
    </div>
  );

  if (pending.error) return <div className="card"><ErrorState error={pending.error} what="This queue" retry={pending.reload} /></div>;
  if (!pending.data) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        <Skel h={34} />
        <div className="an-review">
          <Skel h={420} />
          <Skel h={300} />
        </div>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="stack" style={{ gap: 12 }}>
        {header}
        <div className="card">
          <Empty
            title={onlySkipped ? 'Only skipped traces left' : 'Queue complete'}
            body={onlySkipped ? `You skipped ${remaining.length} ${remaining.length === 1 ? 'trace' : 'traces'}. Go back to them or come back later.` : 'Every trace in this queue has a label. Human labels now calibrate the judges on the Evals page.'}
            actions={
              <>
                {onlySkipped && (
                  <button className="btn primary sm" onClick={() => setSkipped([])}>
                    Review skipped
                  </button>
                )}
                <Link to="/evals" className="btn sm">
                  See judge calibration
                </Link>
                <button className="btn sm" onClick={() => navigate('/annotate')}>
                  All queues
                </button>
              </>
            }
          />
        </div>
      </div>
    );
  }

  return (
    <div className="stack" style={{ gap: 12 }}>
      {header}
      <div className="an-review">
        <TracePanel key={current.trace_id} traceId={current.trace_id} />
        <aside className="card an-verdict">
          <div className="card-head">
            <h3>Your verdict</h3>
            <span className="sub num">{fresh.length} left</span>
          </div>
          <div className="card-body stack" style={{ gap: 12 }}>
            <div className="an-buttons">
              <button className="btn an-pass" onClick={() => label('pass')} disabled={busy}>
                Pass <kbd>p</kbd>
              </button>
              <button className="btn an-fail" onClick={() => label('fail')} disabled={busy}>
                Fail <kbd>f</kbd>
              </button>
            </div>
            <div className="field">
              <label className="row" style={{ justifyContent: 'space-between' }}>
                <span>Failure mode</span>
                <kbd>m</kbd>
              </label>
              <input ref={modeRef} className="input" list="an-modes" value={mode} onChange={(e) => setMode(e.target.value)} placeholder="What went wrong, in a few words" />
              <datalist id="an-modes">
                {MODES.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <div className="chips" style={{ marginTop: 4 }}>
                {MODES.slice(0, 6).map((m) => (
                  <button key={m} type="button" className={'chip btn-chip' + (mode === m ? ' accent' : '')} onClick={() => setMode(mode === m ? '' : m)}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label className="row" style={{ justifyContent: 'space-between' }}>
                <span>Comment</span>
                <kbd>c</kbd>
              </label>
              <textarea ref={commentRef} className="textarea" rows={4} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Why, with evidence. Esc to return to the keyboard." />
            </div>
            <button className="btn ghost sm" onClick={skip} style={{ alignSelf: 'flex-start' }}>
              Skip for now <kbd>n</kbd>
            </button>
            <div className="muted" style={{ fontSize: 11.5, lineHeight: 1.5 }}>
              Judge the whole run against what the user asked. Name the first thing that went wrong as the failure mode.
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
