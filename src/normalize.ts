import type { RawSpan, Attrs } from './otlp.ts';
import type { Kind, Message, SpanRow } from './types.ts';
import { normalizeMessages, openInferenceMessages, openLLMetryMessages, previewOf, outputPreviewOf, textOf } from './messages.ts';
import { num, str, maybeJson, toJson } from './util.ts';

const MAX_PAYLOAD = 512 * 1024;

function a(attrs: Attrs, ...keys: string[]): unknown {
  for (const k of keys) {
    const v = attrs[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

const OP_KIND: Record<string, Kind> = {
  chat: 'llm',
  text_completion: 'llm',
  generate_content: 'llm',
  completion: 'llm',
  embeddings: 'embedding',
  embedding: 'embedding',
  execute_tool: 'tool',
  invoke_agent: 'agent',
  create_agent: 'agent',
  invoke_workflow: 'chain',
  plan: 'chain',
  retrieval: 'retriever',
  retrieve: 'retriever',
  rerank: 'retriever',
  create_memory: 'memory',
  search_memory: 'memory',
  update_memory: 'memory',
  upsert_memory: 'memory',
  delete_memory: 'memory',
  read_memory: 'memory',
};

const OI_KIND: Record<string, Kind> = {
  LLM: 'llm',
  TOOL: 'tool',
  AGENT: 'agent',
  CHAIN: 'chain',
  RETRIEVER: 'retriever',
  RERANKER: 'retriever',
  EMBEDDING: 'embedding',
  GUARDRAIL: 'guardrail',
  EVALUATOR: 'evaluator',
  PROMPT: 'chain',
  DECISION: 'chain',
};

const TL_KIND: Record<string, Kind> = { workflow: 'chain', task: 'chain', agent: 'agent', tool: 'tool' };

const MEMORY_TOOL = /(^|[_.\-\s/])(memory|memories|remember|recall|mem0|zep|graphiti|letta|archival_memory|core_memory|conversation_search)([_.\-\s/]|$)/i;

export function memoryOpFromName(name: string | null): string | null {
  if (!name || !MEMORY_TOOL.test(name)) return null;
  const n = name.toLowerCase();
  if (/(search|recall|query|retrieve|get|read|list|view|lookup|find)/.test(n)) return 'read';
  if (/(delete|remove|forget|clear)/.test(n)) return 'delete';
  if (/(update|replace|edit|rethink|upsert|patch|str_replace)/.test(n)) return 'update';
  if (/(add|create|insert|remember|store|save|write|append)/.test(n)) return 'write';
  return 'access';
}

function detectSource(s: RawSpan): string {
  const at = s.attributes;
  if (s.name.startsWith('claude_code.') || s.scope?.startsWith('com.anthropic.claude_code')) return 'claude-code';
  if (at['openinference.span.kind'] !== undefined) return 'openinference';
  if (at['traceloop.span.kind'] !== undefined || at['llm.request.type'] !== undefined || Object.keys(at).some((k) => k.startsWith('gen_ai.prompt.'))) return 'openllmetry';
  if (s.name.startsWith('ai.') || at['ai.operationId'] !== undefined) return 'vercel-ai';
  if (at['mcp.method.name'] !== undefined) return 'mcp';
  if (at['gen_ai.operation.name'] !== undefined || at['gen_ai.system'] !== undefined || at['gen_ai.provider.name'] !== undefined) return 'otel-genai';
  if (at['blackbox.source'] !== undefined) return String(at['blackbox.source']);
  if (s.scope?.includes('openai.agents') || at['openai.agents.span_type'] !== undefined) return 'openai-agents';
  return 'otel';
}

function detectKind(s: RawSpan, source: string): Kind {
  const at = s.attributes;
  const explicit = str(a(at, 'blackbox.kind'));
  if (explicit) return explicit as Kind;
  if (at['mcp.method.name'] !== undefined) return 'mcp';
  const op = str(a(at, 'gen_ai.operation.name'));
  if (op && OP_KIND[op]) return OP_KIND[op];
  const oi = str(at['openinference.span.kind']);
  if (oi && OI_KIND[oi.toUpperCase()]) return OI_KIND[oi.toUpperCase()];
  const tl = str(at['traceloop.span.kind']);
  if (tl && TL_KIND[tl]) return TL_KIND[tl];
  if (at['llm.request.type'] !== undefined) return 'llm';
  if (source === 'claude-code') {
    if (s.name === 'claude_code.interaction') return 'agent';
    if (s.name === 'claude_code.llm_request') return 'llm';
    if (s.name === 'claude_code.tool') return 'tool';
    if (s.name.startsWith('claude_code.subagent') || s.name.includes('agent')) return 'agent';
    return 'span';
  }
  if (source === 'vercel-ai') {
    if (/\.do(Generate|Stream)$/.test(s.name)) return 'llm';
    if (s.name === 'ai.toolCall') return 'tool';
    if (/^ai\.embed/.test(s.name)) return 'embedding';
    if (/^ai\.(generateText|streamText|generateObject|streamObject)$/.test(s.name)) return 'agent';
  }
  const st = str(a(at, 'openai.agents.span_type', 'span.type'));
  if (st) {
    const m: Record<string, Kind> = { agent: 'agent', generation: 'llm', response: 'llm', function: 'tool', handoff: 'handoff', guardrail: 'guardrail', custom: 'span' };
    if (m[st]) return m[st];
  }
  const n = s.name.toLowerCase();
  if (/^(chat|completion|generate_content|llm)\b/.test(n) || /(chatcompletion|messages\.create|anthropic\.chat|openai\.chat)/.test(n)) return 'llm';
  if (/^execute_tool\b|^tool[ :.]/.test(n)) return 'tool';
  if (/^invoke_agent\b|^agent[ :.]/.test(n)) return 'agent';
  if (/handoff/.test(n)) return 'handoff';
  if (/guardrail/.test(n)) return 'guardrail';
  if (/retriev|vector.?search|similarity/.test(n)) return 'retriever';
  if (/embed/.test(n)) return 'embedding';
  return 'span';
}

function attrsWithPrefix(at: Attrs, prefix: string): boolean {
  for (const k in at) if (k.startsWith(prefix)) return true;
  return false;
}

function eventMessages(s: RawSpan): { input: Message[] | null; output: Message[] | null } {
  const input: Message[] = [];
  const output: Message[] = [];
  for (const e of s.events) {
    const at = e.attributes;
    if (e.name === 'gen_ai.client.inference.operation.details' || e.name === 'gen_ai.content.prompt' || e.name === 'gen_ai.content.completion') {
      const im = normalizeMessages(at['gen_ai.input.messages'] ?? at['gen_ai.prompt']);
      const om = normalizeMessages(at['gen_ai.output.messages'] ?? at['gen_ai.completion']);
      const sys = maybeJson(at['gen_ai.system_instructions']);
      if (sys) input.push({ role: 'system', content: textOf(sys) });
      if (im) input.push(...im);
      if (om) output.push(...om);
      continue;
    }
    const m = /^gen_ai\.(system|user|assistant|tool)\.message$/.exec(e.name);
    if (m) {
      const body = maybeJson(at['content'] ?? at['gen_ai.event.content'] ?? at['body']);
      const msgs = normalizeMessages(typeof body === 'object' && body ? { role: m[1], ...(body as object) } : { role: m[1], content: body });
      if (msgs) input.push(...msgs);
      continue;
    }
    if (e.name === 'gen_ai.choice') {
      const body = maybeJson(at['message'] ?? at['content'] ?? at['body']);
      const msgs = normalizeMessages(typeof body === 'object' && body ? { role: 'assistant', ...(body as object) } : { role: 'assistant', content: body });
      if (msgs) output.push(...msgs);
    }
  }
  return { input: input.length ? input : null, output: output.length ? output : null };
}

function extractIO(s: RawSpan, source: string, kind: Kind): { input: unknown; output: unknown } {
  const at = s.attributes;
  let input: unknown = null;
  let output: unknown = null;

  const gi = at['gen_ai.input.messages'];
  const go = at['gen_ai.output.messages'];
  if (gi !== undefined || go !== undefined) {
    const msgs = normalizeMessages(gi) ?? [];
    const sys = maybeJson(at['gen_ai.system_instructions']);
    if (sys) msgs.unshift({ role: 'system', content: textOf(sys) });
    input = msgs.length ? msgs : null;
    output = normalizeMessages(go);
  }

  if (input == null && attrsWithPrefix(at, 'llm.input_messages.')) input = openInferenceMessages(at, 'llm.input_messages');
  if (output == null && attrsWithPrefix(at, 'llm.output_messages.')) output = openInferenceMessages(at, 'llm.output_messages');
  if (input == null && attrsWithPrefix(at, 'gen_ai.prompt.')) input = openLLMetryMessages(at, 'gen_ai.prompt');
  if (output == null && attrsWithPrefix(at, 'gen_ai.completion.')) output = openLLMetryMessages(at, 'gen_ai.completion');

  if (input == null && source === 'vercel-ai') {
    input = normalizeMessages(at['ai.prompt.messages']) ?? normalizeMessages(at['ai.prompt']) ?? maybeJson(at['ai.toolCall.args'] ?? at['ai.toolCall.input']);
  }
  if (output == null && source === 'vercel-ai') {
    const text = at['ai.response.text'];
    const calls = maybeJson(at['ai.response.toolCalls']);
    if (text != null || Array.isArray(calls)) {
      const msg: Message = { role: 'assistant', content: text != null ? String(text) : '' };
      if (Array.isArray(calls) && calls.length) msg.tool_calls = calls.map((c: any) => ({ id: c.toolCallId, name: c.toolName, arguments: maybeJson(c.args ?? c.input) }));
      output = [msg];
    } else if (at['ai.toolCall.result'] !== undefined || at['ai.toolCall.output'] !== undefined) {
      output = maybeJson(at['ai.toolCall.result'] ?? at['ai.toolCall.output']);
    } else if (at['ai.response.object'] !== undefined) {
      output = maybeJson(at['ai.response.object']);
    }
  }

  if (input == null || output == null) {
    const ev = eventMessages(s);
    if (input == null) input = ev.input;
    if (output == null) output = ev.output;
  }

  if (kind === 'tool' || kind === 'mcp' || kind === 'memory') {
    if (input == null) input = maybeJson(a(at, 'gen_ai.tool.call.arguments', 'tool.parameters', 'tool.arguments', 'mcp.tool.arguments', 'input.value', 'traceloop.entity.input', 'tool_input', 'gen_ai.memory.query.text'));
    if (output == null) output = maybeJson(a(at, 'gen_ai.tool.call.result', 'tool.result', 'tool.output', 'output.value', 'traceloop.entity.output', 'tool_result', 'mcp.tool.result'));
  }
  if (input == null) input = maybeJson(a(at, 'input.value', 'traceloop.entity.input', 'blackbox.input', 'gen_ai.prompt', 'user_prompt', 'prompt'));
  if (output == null) output = maybeJson(a(at, 'output.value', 'traceloop.entity.output', 'blackbox.output', 'gen_ai.completion', 'response'));

  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const o = input as Record<string, unknown>;
    if (Array.isArray(o.messages) && kind === 'llm') input = normalizeMessages(o) ?? input;
  }
  if (output && typeof output === 'object' && !Array.isArray(output) && kind === 'llm') {
    const o = output as Record<string, any>;
    if (Array.isArray(o.choices)) output = normalizeMessages(o.choices.map((c: any) => c.message).filter(Boolean)) ?? output;
    else if (o.role && o.content !== undefined) output = normalizeMessages([o]) ?? output;
  }
  return { input, output };
}

function capPayload(v: unknown): string | null {
  const s = toJson(v);
  if (s == null) return null;
  if (s.length <= MAX_PAYLOAD) return s;
  return JSON.stringify({ truncated: true, bytes: s.length, head: s.slice(0, MAX_PAYLOAD) });
}

function compactAttrs(at: Attrs): string | null {
  const out: Attrs = {};
  for (const [k, v] of Object.entries(at)) {
    if (/^(llm\.(input|output)_messages\.|gen_ai\.(prompt|completion)\.\d)/.test(k)) continue;
    if (k === 'gen_ai.input.messages' || k === 'gen_ai.output.messages' || k === 'input.value' || k === 'output.value') continue;
    if (typeof v === 'string' && v.length > 8192) out[k] = v.slice(0, 8192) + '…';
    else out[k] = v;
  }
  return Object.keys(out).length ? JSON.stringify(out) : null;
}

function inputTokensNormalized(at: Attrs, provider: string | null, source: string): { input: number | null; cacheRead: number | null; cacheWrite: number | null } {
  let input = num(a(at, 'gen_ai.usage.input_tokens', 'gen_ai.usage.prompt_tokens', 'llm.token_count.prompt', 'llm.usage.prompt_tokens', 'ai.usage.promptTokens', 'ai.usage.inputTokens', 'input_tokens'));
  const cacheRead = num(a(at, 'gen_ai.usage.cache_read.input_tokens', 'gen_ai.usage.cache_read_input_tokens', 'llm.token_count.prompt_details.cache_read', 'gen_ai.usage.input_tokens_details.cached_tokens', 'ai.usage.cachedInputTokens', 'cache_read_tokens'));
  const cacheWrite = num(a(at, 'gen_ai.usage.cache_write.input_tokens', 'gen_ai.usage.cache_creation.input_tokens', 'gen_ai.usage.cache_creation_input_tokens', 'llm.token_count.prompt_details.cache_write', 'cache_creation_tokens', 'cache_write_tokens'));
  const inclusive = provider && /openai|azure|gemini|google|vertex/.test(provider) || source === 'openinference';
  if (input != null && inclusive) {
    const sub = (cacheRead ?? 0) + (source === 'openinference' ? cacheWrite ?? 0 : 0);
    if (sub && input >= sub) input -= sub;
  }
  return { input, cacheRead, cacheWrite };
}

export function normalizeSpan(s: RawSpan, project = 'default'): SpanRow {
  const at = s.attributes;
  const res = s.resource;
  const source = detectSource(s);
  let kind = detectKind(s, source);
  const operation = str(a(at, 'gen_ai.operation.name')) ?? (kind === 'llm' ? 'chat' : null);
  const provider = str(a(at, 'gen_ai.provider.name', 'gen_ai.system', 'llm.provider', 'llm.system', 'ai.model.provider'));
  const model = str(a(at, 'gen_ai.response.model', 'gen_ai.request.model', 'llm.model_name', 'llm.response.model', 'llm.request.model', 'ai.model.id', 'ai.response.model', 'model'));
  let toolName = str(a(at, 'gen_ai.tool.name', 'tool.name', 'ai.toolCall.name', 'mcp.tool.name', 'tool_name', 'traceloop.entity.name'));
  if (kind !== 'tool' && kind !== 'mcp' && kind !== 'memory' && toolName && at['traceloop.entity.name'] === toolName) toolName = null;
  if (!toolName && kind === 'tool') toolName = s.name.replace(/^(execute_tool|tool)[\s.:]+/, '') || null;
  const mcpMethod = str(a(at, 'mcp.method.name'));
  const mcpServer = str(a(at, 'mcp.server.name', 'mcp_server.name', 'mcp.server', 'server.address')) ?? (mcpMethod ? str(res['service.name']) : null);
  if (kind === 'tool' && toolName && /^mcp__/.test(toolName)) {
    kind = 'mcp';
  }
  let memoryOp = str(a(at, 'blackbox.memory.op'));
  if (!memoryOp && operation && operation.endsWith('_memory')) memoryOp = operation.replace('_memory', '');
  if (!memoryOp && (kind === 'tool' || kind === 'mcp')) memoryOp = memoryOpFromName(toolName);
  if (memoryOp) kind = 'memory';

  const { input: inTok, cacheRead, cacheWrite } = inputTokensNormalized(at, provider, source);
  const outTok = num(a(at, 'gen_ai.usage.output_tokens', 'gen_ai.usage.completion_tokens', 'llm.token_count.completion', 'llm.usage.completion_tokens', 'ai.usage.completionTokens', 'ai.usage.outputTokens', 'output_tokens'));
  const reasoning = num(a(at, 'gen_ai.usage.reasoning.output_tokens', 'gen_ai.usage.reasoning_tokens', 'llm.token_count.completion_details.reasoning', 'gen_ai.usage.output_tokens_details.reasoning_tokens', 'ai.usage.reasoningTokens'));
  const cost = num(a(at, 'blackbox.cost_usd', 'llm.cost.total', 'gen_ai.usage.cost', 'gen_ai.cost.total', 'cost_usd', 'langfuse.observation.cost_details.total'));
  let ttft = num(a(at, 'ttft_ms', 'gen_ai.response.time_to_first_chunk_ms', 'ai.response.msToFirstChunk', 'gen_ai.server.time_to_first_token_ms'));
  if (ttft == null) {
    const secs = num(a(at, 'gen_ai.client.operation.time_to_first_chunk', 'gen_ai.response.time_to_first_chunk', 'gen_ai.server.time_to_first_token'));
    if (secs != null) ttft = secs * 1000;
  }
  const finish = maybeJson(a(at, 'gen_ai.response.finish_reasons', 'llm.finish_reason', 'ai.response.finishReason', 'stop_reason'));
  const finishReason = Array.isArray(finish) ? finish.join(',') : str(finish);

  const { input, output } = extractIO(s, source, kind);
  const statusErr = s.statusCode === 2 || at['error.type'] !== undefined && at['error.type'] !== null || at['tool.is_error'] === true || at['mcp.tool.is_error'] === true || at['success'] === false || at['success'] === 'false' || at['success'] === 'False';
  const okAttr = at['success'] === true || at['success'] === 'true' || at['success'] === 'True';
  const status: SpanRow['status'] = statusErr ? 'error' : s.statusCode === 1 || okAttr ? 'ok' : 'unset';
  let statusMessage = s.statusMessage ?? str(a(at, 'error.message', 'error.type', 'exception.message', 'error'));
  if (!statusMessage) {
    const exc = s.events.find((e) => e.name === 'exception');
    if (exc) statusMessage = str(exc.attributes['exception.message'] ?? exc.attributes['exception.type']);
  }

  const session = str(a(at, 'session.id', 'gen_ai.conversation.id', 'langfuse.session.id', 'ai.telemetry.metadata.sessionId', 'thread_id', 'metadata.thread_id', 'langsmith.metadata.thread_id', 'conversation.id', 'traceloop.association.properties.session_id', 'blackbox.session_id')) ?? str(a(res, 'session.id', 'gen_ai.conversation.id'));
  const user = (source === 'claude-code' ? str(at['user.email']) : null) ?? str(a(at, 'user.id', 'enduser.id', 'langfuse.user.id', 'ai.telemetry.metadata.userId', 'traceloop.association.properties.user_id', 'user.account_uuid', 'blackbox.user_id')) ?? str(a(res, 'user.id', 'enduser.id'));
  const agentName = str(a(at, 'gen_ai.agent.name', 'agent.name', 'ai.telemetry.functionId', 'graph.node.id', 'subagent_type', 'agent_type')) ?? (s.name === 'claude_code.interaction' ? 'claude-code' : null) ?? (kind === 'agent' && source !== 'claude-code' ? s.name.replace(/^invoke_agent\s+/, '') : null);

  const startNs = s.startNs || Date.now() * 1e6;
  const endNs = s.endNs;
  const duration = endNs ? (endNs - startNs) / 1e6 : num(a(at, 'duration_ms'));

  const eventsOut = s.events
    .filter((e) => !/^gen_ai\.(system|user|assistant|tool)\.message$|^gen_ai\.choice$/.test(e.name))
    .map((e) => ({ name: e.name, time_ns: e.timeNs, attributes: e.attributes }));

  return {
    span_id: s.spanId,
    trace_id: s.traceId,
    parent_id: s.parentSpanId,
    project: str(a(at, 'blackbox.project')) ?? str(res['blackbox.project']) ?? project,
    name: s.name,
    kind,
    source,
    operation,
    start_ns: startNs,
    end_ns: endNs,
    duration_ms: duration,
    status,
    status_message: statusMessage,
    session_id: session,
    user_id: user,
    agent_name: agentName,
    model,
    provider,
    tool_name: toolName,
    tool_call_id: str(a(at, 'gen_ai.tool.call.id', 'tool_call.id', 'ai.toolCall.id', 'tool_use_id')),
    mcp_server: mcpServer ?? (toolName && /^mcp__/.test(toolName) ? toolName.split('__')[1] ?? null : null),
    mcp_method: mcpMethod,
    memory_op: memoryOp,
    input_tokens: inTok,
    output_tokens: outTok,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoning,
    cost_usd: cost,
    ttft_ms: ttft,
    finish_reason: finishReason,
    input: capPayload(input),
    output: capPayload(output),
    input_preview: previewOf(input),
    output_preview: outputPreviewOf(output),
    attributes: compactAttrs(at),
    events: eventsOut.length ? JSON.stringify(eventsOut) : null,
    resource: Object.keys(res).length ? JSON.stringify(res) : null,
  };
}

export function blankSpan(partial: Partial<SpanRow> & { span_id: string; trace_id: string; name: string; start_ns: number }): SpanRow {
  const input = partial.input ?? null;
  const output = partial.output ?? null;
  const parsedIn = input ? maybeJson(input) : null;
  const parsedOut = output ? maybeJson(output) : null;
  return {
    parent_id: null,
    project: 'default',
    kind: 'span',
    source: 'sdk',
    operation: null,
    end_ns: null,
    duration_ms: null,
    status: 'unset',
    status_message: null,
    session_id: null,
    user_id: null,
    agent_name: null,
    model: null,
    provider: null,
    tool_name: null,
    tool_call_id: null,
    mcp_server: null,
    mcp_method: null,
    memory_op: null,
    input_tokens: null,
    output_tokens: null,
    cache_read_tokens: null,
    cache_write_tokens: null,
    reasoning_tokens: null,
    cost_usd: null,
    ttft_ms: null,
    finish_reason: null,
    input_preview: previewOf(parsedIn),
    output_preview: outputPreviewOf(parsedOut),
    attributes: null,
    events: null,
    resource: null,
    ...partial,
    input,
    output,
  };
}

