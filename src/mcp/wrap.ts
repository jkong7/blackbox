import { spawn } from 'node:child_process';
import { memoryOpFromName } from '../normalize.ts';
import { hexId, sha, shortHash, stableStringify } from '../util.ts';
import { parseTraceparent } from '../tracecontext.ts';

type Any = Record<string, any>;

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ApiSpan {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  name: string;
  kind: string;
  source: string;
  start_ns: number;
  end_ns: number;
  status: 'ok' | 'error' | 'unset';
  status_message: string | null;
  session_id: string | null;
  agent_name: string | null;
  project: string;
  tool_name: string | null;
  tool_call_id: string | null;
  mcp_server: string | null;
  mcp_method: string;
  memory_op: string | null;
  input: unknown;
  output: unknown;
  attributes: Any;
}

export function toolHash(t: McpToolDef): string {
  return shortHash(stableStringify({ name: t.name, description: t.description ?? null, inputSchema: t.inputSchema ?? null }));
}

export function toolTokens(t: McpToolDef): number {
  return Math.ceil(JSON.stringify({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? {} }).length / 4);
}

export class LineSplitter {
  buf: Buffer = Buffer.alloc(0);
  onLine: (line: string) => void;
  max: number;

  constructor(onLine: (line: string) => void, max = 64 * 1024 * 1024) {
    this.onLine = onLine;
    this.max = max;
  }

  push(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    let i: number;
    while ((i = this.buf.indexOf(10)) >= 0) {
      const line = this.buf.subarray(0, i).toString('utf8').replace(/\r$/, '');
      this.buf = this.buf.subarray(i + 1);
      if (line.trim()) this.onLine(line);
    }
    if (this.buf.length > this.max) this.buf = Buffer.alloc(0);
  }
}

const RECORDED = new Set(['tools/call', 'resources/read', 'prompts/get', 'initialize']);
const MAX_PAYLOAD = 256 * 1024;

function cap(v: unknown): unknown {
  if (v == null) return v;
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= MAX_PAYLOAD) return v;
  return { truncated: true, bytes: s.length, head: s.slice(0, MAX_PAYLOAD) };
}

function idKey(id: unknown): string {
  return typeof id + ':' + String(id);
}

function errorText(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const t = content.filter((c: Any) => c && c.type === 'text').map((c: Any) => c.text).join('\n').trim();
  return t ? t.slice(0, 1000) : null;
}

interface PendingReq {
  method: string;
  params: Any;
  id: unknown;
  startNs: number;
  startPerf: number;
}

export interface TrackerOptions {
  name?: string | null;
  sessionId?: string;
  project?: string;
  onSpan: (s: ApiSpan) => void;
  onTools?: (server: string, tools: McpToolDef[]) => void;
}

export class McpTracker {
  pending = new Map<string, PendingReq>();
  serverName: string | null;
  serverVersion: string | null = null;
  nameOverride: string | null;
  clientName: string | null = null;
  protocolVersion: string | null = null;
  sessionId: string;
  project: string;
  opts: TrackerOptions;

  constructor(opts: TrackerOptions) {
    this.opts = opts;
    this.nameOverride = opts.name ?? null;
    this.serverName = opts.name ?? null;
    this.sessionId = opts.sessionId ?? 'mcp-' + hexId(8);
    this.project = opts.project ?? 'default';
  }

  fromClient(line: string): void {
    this.each(line, (m) => {
      if (typeof m.method === 'string' && m.id !== undefined && m.id !== null) {
        this.pending.set(idKey(m.id), { method: m.method, params: m.params ?? {}, id: m.id, startNs: Date.now() * 1e6, startPerf: performance.now() });
        if (m.method === 'initialize') {
          this.clientName = m.params?.clientInfo?.name ?? null;
          this.protocolVersion = m.params?.protocolVersion ?? null;
        }
      } else if (m.method === 'notifications/cancelled') {
        const rid = m.params?.requestId;
        const p = rid !== undefined ? this.pending.get(idKey(rid)) : undefined;
        if (p) {
          this.pending.delete(idKey(rid));
          this.emit(p, null, null, 'cancelled', m.params?.reason ?? 'cancelled by client');
        }
      }
    });
  }

  fromServer(line: string): void {
    this.each(line, (m) => {
      if (m.method !== undefined || m.id === undefined || m.id === null) return;
      const k = idKey(m.id);
      const p = this.pending.get(k);
      if (!p) return;
      this.pending.delete(k);
      if (p.method === 'initialize' && m.result) {
        const si = m.result.serverInfo ?? {};
        if (!this.nameOverride && si.name) this.serverName = String(si.name);
        this.serverVersion = si.version ?? null;
        this.protocolVersion = m.result.protocolVersion ?? this.protocolVersion;
      }
      if (p.method === 'tools/list' && Array.isArray(m.result?.tools)) {
        const tools = m.result.tools.filter((t: Any) => t && typeof t.name === 'string').map((t: Any) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
        try {
          this.opts.onTools?.(this.serverName ?? 'unknown', tools);
        } catch {}
      }
      this.emit(p, m.result ?? null, m.error ?? null, null, null);
    });
  }

  flushPending(reason = 'no response before exit'): void {
    for (const p of this.pending.values()) this.emit(p, null, null, 'unanswered', reason);
    this.pending.clear();
  }

  each(line: string, fn: (m: Any) => void): void {
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      return;
    }
    const arr = Array.isArray(v) ? v : [v];
    for (const m of arr) {
      if (!m || typeof m !== 'object') continue;
      try {
        fn(m as Any);
      } catch {}
    }
  }

  emit(p: PendingReq, result: Any | null, error: Any | null, abandoned: string | null, reason: string | null): void {
    if (!RECORDED.has(p.method)) return;
    const endNs = p.startNs + Math.round((performance.now() - p.startPerf) * 1e6);
    const params = p.params ?? {};
    const meta = (params._meta ?? {}) as Any;
    const tp = parseTraceparent(meta.traceparent);
    const traceId = tp?.traceId ?? hexId(16);
    const server = this.serverName ?? 'unknown';
    let name: string = p.method;
    let toolName: string | null = null;
    let input: unknown = params;
    let output: unknown = null;
    let kind = 'mcp';
    let memoryOp: string | null = null;
    let status: ApiSpan['status'] = 'ok';
    let message: string | null = null;
    const attrs: Any = {
      'mcp.method.name': p.method,
      'mcp.server.name': server,
      'jsonrpc.request.id': String(p.id),
      'mcp.session.id': this.sessionId,
      'blackbox.mcp_wrapper': true,
    };
    if (this.serverVersion) attrs['mcp.server.version'] = this.serverVersion;
    if (this.protocolVersion) attrs['mcp.protocol.version'] = this.protocolVersion;
    if (this.clientName) attrs['mcp.client.name'] = this.clientName;

    if (p.method === 'tools/call') {
      toolName = String(params.name ?? 'tool');
      name = 'tools/call ' + toolName;
      input = params.arguments ?? {};
      attrs['gen_ai.tool.name'] = toolName;
      attrs['gen_ai.operation.name'] = 'execute_tool';
      memoryOp = memoryOpFromName(toolName) ?? (memoryOpFromName(server) ? memoryOpFromName('memory_' + toolName) : null);
      if (memoryOp) kind = 'memory';
      if (result) {
        output = result.structuredContent !== undefined ? { content: result.content, structuredContent: result.structuredContent } : result.content ?? result;
        if (result.isError) {
          status = 'error';
          message = errorText(result.content) ?? 'tool returned isError';
          attrs['mcp.tool.is_error'] = true;
        }
        attrs['blackbox.result_tokens'] = Math.ceil(JSON.stringify(output ?? '').length / 4);
      }
    } else if (p.method === 'resources/read') {
      name = 'resources/read ' + String(params.uri ?? '');
      attrs['mcp.resource.uri'] = params.uri;
      output = result?.contents ?? result;
      if (/memory|memories/i.test(String(params.uri ?? '')) || memoryOpFromName(server)) {
        kind = 'memory';
        memoryOp = 'read';
      }
    } else if (p.method === 'prompts/get') {
      name = 'prompts/get ' + String(params.name ?? '');
      attrs['gen_ai.prompt.name'] = params.name;
      input = params.arguments ?? {};
      output = Array.isArray(result?.messages) ? result.messages.map((m: Any) => ({ role: String(m?.role ?? 'user'), content: m?.content?.type === 'text' ? String(m.content.text ?? '') : JSON.stringify(m?.content ?? null) })) : result;
    } else if (p.method === 'initialize') {
      name = 'initialize';
      input = { protocolVersion: params.protocolVersion, clientInfo: params.clientInfo, capabilities: params.capabilities };
      output = result ? { protocolVersion: result.protocolVersion, serverInfo: result.serverInfo, capabilities: result.capabilities, instructions: result.instructions } : null;
    }
    if (error) {
      status = 'error';
      message = String(error.message ?? 'JSON-RPC error ' + error.code);
      output = error;
      attrs['rpc.jsonrpc.error_code'] = error.code;
      attrs['error.type'] = String(error.code ?? 'error');
    }
    if (abandoned) {
      status = abandoned === 'cancelled' ? 'unset' : 'error';
      message = reason;
      attrs['blackbox.' + abandoned] = true;
    }
    const callId = meta['claudecode/toolUseId'] ?? meta.toolUseId ?? meta.tool_call_id ?? null;
    if (meta.progressToken !== undefined) attrs['mcp.progress_token'] = String(meta.progressToken);
    if (tp) attrs['blackbox.traceparent_span_id'] = tp.spanId;
    const spanSeed = this.sessionId + ':' + idKey(p.id) + ':' + p.startNs;
    this.opts.onSpan({
      trace_id: traceId,
      span_id: sha(spanSeed).slice(0, 16),
      parent_id: tp?.spanId ?? null,
      name,
      kind,
      source: 'mcp-wrapper',
      start_ns: p.startNs,
      end_ns: endNs,
      status,
      status_message: message,
      session_id: this.sessionId,
      agent_name: this.clientName,
      project: this.project,
      tool_name: toolName,
      tool_call_id: callId != null ? String(callId) : null,
      mcp_server: server,
      mcp_method: p.method,
      memory_op: memoryOp,
      input: cap(input),
      output: cap(output),
      attributes: attrs,
    });
  }
}

export interface ExporterOptions {
  url: string;
  maxBuffer?: number;
  batch?: number;
  intervalMs?: number;
}

export class Exporter {
  url: string;
  queue: ApiSpan[] = [];
  tools: { server: string; tools: McpToolDef[] }[] = [];
  maxBuffer: number;
  batch: number;
  timer: NodeJS.Timeout | null = null;
  inflight: Promise<void> | null = null;
  failures = 0;
  intervalMs: number;

  constructor(opts: ExporterOptions) {
    this.url = opts.url.replace(/\/+$/, '');
    this.maxBuffer = opts.maxBuffer ?? 200;
    this.batch = opts.batch ?? 20;
    this.intervalMs = opts.intervalMs ?? 500;
  }

  span(s: ApiSpan): void {
    this.queue.push(s);
    if (this.queue.length > this.maxBuffer) this.queue.splice(0, this.queue.length - this.maxBuffer);
    this.schedule(this.queue.length >= this.batch ? 0 : this.intervalMs);
  }

  toolDefs(server: string, tools: McpToolDef[]): void {
    this.tools.push({ server, tools });
    if (this.tools.length > 20) this.tools.shift();
    this.schedule(0);
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
    this.timer.unref();
  }

  async post(path: string, body: unknown): Promise<boolean> {
    try {
      const r = await fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(3000) });
      await r.arrayBuffer().catch(() => null);
      return r.ok || (r.status >= 400 && r.status < 500);
    } catch {
      return false;
    }
  }

  async flush(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        while (this.tools.length) {
          const t = this.tools[0];
          if (!(await this.post('/api/mcp/tools', t))) throw new Error('down');
          this.tools.shift();
        }
        while (this.queue.length) {
          const batch = this.queue.slice(0, this.batch);
          if (!(await this.post('/api/ingest', { spans: batch }))) throw new Error('down');
          this.queue.splice(0, batch.length);
        }
        this.failures = 0;
      } catch {
        this.failures++;
        if (this.queue.length || this.tools.length) this.schedule(this.intervalMs);
      } finally {
        this.inflight = null;
      }
    })();
    return this.inflight;
  }
}

export interface WrapOptions {
  name?: string;
  url?: string;
  project?: string;
  sessionId?: string;
}

export function parseWrapArgs(argv: string[]): { cmd: string[]; opts: WrapOptions } {
  const opts: WrapOptions = {};
  const dd = argv.indexOf('--');
  const flags = dd >= 0 ? argv.slice(0, dd) : [];
  let cmd = dd >= 0 ? argv.slice(dd + 1) : [];
  if (dd < 0) {
    let i = 0;
    while (i < argv.length && argv[i].startsWith('--')) {
      flags.push(argv[i]);
      if (!argv[i].includes('=')) flags.push(argv[i + 1]);
      i += argv[i].includes('=') ? 1 : 2;
    }
    cmd = argv.slice(i);
  }
  for (let i = 0; i < flags.length; i++) {
    const f = flags[i];
    const [k, inline] = f.split('=', 2);
    const val = inline ?? flags[++i];
    if (k === '--name') opts.name = val;
    else if (k === '--url') opts.url = val;
    else if (k === '--project') opts.project = val;
    else if (k === '--session') opts.sessionId = val;
  }
  return { cmd, opts };
}

export function runMcpWrapper(cmd: string[], opts: WrapOptions = {}): Promise<number> {
  return new Promise((resolve) => {
    if (!cmd.length) {
      process.stderr.write('usage: blackbox mcp [--name NAME] -- <server command...>\n');
      resolve(2);
      return;
    }
    const exporter = new Exporter({ url: opts.url ?? process.env.BLACKBOX_URL ?? 'http://localhost:7777' });
    const tracker = new McpTracker({
      name: opts.name ?? process.env.BLACKBOX_MCP_NAME ?? null,
      sessionId: opts.sessionId ?? process.env.BLACKBOX_SESSION ?? undefined,
      project: opts.project ?? process.env.BLACKBOX_PROJECT ?? 'default',
      onSpan: (s) => exporter.span(s),
      onTools: (server, tools) => exporter.toolDefs(server, tools),
    });
    const safe = (fn: () => void) => {
      try {
        fn();
      } catch {}
    };
    const child = spawn(cmd[0], cmd.slice(1), { stdio: ['pipe', 'pipe', 'inherit'], env: process.env });
    const fromClient = new LineSplitter((l) => safe(() => tracker.fromClient(l)));
    const fromServer = new LineSplitter((l) => safe(() => tracker.fromServer(l)));
    child.stdin.on('error', () => {});
    child.stdout.on('error', () => {});
    process.stdout.on('error', () => {});
    process.stdin.on('data', (c: Buffer) => safe(() => fromClient.push(c)));
    process.stdin.pipe(child.stdin);
    child.stdout.on('data', (c: Buffer) => safe(() => fromServer.push(c)));
    child.stdout.pipe(process.stdout);
    let exited = false;
    const finish = async (code: number) => {
      if (exited) return;
      exited = true;
      safe(() => tracker.flushPending());
      await Promise.race([exporter.flush(), new Promise((r) => setTimeout(r, 1500))]);
      resolve(code);
    };
    child.on('error', (e: any) => {
      process.stderr.write(`[blackbox mcp] failed to start ${cmd[0]}: ${e?.message ?? e}\n`);
      void finish(127);
    });
    child.on('exit', (code, signal) => void finish(code ?? (signal ? 128 + (signal === 'SIGTERM' ? 15 : signal === 'SIGINT' ? 2 : 1) : 0)));
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(sig, () => {
        safe(() => child.kill(sig));
      });
    }
  });
}
