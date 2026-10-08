import { LineSplitter } from './wrap.ts';

type Any = Record<string, any>;

export const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const VERSION = '0.1.0';

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  inputSchema: Any;
  annotations?: Any;
}

const WINDOW = { type: 'string', enum: ['1h', '24h', '7d', '30d'], description: 'Time window. Default 24h.' };

export const TOOLS: ToolSpec[] = [
  {
    name: 'search_traces',
    title: 'Search traces',
    description: 'Find recorded agent runs (traces). Filter by full text over inputs and outputs, status, a detected signal type (tool_loop, error_spans, runaway_cost, refusal, user_frustration, hallucinated_success, ...), agent, model, tool or session. Returns one line per trace with id, time, cost, errors and signals.',
    inputSchema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Full text search, 3+ characters.' },
        status: { type: 'string', enum: ['error', 'ok'] },
        signal: { type: 'string', description: 'Signal type to filter on.' },
        agent: { type: 'string' },
        model: { type: 'string' },
        tool: { type: 'string' },
        session: { type: 'string' },
        window: WINDOW,
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Default 20.' },
      },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_trace',
    title: 'Get trace',
    description: 'Readable rendering of one trace: the user goal, numbered steps (LLM calls, tool calls with arguments and results), errors, signals, scores, tokens and cost.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string' },
        max_steps: { type: 'integer', minimum: 1, maximum: 500, description: 'Default 60.' },
        detail: { type: 'string', enum: ['compact', 'full'], description: 'full shows longer inputs and outputs. Default compact.' },
      },
      required: ['trace_id'],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_issues',
    title: 'List issues',
    description: 'Detected problems grouped by fingerprint (loops, errors, runaway cost, cache misses, refusals, frustration, toxic flows, ...) with counts and a sample trace id.',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'resolved', 'ignored'] }, window: WINDOW, limit: { type: 'integer', minimum: 1, maximum: 200 } },
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_session',
    title: 'Get session',
    description: 'A conversation across traces: each turn with the user message, the assistant reply, tools used, cost, errors and signals.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, max_turns: { type: 'integer', minimum: 1, maximum: 200 } }, required: ['session_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'stats',
    title: 'Stats',
    description: 'Totals for a time window: traces, cost, tokens, cache hit ratio, error rate, latency, top models, top tools and open issues.',
    inputSchema: { type: 'object', properties: { window: WINDOW, project: { type: 'string' } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'score_trace',
    title: 'Score trace',
    description: 'Record a score on a trace (or a span in it), for example a self-assessment or a test result. Give a value from 0 to 1, a label such as pass or fail, or both.',
    inputSchema: {
      type: 'object',
      properties: {
        trace_id: { type: 'string' },
        name: { type: 'string', description: 'Score name, for example task_completion.' },
        value: { type: 'number', minimum: 0, maximum: 1 },
        label: { type: 'string' },
        reasoning: { type: 'string' },
        span_id: { type: 'string' },
      },
      required: ['trace_id', 'name'],
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

export class ApiClient {
  base: string;

  constructor(base: string) {
    this.base = base.replace(/\/+$/, '');
  }

  async req(method: string, path: string, body?: unknown): Promise<any> {
    let r: Response;
    try {
      r = await fetch(this.base + path, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
    } catch (e: any) {
      throw new Error(`blackbox is not reachable at ${this.base} (${e?.cause?.code ?? e?.message ?? e}). Start it with: blackbox serve`);
    }
    const text = await r.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!r.ok) throw new Error(`${method} ${path} failed: ${r.status} ${data?.error ?? text.slice(0, 200)}`);
    return data;
  }

  get(path: string, q: Record<string, unknown> = {}): Promise<any> {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== null && v !== '') u.set(k, String(v));
    const qs = u.toString();
    return this.req('GET', path + (qs ? '?' + qs : ''));
  }
}

function one(s: unknown, n: number): string {
  if (s == null) return '';
  const t = (typeof s === 'string' ? s : JSON.stringify(s)).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function usd(v: unknown): string {
  const n = Number(v ?? 0);
  if (!n) return '$0';
  return n < 0.01 ? '$' + n.toFixed(4) : '$' + n.toFixed(2);
}

function ms(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return '?';
  if (n < 1000) return Math.round(n) + 'ms';
  if (n < 60000) return (n / 1000).toFixed(1) + 's';
  return (n / 60000).toFixed(1) + 'm';
}

function when(ns: unknown): string {
  const n = Number(ns);
  if (!Number.isFinite(n) || !n) return '?';
  return new Date(n / 1e6).toISOString().replace('T', ' ').slice(0, 19);
}

function tokens(v: unknown): string {
  const n = Number(v ?? 0);
  return n >= 1000 ? (n / 1000).toFixed(n >= 100000 ? 0 : 1) + 'k' : String(n);
}

function parsed(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v);
  } catch {
    return v;
  }
}

function lastUser(msgs: unknown): string | null {
  if (!Array.isArray(msgs)) return typeof msgs === 'string' ? msgs : null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m?.role === 'user' && typeof m.content === 'string' && m.content.trim() && !/^<system-reminder>/.test(m.content.trim())) return m.content;
  }
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i]?.role === 'user' && msgs[i].content) return msgs[i].content;
  return null;
}

function firstUser(msgs: unknown): string | null {
  if (!Array.isArray(msgs)) return typeof msgs === 'string' ? msgs : null;
  const users = msgs.filter((m: Any) => m?.role === 'user' && typeof m.content === 'string' && m.content.trim());
  const real = users.find((m: Any) => !/^<system-reminder>/.test(m.content.trim()));
  return (real ?? users[0])?.content ?? null;
}

export function renderTraceList(data: Any): string {
  const items: Any[] = data?.items ?? [];
  if (!items.length) return 'No traces match.';
  const lines = [`${items.length} of ${data.total ?? items.length} traces`];
  for (const t of items) {
    const sig = (t.signals ?? []).map((s: Any) => s.type).join(',');
    const sc = (t.scores ?? []).map((s: Any) => `${s.name}=${s.label ?? (s.value != null ? Number(s.value).toFixed(2) : '?')}`).join(',');
    lines.push(
      [
        t.trace_id,
        when(t.start_ns),
        one(t.name, 40),
        `${t.llm_calls ?? 0} llm, ${t.tool_calls ?? 0} tools`,
        usd(t.cost_usd),
        ms(t.duration_ms),
        t.error_count ? `${t.error_count} errors` : 'ok',
        sig ? 'signals: ' + sig : '',
        sc ? 'scores: ' + sc : '',
        t.agent_names ? 'agent: ' + t.agent_names : '',
        '| ' + one(t.input_preview, 120),
      ]
        .filter(Boolean)
        .join('  '),
    );
  }
  return lines.join('\n');
}

export function renderTrace(d: Any, opts: { maxSteps?: number; detail?: 'compact' | 'full' } = {}): string {
  const t = d.trace ?? {};
  const spans: Any[] = (d.spans ?? []).map((s: Any) => ({ ...s, input: parsed(s.input), output: parsed(s.output) }));
  const full = opts.detail === 'full';
  const w = full ? 2000 : 300;
  const maxSteps = opts.maxSteps ?? 60;
  const out: string[] = [];
  out.push(`Trace ${t.trace_id}  ${one(t.name, 80)}`);
  out.push(
    `${when(t.start_ns)}  duration ${ms(t.duration_ms)}  cost ${usd(t.cost_usd)}  tokens in ${tokens(t.input_tokens)} out ${tokens(t.output_tokens)} cache read ${tokens(t.cache_read_tokens)} write ${tokens(t.cache_write_tokens)}`,
  );
  const meta = [t.session_id ? 'session ' + t.session_id : '', t.agent_names ? 'agents ' + t.agent_names : '', t.models ? 'models ' + t.models : '', t.sources ? 'sources ' + t.sources : ''].filter(Boolean);
  if (meta.length) out.push(meta.join('  '));
  const root = spans.find((s) => s.span_id === t.root_span_id);
  const llms = spans.filter((s) => s.kind === 'llm');
  const goal = lastUser(root?.input) ?? firstUser(llms[0]?.input) ?? t.input_preview;
  if (goal) out.push('', 'Goal: ' + one(goal, full ? 4000 : 600));
  const steps = spans.filter((s) => ['llm', 'tool', 'mcp', 'memory', 'retriever', 'handoff', 'guardrail', 'embedding'].includes(s.kind) || s.status === 'error');
  out.push('', `Steps (${steps.length}${steps.length > maxSteps ? `, showing ${maxSteps}` : ''}):`);
  let n = 0;
  for (const s of steps.slice(0, maxSteps)) {
    n++;
    const err = s.status === 'error' ? `  ERROR: ${one(s.status_message, 200)}` : '';
    if (s.kind === 'llm') {
      const msgs = Array.isArray(s.output) ? s.output : [];
      const text = msgs.map((m: Any) => m.content).filter(Boolean).join(' ');
      const calls = msgs.flatMap((m: Any) => m.tool_calls ?? []).map((c: Any) => `${c.name}(${one(c.arguments, 120)})`);
      const tok = `in ${tokens(s.input_tokens)}${s.cache_read_tokens ? ' +' + tokens(s.cache_read_tokens) + ' cached' : ''} out ${tokens(s.output_tokens)}`;
      out.push(`${n}. LLM ${s.model ?? s.name}${s.agent_name ? ' [' + s.agent_name + ']' : ''}  ${ms(s.duration_ms)}  ${tok}  ${usd(s.cost_usd)}${err}`);
      if (text) out.push('   says: ' + one(text, w));
      if (calls.length) out.push('   calls: ' + calls.join('; '));
      if (!text && !calls.length && s.output_preview) out.push('   out: ' + one(s.output_preview, w));
    } else {
      const label = s.kind === 'mcp' ? `MCP ${s.mcp_server ? s.mcp_server + '.' : ''}${s.tool_name ?? s.name}` : s.kind === 'memory' ? `MEMORY ${s.memory_op ?? ''} ${s.tool_name ?? s.name}` : `${s.kind.toUpperCase()} ${s.tool_name ?? s.name}`;
      out.push(`${n}. ${label}  ${ms(s.duration_ms)}${err}`);
      if (s.input != null) out.push('   args: ' + one(s.input, w));
      if (s.output != null) out.push('   result: ' + one(s.output, w));
    }
  }
  const errors = spans.filter((s) => s.status === 'error');
  if (errors.length) {
    out.push('', `Errors (${errors.length}):`);
    for (const e of errors.slice(0, 20)) out.push(`- ${e.tool_name ?? e.name}: ${one(e.status_message, 300)}`);
  }
  const sigs: Any[] = d.signals ?? [];
  if (sigs.length) {
    out.push('', 'Signals:');
    for (const s of sigs) out.push(`- [${s.severity}] ${s.type}: ${one(s.title, 200)}`);
  }
  const scores: Any[] = d.scores ?? [];
  if (scores.length) {
    out.push('', 'Scores:');
    for (const s of scores) out.push(`- ${s.name} = ${s.label ?? ''}${s.value != null ? ' (' + Number(s.value).toFixed(2) + ')' : ''} [${s.source}]${s.reasoning ? ': ' + one(s.reasoning, 200) : ''}`);
  }
  const final = [...llms].reverse().find((s) => Array.isArray(s.output) && s.output.some((m: Any) => m.content));
  const answer = root?.output ?? final?.output;
  if (answer) {
    const txt = Array.isArray(answer) ? answer.map((m: Any) => m.content).filter(Boolean).join(' ') : answer;
    if (txt) out.push('', 'Final answer: ' + one(txt, full ? 4000 : 600));
  }
  return out.join('\n');
}

export function renderIssues(d: Any): string {
  const items: Any[] = d?.items ?? [];
  if (!items.length) return 'No issues.';
  return items
    .map((i) => `[${i.severity}] ${i.type}  ${one(i.title, 160)}  count ${i.count} in ${i.traces} traces  last ${when(Number(i.last_seen) * 1e6)}  status ${i.status}  sample ${i.sample_trace_id}  fingerprint ${i.fingerprint}`)
    .join('\n');
}

export function renderSession(d: Any, maxTurns = 50): string {
  const s = d.session ?? {};
  const out = [
    `Session ${s.session_id}  ${s.trace_count ?? 0} traces  ${s.llm_calls ?? 0} llm calls  ${s.tool_calls ?? 0} tool calls  ${s.error_count ?? 0} errors  cost ${usd(s.cost_usd)}`,
    `${when(s.start_ns)} to ${when(s.end_ns)}`,
  ];
  const turns: Any[] = d.turns ?? [];
  turns.slice(0, maxTurns).forEach((t, i) => {
    out.push('', `Turn ${i + 1}  trace ${t.trace_id}  ${ms(t.duration_ms)}  ${usd(t.cost_usd)}${t.error_count ? '  ' + t.error_count + ' errors' : ''}`);
    if (t.user) out.push('  user: ' + one(t.user, 400));
    const tools = (t.tools ?? []).map((x: Any) => (x.tool_name ?? x.name) + (x.status === 'error' ? '(error)' : ''));
    if (tools.length) out.push('  tools: ' + tools.slice(0, 30).join(', ') + (tools.length > 30 ? ` +${tools.length - 30} more` : ''));
    if (t.assistant) out.push('  assistant: ' + one(t.assistant, 400));
    const sig = (t.signals ?? []).map((x: Any) => x.type).join(',');
    if (sig) out.push('  signals: ' + sig);
  });
  if (turns.length > maxTurns) out.push('', `${turns.length - maxTurns} more turns not shown.`);
  return out.join('\n');
}

export function renderStats(d: Any, window: string): string {
  const t = d.totals ?? {};
  const out = [
    `Last ${window}: ${t.traces ?? 0} traces, ${t.sessions ?? 0} sessions, ${t.llm_calls ?? 0} llm calls, ${t.tool_calls ?? 0} tool calls`,
    `cost ${usd(t.cost_usd)}  tokens in ${tokens(t.input_tokens)} out ${tokens(t.output_tokens)} cache read ${tokens(t.cache_read_tokens)} write ${tokens(t.cache_write_tokens)}  cache hit ${t.cache_hit_ratio != null ? Math.round(t.cache_hit_ratio * 100) + '%' : 'n/a'}`,
    `error rate ${Math.round((t.error_rate ?? 0) * 100)}%  trace p50 ${ms(t.p50_ms)} p95 ${ms(t.p95_ms)}  llm p50 ${ms(t.llm_p50_ms)} p95 ${ms(t.llm_p95_ms)}${t.cost_per_clean_trace != null ? '  cost per clean trace ' + usd(t.cost_per_clean_trace) : ''}`,
  ];
  const models: Any[] = d.models ?? [];
  if (models.length) out.push('', 'Models:', ...models.slice(0, 8).map((m) => `- ${m.model}: ${m.calls} calls, ${usd(m.cost_usd)}, ${m.errors ?? 0} errors, avg ${ms(m.avg_ms)}`));
  const tools: Any[] = d.tools ?? [];
  if (tools.length) out.push('', 'Tools:', ...tools.slice(0, 10).map((x) => `- ${x.tool}${x.mcp_server ? ' (' + x.mcp_server + ')' : ''}: ${x.calls} calls, ${x.errors ?? 0} errors, avg ${ms(x.avg_ms)}`));
  const issues: Any[] = d.issues ?? [];
  if (issues.length) out.push('', 'Issues:', ...issues.slice(0, 8).map((i) => `- [${i.severity}] ${i.type}: ${one(i.title, 120)} (${i.count})`));
  return out.join('\n');
}

export async function callTool(api: ApiClient, name: string, args: Any): Promise<string> {
  const a = args ?? {};
  if (name === 'search_traces') {
    const d = await api.get('/api/traces', { q: a.q, status: a.status, signal: a.signal, agent: a.agent, model: a.model, tool: a.tool, session: a.session, window: a.window, limit: Math.min(100, Number(a.limit ?? 20)) });
    return renderTraceList(d);
  }
  if (name === 'get_trace') {
    if (!a.trace_id) throw new Error('trace_id is required');
    const d = await api.get('/api/traces/' + encodeURIComponent(a.trace_id));
    return renderTrace(d, { maxSteps: a.max_steps, detail: a.detail });
  }
  if (name === 'list_issues') return renderIssues(await api.get('/api/issues', { status: a.status ?? 'open', window: a.window, limit: a.limit }));
  if (name === 'get_session') {
    if (!a.session_id) throw new Error('session_id is required');
    return renderSession(await api.get('/api/sessions/' + encodeURIComponent(a.session_id)), a.max_turns ?? 50);
  }
  if (name === 'stats') {
    const window = a.window ?? '24h';
    return renderStats(await api.get('/api/overview', { window, project: a.project }), window);
  }
  if (name === 'score_trace') {
    if (!a.trace_id || !a.name) throw new Error('trace_id and name are required');
    if (a.value == null && !a.label) throw new Error('give a value, a label, or both');
    const s = await api.req('POST', '/api/scores', { trace_id: a.trace_id, span_id: a.span_id, name: a.name, value: a.value, label: a.label, reasoning: a.reasoning, source: 'sdk' });
    return `Recorded score ${a.name}${a.label ? ' = ' + a.label : ''}${a.value != null ? ' (' + a.value + ')' : ''} on trace ${a.trace_id}${s?.id ? ' as ' + s.id : ''}.`;
  }
  throw new Error('unknown tool ' + name);
}

export interface ServerIO {
  write: (line: string) => void;
}

export class McpServer {
  api: ApiClient;
  io: ServerIO;
  protocolVersion = PROTOCOL_VERSIONS[1];

  constructor(api: ApiClient, io: ServerIO) {
    this.api = api;
    this.io = io;
  }

  send(msg: Any): void {
    this.io.write(JSON.stringify(msg) + '\n');
  }

  async handleLine(line: string): Promise<void> {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (Array.isArray(msg)) {
      const res = (await Promise.all(msg.map((m) => this.handle(m)))).filter(Boolean);
      if (res.length) this.io.write(JSON.stringify(res) + '\n');
      return;
    }
    const r = await this.handle(msg);
    if (r) this.send(r);
  }

  async handle(m: any): Promise<Any | null> {
    if (!m || typeof m !== 'object' || m.jsonrpc !== '2.0') return { jsonrpc: '2.0', id: m?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
    const isRequest = m.id !== undefined && m.id !== null;
    if (typeof m.method !== 'string') return null;
    if (!isRequest) return null;
    try {
      const result = await this.dispatch(m.method, m.params ?? {});
      return { jsonrpc: '2.0', id: m.id, result };
    } catch (e: any) {
      if (e && typeof e.code === 'number') return { jsonrpc: '2.0', id: m.id, error: { code: e.code, message: e.message, ...(e.data ? { data: e.data } : {}) } };
      return { jsonrpc: '2.0', id: m.id, error: { code: -32603, message: String(e?.message ?? e) } };
    }
  }

  negotiate(requested: unknown): string {
    if (typeof requested === 'string' && PROTOCOL_VERSIONS.includes(requested)) return requested;
    if (typeof requested === 'string') {
      const older = PROTOCOL_VERSIONS.filter((v) => v <= requested);
      if (older.length) return older[0];
    }
    return PROTOCOL_VERSIONS[1];
  }

  async dispatch(method: string, params: Any): Promise<Any> {
    const metaVersion = params?._meta?.['io.modelcontextprotocol/protocolVersion'] ?? params?._meta?.protocolVersion;
    if (metaVersion && typeof metaVersion === 'string') this.protocolVersion = this.negotiate(metaVersion);
    switch (method) {
      case 'initialize': {
        this.protocolVersion = this.negotiate(params.protocolVersion);
        return {
          protocolVersion: this.protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'blackbox', title: 'blackbox telemetry', version: VERSION },
          instructions: 'Query this machine\'s recorded LLM and agent telemetry. Start with stats or search_traces, then get_trace on an id. Use score_trace to record a judgement about a run.',
        };
      }
      case 'ping':
        return {};
      case 'tools/list':
        return { tools: TOOLS };
      case 'tools/call': {
        const name = String(params.name ?? '');
        if (!TOOLS.some((t) => t.name === name)) throw Object.assign(new Error('Unknown tool: ' + name), { code: -32602 });
        try {
          const text = await callTool(this.api, name, params.arguments ?? {});
          return { content: [{ type: 'text', text }], isError: false };
        } catch (e: any) {
          return { content: [{ type: 'text', text: String(e?.message ?? e) }], isError: true };
        }
      }
      case 'resources/list':
        return { resources: [] };
      case 'resources/templates/list':
        return { resourceTemplates: [] };
      case 'prompts/list':
        return { prompts: [] };
      case 'logging/setLevel':
        return {};
      default:
        throw Object.assign(new Error('Method not found: ' + method), { code: -32601 });
    }
  }
}

export function runMcpServer(opts: { url?: string } = {}): Promise<void> {
  const api = new ApiClient(opts.url ?? process.env.BLACKBOX_URL ?? 'http://localhost:7777');
  const server = new McpServer(api, { write: (l) => void process.stdout.write(l) });
  const inflight = new Set<Promise<void>>();
  const splitter = new LineSplitter((line) => {
    const p = server.handleLine(line).catch((e) => {
      process.stderr.write('[blackbox mcp-server] ' + String(e?.message ?? e) + '\n');
    });
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  });
  process.stdout.on('error', () => {});
  return new Promise((resolve) => {
    process.stdin.on('data', (c: Buffer) => splitter.push(c));
    process.stdin.on('end', async () => {
      await Promise.allSettled([...inflight]);
      resolve();
    });
  });
}
