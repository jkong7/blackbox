import type { RawLog } from '../otlp.ts';
import type { DB } from '../db.ts';
import { indexSpanText } from '../fts.ts';
import type { SpanRow } from '../types.ts';
import { blankSpan } from '../normalize.ts';
import { memoryOpFromName } from '../normalize.ts';
import { sha, str, num, maybeJson, toJson } from '../util.ts';
import { previewOf, outputPreviewOf } from '../messages.ts';

function eventName(l: RawLog): string | null {
  const n = str(l.attributes['event.name']) ?? str(l.name) ?? (typeof l.body === 'string' ? l.body : null);
  if (!n) return null;
  return n.replace(/^claude_code\./, '');
}

function isClaudeCode(l: RawLog): boolean {
  const svc = str(l.resource['service.name']) ?? '';
  return svc === 'claude-code' || (l.scope ?? '').includes('claude_code') || String(l.name ?? '').startsWith('claude_code.') || (typeof l.body === 'string' && l.body.startsWith('claude_code.'));
}

function tsNs(l: RawLog): number {
  const t = str(l.attributes['event.timestamp']);
  if (t) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms * 1e6;
  }
  return l.timeNs;
}

const SYNTH_EVENTS = new Set(['user_prompt', 'api_request', 'api_error', 'tool_result', 'tool_decision', 'assistant_response', 'api_refusal', 'api_retries_exhausted', 'skill_activated']);

export function traceIdFor(promptId: string): string {
  return sha('cc-trace:' + promptId).slice(0, 32);
}

export function rootIdFor(promptId: string): string {
  return sha('cc-root:' + promptId).slice(0, 16);
}

export function claudeCodeLogToSpans(l: RawLog): SpanRow[] {
  if (!isClaudeCode(l) || l.traceId) return [];
  const ev = eventName(l);
  const at = l.attributes;
  const promptId = str(at['prompt.id']);
  const session = str(at['session.id'] ?? l.resource['session.id']);
  const user = str(at['user.email'] ?? at['user.id'] ?? at['user.account_uuid']);
  if (!ev || !promptId || !SYNTH_EVENTS.has(ev)) return [];
  const key = promptId;
  const traceId = traceIdFor(key);
  const rootId = rootIdFor(key);
  const ts = tsNs(l);
  const seq = str(at['event.sequence']) ?? String(ts);
  const common = { project: 'claude-code', session_id: session, user_id: user, trace_id: traceId };
  const out: SpanRow[] = [];
  const root = (extra: Partial<SpanRow> = {}) =>
    blankSpan({
      ...common,
      span_id: rootId,
      name: 'claude_code.prompt',
      kind: 'agent',
      source: 'claude-code-logs',
      agent_name: 'claude-code',
      start_ns: ts,
      end_ns: ts,
      ...extra,
    });

  if (ev === 'user_prompt') {
    const prompt = str(at['prompt']);
    out.push(
      root({
        input: prompt ? JSON.stringify([{ role: 'user', content: prompt }]) : null,
        attributes: JSON.stringify({ prompt_length: at['prompt_length'], 'prompt.id': promptId }),
      }),
    );
    return out;
  }

  out.push(root({ start_ns: ts, end_ns: ts }));
  const id = sha(`cc-span:${key}:${ev}:${seq}:${str(at['tool_use_id']) ?? ''}`).slice(0, 16);

  if (ev === 'api_request' || ev === 'api_error') {
    const dur = num(at['duration_ms']) ?? 0;
    const qs = str(at['query_source']);
    out.push(
      blankSpan({
        ...common,
        span_id: id,
        parent_id: rootId,
        name: ev === 'api_error' ? 'claude_code.api_error' : 'claude_code.api_request',
        kind: 'llm',
        source: 'claude-code-logs',
        operation: 'chat',
        provider: 'anthropic',
        model: str(at['model']),
        agent_name: qs && qs !== 'main' ? qs : 'claude-code',
        start_ns: ts - dur * 1e6,
        end_ns: ts,
        duration_ms: dur,
        status: ev === 'api_error' ? 'error' : 'ok',
        status_message: ev === 'api_error' ? str(at['error'] ?? at['status_code']) : null,
        input_tokens: num(at['input_tokens']),
        output_tokens: num(at['output_tokens']),
        cache_read_tokens: num(at['cache_read_tokens']),
        cache_write_tokens: num(at['cache_creation_tokens']),
        cost_usd: num(at['cost_usd']),
        ttft_ms: num(at['ttft_ms']),
        attributes: JSON.stringify(at),
      }),
    );
    return out;
  }

  if (ev === 'tool_result') {
    const dur = num(at['duration_ms']) ?? 0;
    const tool = str(at['tool_name']) ?? 'tool';
    const params = maybeJson(at['tool_parameters'] ?? at['tool_input']);
    const isMcp = tool.startsWith('mcp__') || str(at['mcp_server_scope']) != null;
    const memOp = memoryOpFromName(tool);
    const failed = at['success'] === false || at['success'] === 'false';
    out.push(
      blankSpan({
        ...common,
        span_id: id,
        parent_id: rootId,
        name: tool,
        kind: memOp ? 'memory' : isMcp ? 'mcp' : 'tool',
        source: 'claude-code-logs',
        operation: 'execute_tool',
        tool_name: tool,
        tool_call_id: str(at['tool_use_id']),
        mcp_server: isMcp ? tool.split('__')[1] ?? null : null,
        memory_op: memOp,
        start_ns: ts - dur * 1e6,
        end_ns: ts,
        duration_ms: dur,
        status: failed ? 'error' : 'ok',
        status_message: failed ? str(at['error']) : null,
        input: params != null ? JSON.stringify(params) : null,
        output: str(at['tool_result'] ?? at['tool_output']),
        attributes: JSON.stringify(at),
      }),
    );
    return out;
  }

  if (ev === 'tool_decision' || ev === 'api_refusal' || ev === 'api_retries_exhausted' || ev === 'permission_mode_changed' || ev === 'assistant_response' || ev === 'skill_activated' || ev === 'mcp_server_connection') {
    const isErr = ev === 'api_refusal' || ev === 'api_retries_exhausted' || (ev === 'tool_decision' && /reject|abort/.test(str(at['decision']) ?? ''));
    const text = ev === 'assistant_response' ? str(at['response'] ?? at['text'] ?? at['content']) : null;
    out.push(
      blankSpan({
        ...common,
        span_id: id,
        parent_id: rootId,
        name: 'claude_code.' + ev,
        kind: 'span',
        source: 'claude-code-logs',
        start_ns: ts,
        end_ns: ts,
        duration_ms: 0,
        status: isErr ? 'error' : 'ok',
        status_message: isErr ? str(at['decision'] ?? at['category'] ?? ev) : null,
        tool_name: str(at['tool_name']),
        output: text ? JSON.stringify([{ role: 'assistant', content: text }]) : null,
        attributes: JSON.stringify(at),
      }),
    );
    if (text) out[0] = root({ output: JSON.stringify([{ role: 'assistant', content: text }]) });
    return out;
  }
  return out;
}

type Row = Record<string, any>;

function patchSpan(db: DB, span: Row, patch: Row): void {
  const keys = Object.keys(patch).filter((k) => patch[k] !== undefined && patch[k] !== span[k]);
  if (!keys.length) return;
  if ('input' in patch) patch.input_preview = previewOf(maybeJson(patch.input));
  if ('output' in patch) patch.output_preview = outputPreviewOf(maybeJson(patch.output));
  const all = Object.keys(patch).filter((k) => patch[k] !== undefined);
  db.prepare(`update spans set ${all.map((k) => `${k} = ?`).join(', ')} where span_id = ?`).run(...all.map((k) => patch[k]), span.span_id);
  if ('input' in patch || 'output' in patch) indexSpanText(db, span.span_id);
}

export function enrichClaudeCodeTrace(db: DB, traceId: string): void {
  const logs = db.prepare(`select name, span_id, attributes from logs where trace_id = ? and name in ('claude_code.tool_result','claude_code.api_request','claude_code.api_error','claude_code.assistant_response','claude_code.user_prompt','tool_result','api_request','api_error','assistant_response','user_prompt') order by ts_ns`).all(traceId) as Row[];
  if (!logs.length) return;
  const spans = db.prepare('select span_id, name, kind, tool_call_id, input, output, status, status_message, cost_usd, attributes, parent_id from spans where trace_id = ?').all(traceId) as Row[];
  const byId = new Map(spans.map((s) => [s.span_id, s]));
  for (const l of logs) {
    const at = (maybeJson(l.attributes) ?? {}) as Row;
    const ev = String(at['event.name'] ?? l.name).replace(/^claude_code\./, '');
    if (ev === 'tool_result') {
      const tid = str(at['tool_use_id']);
      const span = spans.find((s) => s.tool_call_id === tid && s.name === 'claude_code.tool');
      if (!span) continue;
      const failed = at['success'] === 'false' || at['success'] === false;
      const params = maybeJson(at['tool_input'] ?? at['tool_parameters']);
      const result = at['tool_result'] ?? at['tool_output'] ?? at['tool_result_content'];
      patchSpan(db, span, {
        input: span.input ?? (params != null ? toJson(params) : undefined),
        output: span.output ?? (result != null ? toJson(maybeJson(result)) : undefined),
        status: failed ? 'error' : span.status === 'unset' ? 'ok' : span.status,
        status_message: failed ? span.status_message ?? str(at['error']) : span.status_message,
      });
    } else if (ev === 'api_request' || ev === 'api_error') {
      const rid = str(at['request_id']);
      const span = spans.find((s) => s.kind === 'llm' && rid && String(s.attributes ?? '').includes(rid));
      if (!span) continue;
      const cost = num(at['cost_usd']);
      patchSpan(db, span, { cost_usd: cost ?? span.cost_usd, status: ev === 'api_error' ? 'error' : span.status, status_message: ev === 'api_error' ? str(at['error']) : span.status_message });
    } else if (ev === 'assistant_response') {
      const span = l.span_id ? byId.get(l.span_id) : null;
      const text = str(at['response']);
      if (!span || !text || span.name !== 'claude_code.interaction') continue;
      patchSpan(db, span, { output: span.output ?? JSON.stringify([{ role: 'assistant', content: text }]) });
    } else if (ev === 'user_prompt') {
      const span = l.span_id ? byId.get(l.span_id) : null;
      const text = str(at['prompt'] ?? at['prompt_text']);
      if (!span || !text || span.name !== 'claude_code.interaction') continue;
      const cur = maybeJson(span.input);
      if (Array.isArray(cur)) continue;
      patchSpan(db, span, { input: JSON.stringify([{ role: 'user', content: text }]) });
    }
  }
}
