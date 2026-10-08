import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { emit } from './bus.ts';
import { contextWindow } from './pricing.ts';
import { maybeJson, median, nowMs, sha, stableStringify, clip } from './util.ts';

type Row = Record<string, any>;
export type Severity = 'high' | 'medium' | 'low';

export interface Signal {
  type: string;
  severity: Severity;
  key: string;
  title: string;
  span_id?: string | null;
  detail?: Row;
}

const RUNAWAY_USD = Number(process.env.BLACKBOX_RUNAWAY_USD || 1);
const QUIET_MS = Number(process.env.BLACKBOX_QUIET_MS || 4000);

const REFUSAL = /\b(I can(?:no|')t (?:help|assist|do that|provide|comply)|I(?:'m| am) (?:not able|unable) to (?:help|assist|provide)|I won't be able to|I must decline|I'm sorry, but I can(?:no|')t|as an AI(?: language model)?, I)\b/i;
const FRUSTRATION = /\b(useless|already (?:told|said|gave)|not what I (?:asked|wanted)|wrong again|still wrong|talk to a (?:human|person|real)|are you (?:even|serious)|this is (?:ridiculous|stupid|absurd)|wtf|ugh+|you keep|stop (?:doing|saying)|for the (?:third|second|last) time|frustrat|annoying|pointless)\b/i;
const SUCCESS_CLAIM = /\b(all tests (?:pass|passed|are passing)|tests (?:pass|passed|are passing|now pass)|verified (?:that|it works)|successfully (?:deployed|ran|completed)|everything (?:works|is working)|build (?:passes|succeeded))\b/i;
const TEST_TOOL = /(test|pytest|jest|vitest|mocha|go test|cargo test|npm (?:run )?test|rspec|unittest)/i;
const TEST_FAIL = /(\bFAIL\b|\bfailed\b|\bfailing\b|AssertionError|Tests?:\s*\d+ failed|exit code [1-9]|Error:)/i;
const DESTRUCTIVE = /(rm\s+-[a-z]*r[a-z]*f|rm\s+-[a-z]*f[a-z]*r|\bdrop\s+(table|database|schema)\b|\btruncate\s+table\b|git\s+push\s+(?:[^\n]*\s)?(--force|-f)\b|git\s+reset\s+--hard|\bdelete\s+from\s+\w+\s*(?:;|$)|kubectl\s+delete|terraform\s+destroy|chmod\s+-R\s+777|mkfs\.|dd\s+if=|:\(\)\s*\{)/i;
const UNTRUSTED_TOOL = /(fetch|browse|web|http_get|url|scrape|crawl|read_issue|get_issue|search_issues|issue|email|gmail|inbox|slack|comment|webpage|download)/i;
const SENSITIVE_ARG = /(\.ssh|id_rsa|id_ed25519|\.env\b|credentials|\.aws|hosts\.yml|secret|private[_ ]?key|api[_-]?key|token|password|\.netrc|keychain)/i;
const EGRESS_TOOL = /(http_post|post|send|email|upload|webhook|create_issue|comment|publish|curl|request|slack_post|tweet|share)/i;
const INJECTION = /(ignore (?:all |any )?(?:prior|previous|above) instructions|disregard (?:your|the) (?:instructions|system prompt)|AI agents? reading this|you are now|new instructions:|<\s*important\s*>)/i;
const ASK_AGAIN = /\b(?:could|can|would) you (?:please )?(?:tell|give|share|provide|send) me (?:your|the) ([a-z ]{3,30}?)(?:\?|\.|,| so)/i;

function textOfMessages(v: unknown, role?: string): string {
  const parsed = maybeJson(v);
  if (typeof parsed === 'string') return parsed;
  if (!Array.isArray(parsed)) return parsed ? JSON.stringify(parsed) : '';
  return (parsed as Row[])
    .filter((m) => !role || m?.role === role)
    .map((m) => (typeof m?.content === 'string' ? m.content : ''))
    .join('\n');
}

function lastUser(v: unknown): string {
  const parsed = maybeJson(v);
  if (typeof parsed === 'string') return parsed;
  if (!Array.isArray(parsed)) return '';
  for (let i = parsed.length - 1; i >= 0; i--) {
    const m = parsed[i] as Row;
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return '';
}

function argsText(s: Row): string {
  if (s.input == null) return '';
  return typeof s.input === 'string' ? s.input : JSON.stringify(s.input);
}

function normMsg(s: string | null): string {
  return (s ?? '').replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, 'N').slice(0, 80);
}

function finalAnswer(spans: Row[], root: Row | undefined): string {
  const fromRoot = root ? textOfMessages(root.output, 'assistant') || (typeof maybeJson(root.output) === 'string' ? (maybeJson(root.output) as string) : '') : '';
  if (fromRoot) return fromRoot;
  const llms = spans.filter((s) => s.kind === 'llm');
  for (let i = llms.length - 1; i >= 0; i--) {
    const t = textOfMessages(llms[i].output, 'assistant');
    if (t.trim()) return t;
  }
  return '';
}

export function detect(db: DB, trace: Row, spans: Row[]): Signal[] {
  const out: Signal[] = [];
  const agent = (trace.agent_names ?? '').split(',')[0] || trace.name || 'unknown';
  const ids = new Set(spans.map((s) => s.span_id));
  const root = spans.find((s) => s.span_id === trace.root_span_id) ?? spans.find((s) => !s.parent_id || !ids.has(s.parent_id));
  const tools = spans.filter((s) => s.kind === 'tool' || s.kind === 'mcp' || s.kind === 'memory');
  const llms = spans.filter((s) => s.kind === 'llm');

  const groups = new Map<string, Row[]>();
  for (const t of tools) {
    const k = (t.tool_name ?? t.name) + '|' + stableStringify(maybeJson(t.input) ?? null);
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  for (const [k, g] of groups) {
    if (g.length < 3) continue;
    const tool = k.split('|')[0];
    out.push({
      type: 'tool_loop',
      severity: g.length >= 5 ? 'high' : 'medium',
      key: `${agent}:${tool}`,
      title: `${agent} called ${tool} ${g.length}x with identical arguments`,
      span_id: g[g.length - 1].span_id,
      detail: { tool, count: g.length, arguments: clip(argsText(g[0]), 300), span_ids: g.map((x) => x.span_id) },
    });
  }

  const byId = new Map(spans.map((s) => [s.span_id, s]));
  for (const s of spans.filter((x) => x.status === 'error')) {
    const parent = s.parent_id ? byId.get(s.parent_id) : null;
    if (parent && parent.status === 'error' && (parent.status_message ?? '') === (s.status_message ?? '') && parent.kind !== 'agent') continue;
    const what = s.tool_name ?? s.model ?? s.name;
    out.push({
      type: 'error_spans',
      severity: s.span_id === root?.span_id ? 'high' : 'medium',
      key: `${s.kind}:${what}:${normMsg(s.status_message)}`,
      title: `${s.kind === 'llm' ? 'LLM call' : s.kind === 'mcp' ? 'MCP tool' : s.kind === 'tool' || s.kind === 'memory' ? 'Tool' : 'Span'} ${what} failed${s.status_message ? ': ' + clip(s.status_message, 80) : ''}`,
      span_id: s.span_id,
      detail: { kind: s.kind, name: what, message: s.status_message },
    });
  }

  const failedTools = new Map<string, Row>();
  for (const t of tools) {
    const name = t.tool_name ?? t.name;
    if (t.status === 'error') failedTools.set(name, t);
    else if (failedTools.has(name)) {
      out.push({ type: 'tool_retry', severity: 'low', key: `${agent}:${name}`, title: `${name} failed then succeeded on retry`, span_id: t.span_id, detail: { tool: name, failed_span: failedTools.get(name)!.span_id } });
      failedTools.delete(name);
    }
  }

  const cost = trace.cost_usd ?? 0;
  const agentCosts = (db.prepare(`select cost_usd from traces where agent_names = ? and trace_id != ? and start_ns > ? order by start_ns desc limit 200`).all(trace.agent_names ?? '', trace.trace_id, trace.start_ns - 7 * 86400e9) as Row[]).map((r) => r.cost_usd as number);
  const med = median(agentCosts);
  if (cost >= RUNAWAY_USD || (med != null && agentCosts.length >= 10 && cost > 0.05 && cost > med * 5) || llms.length > 25) {
    out.push({
      type: 'runaway_cost',
      severity: cost >= RUNAWAY_USD * 3 || llms.length > 40 ? 'high' : 'medium',
      key: agent,
      title: `${agent} run cost $${cost.toFixed(2)} over ${llms.length} LLM calls${med ? ` (${(cost / Math.max(med, 1e-6)).toFixed(0)}x the median)` : ''}`,
      detail: { cost_usd: cost, llm_calls: llms.length, median_cost_usd: med },
    });
  }

  for (const s of llms) {
    const win = contextWindow(db, s.model);
    const used = (s.input_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0);
    if (win && used / win > 0.8) {
      out.push({ type: 'context_pressure', severity: used / win > 0.95 ? 'high' : 'medium', key: `${agent}:${s.model}`, title: `LLM call used ${Math.round((100 * used) / win)}% of ${s.model}'s ${Math.round(win / 1000)}k context`, span_id: s.span_id, detail: { used, window: win, model: s.model } });
      break;
    }
  }

  const promptSide = (trace.input_tokens ?? 0) + (trace.cache_read_tokens ?? 0) + (trace.cache_write_tokens ?? 0);
  if (llms.length >= 3 && promptSide > 20000 && (trace.cache_read_tokens ?? 0) / promptSide < 0.2) {
    out.push({ type: 'cache_miss', severity: 'low', key: agent, title: `Only ${Math.round((100 * (trace.cache_read_tokens ?? 0)) / promptSide)}% of ${Math.round(promptSide / 1000)}k prompt tokens hit the cache across ${llms.length} calls`, detail: { prompt_tokens: promptSide, cache_read_tokens: trace.cache_read_tokens, llm_calls: llms.length } });
  }

  for (const s of llms) {
    const at = (maybeJson(s.attributes) ?? {}) as Row;
    const toolsTokens = Number(at['blackbox.tools_tokens'] ?? 0);
    const toolsCount = Number(at['blackbox.tools_count'] ?? (Array.isArray(at['blackbox.tools']) ? at['blackbox.tools'].length : 0));
    if (toolsTokens > 15000 || toolsCount > 40) {
      out.push({ type: 'toolset_tax', severity: toolsTokens > 30000 ? 'high' : 'medium', key: agent, title: `${toolsCount} tool definitions (~${Math.round(toolsTokens / 1000)}k tokens) sent on every call`, span_id: s.span_id, detail: { tools_count: toolsCount, tools_tokens: toolsTokens } });
      break;
    }
  }

  for (const s of llms) {
    if ((s.duration_ms ?? 0) > 30000 || (s.ttft_ms ?? 0) > 10000) {
      out.push({ type: 'slow_llm', severity: 'low', key: `${s.model}`, title: `${s.model} took ${((s.duration_ms ?? 0) / 1000).toFixed(1)}s${s.ttft_ms ? ` (first token ${(s.ttft_ms / 1000).toFixed(1)}s)` : ''}`, span_id: s.span_id, detail: { duration_ms: s.duration_ms, ttft_ms: s.ttft_ms, model: s.model } });
      break;
    }
  }

  const answer = finalAnswer(spans, root);
  const refusalSpan = llms.find((s) => REFUSAL.test(textOfMessages(s.output, 'assistant')) || /refusal|content_filter/.test(s.finish_reason ?? ''));
  if (refusalSpan || (answer && REFUSAL.test(answer))) {
    out.push({ type: 'refusal', severity: 'medium', key: agent, title: `${agent} refused: "${clip(answer || textOfMessages(refusalSpan?.output, 'assistant'), 90)}"`, span_id: refusalSpan?.span_id ?? root?.span_id, detail: { answer: clip(answer, 400) } });
  }

  const userText = lastUser(root?.input) || (typeof maybeJson(root?.input) === 'string' ? (maybeJson(root?.input) as string) : '') || lastUser(llms[0]?.input);
  if (userText && FRUSTRATION.test(userText)) {
    out.push({ type: 'user_frustration', severity: 'medium', key: agent, title: `User frustrated: "${clip(userText, 90)}"`, span_id: root?.span_id, detail: { message: clip(userText, 400), match: FRUSTRATION.exec(userText)?.[0] } });
  }

  if (answer && SUCCESS_CLAIM.test(answer)) {
    const testRuns = tools.filter((t) => TEST_TOOL.test((t.tool_name ?? '') + ' ' + argsText(t)));
    const last = testRuns[testRuns.length - 1];
    const lastOut = last ? (typeof last.output === 'string' ? last.output : JSON.stringify(last.output ?? '')) : '';
    const failed = last && (last.status === 'error' || TEST_FAIL.test(lastOut));
    if (!testRuns.length || failed) {
      out.push({
        type: 'hallucinated_success',
        severity: 'high',
        key: agent,
        title: failed ? `${agent} claimed success but the last test run failed` : `${agent} claimed tests pass without running any`,
        span_id: last?.span_id ?? root?.span_id,
        detail: { claim: SUCCESS_CLAIM.exec(answer)?.[0], last_test_output: clip(lastOut, 300), test_runs: testRuns.length },
      });
    }
  }

  let untrusted: Row | null = null;
  let sensitive: Row | null = null;
  for (const t of tools) {
    const name = t.tool_name ?? t.name;
    const a = argsText(t);
    const o = typeof t.output === 'string' ? t.output : JSON.stringify(t.output ?? '');
    if (INJECTION.test(o)) {
      out.push({ type: 'prompt_injection', severity: 'high', key: `${agent}:${name}`, title: `Possible prompt injection in ${name} output`, span_id: t.span_id, detail: { tool: name, excerpt: clip(o.slice(Math.max(0, o.search(INJECTION) - 80)), 300) } });
    }
    if (!sensitive && UNTRUSTED_TOOL.test(name)) untrusted = t;
    else if (untrusted && !sensitive && SENSITIVE_ARG.test(a)) sensitive = t;
    else if (untrusted && sensitive && (EGRESS_TOOL.test(name) || /curl\s+.*(-d|--data|-X\s*POST)/i.test(a))) {
      out.push({
        type: 'toxic_flow',
        severity: 'high',
        key: `${agent}:${untrusted.tool_name}>${sensitive.tool_name}>${name}`,
        title: `Untrusted ${untrusted.tool_name} output, then ${sensitive.tool_name} on sensitive data, then ${name}`,
        span_id: t.span_id,
        detail: { untrusted: untrusted.span_id, sensitive: sensitive.span_id, egress: t.span_id, path: [untrusted.tool_name, sensitive.tool_name, name] },
      });
      break;
    }
  }

  for (const t of tools) {
    const a = argsText(t);
    const m = DESTRUCTIVE.exec(a);
    if (m) {
      out.push({ type: 'destructive_action', severity: 'high', key: `${agent}:${m[0].toLowerCase().replace(/\s+/g, ' ').slice(0, 30)}`, title: `${t.tool_name ?? t.name} ran a destructive command: ${clip(m[0], 60)}`, span_id: t.span_id, detail: { command: clip(a, 300), match: m[0] } });
    }
  }

  const llmErrors = llms.filter((s) => s.status === 'error');
  if (llmErrors.length >= 3) {
    const rate = llmErrors.filter((s) => /429|529|rate|overload/i.test(s.status_message ?? '')).length;
    out.push({ type: 'retry_storm', severity: 'medium', key: `${agent}:${llmErrors[0].model}`, title: `${llmErrors.length} failed LLM calls${rate ? ` (${rate} rate limited)` : ''} in one run`, span_id: llmErrors[0].span_id, detail: { errors: llmErrors.length, rate_limited: rate } });
  }

  if (!answer.trim() && root && root.status !== 'error' && llms.length && !tools.length) {
    out.push({ type: 'empty_output', severity: 'low', key: agent, title: `${agent} produced an empty final answer`, span_id: root.span_id });
  }

  const ask = answer ? ASK_AGAIN.exec(answer) : null;
  if (ask && trace.session_id) {
    const thing = ask[1].trim().split(' ').pop()!;
    const earlier = db.prepare(`select input_preview from traces where session_id = ? and start_ns < ? and input_preview like ?`).get(trace.session_id, trace.start_ns, `%${thing}%`) as Row | undefined;
    if (earlier) {
      out.push({ type: 'forgetting', severity: 'medium', key: agent, title: `${agent} asked for the ${ask[1].trim()} the user already gave`, span_id: root?.span_id, detail: { asked: ask[0], earlier: earlier.input_preview } });
    }
  }

  return out;
}

export function analyzeTrace(db: DB, traceId: string): number {
  const trace = db.prepare('select * from traces where trace_id = ?').get(traceId) as Row | undefined;
  if (!trace) return 0;
  const spans = db.prepare('select * from spans where trace_id = ? order by start_ns').all(traceId) as Row[];
  if (spans.some((s) => String(s.attributes ?? '').includes('"blackbox.internal":true'))) {
    db.prepare('update traces set analyzed_at = ? where trace_id = ?').run(nowMs(), traceId);
    return 0;
  }
  const found = detect(db, trace, spans);
  const now = nowMs();
  const created = Math.floor(trace.end_ns / 1e6) || now;
  db.exec('begin immediate');
  try {
    const prev = new Map((db.prepare('select fingerprint, status from signals where trace_id = ?').all(traceId) as Row[]).map((r) => [r.fingerprint, r.status]));
    db.prepare('delete from signals where trace_id = ?').run(traceId);
    const ins = db.prepare('insert or replace into signals(id, trace_id, span_id, session_id, type, severity, fingerprint, title, detail, created_at, status) values(?,?,?,?,?,?,?,?,?,?,?)');
    const seen = new Set<string>();
    for (const s of found) {
      const fp = sha(`${s.type}:${s.key}`).slice(0, 16);
      const id = sha(`${traceId}:${fp}:${s.span_id ?? ''}`).slice(0, 20);
      if (seen.has(id)) continue;
      seen.add(id);
      const status = prev.get(fp) ?? (db.prepare("select status from signals where fingerprint = ? and status != 'open' limit 1").get(fp) as Row | undefined)?.status ?? 'open';
      ins.run(id, traceId, s.span_id ?? null, trace.session_id, s.type, s.severity, fp, s.title, s.detail ? JSON.stringify(s.detail) : null, created, status === 'resolved' ? 'open' : status);
    }
    db.prepare('update traces set signal_count = ?, analyzed_at = ? where trace_id = ?').run(seen.size, now, traceId);
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return found.length;
}

export function analyzeSessions(db: DB, idleMs = 30 * 60e3): number {
  const cutoff = (nowMs() - idleMs) * 1e6;
  const rows = db
    .prepare(
      `select s.session_id, t.trace_id, t.error_count, t.root_span_id from sessions s
       join traces t on t.trace_id = (select trace_id from traces where session_id = s.session_id order by start_ns desc limit 1)
       where s.end_ns < ? and s.trace_count >= 2 and not exists (select 1 from signals g where g.session_id = s.session_id and g.type = 'abandoned')
       and (t.error_count > 0 or exists (select 1 from signals g where g.trace_id = t.trace_id and g.type in ('refusal','user_frustration','error_spans','forgetting')))`,
    )
    .all(cutoff) as Row[];
  const ins = db.prepare("insert or ignore into signals(id, trace_id, span_id, session_id, type, severity, fingerprint, title, detail, created_at, status) values(?,?,?,?,'abandoned','low',?,?,?,?,'open')");
  for (const r of rows) {
    const agent = (db.prepare('select agent_names from traces where trace_id = ?').get(r.trace_id) as Row).agent_names ?? 'agent';
    const fp = sha(`abandoned:${agent}`).slice(0, 16);
    const t = db.prepare('select end_ns from traces where trace_id = ?').get(r.trace_id) as Row;
    ins.run(sha(`${r.trace_id}:abandoned`).slice(0, 20), r.trace_id, r.root_span_id, r.session_id, fp, `Session ended right after a failed turn in ${agent}`, JSON.stringify({ last_trace: r.trace_id }), Math.floor(t.end_ns / 1e6));
    db.prepare('update traces set signal_count = signal_count + 1 where trace_id = ?').run(r.trace_id);
  }
  return rows.length;
}

export function analyzeAll(db: DB = getDb(), quietMs = 0): number {
  const due = db.prepare('select trace_id from traces where analyzed_at is null and updated_at <= ? order by start_ns').all(nowMs() - quietMs) as Row[];
  let n = 0;
  for (const r of due) n += analyzeTrace(db, r.trace_id);
  if (due.length) emit({ type: 'signals', ids: due.map((r) => r.trace_id) });
  return due.length;
}

export function startSignalWorker(db: DB = getDb()): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    try {
      analyzeAll(db, QUIET_MS);
    } catch (e) {
      console.error('[blackbox] signals', e);
    } finally {
      busy = false;
    }
  };
  const a = setInterval(tick, 1000);
  const b = setInterval(() => {
    try {
      if (analyzeSessions(db)) emit({ type: 'signals', ids: [] });
    } catch (e) {
      console.error('[blackbox] sessions', e);
    }
  }, 60000);
  return () => {
    clearInterval(a);
    clearInterval(b);
  };
}

