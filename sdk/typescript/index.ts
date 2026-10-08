import { AsyncLocalStorage } from 'node:async_hooks';

export type Kind = 'agent' | 'llm' | 'tool' | 'mcp' | 'memory' | 'retriever' | 'embedding' | 'chain' | 'guardrail' | 'handoff' | 'evaluator' | 'span';

type Any = Record<string, any>;

export interface InitOptions {
  url?: string;
  project?: string;
  sessionId?: string;
  userId?: string;
  agent?: string;
  enabled?: boolean;
  batchSize?: number;
  flushIntervalMs?: number;
  maxQueue?: number;
  debug?: boolean;
}

export interface SpanOptions {
  kind?: Kind;
  input?: unknown;
  output?: unknown;
  model?: string;
  provider?: string;
  toolName?: string;
  toolCallId?: string;
  agent?: string;
  sessionId?: string;
  userId?: string;
  memoryOp?: string;
  attributes?: Any;
  traceId?: string;
  parentId?: string | null;
  captureInput?: boolean;
  captureOutput?: boolean;
}

export interface Message {
  role: string;
  content?: string;
  tool_calls?: { id?: string; name: string; arguments?: unknown }[];
  tool_call_id?: string;
  reasoning?: string;
}

interface ApiSpan {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  name: string;
  kind: Kind;
  source: string;
  project: string;
  start_ns: number;
  end_ns?: number;
  status: 'ok' | 'error' | 'unset';
  status_message?: string | null;
  session_id?: string | null;
  user_id?: string | null;
  agent_name?: string | null;
  model?: string | null;
  provider?: string | null;
  tool_name?: string | null;
  tool_call_id?: string | null;
  memory_op?: string | null;
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
  cost_usd?: number | null;
  ttft_ms?: number | null;
  finish_reason?: string | null;
  input?: unknown;
  output?: unknown;
  attributes?: Any;
}

const config = {
  url: 'http://localhost:7777',
  project: 'default',
  sessionId: null as string | null,
  userId: null as string | null,
  agent: null as string | null,
  enabled: true,
  batchSize: 50,
  flushIntervalMs: 1000,
  maxQueue: 5000,
  debug: false,
};

function env(name: string): string | undefined {
  try {
    return typeof process !== 'undefined' ? process.env?.[name] : undefined;
  } catch {
    return undefined;
  }
}

if (env('BLACKBOX_URL')) config.url = env('BLACKBOX_URL')!;
if (env('BLACKBOX_PROJECT')) config.project = env('BLACKBOX_PROJECT')!;
if (env('BLACKBOX_SESSION')) config.sessionId = env('BLACKBOX_SESSION')!;
if (env('BLACKBOX_DISABLED') === '1') config.enabled = false;

function hex(bytes: number): string {
  const a = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
}

function nowNs(): number {
  return Math.round((performance.timeOrigin + performance.now()) * 1e6);
}

function log(...args: unknown[]): void {
  if (config.debug) console.error('[blackbox]', ...args);
}

class Exporter {
  queue: Any[] = [];
  timer: ReturnType<typeof setTimeout> | null = null;
  inflight: Promise<void> | null = null;
  failures = 0;
  hooked = false;

  push(item: Any): void {
    if (!config.enabled) return;
    this.queue.push(item);
    if (this.queue.length > config.maxQueue) this.queue.splice(0, this.queue.length - config.maxQueue);
    this.hook();
    this.schedule(this.queue.length >= config.batchSize ? 0 : config.flushIntervalMs);
  }

  hook(): void {
    if (this.hooked || typeof process === 'undefined' || !process.on) return;
    this.hooked = true;
    process.on('beforeExit', () => {
      if (this.queue.length && this.failures < 3) void this.flush();
    });
  }

  schedule(ms: number): void {
    if (this.timer) {
      if (ms > 0) return;
      clearTimeout(this.timer);
    }
    const backoff = this.failures ? Math.min(30000, 1000 * 2 ** Math.min(this.failures, 5)) : 0;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, Math.max(ms, backoff));
    (this.timer as any).unref?.();
  }

  async post(path: string, body: unknown): Promise<boolean> {
    try {
      const r = await fetch(config.url.replace(/\/+$/, '') + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
      await r.arrayBuffer().catch(() => null);
      if (!r.ok) log(path, r.status);
      return r.ok || (r.status >= 400 && r.status < 500);
    } catch (e) {
      log('export failed', e);
      return false;
    }
  }

  flush(): Promise<void> {
    if (this.inflight) return this.inflight.then(() => (this.queue.length ? this.flush() : undefined));
    if (!this.queue.length) return Promise.resolve();
    this.inflight = (async () => {
      try {
        while (this.queue.length) {
          const batch = this.queue.slice(0, config.batchSize);
          const spans = batch.filter((b) => b._type === 'span').map(({ _type, ...s }) => s);
          const scores = batch.filter((b) => b._type === 'score').map(({ _type, ...s }) => s);
          if (spans.length && !(await this.post('/api/ingest', { spans }))) throw new Error('down');
          for (const s of scores) if (!(await this.post('/api/scores', s))) throw new Error('down');
          this.queue.splice(0, batch.length);
        }
        this.failures = 0;
      } catch {
        this.failures++;
        if (this.queue.length) this.schedule(config.flushIntervalMs);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

const exporter = new Exporter();

export class Span {
  data: ApiSpan;
  ended = false;
  startPerf = performance.now();

  constructor(data: ApiSpan) {
    this.data = data;
  }

  get traceId(): string {
    return this.data.trace_id;
  }

  get spanId(): string {
    return this.data.span_id;
  }

  set(fields: Partial<ApiSpan>): this {
    Object.assign(this.data, fields);
    return this;
  }

  setInput(v: unknown): this {
    this.data.input = safeClone(v);
    return this;
  }

  setOutput(v: unknown): this {
    this.data.output = safeClone(v);
    return this;
  }

  setAttributes(a: Any): this {
    this.data.attributes = { ...(this.data.attributes ?? {}), ...a };
    return this;
  }

  setUsage(u: { input?: number | null; output?: number | null; cacheRead?: number | null; cacheWrite?: number | null; reasoning?: number | null; costUsd?: number | null }): this {
    if (u.input != null) this.data.input_tokens = u.input;
    if (u.output != null) this.data.output_tokens = u.output;
    if (u.cacheRead != null) this.data.cache_read_tokens = u.cacheRead;
    if (u.cacheWrite != null) this.data.cache_write_tokens = u.cacheWrite;
    if (u.reasoning != null) this.data.reasoning_tokens = u.reasoning;
    if (u.costUsd != null) this.data.cost_usd = u.costUsd;
    return this;
  }

  error(e: unknown): this {
    this.data.status = 'error';
    this.data.status_message = e instanceof Error ? e.message : String(e);
    if (e instanceof Error) this.setAttributes({ 'error.type': e.name });
    return this;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    this.data.end_ns = this.data.start_ns + Math.round((performance.now() - this.startPerf) * 1e6);
    if (this.data.status === 'unset') this.data.status = 'ok';
    try {
      exporter.push({ _type: 'span', ...this.data });
    } catch {}
  }
}

const storage = new AsyncLocalStorage<Span>();

function safeClone(v: unknown): unknown {
  if (v === undefined) return undefined;
  try {
    const seen = new WeakSet();
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') return val.toString();
      if (typeof val === 'function') return undefined;
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '[circular]';
        seen.add(val);
      }
      return val;
    });
    if (s === undefined) return String(v);
    if (s.length > 512 * 1024) return { truncated: true, bytes: s.length, head: s.slice(0, 512 * 1024) };
    return JSON.parse(s);
  } catch {
    return String(v);
  }
}

export function init(opts: InitOptions = {}): void {
  if (opts.url) config.url = opts.url;
  if (opts.project) config.project = opts.project;
  if (opts.sessionId !== undefined) config.sessionId = opts.sessionId;
  if (opts.userId !== undefined) config.userId = opts.userId;
  if (opts.agent !== undefined) config.agent = opts.agent;
  if (opts.enabled !== undefined) config.enabled = opts.enabled;
  if (opts.batchSize) config.batchSize = opts.batchSize;
  if (opts.flushIntervalMs) config.flushIntervalMs = opts.flushIntervalMs;
  if (opts.maxQueue) config.maxQueue = opts.maxQueue;
  if (opts.debug !== undefined) config.debug = opts.debug;
}

export function setSession(sessionId: string | null): void {
  config.sessionId = sessionId;
  const cur = storage.getStore();
  if (cur && sessionId) cur.data.session_id = sessionId;
}

export function setUser(userId: string | null): void {
  config.userId = userId;
}

export function currentSpan(): Span | undefined {
  return storage.getStore();
}

export function currentTraceId(): string | undefined {
  return storage.getStore()?.traceId;
}

export function startSpan(name: string, opts: SpanOptions = {}, root = false): Span {
  const parent = root ? undefined : storage.getStore();
  const traceId = opts.traceId ?? (root ? undefined : parent?.traceId) ?? hex(16);
  const s = new Span({
    trace_id: traceId,
    span_id: hex(8),
    parent_id: opts.parentId !== undefined ? opts.parentId : root && !opts.traceId ? null : parent && parent.traceId === traceId ? parent.spanId : null,
    name,
    kind: opts.kind ?? (root ? 'agent' : 'span'),
    source: 'sdk',
    project: config.project,
    start_ns: nowNs(),
    status: 'unset',
    session_id: opts.sessionId ?? parent?.data.session_id ?? config.sessionId,
    user_id: opts.userId ?? parent?.data.user_id ?? config.userId,
    agent_name: opts.agent ?? (opts.kind === 'agent' || root ? config.agent ?? name : parent?.data.agent_name ?? config.agent),
    model: opts.model ?? null,
    provider: opts.provider ?? null,
    tool_name: opts.toolName ?? (opts.kind === 'tool' || opts.kind === 'mcp' || opts.kind === 'memory' ? name : null),
    tool_call_id: opts.toolCallId ?? null,
    memory_op: opts.memoryOp ?? null,
    attributes: opts.attributes,
  });
  if (opts.input !== undefined) s.setInput(opts.input);
  if (opts.output !== undefined) s.setOutput(opts.output);
  return s;
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && (typeof v === 'object' || typeof v === 'function') && typeof (v as any).then === 'function';
}

function run<T>(s: Span, fn: (s: Span) => T, captureOutput: boolean): T {
  let out: T;
  try {
    out = storage.run(s, () => fn(s));
  } catch (e) {
    s.error(e);
    s.end();
    throw e;
  }
  if (isThenable(out)) {
    return (out as any).then(
      (v: unknown) => {
        if (captureOutput && s.data.output === undefined && v !== undefined) s.setOutput(v);
        s.end();
        return v;
      },
      (e: unknown) => {
        s.error(e);
        s.end();
        throw e;
      },
    ) as T;
  }
  if (captureOutput && s.data.output === undefined && out !== undefined) s.setOutput(out);
  s.end();
  return out;
}

export function trace<T>(name: string, fn: (s: Span) => T, opts: SpanOptions = {}): T {
  let s: Span;
  try {
    s = startSpan(name, { kind: 'agent', ...opts }, true);
  } catch {
    return fn(undefined as unknown as Span);
  }
  return run(s, fn, opts.captureOutput !== false);
}

export function span<T>(name: string, fn: (s: Span) => T, opts: SpanOptions = {}): T {
  let s: Span;
  try {
    s = startSpan(name, opts);
  } catch {
    return fn(undefined as unknown as Span);
  }
  return run(s, fn, opts.captureOutput !== false);
}

export function observe<A extends unknown[], R>(fn: (...args: A) => R, opts: SpanOptions & { name?: string } = {}): (...args: A) => R {
  const name = opts.name ?? (fn.name || 'function');
  const wrapped = function (this: unknown, ...args: A): R {
    const capIn = opts.captureInput !== false;
    const input = capIn && opts.input === undefined ? (args.length === 1 ? args[0] : args) : opts.input;
    const root = !storage.getStore() && (opts.kind === undefined || opts.kind === 'agent');
    let s: Span;
    try {
      s = startSpan(name, { ...opts, input }, root);
    } catch {
      return fn.apply(this, args);
    }
    return run(s, () => fn.apply(this, args), opts.captureOutput !== false);
  };
  Object.defineProperty(wrapped, 'name', { value: name });
  return wrapped;
}

export function score(traceId: string, name: string, valueOrLabel: number | string | boolean, opts: { reasoning?: string; spanId?: string; sessionId?: string } = {}): void {
  try {
    const body: Any = { trace_id: traceId, name, source: 'sdk' };
    if (typeof valueOrLabel === 'number') body.value = valueOrLabel;
    else if (typeof valueOrLabel === 'boolean') {
      body.value = valueOrLabel ? 1 : 0;
      body.label = valueOrLabel ? 'pass' : 'fail';
    } else body.label = valueOrLabel;
    if (opts.reasoning) body.reasoning = opts.reasoning;
    if (opts.spanId) body.span_id = opts.spanId;
    if (opts.sessionId) body.session_id = opts.sessionId;
    exporter.push({ _type: 'score', ...body });
  } catch {}
}

export function flush(): Promise<void> {
  return exporter.flush().catch(() => undefined);
}

export async function shutdown(): Promise<void> {
  await flush();
}

function textOf(c: unknown): string {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c))
    return c
      .map((p: Any) => (typeof p === 'string' ? p : p?.type === 'text' || p?.type === 'input_text' || p?.type === 'output_text' ? p.text ?? '' : p?.type === 'image' || p?.type === 'image_url' || p?.type === 'input_image' ? '[image]' : p?.type === 'tool_result' ? textOf(p.content) : ''))
      .filter(Boolean)
      .join('\n');
  if (typeof c === 'object' && typeof (c as Any).text === 'string') return (c as Any).text;
  return JSON.stringify(c);
}

function parseArgs(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

export function anthropicMessages(params: Any): Message[] {
  const out: Message[] = [];
  if (params?.system) out.push({ role: 'system', content: textOf(params.system) });
  for (const m of params?.messages ?? []) {
    if (!m) continue;
    if (!Array.isArray(m.content)) {
      out.push({ role: m.role, content: textOf(m.content) });
      continue;
    }
    const results = m.content.filter((p: Any) => p?.type === 'tool_result');
    for (const r of results) out.push({ role: 'tool', tool_call_id: r.tool_use_id, content: textOf(r.content) });
    const uses = m.content.filter((p: Any) => p?.type === 'tool_use');
    const text = textOf(m.content.filter((p: Any) => p?.type !== 'tool_result' && p?.type !== 'tool_use'));
    const thinking = m.content.filter((p: Any) => p?.type === 'thinking').map((p: Any) => p.thinking).join('\n');
    if (text || uses.length || !results.length) {
      const msg: Message = { role: m.role, content: text };
      if (uses.length) msg.tool_calls = uses.map((u: Any) => ({ id: u.id, name: u.name, arguments: u.input }));
      if (thinking) msg.reasoning = thinking;
      out.push(msg);
    }
  }
  return out;
}

export function anthropicOutput(res: Any): Message[] {
  const blocks: Any[] = res?.content ?? [];
  const msg: Message = { role: 'assistant', content: blocks.filter((b) => b?.type === 'text').map((b) => b.text).join('') };
  const uses = blocks.filter((b) => b?.type === 'tool_use' || b?.type === 'server_tool_use');
  if (uses.length) msg.tool_calls = uses.map((u) => ({ id: u.id, name: u.name, arguments: u.input }));
  const thinking = blocks.filter((b) => b?.type === 'thinking').map((b) => b.thinking).join('\n');
  if (thinking) msg.reasoning = thinking;
  return [msg];
}

export function openaiMessages(params: Any): Message[] {
  const out: Message[] = [];
  for (const m of params?.messages ?? []) {
    if (!m) continue;
    const msg: Message = { role: m.role === 'developer' ? 'system' : m.role, content: textOf(m.content) };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls.map((t: Any) => ({ id: t.id, name: t.function?.name ?? t.name, arguments: parseArgs(t.function?.arguments ?? t.arguments) }));
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    out.push(msg);
  }
  return out;
}

export function openaiOutput(res: Any): Message[] {
  return (res?.choices ?? []).map((c: Any) => {
    const m = c?.message ?? {};
    const msg: Message = { role: m.role ?? 'assistant', content: textOf(m.content) };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls.map((t: Any) => ({ id: t.id, name: t.function?.name, arguments: parseArgs(t.function?.arguments) }));
    if (m.reasoning_content) msg.reasoning = m.reasoning_content;
    return msg;
  });
}

export function responsesMessages(params: Any): Message[] {
  const out: Message[] = [];
  if (params?.instructions) out.push({ role: 'system', content: textOf(params.instructions) });
  const input = params?.input;
  if (typeof input === 'string') return [...out, { role: 'user', content: input }];
  for (const it of Array.isArray(input) ? input : []) {
    if (it?.type === 'function_call') out.push({ role: 'assistant', content: '', tool_calls: [{ id: it.call_id, name: it.name, arguments: parseArgs(it.arguments) }] });
    else if (it?.type === 'function_call_output') out.push({ role: 'tool', tool_call_id: it.call_id, content: textOf(parseArgs(it.output)) });
    else if (it?.role) out.push({ role: it.role === 'developer' ? 'system' : it.role, content: textOf(it.content) });
  }
  return out;
}

export function responsesOutput(res: Any): Message[] {
  const msg: Message = { role: 'assistant', content: '' };
  const texts: string[] = [];
  for (const it of res?.output ?? []) {
    if (it?.type === 'message') texts.push(textOf(it.content));
    else if (it?.type === 'function_call') (msg.tool_calls ??= []).push({ id: it.call_id, name: it.name, arguments: parseArgs(it.arguments) });
  }
  msg.content = texts.join('\n');
  return [msg];
}

export class AnthropicAccumulator {
  message: Any = {};
  blocks: Any[] = [];
  partial: Record<number, string> = {};
  usage: Any = {};
  firstAt: number | null = null;

  add(ev: Any): void {
    if (!ev) return;
    if (ev.type === 'message_start') {
      this.message = { ...(ev.message ?? {}) };
      Object.assign(this.usage, ev.message?.usage ?? {});
    } else if (ev.type === 'content_block_start') {
      this.blocks[ev.index] = { ...(ev.content_block ?? {}) };
      if (ev.content_block?.type === 'tool_use' || ev.content_block?.type === 'server_tool_use') this.partial[ev.index] = '';
    } else if (ev.type === 'content_block_delta') {
      this.firstAt ??= performance.now();
      const b = (this.blocks[ev.index] ??= { type: 'text', text: '' });
      const d = ev.delta ?? {};
      if (d.type === 'text_delta') b.text = (b.text ?? '') + d.text;
      else if (d.type === 'thinking_delta') b.thinking = (b.thinking ?? '') + d.thinking;
      else if (d.type === 'input_json_delta') this.partial[ev.index] = (this.partial[ev.index] ?? '') + d.partial_json;
    } else if (ev.type === 'content_block_stop') {
      this.close(ev.index);
    } else if (ev.type === 'message_delta') {
      if (ev.delta?.stop_reason) this.message.stop_reason = ev.delta.stop_reason;
      for (const [k, v] of Object.entries(ev.usage ?? {})) if (v != null) this.usage[k] = v;
    }
  }

  close(i: number): void {
    const raw = this.partial[i];
    if (raw === undefined) return;
    delete this.partial[i];
    if (this.blocks[i]) this.blocks[i].input = raw ? parseArgs(raw) : {};
  }

  result(): Any {
    for (const k of Object.keys(this.partial)) this.close(Number(k));
    return { ...this.message, content: this.blocks.filter(Boolean), usage: this.usage };
  }
}

export class OpenAIChatAccumulator {
  id: string | null = null;
  model: string | null = null;
  choices: Any[] = [];
  usage: Any | null = null;
  firstAt: number | null = null;

  add(ch: Any): void {
    if (!ch) return;
    this.id ??= ch.id ?? null;
    this.model = ch.model ?? this.model;
    if (ch.usage) this.usage = ch.usage;
    for (const c of ch.choices ?? []) {
      const i = c.index ?? 0;
      const cur = (this.choices[i] ??= { message: { role: 'assistant', content: '' }, finish_reason: null });
      const d = c.delta ?? {};
      if (d.content) {
        this.firstAt ??= performance.now();
        cur.message.content += d.content;
      }
      if (Array.isArray(d.tool_calls)) {
        this.firstAt ??= performance.now();
        cur.message.tool_calls ??= [];
        for (const t of d.tool_calls) {
          const x = (cur.message.tool_calls[t.index ?? 0] ??= { id: t.id, function: { name: '', arguments: '' } });
          if (t.id) x.id = t.id;
          if (t.function?.name) x.function.name += t.function.name;
          if (t.function?.arguments) x.function.arguments += t.function.arguments;
        }
      }
      if (c.finish_reason) cur.finish_reason = c.finish_reason;
    }
  }

  result(): Any {
    return { id: this.id, model: this.model, choices: this.choices.filter(Boolean), usage: this.usage };
  }
}

export class ResponsesAccumulator {
  response: Any | null = null;
  firstAt: number | null = null;

  add(ev: Any): void {
    if (!ev) return;
    if (typeof ev.type === 'string' && ev.type.endsWith('.delta')) this.firstAt ??= performance.now();
    if (ev.response && /^response\.(created|completed|incomplete|failed)$/.test(ev.type)) this.response = ev.response;
  }

  result(): Any {
    return this.response ?? {};
  }
}

function applyAnthropic(s: Span, res: Any): void {
  const u = res?.usage ?? {};
  s.set({ model: res?.model ?? s.data.model, finish_reason: res?.stop_reason ?? null });
  s.setUsage({ input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens, cacheWrite: u.cache_creation_input_tokens });
  s.setOutput(anthropicOutput(res));
}

function applyOpenAI(s: Span, res: Any): void {
  const u = res?.usage ?? {};
  const cached = u.prompt_tokens_details?.cached_tokens ?? null;
  s.set({ model: res?.model ?? s.data.model, finish_reason: (res?.choices ?? []).map((c: Any) => c.finish_reason).filter(Boolean).join(',') || null });
  s.setUsage({ input: u.prompt_tokens != null ? u.prompt_tokens - (cached ?? 0) : null, output: u.completion_tokens, cacheRead: cached, reasoning: u.completion_tokens_details?.reasoning_tokens });
  s.setOutput(openaiOutput(res));
}

function applyResponses(s: Span, res: Any): void {
  const u = res?.usage ?? {};
  const cached = u.input_tokens_details?.cached_tokens ?? null;
  s.set({ model: res?.model ?? s.data.model, finish_reason: res?.status ?? null });
  s.setUsage({ input: u.input_tokens != null ? u.input_tokens - (cached ?? 0) : null, output: u.output_tokens, cacheRead: cached, reasoning: u.output_tokens_details?.reasoning_tokens });
  s.setOutput(responsesOutput(res));
}

const PARAMS = ['temperature', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'top_p', 'tool_choice', 'thinking', 'reasoning', 'reasoning_effort', 'stream'];

function llmSpan(name: string, provider: string, params: Any, input: Message[]): Span {
  const attrs: Any = {};
  for (const k of PARAMS) if (params?.[k] !== undefined) attrs['gen_ai.request.' + k] = params[k];
  if (Array.isArray(params?.tools) && params.tools.length) {
    attrs['blackbox.tools'] = params.tools.map((t: Any) => t?.name ?? t?.function?.name ?? t?.type);
    attrs['blackbox.tools_count'] = params.tools.length;
    attrs['blackbox.tools_tokens'] = Math.ceil(JSON.stringify(params.tools).length / 4);
  }
  const s = startSpan(name, { kind: 'llm', model: params?.model, provider, attributes: attrs }, false);
  s.setInput(input);
  return s;
}

function instrument(target: Any, method: string, name: string, provider: string, toInput: (p: Any) => Message[], apply: (s: Span, res: Any) => void, makeAcc: () => { add(e: Any): void; result(): Any; firstAt: number | null }): void {
  const orig = target?.[method];
  if (typeof orig !== 'function' || orig.__blackbox) return;
  const patched = function (this: unknown, params: Any, ...rest: unknown[]) {
    let s: Span | null = null;
    try {
      s = llmSpan(name, provider, params, toInput(params));
    } catch {
      s = null;
    }
    let p: any;
    try {
      p = orig.call(this ?? target, params, ...rest);
    } catch (e) {
      if (s) {
        s.error(e);
        s.end();
      }
      throw e;
    }
    if (!s || !isThenable(p)) return p;
    const sp = s;
    (p as any).then(
      (res: any) => {
        try {
          if (res && typeof res[Symbol.asyncIterator] === 'function' && params?.stream) {
            const acc = makeAcc();
            const finish = (aborted = false) => {
              if (sp.ended) return;
              try {
                apply(sp, acc.result());
                if (acc.firstAt != null) sp.set({ ttft_ms: acc.firstAt - sp.startPerf });
                if (aborted) sp.setAttributes({ 'blackbox.aborted': true });
              } catch {}
              sp.end();
            };
            const iterFn = res[Symbol.asyncIterator].bind(res);
            let wrappedOnce = false;
            res[Symbol.asyncIterator] = function () {
              const it = iterFn();
              if (wrappedOnce) return it;
              wrappedOnce = true;
              return {
                async next(...a: unknown[]) {
                  try {
                    const r = await it.next(...(a as []));
                    if (r.done) finish();
                    else
                      try {
                        acc.add(r.value);
                      } catch {}
                    return r;
                  } catch (e) {
                    sp.error(e);
                    sp.end();
                    throw e;
                  }
                },
                async return(v?: unknown) {
                  finish(true);
                  return it.return ? it.return(v) : { done: true, value: v };
                },
                async throw(e?: unknown) {
                  sp.error(e);
                  sp.end();
                  if (it.throw) return it.throw(e);
                  throw e;
                },
                [Symbol.asyncIterator]() {
                  return this;
                },
              };
            };
          } else {
            apply(sp, res);
            sp.end();
          }
        } catch {
          sp.end();
        }
      },
      (e: unknown) => {
        sp.error(e);
        sp.end();
      },
    );
    return p;
  };
  (patched as any).__blackbox = true;
  target[method] = patched;
}

export function wrapAnthropic<T>(client: T): T {
  try {
    const c = client as Any;
    instrument(c?.messages, 'create', 'anthropic.messages', 'anthropic', anthropicMessages, applyAnthropic, () => new AnthropicAccumulator());
    instrument(c?.beta?.messages, 'create', 'anthropic.messages', 'anthropic', anthropicMessages, applyAnthropic, () => new AnthropicAccumulator());
  } catch {}
  return client;
}

export function wrapOpenAI<T>(client: T): T {
  try {
    const c = client as Any;
    instrument(c?.chat?.completions, 'create', 'openai.chat', 'openai', openaiMessages, applyOpenAI, () => new OpenAIChatAccumulator());
    instrument(c?.responses, 'create', 'openai.responses', 'openai', responsesMessages, applyResponses, () => new ResponsesAccumulator());
  } catch {}
  return client;
}

export const blackbox = { init, trace, span, observe, score, setSession, setUser, flush, shutdown, wrapAnthropic, wrapOpenAI, currentSpan, currentTraceId, startSpan };
export default blackbox;
