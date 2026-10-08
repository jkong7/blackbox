import { useState, type ReactNode } from 'react';
import type { Score, Signal, Span } from '../../api.ts';
import { KindIcon, KIND_LABEL } from '../../components/Kind.tsx';
import { Tabs, CopyButton, Empty } from '../../components/ui.tsx';
import { JsonView } from '../../components/JsonView.tsx';
import { ScoreChip, SignalChip } from '../../components/Badges.tsx';
import { fmtCompact, fmtCost, fmtInt, fmtMs, fmtPct, pretty, scoreText } from '../../format.ts';
import { asMessages, displayName, promptTokens } from './model.ts';
import { MessageList, ToolCallCard } from './Messages.tsx';

type Tab = 'messages' | 'io' | 'attributes' | 'events';

function TokenBreakdown({ s }: { s: Span }) {
  const parts = [
    { k: 'Input', v: s.input_tokens ?? 0, c: 'var(--c-input)' },
    { k: 'Cache read', v: s.cache_read_tokens ?? 0, c: 'var(--c-cache-read)' },
    { k: 'Cache write', v: s.cache_write_tokens ?? 0, c: 'var(--c-cache-write)' },
    { k: 'Output', v: s.output_tokens ?? 0, c: 'var(--c-output)' },
  ];
  const total = parts.reduce((a, p) => a + p.v, 0);
  if (!total) return null;
  const ps = promptTokens(s);
  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="tokbar" role="img" aria-label="Token breakdown">
        {parts.map((p) => (p.v ? <i key={p.k} style={{ width: `${(p.v / total) * 100}%`, background: p.c }} title={`${p.k}: ${fmtInt(p.v)}`} /> : null))}
      </div>
      <div className="legend">
        {parts.map((p) => (
          <span key={p.k}>
            <i style={{ background: p.c }} />
            {p.k} <b className="num" style={{ fontWeight: 500, color: 'var(--text)' }}>{fmtCompact(p.v)}</b>
          </span>
        ))}
        {s.reasoning_tokens ? (
          <span>
            Reasoning <b className="num" style={{ fontWeight: 500, color: 'var(--text)' }}>{fmtCompact(s.reasoning_tokens)}</b>
          </span>
        ) : null}
        {ps > 0 && <span className="muted">{fmtPct((s.cache_read_tokens ?? 0) / ps, 0)} of prompt cached</span>}
      </div>
    </div>
  );
}

function Meta({ l, v }: { l: string; v: ReactNode }) {
  if (v == null || v === '' || v === false) return null;
  return (
    <span>
      <span className="l">{l}</span>
      <b>{v}</b>
    </span>
  );
}

export function SpanDetail({ span, offsetMs, signals, scores, onSignal, activeSignal }: { span: Span; offsetMs: number; signals: Signal[]; scores: Score[]; onSignal: (s: Signal) => void; activeSignal: string | null }) {
  const inMsgs = asMessages(span.input);
  const outMsgs = asMessages(span.output);
  const isToolish = span.kind === 'tool' || span.kind === 'mcp' || span.kind === 'memory' || span.kind === 'retriever';
  const hasMessages = !!(inMsgs || outMsgs) || isToolish;
  const [tab, setTab] = useState<Tab>(hasMessages ? 'messages' : 'io');
  const t: Tab = !hasMessages && tab === 'messages' ? 'io' : tab;
  const attrs = span.attributes ?? {};
  const events = Array.isArray(span.events) ? (span.events as unknown[]) : span.events ? [span.events] : [];

  return (
    <div className="sd">
      <div className="sd-head">
        <div className="sd-title">
          <KindIcon kind={span.kind} size={22} />
          <span className="ellipsis">{displayName(span)}</span>
          <span className="chip sq neutral">{KIND_LABEL[span.kind] ?? span.kind}</span>
          {span.status === 'error' && <span className="chip bad sq">Error</span>}
          <span style={{ marginLeft: 'auto' }} className="row">
            <span className="muted mono" style={{ fontSize: 11 }}>
              {span.span_id}
            </span>
            <CopyButton text={span.span_id} label={undefined} />
          </span>
        </div>
        <div className="sd-meta">
          <Meta l="Duration" v={fmtMs(span.duration_ms)} />
          <Meta l="Starts at" v={'+' + fmtMs(offsetMs)} />
          <Meta l="TTFT" v={span.ttft_ms != null ? fmtMs(span.ttft_ms) : null} />
          <Meta l="Cost" v={span.cost_usd != null ? fmtCost(span.cost_usd) : null} />
          <Meta l="Model" v={span.model} />
          <Meta l="Provider" v={span.provider} />
          <Meta l="Agent" v={span.agent_name} />
          <Meta l="Tool" v={span.tool_name} />
          <Meta l="MCP" v={span.mcp_server ? `${span.mcp_server}${span.mcp_method ? ' · ' + span.mcp_method : ''}` : null} />
          <Meta l="Memory" v={span.memory_op} />
          <Meta l="Finish" v={span.finish_reason} />
          <Meta l="Source" v={span.source} />
        </div>
        <TokenBreakdown s={span} />
        {span.status === 'error' && span.status_message && (
          <div className="banner" style={{ borderColor: 'color-mix(in srgb, var(--bad) 40%, var(--border))', background: 'var(--bad-soft)', color: 'var(--text)' }}>
            <span className="mono" style={{ fontSize: 12, wordBreak: 'break-word' }}>
              {span.status_message}
            </span>
          </div>
        )}
        {(signals.length > 0 || scores.length > 0) && (
          <div className="chips">
            {signals.map((s) => (
              <span key={s.id} style={{ outline: activeSignal === s.id ? '2px solid var(--serious)' : undefined, borderRadius: 4 }}>
                <SignalChip type={s.type} severity={s.severity} onClick={() => onSignal(s)} title={s.title} />
              </span>
            ))}
            {scores.map((s) => (
              <ScoreChip key={s.id} s={s} title={`${s.name}: ${scoreText(s)}${s.reasoning ? '\n' + s.reasoning : ''}`} />
            ))}
          </div>
        )}
      </div>
      <Tabs<Tab>
        value={t}
        onChange={setTab}
        tabs={[
          ...(hasMessages ? [{ id: 'messages' as Tab, label: isToolish ? 'Call' : 'Messages', badge: inMsgs ? inMsgs.length + (outMsgs?.length ?? 0) : undefined }] : []),
          { id: 'io', label: 'Input / Output' },
          { id: 'attributes', label: 'Attributes', badge: Object.keys(attrs).length },
          { id: 'events', label: 'Events', badge: events.length },
        ]}
      />
      <div className="sd-body">
        {t === 'messages' &&
          (isToolish && !inMsgs ? (
            <ToolCallCard
              call={{ name: span.tool_name ?? span.name, id: span.tool_call_id ?? undefined, arguments: span.input ?? {} }}
              result={span.output == null ? (span.status_message ?? null) : typeof span.output === 'string' ? span.output : pretty(span.output)}
              resultError={span.status === 'error'}
            />
          ) : (
            <MessageList messages={inMsgs ?? []} output={outMsgs ?? (span.output != null ? [{ role: 'assistant', content: typeof span.output === 'string' ? span.output : pretty(span.output) }] : null)} collapseHistory />
          ))}
        {t === 'io' && (
          <>
            <div className="sd-section-title">Input</div>
            {span.input == null ? <span className="muted">No input captured</span> : <JsonView value={span.input} />}
            <div className="sd-section-title">Output</div>
            {span.output == null ? <span className="muted">No output captured</span> : <JsonView value={span.output} />}
          </>
        )}
        {t === 'attributes' && (
          <>
            {Object.keys(attrs).length ? (
              <div className="kv">
                {Object.entries(attrs).flatMap(([k, v]) => [
                  <div key={k + 'k'}>{k}</div>,
                  <div key={k + 'v'}>{typeof v === 'string' ? (v.length > 400 ? v.slice(0, 400) + '…' : v) : JSON.stringify(v)}</div>,
                ])}
              </div>
            ) : (
              <Empty small title="No attributes" />
            )}
            {span.resource && Object.keys(span.resource).length > 0 && (
              <>
                <div className="sd-section-title">Resource</div>
                <div className="kv">
                  {Object.entries(span.resource).flatMap(([k, v]) => [
                    <div key={k + 'k'}>{k}</div>,
                    <div key={k + 'v'}>{typeof v === 'string' ? v : JSON.stringify(v)}</div>,
                  ])}
                </div>
              </>
            )}
            <div className="sd-section-title">Identifiers</div>
            <div className="kv">
              {(['trace_id', 'span_id', 'parent_id', 'session_id', 'user_id', 'tool_call_id', 'project', 'operation'] as const).flatMap((k) =>
                span[k] ? [<div key={k + 'k'}>{k}</div>, <div key={k + 'v'}>{String(span[k])}</div>] : [],
              )}
            </div>
          </>
        )}
        {t === 'events' && (events.length ? <JsonView value={events} openDepth={3} /> : <Empty small title="No events" body="Span events such as exceptions and stream chunks show here." />)}
      </div>
    </div>
  );
}
