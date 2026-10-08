import { useState } from 'react';
import type { SessionDetail, Turn, TurnTool } from '../../api.ts';
import { PageHeader } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, Kpi, Skel, CopyButton } from '../../components/ui.tsx';
import { ScoreChip, SignalChip } from '../../components/Badges.tsx';
import { KindIcon } from '../../components/Kind.tsx';
import { Tooltip } from '../../components/Charts.tsx';
import { useApi, useLive } from '../../hooks.ts';
import { Link, useTitle } from '../../router.tsx';
import { agoNs, fmtCost, fmtDateTime, fmtMs, fmtTokens, oneLine, scoreText, shortId } from '../../format.ts';
import './sessions.css';

function ToolChip({ t }: { t: TurnTool }) {
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const err = t.status === 'error';
  const label = t.tool_name ?? t.name;
  return (
    <span className={'tool-chip' + (err ? ' err' : '')} onPointerMove={(e) => setHover({ x: e.clientX, y: e.clientY })} onPointerLeave={() => setHover(null)} tabIndex={0} onFocus={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover({ x: r.left, y: r.bottom }); }} onBlur={() => setHover(null)}>
      <KindIcon kind={t.kind} size={16} />
      {label}
      {t.memory_op && <span className="d">{t.memory_op}</span>}
      <span className="d">{fmtMs(t.duration_ms)}</span>
      {hover && (
        <Tooltip x={hover.x} y={hover.y}>
          <div className="tip-title">
            {t.kind} · {label} · {err ? 'error' : 'ok'} · {fmtMs(t.duration_ms)}
          </div>
          {t.input_preview && (
            <>
              <div className="tip-title">Input</div>
              <div className="tip-pre">{oneLine(t.input_preview, 400)}</div>
            </>
          )}
          {t.output_preview && (
            <>
              <div className="tip-title">Output</div>
              <div className="tip-pre">{oneLine(t.output_preview, 400)}</div>
            </>
          )}
        </Tooltip>
      )}
    </span>
  );
}

function TurnView({ turn, index }: { turn: Turn; index: number }) {
  return (
    <div className="turn">
      <div className="turn-meta">
        <span className="turn-n">Turn {index + 1}</span>
        <span>{fmtDateTime(turn.start_ns / 1e6)}</span>
        {turn.error_count > 0 && <span className="err-text">{turn.error_count} error{turn.error_count > 1 ? 's' : ''}</span>}
        <div className="chips">
          {turn.signals.map((s) => (
            <SignalChip key={s.type} type={s.type} severity={s.severity} />
          ))}
          {turn.scores.map((s) => (
            <ScoreChip key={s.name} s={s} />
          ))}
        </div>
        <span className="right">
          <span className="num">{fmtCost(turn.cost_usd)}</span>
          <span className="num">{fmtMs(turn.duration_ms)}</span>
          <Link to={'/traces/' + turn.trace_id} className="link mono">
            {shortId(turn.trace_id)}
          </Link>
        </span>
      </div>
      <div className="bubble-role user">User</div>
      <div className={'bubble user' + (turn.user ? '' : ' empty-b')}>{turn.user ?? 'No user input captured'}</div>
      {turn.tools.length > 0 && (
        <div className="tool-strip">
          {turn.tools.map((t) => (
            <ToolChip key={t.span_id} t={t} />
          ))}
        </div>
      )}
      <div className="bubble-role">Assistant</div>
      <div className={'bubble assistant' + (turn.assistant ? '' : ' empty-b')}>{turn.assistant ?? 'No assistant reply captured'}</div>
    </div>
  );
}

export function SessionDetailPage({ id }: { id: string }) {
  const { tick } = useLive();
  const { data, error, reload } = useApi<SessionDetail>('/api/sessions/' + encodeURIComponent(id), undefined, [tick]);
  useTitle('Session ' + shortId(id, 14));
  const s = data?.session;
  const flagged = data ? data.traces.filter((t) => t.signal_count > 0).length : 0;
  const steps = s ? s.llm_calls + s.tool_calls : 0;

  return (
    <>
      <PageHeader
        title={<span className="mono">{id}</span>}
        crumbs={[{ to: '/sessions', label: 'Sessions' }]}
        right={
          <div className="row">
            <CopyButton text={id} label="Copy id" />
            <Link to={'/traces?session=' + encodeURIComponent(id)} className="btn sm">
              View traces
            </Link>
          </div>
        }
      />
      <div className="page">
        {error ? (
          <Card>
            <ErrorState error={error} what="Session" retry={reload} />
          </Card>
        ) : (
          <>
            <div className="kpis">
              <Kpi label="Turns" value={s?.trace_count ?? 0} foot={s ? `${steps} steps` : undefined} loading={!s} />
              <Kpi label="Cost" value={fmtCost(s?.cost_usd)} foot={s && s.trace_count ? `${fmtCost(s.cost_usd / s.trace_count)} per turn` : undefined} loading={!s} />
              <Kpi label="Tokens" value={fmtTokens(s ? s.input_tokens + s.output_tokens : 0)} foot={s ? `${fmtTokens(s.input_tokens)} in · ${fmtTokens(s.output_tokens)} out` : undefined} loading={!s} />
              <Kpi label="Duration" value={fmtMs(s ? (s.end_ns - s.start_ns) / 1e6 : null)} foot={s ? `last ${agoNs(s.end_ns)}` : undefined} loading={!s} />
              <Kpi label="Errors" value={s?.error_count ?? 0} tone={s && s.error_count > 0 ? 'bad' : undefined} foot={flagged ? `${flagged} flagged turn${flagged > 1 ? 's' : ''}` : 'no flagged turns'} loading={!s} />
              <Kpi label="User" value={<span className="ellipsis" style={{ display: 'block' }}>{s?.user_id ?? '-'}</span>} foot={s?.sources ?? undefined} loading={!s} />
            </div>
            <div className="sess-layout">
              <Card title="Conversation" sub={data ? `${data.turns.length} turns` : undefined} flush>
                {!data ? (
                  <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
                    {Array.from({ length: 4 }).map((_, i) => (
                      <div key={i} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                        <Skel w="40%" h={28} style={{ alignSelf: 'flex-end' }} />
                        <Skel w="55%" h={44} />
                      </div>
                    ))}
                  </div>
                ) : data.turns.length === 0 ? (
                  <Empty title="No turns" body="This session has no traces yet." />
                ) : (
                  <div className="replay">
                    {data.turns.map((t, i) => (
                      <TurnView key={t.trace_id} turn={t} index={i} />
                    ))}
                  </div>
                )}
              </Card>
              <div className="sess-side">
                <Card title="Signals" sub={data ? String(data.signals.length) : undefined} flush>
                  {!data ? (
                    <div style={{ padding: 12 }}>
                      <Skel h={36} />
                    </div>
                  ) : data.signals.length === 0 ? (
                    <Empty small title="No signals" body="No detector fired on this session." />
                  ) : (
                    data.signals.map((g) => (
                        <Link key={g.id} to={'/traces/' + g.trace_id + (g.span_id ? '?span=' + g.span_id : '')} className="sess-signal">
                          <div className="row">
                            <SignalChip type={g.type} severity={g.severity} />
                            <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                              {shortId(g.trace_id)}
                            </span>
                          </div>
                          <div className="t">{g.title}</div>
                        </Link>
                    ))
                  )}
                </Card>
                <Card title="Session scores" sub={data ? String(data.scores.length) : undefined} flush>
                  {!data ? (
                    <div style={{ padding: 12 }}>
                      <Skel h={36} />
                    </div>
                  ) : data.scores.length === 0 ? (
                    <Empty small title="No session scores" body="Session evaluators (frustration, forgetting) write scores here once they run." />
                  ) : (
                    data.scores.map((sc) => (
                      <div key={sc.id} className="sess-signal">
                        <div className="row">
                          <ScoreChip s={sc} />
                          <span className="muted" style={{ marginLeft: 'auto', fontSize: 11.5 }}>
                            {sc.source}
                          </span>
                        </div>
                        {sc.reasoning && <div className="t dim">{oneLine(sc.reasoning, 220)}</div>}
                        {!sc.reasoning && <div className="t dim">{scoreText(sc)}</div>}
                      </div>
                    ))
                  )}
                </Card>
              </div>
            </div>
          </>
        )}
      </div>
    </>
  );
}
