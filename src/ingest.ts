import type { DB } from './db.ts';
import { getDb } from './db.ts';
import type { SpanRow } from './types.ts';
import { SPAN_COLUMNS } from './types.ts';
import type { RawLog, RawMetricPoint, RawSpan } from './otlp.ts';
import { normalizeSpan } from './normalize.ts';
import { costFor } from './pricing.ts';
import { indexSpanText } from './fts.ts';
import { emit } from './bus.ts';
import { clip, nowMs, str, maybeJson } from './util.ts';
import { outputPreviewOf } from './messages.ts';
import { claudeCodeLogToSpans, enrichClaudeCodeTrace } from './sources/claudeCode.ts';

interface Pending {
  spans: SpanRow[];
  logs: RawLog[];
  metrics: RawMetricPoint[];
}

const pending: Pending = { spans: [], logs: [], metrics: [] };
let timer: NodeJS.Timeout | null = null;
let flushing = false;
const flushHooks: ((traceIds: string[]) => void)[] = [];

export function onFlush(fn: (traceIds: string[]) => void): void {
  flushHooks.push(fn);
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, 100);
}

export function ingestRawSpans(spans: RawSpan[], project?: string): number {
  for (const s of spans) pending.spans.push(normalizeSpan(s, project));
  schedule();
  return spans.length;
}

export function ingestSpanRows(rows: SpanRow[]): number {
  pending.spans.push(...rows);
  schedule();
  return rows.length;
}

export function ingestLogs(logs: RawLog[]): number {
  pending.logs.push(...logs);
  schedule();
  return logs.length;
}

export function ingestMetrics(points: RawMetricPoint[]): number {
  pending.metrics.push(...points);
  schedule();
  return points.length;
}

const updatable = SPAN_COLUMNS.filter((c) => c !== 'span_id');
const upsertSql =
  `insert into spans(${SPAN_COLUMNS.join(',')}, updated_at) values(${SPAN_COLUMNS.map(() => '?').join(',')}, ?) ` +
  `on conflict(span_id) do update set ` +
  updatable
    .map((c) => {
      if (c === 'kind') return `kind = case when excluded.kind = 'span' then spans.kind else excluded.kind end`;
      if (c === 'status') return `status = case when spans.status = 'error' or excluded.status = 'unset' then spans.status else excluded.status end`;
      if (c === 'start_ns') return `start_ns = min(spans.start_ns, excluded.start_ns)`;
      if (c === 'end_ns') return `end_ns = case when spans.end_ns is null then excluded.end_ns when excluded.end_ns is null then spans.end_ns else max(spans.end_ns, excluded.end_ns) end`;
      if (c === 'source') return `source = case when spans.source in ('sdk','otel') then excluded.source else spans.source end`;
      return `${c} = coalesce(excluded.${c}, spans.${c})`;
    })
    .join(', ') +
  `, updated_at = excluded.updated_at`;

export function flush(db: DB = getDb()): string[] {
  if (flushing) return [];
  if (!pending.spans.length && !pending.logs.length && !pending.metrics.length) return [];
  flushing = true;
  const spans = pending.spans.splice(0);
  const logs = pending.logs.splice(0);
  const metrics = pending.metrics.splice(0);
  const touched = new Set<string>();
  const sessions = new Set<string>();
  try {
    for (const l of logs) {
      for (const s of claudeCodeLogToSpans(l)) spans.push(s);
    }
    const now = nowMs();
    db.exec('begin immediate');
    try {
      const up = db.prepare(upsertSql);
      for (const s of spans) {
        if (s.cost_usd == null && s.model) s.cost_usd = costFor(db, s.model, s);
        up.run(...SPAN_COLUMNS.map((c) => s[c] as any), now);
        if (s.input || s.output) indexSpanText(db, s.span_id);
        touched.add(s.trace_id);
      }
      const logIns = db.prepare('insert into logs(ts_ns, name, severity, body, trace_id, span_id, session_id, attributes, resource) values(?,?,?,?,?,?,?,?,?)');
      for (const l of logs) {
        const sid = str(l.attributes['session.id'] ?? l.resource['session.id']);
        if (l.traceId) touched.add(l.traceId);
        logIns.run(l.timeNs, l.name, l.severity, typeof l.body === 'string' ? l.body : JSON.stringify(l.body ?? null), l.traceId, l.spanId, sid, JSON.stringify(l.attributes), JSON.stringify(l.resource));
      }
      const mIns = db.prepare('insert into metric_points(name, ts_ns, value, kind, unit, attributes, session_id) values(?,?,?,?,?,?,?)');
      for (const m of metrics) {
        mIns.run(m.name, m.timeNs, m.value, m.kind, m.unit, JSON.stringify(m.attributes), str(m.attributes['session.id'] ?? m.resource['session.id']));
      }
      for (const t of touched) {
        const sid = rollupTrace(db, t, now);
        if (sid) sessions.add(sid);
      }
      for (const s of sessions) rollupSession(db, s, now);
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  } finally {
    flushing = false;
  }
  const ids = [...touched];
  if (ids.length) {
    emit({ type: 'traces', ids });
    for (const h of flushHooks) {
      try {
        h(ids);
      } catch (e) {
        console.error('[blackbox] flush hook', e);
      }
    }
  }
  if (pending.spans.length || pending.logs.length || pending.metrics.length) schedule();
  return ids;
}

interface Agg {
  start_ns: number;
  end_ns: number;
  span_count: number;
  llm_calls: number;
  tool_calls: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  session_id: string | null;
  user_id: string | null;
  project: string;
}

export function rollupTrace(db: DB, traceId: string, now = nowMs()): string | null {
  const synth = db.prepare("select span_id from spans where trace_id = ? and parent_id is null and source = 'claude-code-logs'").get(traceId) as { span_id: string } | undefined;
  if (synth) {
    db.prepare(
      `update spans set
        start_ns = (select min(start_ns) from spans where trace_id = ?),
        end_ns = (select max(coalesce(end_ns, start_ns)) from spans where trace_id = ?)
       where span_id = ?`,
    ).run(traceId, traceId, synth.span_id);
    db.prepare('update spans set duration_ms = (end_ns - start_ns) / 1e6 where span_id = ?').run(synth.span_id);
  }
  const hasCC = db.prepare("select 1 from spans where trace_id = ? and source = 'claude-code' limit 1").get(traceId);
  if (hasCC) enrichClaudeCodeTrace(db, traceId);
  backfillToolResults(db, traceId);
  const agg = db
    .prepare(
      `select min(start_ns) start_ns, max(coalesce(end_ns, start_ns)) end_ns, count(*) span_count,
        sum(kind = 'llm') llm_calls, sum(kind in ('tool','mcp','memory')) tool_calls, sum(status = 'error') error_count,
        coalesce(sum(input_tokens),0) input_tokens, coalesce(sum(output_tokens),0) output_tokens,
        coalesce(sum(cache_read_tokens),0) cache_read_tokens, coalesce(sum(cache_write_tokens),0) cache_write_tokens,
        coalesce(sum(cost_usd),0) cost_usd, max(session_id) session_id, max(user_id) user_id, max(project) project
       from spans where trace_id = ?`,
    )
    .get(traceId) as unknown as Agg;
  if (!agg.span_count) return null;
  const spans = db
    .prepare('select span_id, parent_id, name, kind, agent_name, model, source, input_preview, output_preview, start_ns from spans where trace_id = ? order by start_ns')
    .all(traceId) as { span_id: string; parent_id: string | null; name: string; kind: string; agent_name: string | null; model: string | null; source: string; input_preview: string | null; output_preview: string | null; start_ns: number }[];
  const ids = new Set(spans.map((s) => s.span_id));
  const roots = spans.filter((s) => !s.parent_id || !ids.has(s.parent_id));
  const root = roots[0] ?? spans[0];
  const llms = spans.filter((s) => s.kind === 'llm');
  const agents = [...new Set(spans.map((s) => s.agent_name).filter(Boolean))];
  const models = [...new Set(spans.map((s) => s.model).filter(Boolean))];
  const sources = [...new Set(spans.map((s) => s.source))];
  const inputPreview = root?.input_preview ?? llms[0]?.input_preview ?? null;
  const outputPreview = root?.output_preview ?? llms[llms.length - 1]?.output_preview ?? null;
  db.prepare(
    `insert into traces(trace_id, project, name, root_span_id, session_id, user_id, agent_names, models, sources, start_ns, end_ns, duration_ms,
      span_count, llm_calls, tool_calls, error_count, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
      input_preview, output_preview, analyzed_at, updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,null,?)
     on conflict(trace_id) do update set project=excluded.project, name=excluded.name, root_span_id=excluded.root_span_id,
      session_id=coalesce(excluded.session_id, traces.session_id), user_id=coalesce(excluded.user_id, traces.user_id),
      agent_names=excluded.agent_names, models=excluded.models, sources=excluded.sources, start_ns=excluded.start_ns, end_ns=excluded.end_ns,
      duration_ms=excluded.duration_ms, span_count=excluded.span_count, llm_calls=excluded.llm_calls, tool_calls=excluded.tool_calls,
      error_count=excluded.error_count, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens,
      cache_read_tokens=excluded.cache_read_tokens, cache_write_tokens=excluded.cache_write_tokens, cost_usd=excluded.cost_usd,
      input_preview=excluded.input_preview, output_preview=excluded.output_preview, analyzed_at=null, updated_at=excluded.updated_at`,
  ).run(
    traceId,
    agg.project ?? 'default',
    root?.name ?? null,
    root?.span_id ?? null,
    agg.session_id,
    agg.user_id,
    agents.join(',') || null,
    models.join(',') || null,
    sources.join(','),
    agg.start_ns,
    agg.end_ns,
    (agg.end_ns - agg.start_ns) / 1e6,
    agg.span_count,
    agg.llm_calls ?? 0,
    agg.tool_calls ?? 0,
    agg.error_count ?? 0,
    agg.input_tokens,
    agg.output_tokens,
    agg.cache_read_tokens,
    agg.cache_write_tokens,
    agg.cost_usd,
    clip(inputPreview, 240),
    clip(outputPreview, 240),
    now,
  );
  if (agg.session_id) db.prepare('update spans set session_id = ? where trace_id = ? and session_id is null').run(agg.session_id, traceId);
  return agg.session_id;
}

export function backfillToolResults(db: DB, traceId: string): void {
  const missing = db.prepare("select span_id, tool_call_id from spans where trace_id = ? and kind in ('tool','mcp','memory') and output is null and tool_call_id is not null").all(traceId) as { span_id: string; tool_call_id: string }[];
  if (!missing.length) return;
  const want = new Map(missing.map((m) => [m.tool_call_id, m.span_id]));
  const llms = db.prepare("select input from spans where trace_id = ? and kind = 'llm' and input is not null order by start_ns desc").all(traceId) as { input: string }[];
  const set = db.prepare('update spans set output = ?, output_preview = ? where span_id = ?');
  for (const l of llms) {
    if (!want.size) break;
    const msgs = maybeJson(l.input);
    if (!Array.isArray(msgs)) continue;
    for (const m of msgs as Record<string, any>[]) {
      const sid = m?.role === 'tool' && m.tool_call_id ? want.get(m.tool_call_id) : undefined;
      if (!sid) continue;
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      set.run(text, outputPreviewOf(text), sid);
      indexSpanText(db, sid);
      want.delete(m.tool_call_id);
    }
  }
}

export function rollupSession(db: DB, sessionId: string, now = nowMs()): void {
  const agg = db
    .prepare(
      `select min(start_ns) start_ns, max(end_ns) end_ns, count(*) trace_count, sum(llm_calls) llm_calls, sum(tool_calls) tool_calls,
        sum(error_count) error_count, sum(input_tokens) input_tokens, sum(output_tokens) output_tokens, sum(cost_usd) cost_usd,
        max(user_id) user_id, max(project) project, group_concat(distinct sources) sources
       from traces where session_id = ?`,
    )
    .get(sessionId) as Record<string, any>;
  const firstTrace = db.prepare('select input_preview from traces where session_id = ? and input_preview is not null order by start_ns limit 1').get(sessionId) as { input_preview: string } | undefined;
  const sources = [...new Set(String(agg.sources ?? '').split(',').filter(Boolean))].join(',');
  db.prepare(
    `insert into sessions(session_id, project, user_id, start_ns, end_ns, trace_count, llm_calls, tool_calls, error_count, input_tokens, output_tokens, cost_usd, first_input, sources, updated_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(session_id) do update set project=excluded.project, user_id=coalesce(excluded.user_id, sessions.user_id), start_ns=excluded.start_ns,
      end_ns=excluded.end_ns, trace_count=excluded.trace_count, llm_calls=excluded.llm_calls, tool_calls=excluded.tool_calls,
      error_count=excluded.error_count, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, cost_usd=excluded.cost_usd,
      first_input=excluded.first_input, sources=excluded.sources, updated_at=excluded.updated_at`,
  ).run(sessionId, agg.project ?? 'default', agg.user_id, agg.start_ns, agg.end_ns, agg.trace_count, agg.llm_calls ?? 0, agg.tool_calls ?? 0, agg.error_count ?? 0, agg.input_tokens ?? 0, agg.output_tokens ?? 0, agg.cost_usd ?? 0, firstTrace?.input_preview ?? null, sources, now);
}

export function pendingCount(): number {
  return pending.spans.length + pending.logs.length + pending.metrics.length;
}

