import type { Router } from './http.ts';
import { HttpError } from './http.ts';
import { getDb, type DB } from './db.ts';
import { ingestSpanRows, flush } from './ingest.ts';
import { blankSpan } from './normalize.ts';
import { invalidatePrices } from './pricing.ts';
import { deleteTraceText } from './fts.ts';
import { percentile, hexId, nowNs, toJson, num, str, maybeJson } from './util.ts';
import type { SpanRow } from './types.ts';
import { KINDS } from './types.ts';

type Row = Record<string, any>;

const PARSE_SPAN = ['input', 'output', 'attributes', 'events', 'resource'];

export function parseSpan(r: Row): Row {
  const out: Row = { ...r };
  for (const k of PARSE_SPAN) if (typeof out[k] === 'string') out[k] = maybeJson(out[k]);
  return out;
}

function sinceNs(q: URLSearchParams): number {
  const since = num(q.get('since'));
  if (since != null) return since * 1e6;
  const window = q.get('window') ?? '7d';
  const m = /^(\d+)([mhd])$/.exec(window);
  if (!m) return 0;
  const mult = m[2] === 'm' ? 60e3 : m[2] === 'h' ? 3600e3 : 86400e3;
  return (Date.now() - Number(m[1]) * mult) * 1e6;
}

function bucketMs(windowNs: number): number {
  const span = Date.now() - windowNs / 1e6;
  if (span <= 2 * 3600e3) return 60e3;
  if (span <= 26 * 3600e3) return 15 * 60e3;
  if (span <= 8 * 86400e3) return 3600e3;
  return 86400e3;
}

function projectClause(q: URLSearchParams, col = 'project'): [string, any[]] {
  const p = q.get('project');
  return p ? [` and ${col} = ?`, [p]] : ['', []];
}

export function overview(db: DB, q: URLSearchParams): Row {
  const since = sinceNs(q);
  const [pc, pp] = projectClause(q);
  const totals = db
    .prepare(
      `select count(*) traces, coalesce(sum(span_count),0) spans, coalesce(sum(llm_calls),0) llm_calls, coalesce(sum(tool_calls),0) tool_calls,
        coalesce(sum(error_count > 0),0) error_traces, coalesce(sum(cost_usd),0) cost_usd, coalesce(sum(input_tokens),0) input_tokens,
        coalesce(sum(output_tokens),0) output_tokens, coalesce(sum(cache_read_tokens),0) cache_read_tokens,
        coalesce(sum(cache_write_tokens),0) cache_write_tokens, count(distinct session_id) sessions
       from traces where start_ns >= ?${pc}`,
    )
    .get(since, ...pp) as Row;
  const durs = (db.prepare(`select duration_ms from traces where start_ns >= ?${pc} and duration_ms is not null`).all(since, ...pp) as Row[]).map((r) => r.duration_ms as number);
  const llmDurs = (db.prepare(`select duration_ms from spans where kind = 'llm' and start_ns >= ?${pc} and duration_ms is not null`).all(since, ...pp) as Row[]).map((r) => r.duration_ms as number);
  const promptSide = totals.input_tokens + totals.cache_read_tokens + totals.cache_write_tokens;
  totals.cache_hit_ratio = promptSide ? totals.cache_read_tokens / promptSide : null;
  totals.p50_ms = percentile(durs, 50);
  totals.p95_ms = percentile(durs, 95);
  totals.llm_p50_ms = percentile(llmDurs, 50);
  totals.llm_p95_ms = percentile(llmDurs, 95);
  totals.error_rate = totals.traces ? totals.error_traces / totals.traces : 0;
  const succeeded = db.prepare(`select count(*) n from traces where start_ns >= ?${pc} and error_count = 0 and signal_count = 0`).get(since, ...pp) as Row;
  totals.clean_traces = succeeded.n;
  totals.cost_per_clean_trace = succeeded.n ? totals.cost_usd / succeeded.n : null;

  const b = bucketMs(since);
  const series = db
    .prepare(
      `select cast(start_ns / 1000000 / ? as integer) * ? bucket, count(*) traces, sum(cost_usd) cost_usd, sum(error_count > 0) errors,
        sum(input_tokens + output_tokens + cache_read_tokens + cache_write_tokens) tokens, sum(llm_calls) llm_calls, sum(signal_count) signals
       from traces where start_ns >= ?${pc} group by bucket order by bucket`,
    )
    .all(b, b, since, ...pp);

  const models = db
    .prepare(
      `select model, provider, count(*) calls, sum(cost_usd) cost_usd, sum(coalesce(input_tokens,0)) input_tokens, sum(coalesce(output_tokens,0)) output_tokens,
        sum(coalesce(cache_read_tokens,0)) cache_read_tokens, sum(status = 'error') errors, avg(duration_ms) avg_ms
       from spans where kind = 'llm' and model is not null and start_ns >= ?${pc} group by model order by calls desc limit 12`,
    )
    .all(since, ...pp);
  const tools = db
    .prepare(
      `select tool_name tool, kind, max(mcp_server) mcp_server, count(*) calls, sum(status = 'error') errors, avg(duration_ms) avg_ms, max(duration_ms) max_ms
       from spans where tool_name is not null and kind in ('tool','mcp','memory') and start_ns >= ?${pc} group by tool_name order by calls desc limit 15`,
    )
    .all(since, ...pp);
  const agents = db
    .prepare(
      `select agent_name agent, count(distinct trace_id) traces, sum(kind = 'llm') llm_calls, sum(cost_usd) cost_usd, sum(status = 'error') errors
       from spans where agent_name is not null and start_ns >= ?${pc} group by agent_name order by traces desc limit 12`,
    )
    .all(since, ...pp);
  const issues = listIssues(db, since, 8, q.get('project'));
  const scoreSummary = db
    .prepare(
      `select name, count(*) n, avg(value) avg, sum(case when label in ('pass','yes','true','correct','good') or value >= 0.5 then 1 else 0 end) passes
       from scores where created_at >= ? and source != 'signal' group by name order by n desc limit 10`,
    )
    .all(Math.floor(since / 1e6));
  return { totals, series, bucket_ms: b, models, tools, agents, issues, scores: scoreSummary };
}

export function listIssues(db: DB, since: number, limit = 100, project?: string | null, status?: string | null): Row[] {
  const params: any[] = [Math.floor(since / 1e6)];
  let where = 's.created_at >= ?';
  if (project) {
    where += ' and t.project = ?';
    params.push(project);
  }
  if (status) {
    where += ' and s.status = ?';
    params.push(status);
  }
  return db
    .prepare(
      `select s.fingerprint, s.type, max(s.severity) severity, max(s.title) title, count(*) count, count(distinct s.trace_id) traces,
        min(s.created_at) first_seen, max(s.created_at) last_seen, max(s.trace_id) sample_trace_id, min(s.status) status
       from signals s left join traces t on t.trace_id = s.trace_id where ${where}
       group by s.fingerprint order by case max(s.severity) when 'high' then 0 when 'medium' then 1 else 2 end, last_seen desc limit ?`,
    )
    .all(...params, limit) as Row[];
}

export function listTraces(db: DB, q: URLSearchParams): Row {
  const where: string[] = ['1=1'];
  const params: any[] = [];
  const limit = Math.min(500, num(q.get('limit')) ?? 50);
  const since = q.get('since') || q.get('window') ? sinceNs(q) : 0;
  if (since) {
    where.push('t.start_ns >= ?');
    params.push(since);
  }
  const until = num(q.get('until'));
  if (until) {
    where.push('t.start_ns <= ?');
    params.push(until * 1e6);
  }
  const cursor = num(q.get('cursor'));
  if (cursor) {
    where.push('t.start_ns < ?');
    params.push(cursor);
  }
  for (const [param, col] of [['project', 't.project'], ['session', 't.session_id'], ['user', 't.user_id']] as const) {
    const v = q.get(param);
    if (v) {
      where.push(`${col} = ?`);
      params.push(v);
    }
  }
  const status = q.get('status');
  if (status === 'error') where.push('t.error_count > 0');
  if (status === 'ok') where.push('t.error_count = 0');
  if (q.get('flagged') === '1') where.push('t.signal_count > 0');
  const model = q.get('model');
  if (model) {
    where.push(`t.trace_id in (select trace_id from spans where model = ?)`);
    params.push(model);
  }
  const agent = q.get('agent');
  if (agent) {
    where.push(`t.trace_id in (select trace_id from spans where agent_name = ?)`);
    params.push(agent);
  }
  const tool = q.get('tool');
  if (tool) {
    where.push(`t.trace_id in (select trace_id from spans where tool_name = ?)`);
    params.push(tool);
  }
  const kind = q.get('kind');
  if (kind) {
    where.push(`t.trace_id in (select trace_id from spans where kind = ?)`);
    params.push(kind);
  }
  const source = q.get('source');
  if (source) {
    where.push(`t.sources like ?`);
    params.push('%' + source + '%');
  }
  const signal = q.get('signal');
  if (signal) {
    where.push(`exists(select 1 from signals g where g.trace_id = t.trace_id and (g.type = ? or g.fingerprint = ?))`);
    params.push(signal, signal);
  }
  const score = q.get('score');
  if (score) {
    const [name, cmp] = score.split(':');
    if (cmp === 'fail') where.push(`exists(select 1 from scores c where c.trace_id = t.trace_id and c.name = ? and (c.value < 0.5 or c.label in ('fail','no','false','incorrect','bad')))`);
    else if (cmp === 'pass') where.push(`exists(select 1 from scores c where c.trace_id = t.trace_id and c.name = ? and (c.value >= 0.5 or c.label in ('pass','yes','true','correct','good')))`);
    else where.push(`exists(select 1 from scores c where c.trace_id = t.trace_id and c.name = ?)`);
    params.push(name);
  }
  const text = q.get('q');
  if (text && text.trim()) {
    const term = text.trim();
    if (term.length >= 3) {
      where.push(`(t.trace_id in (select trace_id from spans_fts where spans_fts match ?) or t.name like ?)`);
      params.push('"' + term.replace(/"/g, '""') + '"', '%' + term + '%');
    } else {
      where.push(`(t.name like ? or t.input_preview like ?)`);
      params.push('%' + term + '%', '%' + term + '%');
    }
  }
  const minCost = num(q.get('min_cost'));
  if (minCost != null) {
    where.push('t.cost_usd >= ?');
    params.push(minCost);
  }
  const order = q.get('sort') === 'cost' ? 't.cost_usd desc' : q.get('sort') === 'duration' ? 't.duration_ms desc' : 't.start_ns desc';
  const items = db.prepare(`select t.* from traces t where ${where.join(' and ')} order by ${order} limit ?`).all(...params, limit + 1) as Row[];
  const hasMore = items.length > limit;
  if (hasMore) items.pop();
  attachTraceBadges(db, items);
  const total = db.prepare(`select count(*) n from traces t where ${where.join(' and ')}`).get(...params) as Row;
  return { items, total: total.n, next: hasMore && order === 't.start_ns desc' ? items[items.length - 1].start_ns : null };
}

function attachTraceBadges(db: DB, items: Row[]): void {
  if (!items.length) return;
  const ids = items.map((t) => t.trace_id);
  const ph = ids.map(() => '?').join(',');
  const sig = db.prepare(`select trace_id, type, severity from signals where trace_id in (${ph})`).all(...ids) as Row[];
  const sc = db.prepare(`select trace_id, name, value, label from scores where trace_id in (${ph}) and span_id is null order by created_at`).all(...ids) as Row[];
  const byT = new Map<string, Row>();
  for (const t of items) {
    t.signals = [];
    t.scores = [];
    byT.set(t.trace_id, t);
  }
  for (const s of sig) {
    const t = byT.get(s.trace_id);
    if (t && !t.signals.some((x: Row) => x.type === s.type)) t.signals.push({ type: s.type, severity: s.severity });
  }
  for (const s of sc) {
    const t = byT.get(s.trace_id);
    if (!t) continue;
    t.scores = t.scores.filter((x: Row) => x.name !== s.name);
    t.scores.push({ name: s.name, value: s.value, label: s.label });
  }
}

export function getTrace(db: DB, id: string): Row {
  const trace = db.prepare('select * from traces where trace_id = ?').get(id) as Row | undefined;
  if (!trace) throw new HttpError(404, 'trace not found');
  const spans = (db.prepare('select * from spans where trace_id = ? order by start_ns, span_id').all(id) as Row[]).map(parseSpan);
  const scores = db.prepare('select * from scores where trace_id = ? order by created_at').all(id);
  const signals = (db.prepare('select * from signals where trace_id = ? order by created_at').all(id) as Row[]).map((s) => ({ ...s, detail: maybeJson(s.detail) }));
  const annotations = db.prepare('select * from annotations where trace_id = ?').all(id);
  let prev = null;
  let next = null;
  if (trace.session_id) {
    prev = (db.prepare('select trace_id from traces where session_id = ? and start_ns < ? order by start_ns desc limit 1').get(trace.session_id, trace.start_ns) as Row | undefined)?.trace_id ?? null;
    next = (db.prepare('select trace_id from traces where session_id = ? and start_ns > ? order by start_ns limit 1').get(trace.session_id, trace.start_ns) as Row | undefined)?.trace_id ?? null;
  }
  const window = (() => {
    const models = [...new Set(spans.filter((s) => s.kind === 'llm' && s.model).map((s) => s.model))];
    const out: Record<string, number | null> = {};
    for (const m of models) {
      const p = db.prepare('select context from prices where lower(model) = lower(?)').get(m) as Row | undefined;
      out[m] = p?.context ?? null;
    }
    return out;
  })();
  return { trace, spans, scores, signals, annotations, session_nav: { prev, next }, context_windows: window };
}

export function listSessions(db: DB, q: URLSearchParams): Row {
  const where: string[] = ['1=1'];
  const params: any[] = [];
  const limit = Math.min(300, num(q.get('limit')) ?? 50);
  const p = q.get('project');
  if (p) {
    where.push('project = ?');
    params.push(p);
  }
  const text = q.get('q');
  if (text) {
    where.push('(session_id like ? or first_input like ? or user_id like ?)');
    params.push('%' + text + '%', '%' + text + '%', '%' + text + '%');
  }
  const cursor = num(q.get('cursor'));
  if (cursor) {
    where.push('end_ns < ?');
    params.push(cursor);
  }
  const items = db.prepare(`select * from sessions where ${where.join(' and ')} order by end_ns desc limit ?`).all(...params, limit) as Row[];
  if (items.length) {
    const ids = items.map((s) => s.session_id);
    const ph = ids.map(() => '?').join(',');
    const sig = db.prepare(`select session_id, type, count(*) n from signals where session_id in (${ph}) group by session_id, type`).all(...ids) as Row[];
    const by = new Map(items.map((s) => [s.session_id, s]));
    for (const s of items) s.signals = [];
    for (const g of sig) by.get(g.session_id)?.signals.push({ type: g.type, count: g.n });
  }
  return { items, next: items.length === limit ? items[items.length - 1].end_ns : null };
}

export function getSession(db: DB, id: string): Row {
  const session = db.prepare('select * from sessions where session_id = ?').get(id) as Row | undefined;
  if (!session) throw new HttpError(404, 'session not found');
  const traces = db.prepare('select * from traces where session_id = ? order by start_ns').all(id) as Row[];
  attachTraceBadges(db, traces);
  const turns = traces.map((t) => {
    const root = t.root_span_id ? (db.prepare('select input, output from spans where span_id = ?').get(t.root_span_id) as Row | undefined) : undefined;
    const llms = db.prepare(`select input, output from spans where trace_id = ? and kind = 'llm' order by start_ns`).all(t.trace_id) as Row[];
    const tools = db.prepare(`select span_id, name, tool_name, kind, status, duration_ms, input_preview, output_preview, memory_op from spans where trace_id = ? and kind in ('tool','mcp','memory','handoff') order by start_ns`).all(t.trace_id) as Row[];
    return {
      trace_id: t.trace_id,
      start_ns: t.start_ns,
      user: userTurn(root, llms),
      assistant: assistantTurn(root, llms),
      tools,
      cost_usd: t.cost_usd,
      duration_ms: t.duration_ms,
      error_count: t.error_count,
      signals: t.signals,
      scores: t.scores,
    };
  });
  const scores = db.prepare('select * from scores where session_id = ? and trace_id is null order by created_at').all(id);
  const signals = db.prepare('select * from signals where session_id = ? order by created_at').all(id);
  return { session, traces, turns, scores, signals };
}

function lastOfRole(msgs: unknown, role: string): string | null {
  if (!Array.isArray(msgs)) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i] as Row;
    if (m && m.role === role && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return null;
}

function userTurn(root: Row | undefined, llms: Row[]): string | null {
  const rIn = root ? maybeJson(root.input) : null;
  if (typeof rIn === 'string') return rIn;
  const fromRoot = lastOfRole(rIn, 'user');
  if (fromRoot) return fromRoot;
  if (rIn && typeof rIn === 'object' && !Array.isArray(rIn)) return JSON.stringify(rIn);
  for (const l of llms) {
    const msgs = maybeJson(l.input);
    if (Array.isArray(msgs)) {
      const firstUser = (msgs as Row[]).filter((m) => m.role === 'user' && m.content).pop();
      if (firstUser) return firstUser.content;
    }
  }
  return null;
}

function assistantTurn(root: Row | undefined, llms: Row[]): string | null {
  const rOut = root ? maybeJson(root.output) : null;
  if (typeof rOut === 'string') return rOut;
  const fromRoot = lastOfRole(rOut, 'assistant');
  if (fromRoot) return fromRoot;
  if (rOut && typeof rOut === 'object' && !Array.isArray(rOut)) return JSON.stringify(rOut);
  for (let i = llms.length - 1; i >= 0; i--) {
    const t = lastOfRole(maybeJson(llms[i].output), 'assistant');
    if (t) return t;
  }
  return null;
}

export function facets(db: DB): Row {
  const col = (sql: string) => (db.prepare(sql).all() as Row[]).map((r) => r.v).filter(Boolean);
  return {
    projects: col('select distinct project v from traces order by v'),
    models: col("select model v from spans where model is not null group by model order by count(*) desc limit 50"),
    agents: col('select agent_name v from spans where agent_name is not null group by agent_name order by count(*) desc limit 50'),
    tools: col('select tool_name v from spans where tool_name is not null group by tool_name order by count(*) desc limit 100'),
    sources: col('select distinct source v from spans'),
    kinds: KINDS,
    signal_types: col('select distinct type v from signals'),
    score_names: col('select distinct name v from scores'),
  };
}

export function toolStats(db: DB, q: URLSearchParams): Row {
  const since = sinceNs(q);
  const [pc, pp] = projectClause(q);
  const rows = db
    .prepare(
      `select tool_name tool, kind, max(mcp_server) mcp_server, max(memory_op) memory_op, count(*) calls, sum(status = 'error') errors,
        count(distinct trace_id) traces, avg(duration_ms) avg_ms, max(duration_ms) max_ms, max(start_ns) last_ns
       from spans where tool_name is not null and kind in ('tool','mcp','memory') and start_ns >= ?${pc}
       group by tool_name order by calls desc`,
    )
    .all(since, ...pp) as Row[];
  for (const r of rows) {
    const d = (db.prepare(`select duration_ms v from spans where tool_name = ? and start_ns >= ? and duration_ms is not null`).all(r.tool, since) as Row[]).map((x) => x.v);
    r.p50_ms = percentile(d, 50);
    r.p95_ms = percentile(d, 95);
    r.error_rate = r.calls ? r.errors / r.calls : 0;
    const err = db.prepare(`select status_message from spans where tool_name = ? and status = 'error' and status_message is not null order by start_ns desc limit 1`).get(r.tool) as Row | undefined;
    r.last_error = err?.status_message ?? null;
  }
  const servers = db
    .prepare(
      `select mcp_server server, count(*) calls, sum(status = 'error') errors, count(distinct tool_name) tools, avg(duration_ms) avg_ms
       from spans where mcp_server is not null and start_ns >= ?${pc} group by mcp_server order by calls desc`,
    )
    .all(since, ...pp) as Row[];
  const defs = db.prepare('select server, name, hash, description, tokens, first_seen, last_seen from mcp_tools order by server, name, last_seen desc').all() as Row[];
  const drift = db.prepare('select server, name, count(distinct hash) versions from mcp_tools group by server, name having versions > 1').all() as Row[];
  for (const s of servers) {
    const d = defs.filter((x) => x.server === s.server);
    const latest = new Map<string, Row>();
    for (const x of d) if (!latest.has(x.name)) latest.set(x.name, x);
    s.definition_tokens = [...latest.values()].reduce((acc, x) => acc + (x.tokens ?? 0), 0);
    s.defined_tools = latest.size;
    s.error_rate = s.calls ? s.errors / s.calls : 0;
  }
  return { tools: rows, servers, definitions: defs, drift };
}

export function agentStats(db: DB, q: URLSearchParams): Row {
  const since = sinceNs(q);
  const [pc, pp] = projectClause(q);
  const rows = db
    .prepare(
      `select agent_name agent, count(distinct trace_id) traces, sum(kind = 'llm') llm_calls, sum(kind in ('tool','mcp','memory')) tool_calls,
        sum(coalesce(cost_usd,0)) cost_usd, sum(status = 'error') errors, sum(coalesce(input_tokens,0) + coalesce(output_tokens,0)) tokens, max(start_ns) last_ns
       from spans where agent_name is not null and start_ns >= ?${pc} group by agent_name order by traces desc`,
    )
    .all(since, ...pp) as Row[];
  for (const r of rows) {
    const flagged = db.prepare(`select count(distinct s.trace_id) n from signals s join spans p on p.trace_id = s.trace_id where p.agent_name = ? and s.created_at >= ?`).get(r.agent, Math.floor(since / 1e6)) as Row;
    r.flagged_traces = flagged.n;
    r.cost_per_trace = r.traces ? r.cost_usd / r.traces : 0;
    r.steps_per_trace = r.traces ? (r.llm_calls + r.tool_calls) / r.traces : 0;
  }
  const models = db
    .prepare(
      `select model, max(provider) provider, count(*) calls, sum(coalesce(cost_usd,0)) cost_usd, sum(coalesce(input_tokens,0)) input_tokens,
        sum(coalesce(output_tokens,0)) output_tokens, sum(coalesce(cache_read_tokens,0)) cache_read_tokens, sum(coalesce(cache_write_tokens,0)) cache_write_tokens,
        sum(status = 'error') errors, avg(duration_ms) avg_ms, avg(ttft_ms) avg_ttft_ms
       from spans where kind = 'llm' and model is not null and start_ns >= ?${pc} group by model order by calls desc`,
    )
    .all(since, ...pp) as Row[];
  for (const m of models) {
    const side = m.input_tokens + m.cache_read_tokens + m.cache_write_tokens;
    m.cache_hit_ratio = side ? m.cache_read_tokens / side : null;
  }
  return { agents: rows, models };
}

export function memoryLedger(db: DB, q: URLSearchParams): Row {
  const since = sinceNs(q);
  const limit = Math.min(500, num(q.get('limit')) ?? 200);
  const ops = (db
    .prepare(
      `select span_id, trace_id, session_id, name, tool_name, memory_op, status, start_ns, duration_ms, input_preview, output_preview, agent_name, source
       from spans where kind = 'memory' and start_ns >= ? order by start_ns desc limit ?`,
    )
    .all(since, limit) as Row[]);
  const summary = db
    .prepare(`select memory_op op, count(*) n, sum(status = 'error') errors from spans where kind = 'memory' and start_ns >= ? group by memory_op`)
    .all(since);
  const perSession = db
    .prepare(
      `select session_id, sum(memory_op in ('write','update','create','upsert')) writes, sum(memory_op in ('read','search')) reads, sum(memory_op = 'delete') deletes
       from spans where kind = 'memory' and session_id is not null and start_ns >= ? group by session_id order by max(start_ns) desc limit 50`,
    )
    .all(since);
  return { ops, summary, sessions: perSession };
}

function spanFromApi(o: Row): SpanRow {
  const trace = str(o.trace_id) ?? hexId(16);
  const start = num(o.start_ns) ?? (num(o.start_ms) != null ? num(o.start_ms)! * 1e6 : nowNs());
  const end = num(o.end_ns) ?? (num(o.end_ms) != null ? num(o.end_ms)! * 1e6 : null);
  return blankSpan({
    span_id: str(o.span_id) ?? hexId(8),
    trace_id: trace,
    parent_id: str(o.parent_id),
    project: str(o.project) ?? 'default',
    name: str(o.name) ?? 'span',
    kind: (o.kind && KINDS.includes(o.kind) ? o.kind : 'span'),
    source: str(o.source) ?? 'sdk',
    operation: str(o.operation),
    start_ns: start,
    end_ns: end,
    duration_ms: end ? (end - start) / 1e6 : num(o.duration_ms),
    status: o.status === 'error' ? 'error' : o.status === 'ok' ? 'ok' : 'unset',
    status_message: str(o.status_message ?? o.error),
    session_id: str(o.session_id),
    user_id: str(o.user_id),
    agent_name: str(o.agent_name),
    model: str(o.model),
    provider: str(o.provider),
    tool_name: str(o.tool_name),
    tool_call_id: str(o.tool_call_id),
    mcp_server: str(o.mcp_server),
    mcp_method: str(o.mcp_method),
    memory_op: str(o.memory_op),
    input_tokens: num(o.input_tokens),
    output_tokens: num(o.output_tokens),
    cache_read_tokens: num(o.cache_read_tokens),
    cache_write_tokens: num(o.cache_write_tokens),
    reasoning_tokens: num(o.reasoning_tokens),
    cost_usd: num(o.cost_usd),
    ttft_ms: num(o.ttft_ms),
    finish_reason: str(o.finish_reason),
    input: toJson(o.input),
    output: toJson(o.output),
    attributes: o.attributes ? JSON.stringify(o.attributes) : null,
  });
}

export function registerApi(r: Router): void {
  r.get('/api/health', () => {
    const db = getDb();
    const n = db.prepare('select count(*) n from spans').get() as Row;
    return { ok: true, spans: n.n, version: '0.1.0' };
  });
  r.get('/api/overview', (_q, _r, ctx) => overview(getDb(), ctx.query));
  r.get('/api/facets', () => facets(getDb()));
  r.get('/api/traces', (_q, _r, ctx) => listTraces(getDb(), ctx.query));
  r.get('/api/traces/:id', (_q, _r, ctx) => getTrace(getDb(), ctx.params.id));
  r.delete('/api/traces/:id', (_q, _r, ctx) => {
    const db = getDb();
    const id = ctx.params.id;
    deleteTraceText(db, id);
    db.prepare('delete from spans where trace_id = ?').run(id);
    db.prepare('delete from signals where trace_id = ?').run(id);
    db.prepare('delete from scores where trace_id = ?').run(id);
    db.prepare('delete from traces where trace_id = ?').run(id);
    return { ok: true };
  });
  r.get('/api/spans/:id', (_q, _r, ctx) => {
    const s = getDb().prepare('select * from spans where span_id = ?').get(ctx.params.id) as Row | undefined;
    if (!s) throw new HttpError(404, 'span not found');
    return parseSpan(s);
  });
  r.get('/api/sessions', (_q, _r, ctx) => listSessions(getDb(), ctx.query));
  r.get('/api/sessions/:id', (_q, _r, ctx) => getSession(getDb(), ctx.params.id));
  r.get('/api/issues', (_q, _r, ctx) => ({ items: listIssues(getDb(), ctx.query.get('window') || ctx.query.get('since') ? sinceNs(ctx.query) : 0, num(ctx.query.get('limit')) ?? 200, ctx.query.get('project'), ctx.query.get('status')) }));
  r.post('/api/issues/:fp/status', async (_q, _r, ctx) => {
    const body = await ctx.json();
    const status = ['open', 'resolved', 'ignored'].includes(body.status) ? body.status : 'open';
    getDb().prepare('update signals set status = ? where fingerprint = ?').run(status, ctx.params.fp);
    return { ok: true };
  });
  r.get('/api/signals', (_q, _r, ctx) => {
    const q = ctx.query;
    const where: string[] = ['1=1'];
    const params: any[] = [];
    for (const k of ['type', 'trace_id', 'fingerprint', 'session_id']) {
      const v = q.get(k);
      if (v) {
        where.push(`${k} = ?`);
        params.push(v);
      }
    }
    const rows = getDb().prepare(`select * from signals where ${where.join(' and ')} order by created_at desc limit ?`).all(...params, num(q.get('limit')) ?? 100) as Row[];
    return { items: rows.map((s) => ({ ...s, detail: maybeJson(s.detail) })) };
  });
  r.get('/api/tools', (_q, _r, ctx) => toolStats(getDb(), ctx.query));
  r.get('/api/agents', (_q, _r, ctx) => agentStats(getDb(), ctx.query));
  r.get('/api/memory', (_q, _r, ctx) => memoryLedger(getDb(), ctx.query));
  r.get('/api/logs', (_q, _r, ctx) => {
    const q = ctx.query;
    const sid = q.get('session');
    const rows = sid
      ? getDb().prepare('select * from logs where session_id = ? order by ts_ns desc limit ?').all(sid, num(q.get('limit')) ?? 200)
      : getDb().prepare('select * from logs order by ts_ns desc limit ?').all(num(q.get('limit')) ?? 200);
    return { items: rows };
  });
  r.get('/api/metrics', (_q, _r, ctx) => {
    const since = sinceNs(ctx.query);
    const rows = getDb()
      .prepare('select name, unit, kind, count(*) points, sum(value) total, max(ts_ns) last_ns from metric_points where ts_ns >= ? group by name order by name')
      .all(since);
    return { items: rows };
  });
  r.get('/api/prices', (_q, _r, ctx) => {
    const q = ctx.query.get('q');
    const rows = q
      ? getDb().prepare('select * from prices where model like ? order by custom desc, model limit 100').all('%' + q + '%')
      : getDb().prepare('select * from prices order by custom desc, model limit 100').all();
    return { items: rows };
  });
  r.post('/api/prices', async (_q, _r, ctx) => {
    const b = await ctx.json();
    if (!b.model || b.input == null || b.output == null) throw new HttpError(400, 'model, input and output (USD per token) required');
    getDb()
      .prepare(
        `insert into prices(model, pattern, provider, input, output, cache_read, cache_write, context, custom) values(?,?,?,?,?,?,?,?,1)
         on conflict(model) do update set pattern=excluded.pattern, input=excluded.input, output=excluded.output, cache_read=excluded.cache_read, cache_write=excluded.cache_write, context=excluded.context, custom=1`,
      )
      .run(b.model, b.pattern ?? null, b.provider ?? null, b.input, b.output, b.cache_read ?? null, b.cache_write ?? null, b.context ?? null);
    invalidatePrices();
    return { ok: true };
  });
  r.post('/api/ingest', async (_q, _r, ctx) => {
    const b = await ctx.json();
    const items: Row[] = Array.isArray(b) ? b : Array.isArray(b.spans) ? b.spans : [b];
    const n = ingestSpanRows(items.map(spanFromApi));
    if (b.flush) flush();
    return { accepted: n };
  });
  r.post('/api/flush', () => ({ traces: flush() }));
}
