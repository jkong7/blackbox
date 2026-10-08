import { createServer, request as httpRequest, Agent as HttpAgent, type IncomingMessage, type ServerResponse, type Server, type IncomingHttpHeaders, type OutgoingHttpHeaders, type ClientRequest } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';
import type { Transform } from 'node:stream';
import type { Message, SpanRow } from './types.ts';
import { blankSpan } from './normalize.ts';
import { normalizeMessages, normalizeMessage, textOf } from './messages.ts';
import { hexId, sha, shortHash, stableStringify, num, str } from './util.ts';
import { ingestSpanRows, onFlush } from './ingest.ts';
import { getDb } from './db.ts';
import { parseTraceparent } from './tracecontext.ts';

export { parseTraceparent };
export type { TraceParent } from './tracecontext.ts';

type Any = Record<string, any>;

export type Provider = 'anthropic' | 'openai';
export type ApiKind = 'messages' | 'chat' | 'responses' | 'passthrough';

const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'trailers', 'transfer-encoding', 'upgrade', 'host']);
const MAX_INPUT = 512 * 1024;
const MAX_OUTPUT = 256 * 1024;
const httpsAgent = new HttpsAgent({ keepAlive: true, timeout: 15000, maxFreeSockets: 32 });
const httpAgent = new HttpAgent({ keepAlive: true, timeout: 15000, maxFreeSockets: 32 });

export class SseParser {
  buf = '';
  event = '';
  data: string[] = [];
  decoder = new TextDecoder();
  onEvent: (event: string, data: string) => void;

  constructor(onEvent: (event: string, data: string) => void) {
    this.onEvent = onEvent;
  }

  push(chunk: Uint8Array | string): void {
    this.buf += typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      let line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      this.line(line);
    }
  }

  end(): void {
    this.buf += this.decoder.decode();
    if (this.buf) {
      const rest = this.buf.split(/\r?\n/);
      this.buf = '';
      for (const l of rest) this.line(l);
    }
    this.dispatch();
  }

  line(line: string): void {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return;
    const c = line.indexOf(':');
    const field = c < 0 ? line : line.slice(0, c);
    let value = c < 0 ? '' : line.slice(c + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
  }

  dispatch(): void {
    if (this.data.length) this.onEvent(this.event || 'message', this.data.join('\n'));
    this.event = '';
    this.data = [];
  }
}

function parse(data: string): Any | null {
  try {
    const v = JSON.parse(data);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

function mergeNumbers(into: Any, from: Any | null | undefined): void {
  if (!from || typeof from !== 'object') return;
  for (const [k, v] of Object.entries(from)) {
    if (v == null) continue;
    if (typeof v === 'object' && !Array.isArray(v)) {
      into[k] = into[k] && typeof into[k] === 'object' ? into[k] : {};
      mergeNumbers(into[k], v as Any);
    } else into[k] = v;
  }
}

export interface StreamAccumulator {
  firstContentAt: number | null;
  handle(event: string, data: string, now?: number): void;
  result(): Any | null;
  error(): string | null;
}

export class AnthropicStream implements StreamAccumulator {
  firstContentAt: number | null = null;
  message: Any = {};
  blocks: Any[] = [];
  partial: Record<number, string> = {};
  usage: Any = {};
  err: string | null = null;
  seen = false;

  handle(_event: string, data: string, now = performance.now()): void {
    const d = parse(data);
    if (!d) return;
    this.seen = true;
    if (d.type === 'message_start') {
      this.message = { ...(d.message ?? {}) };
      mergeNumbers(this.usage, d.message?.usage);
    } else if (d.type === 'content_block_start') {
      const b = { ...(d.content_block ?? {}) };
      if (b.type === 'tool_use' || b.type === 'server_tool_use' || b.type === 'mcp_tool_use') this.partial[d.index] = '';
      this.blocks[d.index] = b;
    } else if (d.type === 'content_block_delta') {
      if (this.firstContentAt == null) this.firstContentAt = now;
      const b = (this.blocks[d.index] ??= { type: 'text', text: '' });
      const dl = d.delta ?? {};
      if (dl.type === 'text_delta') b.text = (b.text ?? '') + (dl.text ?? '');
      else if (dl.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + (dl.thinking ?? '');
      else if (dl.type === 'signature_delta') b.signature = (b.signature ?? '') + (dl.signature ?? '');
      else if (dl.type === 'input_json_delta') this.partial[d.index] = (this.partial[d.index] ?? '') + (dl.partial_json ?? '');
      else if (dl.type === 'citations_delta') (b.citations ??= []).push(dl.citation);
    } else if (d.type === 'content_block_stop') {
      this.closeBlock(d.index);
    } else if (d.type === 'message_delta') {
      if (d.delta?.stop_reason !== undefined) this.message.stop_reason = d.delta.stop_reason;
      if (d.delta?.stop_sequence !== undefined) this.message.stop_sequence = d.delta.stop_sequence;
      mergeNumbers(this.usage, d.usage);
    } else if (d.type === 'error') {
      this.err = str(d.error?.message ?? d.error?.type) ?? 'stream error';
    }
  }

  closeBlock(i: number): void {
    const raw = this.partial[i];
    if (raw === undefined) return;
    delete this.partial[i];
    const b = this.blocks[i];
    if (!b) return;
    if (raw === '') b.input = b.input && Object.keys(b.input).length ? b.input : {};
    else {
      try {
        b.input = JSON.parse(raw);
      } catch {
        b.input = raw;
      }
    }
  }

  result(): Any | null {
    if (!this.seen) return null;
    for (const k of Object.keys(this.partial)) this.closeBlock(Number(k));
    return { ...this.message, role: 'assistant', content: this.blocks.filter(Boolean), usage: this.usage };
  }

  error(): string | null {
    return this.err;
  }
}

export class OpenAIChatStream implements StreamAccumulator {
  firstContentAt: number | null = null;
  id: string | null = null;
  model: string | null = null;
  choices: Any[] = [];
  usage: Any | null = null;
  err: string | null = null;
  seen = false;

  handle(_event: string, data: string, now = performance.now()): void {
    if (data.trim() === '[DONE]') return;
    const d = parse(data);
    if (!d) return;
    this.seen = true;
    if (d.error) {
      this.err = str(d.error.message ?? d.error) ?? 'stream error';
      return;
    }
    this.id ??= d.id ?? null;
    this.model = d.model ?? this.model;
    if (d.usage) this.usage = d.usage;
    for (const c of d.choices ?? []) {
      const i = c.index ?? 0;
      const ch = (this.choices[i] ??= { index: i, message: { role: 'assistant', content: '' }, finish_reason: null });
      const dl = c.delta ?? {};
      if (dl.role) ch.message.role = dl.role;
      const reasoning = dl.reasoning_content ?? dl.reasoning;
      if (typeof dl.content === 'string' && dl.content) {
        if (this.firstContentAt == null) this.firstContentAt = now;
        ch.message.content += dl.content;
      }
      if (typeof reasoning === 'string' && reasoning) {
        if (this.firstContentAt == null) this.firstContentAt = now;
        ch.message.reasoning_content = (ch.message.reasoning_content ?? '') + reasoning;
      }
      if (dl.refusal) ch.message.refusal = (ch.message.refusal ?? '') + dl.refusal;
      if (Array.isArray(dl.tool_calls)) {
        if (this.firstContentAt == null) this.firstContentAt = now;
        ch.message.tool_calls ??= [];
        for (const t of dl.tool_calls) {
          const ti = t.index ?? ch.message.tool_calls.length;
          const cur = (ch.message.tool_calls[ti] ??= { id: t.id, type: 'function', function: { name: '', arguments: '' } });
          if (t.id) cur.id = t.id;
          if (t.function?.name) cur.function.name += t.function.name;
          if (t.function?.arguments) cur.function.arguments += t.function.arguments;
        }
      }
      if (c.finish_reason) ch.finish_reason = c.finish_reason;
    }
  }

  result(): Any | null {
    if (!this.seen) return null;
    const choices = this.choices.filter(Boolean).map((c) => {
      const m = { ...c.message };
      if (m.tool_calls) m.tool_calls = m.tool_calls.filter(Boolean);
      return { ...c, message: m };
    });
    return { id: this.id, model: this.model, object: 'chat.completion', choices, usage: this.usage };
  }

  error(): string | null {
    return this.err;
  }
}

export class OpenAIResponsesStream implements StreamAccumulator {
  firstContentAt: number | null = null;
  response: Any | null = null;
  items: Any[] = [];
  err: string | null = null;

  handle(event: string, data: string, now = performance.now()): void {
    const d = parse(data);
    if (!d) return;
    const type = String(d.type ?? event);
    if (/\.delta$/.test(type) && this.firstContentAt == null) this.firstContentAt = now;
    if (type === 'response.created' || type === 'response.in_progress') this.response = { ...(this.response ?? {}), ...(d.response ?? {}) };
    else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
      if (d.item) this.items[d.output_index ?? this.items.length] = d.item;
    } else if (type === 'response.output_text.delta') {
      const it = (this.items[d.output_index] ??= { type: 'message', role: 'assistant', content: [] });
      const parts = (it.content ??= []);
      const p = (parts[d.content_index ?? 0] ??= { type: 'output_text', text: '' });
      p.text = (p.text ?? '') + (d.delta ?? '');
    } else if (type === 'response.function_call_arguments.delta') {
      const it = (this.items[d.output_index] ??= { type: 'function_call', arguments: '' });
      it.arguments = (it.arguments ?? '') + (d.delta ?? '');
    } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      this.response = d.response ?? this.response;
      if (type === 'response.failed') this.err = str(d.response?.error?.message) ?? 'response failed';
    } else if (type === 'error') {
      this.err = str(d.message ?? d.error?.message ?? d.code) ?? 'stream error';
    }
  }

  result(): Any | null {
    if (!this.response && !this.items.length) return null;
    const r = { ...(this.response ?? {}) };
    if (!Array.isArray(r.output) || !r.output.length) r.output = this.items.filter(Boolean);
    return r;
  }

  error(): string | null {
    return this.err;
  }
}

export function accumulatorFor(provider: Provider, api: ApiKind): StreamAccumulator | null {
  if (provider === 'anthropic' && api === 'messages') return new AnthropicStream();
  if (provider === 'openai' && api === 'chat') return new OpenAIChatStream();
  if (provider === 'openai' && api === 'responses') return new OpenAIResponsesStream();
  return null;
}

export function responsesInputMessages(body: Any): Message[] {
  const out: Message[] = [];
  if (body.instructions) out.push({ role: 'system', content: textOf(body.instructions) });
  const input = body.input;
  if (typeof input === 'string') {
    out.push({ role: 'user', content: input });
    return out;
  }
  if (!Array.isArray(input)) return out;
  for (const it of input) {
    if (!it || typeof it !== 'object') continue;
    if (it.type === 'function_call' || it.type === 'custom_tool_call') {
      const last = out[out.length - 1];
      const call = { id: it.call_id ?? it.id, name: it.name, arguments: parseMaybe(it.arguments ?? it.input) };
      if (last && last.role === 'assistant') (last.tool_calls ??= []).push(call);
      else out.push({ role: 'assistant', content: '', tool_calls: [call] });
    } else if (it.type === 'function_call_output' || it.type === 'custom_tool_call_output') {
      out.push({ role: 'tool', tool_call_id: it.call_id, content: textOf(parseMaybe(it.output)) });
    } else if (it.type === 'reasoning') {
      const text = (it.summary ?? []).map((s: Any) => s.text ?? '').join('\n');
      if (text) out.push({ role: 'assistant', content: '', reasoning: text });
    } else if (it.role) {
      out.push(...normalizeMessage({ role: it.role === 'developer' ? 'system' : it.role, content: contentParts(it.content) }));
    }
  }
  return out;
}

function contentParts(c: unknown): unknown {
  if (!Array.isArray(c)) return c;
  return c.map((p: Any) => (p && (p.type === 'input_text' || p.type === 'output_text') ? { type: 'text', text: p.text } : p && p.type === 'input_image' ? { type: 'image' } : p));
}

function parseMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export function responsesOutputMessage(r: Any | null): Message[] | null {
  if (!r || !Array.isArray(r.output)) return null;
  const msg: Message = { role: 'assistant', content: '' };
  const texts: string[] = [];
  const reasoning: string[] = [];
  for (const it of r.output) {
    if (!it) continue;
    if (it.type === 'message') texts.push(textOf(contentParts(it.content)));
    else if (it.type === 'function_call' || it.type === 'custom_tool_call') (msg.tool_calls ??= []).push({ id: it.call_id ?? it.id, name: it.name, arguments: parseMaybe(it.arguments ?? it.input) });
    else if (it.type === 'reasoning') reasoning.push((it.summary ?? []).map((s: Any) => s.text ?? '').join('\n'));
    else if (/_call$/.test(String(it.type))) (msg.tool_calls ??= []).push({ id: it.id, name: it.type, arguments: it.action ?? it.arguments ?? null });
  }
  msg.content = texts.filter(Boolean).join('\n');
  const rs = reasoning.filter(Boolean).join('\n');
  if (rs) msg.reasoning = rs;
  return [msg];
}

export interface ToolsInfo {
  names: string[];
  count: number;
  tokens: number;
  hash: string | null;
}

export function toolsInfo(tools: unknown): ToolsInfo {
  if (!Array.isArray(tools) || !tools.length) return { names: [], count: 0, tokens: 0, hash: null };
  const names = tools.map((t: Any) => String(t?.name ?? t?.function?.name ?? t?.type ?? 'tool'));
  const json = JSON.stringify(tools);
  return { names, count: tools.length, tokens: Math.ceil(json.length / 4), hash: shortHash(stableStringify(tools)) };
}

export function capMessages(msgs: Message[] | null, max = MAX_INPUT): Message[] | null {
  if (!msgs) return null;
  let json = JSON.stringify(msgs);
  if (json.length <= max) return msgs;
  const clipped = msgs.map((m) => (m.content && m.content.length > 20000 ? { ...m, content: m.content.slice(0, 20000) + '… [' + (m.content.length - 20000) + ' chars clipped]' } : m));
  json = JSON.stringify(clipped);
  if (json.length <= max) return clipped;
  const head: Message[] = [];
  let i = 0;
  while (i < clipped.length && clipped[i].role === 'system') head.push(clipped[i++]);
  if (i < clipped.length) head.push(clipped[i++]);
  const tail: Message[] = [];
  let size = JSON.stringify(head).length + 100;
  for (let j = clipped.length - 1; j >= i; j--) {
    const s = JSON.stringify(clipped[j]).length;
    if (size + s > max && tail.length) break;
    tail.unshift(clipped[j]);
    size += s;
  }
  const omitted = clipped.length - head.length - tail.length;
  return omitted > 0 ? [...head, { role: 'system', content: `[blackbox: ${omitted} earlier messages omitted]` }, ...tail] : [...head, ...tail];
}

function errorMessage(body: string): string | null {
  const d = parse(body);
  if (d) {
    const m = d.error?.message ?? d.message ?? d.error?.type ?? (typeof d.error === 'string' ? d.error : null);
    if (m) return String(m);
  }
  const t = body.trim();
  return t ? t.slice(0, 500) : null;
}

function header(h: IncomingHttpHeaders, name: string): string | null {
  const v = h[name];
  if (Array.isArray(v)) return v[0] ?? null;
  return v ?? null;
}

export function sessionFromMetadata(body: Any): string | null {
  const uid = body?.metadata?.user_id;
  if (typeof uid !== 'string') return null;
  const j = parse(uid);
  if (j && typeof j.session_id === 'string') return j.session_id;
  const m = /session_([0-9a-f-]{8,})/i.exec(uid);
  return m ? m[1] : null;
}

function toTraceId(v: string): string {
  return /^[0-9a-f]{32}$/i.test(v) ? v.toLowerCase() : sha('bb-trace:' + v).slice(0, 32);
}

export interface ProxyCall {
  provider: Provider;
  api: ApiKind;
  path: string;
  reqHeaders: IncomingHttpHeaders;
  reqBody: Any | null;
  status: number;
  resHeaders: IncomingHttpHeaders;
  response: Any | null;
  streamError: string | null;
  errorBody: string | null;
  startMs: number;
  startPerf: number;
  endPerf: number;
  firstContentPerf: number | null;
  aborted: boolean;
  upstreamError?: string | null;
}

const PARAM_KEYS = ['temperature', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'top_p', 'top_k', 'tool_choice', 'thinking', 'reasoning', 'reasoning_effort', 'stop_sequences', 'stop', 'stream', 'parallel_tool_calls', 'response_format', 'service_tier', 'seed', 'output_config', 'context_management'];

export function buildProxySpan(c: ProxyCall, opts: { merge?: boolean } = {}): SpanRow {
  const h = c.reqHeaders;
  const body = c.reqBody ?? {};
  const tp = parseTraceparent(h['traceparent']);
  const bbTrace = header(h, 'x-blackbox-trace');
  const ua = header(h, 'user-agent') ?? '';
  const isClaudeCode = /claude-cli|claude-code/i.test(ua) || !!header(h, 'x-claude-code-session-id');
  const session = header(h, 'x-blackbox-session') ?? header(h, 'x-claude-code-session-id') ?? sessionFromMetadata(body);
  const agent = header(h, 'x-blackbox-agent') ?? (isClaudeCode ? 'claude-code' : null);
  const project = header(h, 'x-blackbox-project') ?? 'default';

  let traceId: string;
  let parentId: string | null = null;
  let spanId = hexId(8);
  const failed = c.status >= 400 || c.status === 0 || !!c.streamError || !!c.upstreamError || c.aborted;
  const merge = !!(opts.merge && tp && isClaudeCode && !failed);
  if (tp) {
    traceId = tp.traceId;
    if (merge) spanId = tp.spanId;
    else parentId = tp.spanId;
  } else if (bbTrace) {
    traceId = toTraceId(bbTrace);
    parentId = header(h, 'x-blackbox-parent');
  } else traceId = hexId(16);

  let input: Message[] | null = null;
  let output: Message[] | null = null;
  let model = str(body.model);
  let inTok: number | null = null;
  let outTok: number | null = null;
  let cacheRead: number | null = null;
  let cacheWrite: number | null = null;
  let reasoningTok: number | null = null;
  let finish: string | null = null;
  const r = c.response;
  const reqId = header(c.resHeaders, 'request-id') ?? header(c.resHeaders, 'x-request-id') ?? str(r?.id);

  if (c.provider === 'anthropic') {
    input = normalizeMessages({ system: body.system, messages: Array.isArray(body.messages) ? body.messages : [] });
    if (input && !input.length) input = null;
    if (r && Array.isArray(r.content)) output = normalizeMessages([{ role: 'assistant', content: r.content }]);
    model = str(r?.model) ?? model;
    const u = r?.usage ?? {};
    inTok = num(u.input_tokens);
    outTok = num(u.output_tokens);
    cacheRead = num(u.cache_read_input_tokens);
    cacheWrite = num(u.cache_creation_input_tokens);
    finish = str(r?.stop_reason);
  } else if (c.api === 'chat') {
    input = normalizeMessages(Array.isArray(body.messages) ? body.messages : []);
    if (r && Array.isArray(r.choices)) {
      output = normalizeMessages(r.choices.map((x: Any) => x?.message).filter(Boolean));
      finish = r.choices.map((x: Any) => x?.finish_reason).filter(Boolean).join(',') || null;
    }
    model = str(r?.model) ?? model;
    const u = r?.usage ?? {};
    const prompt = num(u.prompt_tokens);
    cacheRead = num(u.prompt_tokens_details?.cached_tokens);
    inTok = prompt != null ? Math.max(0, prompt - (cacheRead ?? 0)) : null;
    outTok = num(u.completion_tokens);
    reasoningTok = num(u.completion_tokens_details?.reasoning_tokens);
  } else if (c.api === 'responses') {
    input = responsesInputMessages(body);
    if (!input.length) input = null;
    output = responsesOutputMessage(r);
    model = str(r?.model) ?? model;
    const u = r?.usage ?? {};
    const prompt = num(u.input_tokens);
    cacheRead = num(u.input_tokens_details?.cached_tokens);
    inTok = prompt != null ? Math.max(0, prompt - (cacheRead ?? 0)) : null;
    outTok = num(u.output_tokens);
    reasoningTok = num(u.output_tokens_details?.reasoning_tokens);
    finish = str(r?.status === 'incomplete' ? r?.incomplete_details?.reason ?? 'incomplete' : r?.status);
  }

  const tools = toolsInfo(body.tools);
  const attrs: Any = { 'blackbox.proxy': true, 'http.status_code': c.status, 'url.path': c.path, 'gen_ai.operation.name': 'chat' };
  for (const k of PARAM_KEYS) if (body[k] !== undefined) attrs['gen_ai.request.' + k] = body[k];
  if (tools.count) {
    attrs['blackbox.tools'] = tools.names;
    attrs['blackbox.tools_count'] = tools.count;
    attrs['blackbox.tools_tokens'] = tools.tokens;
    attrs['blackbox.tools_hash'] = tools.hash;
  }
  if (reqId) attrs['gen_ai.response.id'] = reqId;
  const rid = header(c.resHeaders, 'request-id') ?? header(c.resHeaders, 'x-request-id');
  if (rid) attrs['request_id'] = rid;
  if (ua) attrs['user_agent.original'] = ua;
  const beta = header(h, 'anthropic-beta');
  if (beta) attrs['anthropic.beta'] = beta;
  if (tp) attrs['blackbox.traceparent_span_id'] = tp.spanId;
  if (merge) attrs['blackbox.merged'] = true;
  if (c.aborted) attrs['blackbox.aborted'] = true;

  const httpErr = c.status >= 400 || c.status === 0;
  const errMsg = c.upstreamError ?? (c.status >= 400 ? errorMessage(c.errorBody ?? '') ?? `HTTP ${c.status}` : null) ?? c.streamError;
  const status: SpanRow['status'] = httpErr || c.streamError ? 'error' : c.aborted ? 'unset' : 'ok';
  const startNs = Math.round(c.startMs * 1e6);
  const dur = c.endPerf - c.startPerf;
  const name = merge && isClaudeCode ? 'claude_code.llm_request' : c.provider === 'anthropic' ? 'anthropic.messages' : c.api === 'responses' ? 'openai.responses' : 'openai.chat';

  const inJson = input ? JSON.stringify(capMessages(input)) : null;
  let outJson = output ? JSON.stringify(output) : null;
  if (outJson && outJson.length > MAX_OUTPUT) outJson = JSON.stringify(capMessages(output, MAX_OUTPUT));
  if (!outJson && c.status >= 400 && c.errorBody) outJson = JSON.stringify(parse(c.errorBody) ?? c.errorBody.slice(0, 4000));

  return blankSpan({
    span_id: spanId,
    trace_id: traceId,
    parent_id: parentId,
    project,
    name,
    kind: 'llm',
    source: merge && isClaudeCode ? 'claude-code' : 'proxy',
    operation: 'chat',
    start_ns: startNs,
    end_ns: startNs + Math.round(dur * 1e6),
    duration_ms: dur,
    status,
    status_message: errMsg,
    session_id: session,
    agent_name: agent,
    model,
    provider: c.provider,
    input_tokens: inTok,
    output_tokens: outTok,
    cache_read_tokens: cacheRead,
    cache_write_tokens: cacheWrite,
    reasoning_tokens: reasoningTok,
    ttft_ms: c.firstContentPerf != null ? c.firstContentPerf - c.startPerf : null,
    finish_reason: c.aborted && !finish ? 'aborted' : finish,
    input: inJson,
    output: outJson,
    attributes: JSON.stringify(attrs),
  });
}

export interface Route {
  provider: Provider;
  api: ApiKind;
  path: string;
  record: boolean;
}

const OPENAI_PATHS = /\/v1\/(chat\/completions|responses|completions|embeddings|audio|images|moderations|assistants|threads|vector_stores|fine_tuning|batches|uploads|realtime|conversations)(\/|$)/;

export function routeFor(rawPath: string, headers: IncomingHttpHeaders): Route {
  let path = rawPath;
  let forced: Provider | null = null;
  const pre = /^\/(anthropic|openai)(\/.*)$/.exec(path);
  if (pre) {
    forced = pre[1] as Provider;
    path = pre[2];
  }
  const p = path.split('?')[0].replace(/\/+$/, '');
  if (/\/v1\/messages\/count_tokens$/.test(p)) return { provider: forced ?? 'anthropic', api: 'passthrough', path, record: false };
  if (/\/v1\/messages$/.test(p)) return { provider: forced ?? 'anthropic', api: 'messages', path, record: true };
  if (/\/chat\/completions$/.test(p)) return { provider: forced ?? 'openai', api: 'chat', path, record: true };
  if (/\/responses$/.test(p)) return { provider: forced ?? 'openai', api: 'responses', path, record: true };
  if (forced) return { provider: forced, api: 'passthrough', path, record: false };
  const anthropicHeaders = Object.keys(headers).some((k) => k.startsWith('anthropic-') || k === 'x-api-key');
  if (anthropicHeaders) return { provider: 'anthropic', api: 'passthrough', path, record: false };
  const auth = String(headers['authorization'] ?? '');
  const openaiKey = /^bearer\s+sk-(?!ant-)/i.test(auth) || !!headers['openai-organization'] || !!headers['openai-project'];
  return { provider: openaiKey || OPENAI_PATHS.test(p) ? 'openai' : 'anthropic', api: 'passthrough', path, record: false };
}

export function upstreamBase(p: Provider): URL {
  const v = p === 'anthropic' ? process.env.BLACKBOX_UPSTREAM_ANTHROPIC || 'https://api.anthropic.com' : process.env.BLACKBOX_UPSTREAM_OPENAI || 'https://api.openai.com';
  return new URL(v);
}

export function forwardHeaders(h: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  const conn = String(h['connection'] ?? '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const lk = k.toLowerCase();
    if (HOP.has(lk) || conn.includes(lk) || lk.startsWith('x-blackbox-')) continue;
    out[k] = v;
  }
  return out;
}

function responseHeaders(h: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined || HOP.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

function decoderFor(enc: string): Transform | null {
  const e = enc.toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return createGunzip();
  if (e === 'deflate') return createInflate();
  if (e === 'br') return createBrotliDecompress();
  return null;
}

export interface ProxyOptions {
  sink?: (rows: SpanRow[]) => void;
  merge?: boolean;
  log?: (msg: string) => void;
  onRequest?: (req: IncomingMessage, route: Route) => void;
}

interface PendingMerge {
  row: SpanRow;
  at: number;
}

const pendingMerges = new Map<string, PendingMerge>();
let mergeHookInstalled = false;

function existingSpan(id: string): Any | null {
  try {
    return (getDb().prepare('select name, source, attributes, project, parent_id from spans where span_id = ?').get(id) as Any | undefined) ?? null;
  } catch {
    return null;
  }
}

export function mergeOnto(row: SpanRow, cur: Any | null): SpanRow {
  if (!cur) return row;
  const attrs = parse(cur.attributes ?? '') ?? {};
  const ours = parse(row.attributes ?? '') ?? {};
  return { ...row, name: cur.name ?? row.name, project: cur.project ?? row.project, parent_id: cur.parent_id ?? row.parent_id, attributes: JSON.stringify({ ...attrs, ...ours }) };
}

function installMergeHook(sink: (rows: SpanRow[]) => void): void {
  if (mergeHookInstalled) return;
  mergeHookInstalled = true;
  onFlush((traceIds) => {
    if (!pendingMerges.size) return;
    const touched = new Set(traceIds);
    const now = Date.now();
    const again: SpanRow[] = [];
    for (const [id, p] of pendingMerges) {
      if (now - p.at > 10 * 60 * 1000) {
        pendingMerges.delete(id);
        continue;
      }
      if (!touched.has(p.row.trace_id)) continue;
      const cur = existingSpan(id);
      if (!cur || String(cur.attributes ?? '').includes('"blackbox.merged":true')) continue;
      again.push(mergeOnto(p.row, cur));
      pendingMerges.delete(id);
    }
    if (again.length) setImmediate(() => sink(again));
  });
}

export function startProxy(port = 7778, opts: ProxyOptions = {}): Promise<Server> {
  const sink = opts.sink ?? ((rows: SpanRow[]) => void ingestSpanRows(rows));
  const merge = opts.merge ?? process.env.BLACKBOX_PROXY_MERGE !== '0';
  if (merge && !opts.sink) installMergeHook(sink);
  const record = (row: SpanRow) => {
    try {
      if (merge && !opts.sink && row.attributes && row.attributes.includes('"blackbox.merged":true')) {
        const cur = existingSpan(row.span_id);
        if (cur && cur.source === 'claude-code' && !String(cur.attributes ?? '').includes('"blackbox.merged":true')) {
          sink([mergeOnto(row, cur)]);
          return;
        }
        if (pendingMerges.size > 2000) pendingMerges.delete(pendingMerges.keys().next().value!);
        pendingMerges.set(row.span_id, { row, at: Date.now() });
      }
      sink([row]);
    } catch (e: any) {
      opts.log?.('[blackbox proxy] record failed ' + String(e?.message ?? e));
    }
  };

  const server = createServer((req, res) => handle(req, res, record, merge, opts));
  server.keepAliveTimeout = 65000;
  server.requestTimeout = 0;
  server.headersTimeout = 120000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

function handle(req: IncomingMessage, res: ServerResponse, record: (row: SpanRow) => void, merge: boolean, opts: ProxyOptions): void {
  req.socket.setNoDelay(true);
  const startMs = Date.now();
  const startPerf = performance.now();
  const route = routeFor(req.url ?? '/', req.headers);
  try {
    opts.onRequest?.(req, route);
  } catch {}
  if (req.method === 'GET' && route.path === '/__blackbox/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, proxy: true }));
    return;
  }
  const base = upstreamBase(route.provider);
  const target = new URL(base.pathname.replace(/\/+$/, '') + route.path, base);
  const headers = forwardHeaders(req.headers);
  const mod = target.protocol === 'http:' ? httpRequest : httpsRequest;
  const recording = route.record && req.method === 'POST';
  let done = false;
  let upRes: IncomingMessage | null = null;
  let acc: StreamAccumulator | null = null;
  let parser: SseParser | null = null;
  const resChunks: Buffer[] = [];
  let resSize = 0;
  let isStream = false;
  let decoder: Transform | null = null;
  let decodedDone: Promise<void> = Promise.resolve();

  const finish = async (aborted: boolean, upstreamError: string | null = null) => {
    if (done) return;
    done = true;
    if (!recording) return;
    const endPerf = performance.now();
    try {
      if (decoder) {
        decoder.end();
        await decodedDone;
      }
      if (parser) parser.end();
      let reqBody: Any | null = null;
      try {
        reqBody = JSON.parse(Buffer.concat(bodyChunks).toString('utf8'));
      } catch {
        reqBody = null;
      }
      const status = upRes?.statusCode ?? 0;
      const raw = Buffer.concat(resChunks).toString('utf8');
      let response: Any | null = null;
      if (acc) response = acc.result();
      else if (status < 400) response = parse(raw);
      const row = buildProxySpan(
        {
          provider: route.provider,
          api: route.api,
          path: route.path.split('?')[0],
          reqHeaders: req.headers,
          reqBody,
          status,
          resHeaders: upRes?.headers ?? {},
          response,
          streamError: acc?.error() ?? null,
          errorBody: status >= 400 ? raw : null,
          startMs,
          startPerf,
          endPerf,
          firstContentPerf: acc?.firstContentAt ?? null,
          aborted,
          upstreamError,
        },
        { merge },
      );
      record(row);
    } catch (e: any) {
      opts.log?.('[blackbox proxy] span build failed ' + String(e?.message ?? e));
    }
  };

  const tee = (chunk: Buffer) => {
    if (!recording) return;
    if (parser) {
      if (decoder) decoder.write(chunk);
      else parser.push(chunk);
      return;
    }
    if (resSize < 32 * 1024 * 1024) {
      if (decoder) decoder.write(chunk);
      else resChunks.push(chunk);
      resSize += chunk.length;
    }
  };

  const onResponse = (r: IncomingMessage) => {
    upRes = r;
    const ct = String(r.headers['content-type'] ?? '');
    isStream = /text\/event-stream/i.test(ct);
    if (recording) {
      decoder = decoderFor(String(r.headers['content-encoding'] ?? ''));
      if (isStream && (r.statusCode ?? 0) < 400) {
        acc = accumulatorFor(route.provider, route.api);
        if (acc) {
          const a = acc;
          parser = new SseParser((ev, data) => a.handle(ev, data));
        }
      }
      if (decoder) {
        const d = decoder;
        decodedDone = new Promise((resolve) => {
          d.on('data', (c: Buffer) => {
            if (parser) parser.push(c);
            else if (resSize < 32 * 1024 * 1024) resChunks.push(c);
          });
          d.on('end', () => resolve());
          d.on('error', () => resolve());
        });
      }
    }
    res.writeHead(r.statusCode ?? 502, r.statusMessage, responseHeaders(r.headers));
    res.flushHeaders();
    r.on('data', (c: Buffer) => {
      res.write(c);
      try {
        tee(c);
      } catch {}
    });
    r.on('end', () => {
      res.end();
      void finish(false);
    });
    r.on('error', (e) => {
      res.destroy(e);
      void finish(true, 'upstream stream error: ' + e.message);
    });
    r.on('aborted', () => void finish(true));
  };

  const fail = (e: any) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'blackbox proxy upstream error: ' + String(e?.code ?? e?.message ?? e) } }));
    } else res.destroy();
    void finish(true, upRes ? null : 'upstream error: ' + String(e?.code ?? e?.message ?? e));
  };

  const bodyChunks: Buffer[] = [];
  let bodySize = 0;
  let bodyEnded = false;
  let bodyKept = true;
  let attempt = 0;
  let upReq: ClientRequest;

  const open = (fresh: boolean): ClientRequest => {
    const agent = fresh ? false : target.protocol === 'http:' ? httpAgent : httpsAgent;
    const r = mod(target, { method: req.method, headers, agent, ...(target.protocol === 'https:' ? { servername: target.hostname } : {}) });
    r.on('response', onResponse);
    r.on('error', (e: any) => {
      if (upRes || res.headersSent || done) return fail(e);
      const retriable = attempt < 2 && bodyKept && (r.reusedSocket || /ECONNRESET|EPIPE|ECONNABORTED|SSL|TLS/i.test(String(e?.code ?? '') + ' ' + String(e?.message ?? '')));
      if (!retriable) return fail(e);
      attempt++;
      opts.log?.('[blackbox proxy] retrying upstream after ' + String(e?.code ?? e?.message ?? e));
      upReq = open(true);
      for (const c of bodyChunks) upReq.write(c);
      if (bodyEnded) upReq.end();
    });
    return r;
  };

  try {
    upReq = open(false);
  } catch (e: any) {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: 'blackbox proxy: ' + String(e?.message ?? e) } }));
    return;
  }
  res.on('close', () => {
    if (!res.writableFinished) {
      upReq.destroy();
      void finish(true);
    }
  });
  req.on('data', (c: Buffer) => {
    if (bodyKept) {
      bodySize += c.length;
      if (bodySize > 64 * 1024 * 1024) {
        bodyKept = false;
        bodyChunks.length = 0;
      } else bodyChunks.push(c);
    }
    upReq.write(c);
  });
  req.on('end', () => {
    bodyEnded = true;
    upReq.end();
  });
  req.on('error', () => upReq.destroy());
}
