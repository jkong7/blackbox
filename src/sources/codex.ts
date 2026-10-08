import type { RawLog } from '../otlp.ts';
import type { SpanRow } from '../types.ts';
import { blankSpan, memoryOpFromName } from '../normalize.ts';
import { sha, str, num, maybeJson, toJson } from '../util.ts';

interface Turn {
  key: string;
  last: number;
}

const turns = new Map<string, Turn>();

function eventName(l: RawLog): string | null {
  const n = str(l.attributes['event.name']) ?? str(l.name) ?? (typeof l.body === 'string' ? l.body : null);
  return n && n.startsWith('codex.') ? n.slice(6) : null;
}

function tsNs(l: RawLog): number {
  const t = str(l.attributes['event.timestamp']);
  if (t) {
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms * 1e6;
  }
  return l.timeNs;
}

export function resetCodexTurns(): void {
  turns.clear();
}

export function codexLogToSpans(l: RawLog): SpanRow[] {
  const ev = eventName(l);
  if (!ev) return [];
  const at = l.attributes;
  const conv = str(at['conversation.id'] ?? l.resource['conversation.id']);
  if (!conv) return [];
  const ts = tsNs(l);
  let turn = turns.get(conv);
  if (!turn && ev !== 'user_prompt' && ev !== 'sse_event' && ev !== 'tool_result' && ev !== 'tool_decision') return [];
  if (ev === 'user_prompt' || !turn) {
    turn = { key: `${conv}:${ev === 'user_prompt' ? ts : 'start'}`, last: ts };
    turns.set(conv, turn);
    if (turns.size > 5000) turns.delete(turns.keys().next().value!);
  }
  const traceId = sha('codex-trace:' + turn.key).slice(0, 32);
  const rootId = sha('codex-root:' + turn.key).slice(0, 16);
  const model = str(at['model'] ?? at['slug']);
  const user = str(at['user.email'] ?? at['user.account_id']);
  const common = { project: 'codex', session_id: conv, user_id: user, trace_id: traceId };
  const root = (extra: Partial<SpanRow> = {}) =>
    blankSpan({ ...common, span_id: rootId, name: 'codex.turn', kind: 'agent', source: 'codex-logs', agent_name: 'codex', model, start_ns: ts, end_ns: ts, ...extra });
  const prevTs = turn.last;
  turn.last = ts;
  const id = sha(`codex-span:${turn.key}:${ev}:${ts}:${str(at['call_id']) ?? ''}`).slice(0, 16);

  if (ev === 'user_prompt') {
    const prompt = str(at['prompt']);
    return [root({ input: prompt ? JSON.stringify([{ role: 'user', content: prompt }]) : null, attributes: JSON.stringify({ prompt_length: at['prompt_length'], approval_policy: at['approval_policy'], sandbox_policy: at['sandbox_policy'] }) })];
  }

  if (ev === 'sse_event' && str(at['event.kind']) === 'response.completed') {
    const input = num(at['input_token_count']) ?? 0;
    const cached = num(at['cached_token_count']) ?? 0;
    const start = Math.min(prevTs, ts);
    return [
      root(),
      blankSpan({
        ...common,
        span_id: id,
        parent_id: rootId,
        name: `chat ${model ?? 'codex'}`,
        kind: 'llm',
        source: 'codex-logs',
        operation: 'chat',
        provider: 'openai',
        model,
        agent_name: 'codex',
        start_ns: start,
        end_ns: ts,
        duration_ms: (ts - start) / 1e6,
        status: 'ok',
        input_tokens: Math.max(0, input - cached),
        output_tokens: num(at['output_token_count']),
        cache_read_tokens: cached || null,
        cache_write_tokens: num(at['cache_write_token_count']) || null,
        reasoning_tokens: num(at['reasoning_token_count']) || null,
        ttft_ms: num(at['ttft_ms']),
        attributes: JSON.stringify({ reasoning_effort: at['model_reasoning_effort'], tool_token_count: at['tool_token_count'] }),
      }),
    ];
  }

  if (ev === 'sse_event' && /failed|error/.test(str(at['event.kind']) ?? '')) {
    return [root(), blankSpan({ ...common, span_id: id, parent_id: rootId, name: `chat ${model ?? 'codex'}`, kind: 'llm', source: 'codex-logs', operation: 'chat', provider: 'openai', model, start_ns: prevTs, end_ns: ts, duration_ms: (ts - prevTs) / 1e6, status: 'error', status_message: str(at['error.message'] ?? at['event.kind']) })];
  }

  if (ev === 'api_request' && (num(at['http.response.status_code']) ?? 200) >= 400) {
    const dur = num(at['duration_ms']) ?? 0;
    return [root(), blankSpan({ ...common, span_id: id, parent_id: rootId, name: 'codex.api_request', kind: 'span', source: 'codex-logs', start_ns: ts - dur * 1e6, end_ns: ts, duration_ms: dur, status: 'error', status_message: str(at['error.message']) ?? `HTTP ${at['http.response.status_code']}`, attributes: JSON.stringify({ endpoint: at['endpoint'], attempt: at['attempt'] }) })];
  }

  if (ev === 'tool_result') {
    const dur = num(at['duration_ms']) ?? 0;
    const tool = str(at['tool_name']) ?? 'tool';
    const failed = at['success'] === false || at['success'] === 'false';
    const ns = str(at['tool_namespace']) ?? '';
    const isMcp = tool.startsWith('mcp__') || ns.startsWith('mcp__') || str(at['mcp_server']) != null;
    const memOp = memoryOpFromName(tool);
    const args = maybeJson(at['arguments']);
    return [
      root(),
      blankSpan({
        ...common,
        span_id: id,
        parent_id: rootId,
        name: isMcp && ns.startsWith('mcp__') ? `${ns}__${tool}` : tool,
        kind: memOp ? 'memory' : isMcp ? 'mcp' : 'tool',
        source: 'codex-logs',
        operation: 'execute_tool',
        tool_name: tool,
        tool_call_id: str(at['call_id']),
        mcp_server: isMcp ? str(at['mcp_server']) ?? (ns.startsWith('mcp__') ? ns.slice(5) : tool.split('__').filter(Boolean)[1]) ?? null : null,
        memory_op: memOp,
        start_ns: ts - dur * 1e6,
        end_ns: ts,
        duration_ms: dur,
        status: failed ? 'error' : 'ok',
        status_message: failed ? str(at['output'])?.slice(0, 500) ?? 'tool failed' : null,
        input: args != null ? toJson(args) : null,
        output: str(at['output']),
        attributes: JSON.stringify({ call_id: at['call_id'], tool_namespace: ns || undefined, output_truncated: at['output_truncated'] }),
      }),
    ];
  }

  if (ev === 'tool_decision') {
    const decision = str(at['decision']) ?? '';
    const denied = /denied|reject|abort/i.test(decision);
    return [root(), blankSpan({ ...common, span_id: id, parent_id: rootId, name: 'codex.tool_decision', kind: 'span', source: 'codex-logs', start_ns: ts, end_ns: ts, duration_ms: 0, status: denied ? 'error' : 'ok', status_message: denied ? decision : null, tool_name: str(at['tool_name']), attributes: JSON.stringify({ decision, source: at['source'], call_id: at['call_id'] }) })];
  }

  if (ev === 'turn_ttft' || ev === 'websocket_request' || ev === 'conversation_starts') return [root()];
  return [];
}
