import type { IncomingMessage } from 'node:http';
import type { Router } from './http.ts';
import { HttpError } from './http.ts';
import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { nowMs } from './util.ts';
import { toolHash, toolTokens, type McpToolDef } from './mcp/wrap.ts';

type Any = Record<string, any>;

export interface ToolsUpsertResult {
  server: string;
  tools: number;
  added: string[];
  changed: string[];
  tokens: number;
}

export function upsertMcpTools(db: DB, server: string, tools: McpToolDef[], now = nowMs()): ToolsUpsertResult {
  const known = db.prepare('select name, hash from mcp_tools where server = ?').all(server) as { name: string; hash: string }[];
  const byName = new Map<string, Set<string>>();
  for (const k of known) {
    if (!byName.has(k.name)) byName.set(k.name, new Set());
    byName.get(k.name)!.add(k.hash);
  }
  const up = db.prepare(
    `insert into mcp_tools(server, name, hash, description, schema, tokens, first_seen, last_seen) values(?,?,?,?,?,?,?,?)
     on conflict(server, name, hash) do update set last_seen = excluded.last_seen, tokens = excluded.tokens`,
  );
  const added: string[] = [];
  const changed: string[] = [];
  let tokens = 0;
  db.exec('begin immediate');
  try {
    for (const t of tools) {
      if (!t || typeof t.name !== 'string' || !t.name) continue;
      const hash = toolHash(t);
      const tk = toolTokens(t);
      tokens += tk;
      const prior = byName.get(t.name);
      if (!prior) added.push(t.name);
      else if (!prior.has(hash)) changed.push(t.name);
      up.run(server, t.name, hash, t.description ?? null, t.inputSchema != null ? JSON.stringify(t.inputSchema) : null, tk, now, now);
    }
    db.exec('commit');
  } catch (e) {
    db.exec('rollback');
    throw e;
  }
  return { server, tools: tools.length, added, changed, tokens };
}

function baseUrl(req: IncomingMessage): string {
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? `localhost:${process.env.BLACKBOX_PORT || 7777}`);
  return `http://${host}`;
}

export interface Snippet {
  id: string;
  title: string;
  description: string;
  language: string;
  code: string;
  notes?: string[];
}

export function connectSnippets(base: string, proxyPort = Number(process.env.BLACKBOX_PROXY_PORT || 7778)): { base: string; proxy: string; snippets: Snippet[] } {
  const host = new URL(base).hostname;
  const proxy = `http://${host}:${proxyPort}`;
  const otlpEnv = [
    'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
    'export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
    'export OTEL_TRACES_EXPORTER=otlp',
    'export OTEL_LOGS_EXPORTER=otlp',
    'export OTEL_METRICS_EXPORTER=otlp',
    'export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    `export OTEL_EXPORTER_OTLP_ENDPOINT=${base}`,
    'export OTEL_LOG_USER_PROMPTS=1',
    'export OTEL_LOG_ASSISTANT_RESPONSES=1',
    'export OTEL_LOG_TOOL_DETAILS=1',
    'export OTEL_LOG_TOOL_CONTENT=1',
    'export OTEL_METRICS_INCLUDE_SESSION_ID=true',
    'export OTEL_BSP_SCHEDULE_DELAY=1000',
    'export OTEL_LOGS_EXPORT_INTERVAL=1000',
  ];
  const snippets: Snippet[] = [
    {
      id: 'claude-code',
      title: 'Claude Code (OpenTelemetry)',
      description: 'Traces (beta), events and metrics from Claude Code. Add to your shell profile or to the env block of ~/.claude/settings.json.',
      language: 'bash',
      code: otlpEnv.join('\n'),
      notes: [
        'CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1 with OTEL_TRACES_EXPORTER turns on the span tree: claude_code.interaction, llm_request, tool, hooks and subagents.',
        'The OTEL_LOG_* flags capture prompts, responses and tool inputs and outputs. Leave them out to record only metadata.',
        'Telemetry alone does not include the full request messages or tool definitions. Add the proxy below for full LLM content.',
      ],
    },
    {
      id: 'claude-code-settings',
      title: 'Claude Code (settings.json)',
      description: 'The same setup as a settings.json env block.',
      language: 'json',
      code: JSON.stringify(
        {
          env: {
            ...Object.fromEntries(otlpEnv.map((l) => l.replace(/^export /, '').split('=') as [string, string])),
            ANTHROPIC_BASE_URL: proxy,
            CLAUDE_CODE_PROPAGATE_TRACEPARENT: '1',
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'claude-code-proxy',
      title: 'Claude Code (proxy, full content)',
      description: 'Route Claude Code through the blackbox proxy to record every request with the full messages, tool definitions, cache tokens and streaming timing. Works with API keys and Claude subscriptions.',
      language: 'bash',
      code: [`export ANTHROPIC_BASE_URL=${proxy}`, 'export CLAUDE_CODE_PROPAGATE_TRACEPARENT=1', 'claude'].join('\n'),
      notes: [
        'With CLAUDE_CODE_PROPAGATE_TRACEPARENT=1 and the telemetry above, each proxied call is merged onto its claude_code.llm_request span, so tokens are never double counted.',
        'Without telemetry, calls are grouped into sessions by the x-claude-code-session-id header Claude Code sends.',
        'Hooks and plugins that call claude themselves inherit ANTHROPIC_BASE_URL and show up as their own sessions.',
      ],
    },
    {
      id: 'proxy',
      title: 'LLM proxy (any app)',
      description: 'Zero code changes: point the SDK base URL at blackbox. Requests go to the real API with your own key; blackbox never stores auth headers.',
      language: 'bash',
      code: [`export ANTHROPIC_BASE_URL=${proxy}`, `export OPENAI_BASE_URL=${proxy}/v1`].join('\n'),
      notes: [
        'Recorded: /v1/messages (Anthropic), /v1/chat/completions and /v1/responses (OpenAI), streaming or not. Other paths pass through.',
        'Optional request headers: x-blackbox-session, x-blackbox-trace, x-blackbox-agent, x-blackbox-project, and W3C traceparent to nest the call under your own span.',
        'Upstreams can be changed with BLACKBOX_UPSTREAM_ANTHROPIC and BLACKBOX_UPSTREAM_OPENAI (for example an Azure or gateway URL).',
      ],
    },
    {
      id: 'codex',
      title: 'OpenAI Codex CLI',
      description: 'Add to ~/.codex/config.toml.',
      language: 'toml',
      code: [
        '[otel]',
        'environment = "dev"',
        'log_user_prompt = true',
        `exporter = { otlp-http = { endpoint = "${base}/v1/logs", protocol = "binary" } }`,
        `trace_exporter = { otlp-http = { endpoint = "${base}/v1/traces", protocol = "binary" } }`,
      ].join('\n'),
      notes: ['Codex emits codex.* log events (user_prompt, sse_event, tool_decision, tool_result). blackbox builds one trace per turn from them, with model calls, tokens, TTFT and tool calls. Leave the Codex trace_exporter off, because its internal spans are noise. To capture full model traffic as well, set OPENAI_BASE_URL to the proxy.'],
    },
    {
      id: 'otel',
      title: 'Any OpenTelemetry SDK',
      description: 'blackbox accepts OTLP over HTTP (protobuf or JSON) for traces, logs and metrics.',
      language: 'bash',
      code: [`export OTEL_EXPORTER_OTLP_ENDPOINT=${base}`, 'export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf', 'export OTEL_SERVICE_NAME=my-agent', 'export OTEL_SEMCONV_STABILITY_OPT_IN=gen_ai_latest_experimental', 'export OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT=true'].join('\n'),
      notes: ['Port 4318 also accepts OTLP, so exporters with default settings work unchanged.', `Set the project with the header x-blackbox-project, for example OTEL_EXPORTER_OTLP_HEADERS=x-blackbox-project=my-app.`],
    },
    {
      id: 'openinference',
      title: 'OpenInference (Arize, Phoenix instrumentors)',
      description: 'Use any OpenInference instrumentor with a plain OTLP exporter pointed at blackbox.',
      language: 'python',
      code: [
        'from opentelemetry import trace',
        'from opentelemetry.sdk.trace import TracerProvider',
        'from opentelemetry.sdk.trace.export import BatchSpanProcessor',
        'from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter',
        'from openinference.instrumentation.anthropic import AnthropicInstrumentor',
        '',
        'provider = TracerProvider()',
        `provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="${base}/v1/traces")))`,
        'trace.set_tracer_provider(provider)',
        'AnthropicInstrumentor().instrument()',
      ].join('\n'),
    },
    {
      id: 'openllmetry',
      title: 'OpenLLMetry (Traceloop)',
      description: 'Point the Traceloop SDK at blackbox.',
      language: 'python',
      code: ['from traceloop.sdk import Traceloop', '', `Traceloop.init(app_name="my-agent", api_endpoint="${base}", disable_batch=True)`].join('\n'),
      notes: ['Or set TRACELOOP_BASE_URL to the same address.'],
    },
    {
      id: 'vercel-ai',
      title: 'Vercel AI SDK',
      description: 'Enable telemetry per call and register an OTLP exporter (for example @vercel/otel or NodeSDK).',
      language: 'typescript',
      code: [
        "import { generateText } from 'ai';",
        '',
        'await generateText({',
        '  model,',
        '  prompt,',
        "  experimental_telemetry: { isEnabled: true, functionId: 'my-agent', metadata: { sessionId: 'abc' } },",
        '});',
      ].join('\n'),
      notes: [`Set OTEL_EXPORTER_OTLP_ENDPOINT=${base} for the exporter.`],
    },
    {
      id: 'openai-agents',
      title: 'OpenAI Agents SDK',
      description: 'Use an OpenTelemetry or OpenInference processor so the agent, generation, function and handoff spans reach blackbox, or route model calls through the proxy.',
      language: 'python',
      code: [
        'from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor',
        'OpenAIAgentsInstrumentor().instrument()',
        '',
        `# plus the OTLP exporter setup from the OpenInference snippet, endpoint ${base}/v1/traces`,
      ].join('\n'),
      notes: [`Simplest path with no tracing setup: OPENAI_BASE_URL=${proxy}/v1.`],
    },
    {
      id: 'mcp-wrapper',
      title: 'MCP servers (stdio wrapper)',
      description: 'Wrap any stdio MCP server to record every tool call, resource read and prompt, plus tool definition drift and toolset token cost.',
      language: 'bash',
      code: ['claude mcp add github -- blackbox mcp --name github -- npx -y @modelcontextprotocol/server-github', '', '# any server: blackbox mcp [--name NAME] [--project P] -- <server command...>'].join('\n'),
      notes: [`Spans are sent to BLACKBOX_URL (default ${base}). If blackbox is down the wrapper keeps working and drops telemetry.`, 'Requests that carry params._meta.traceparent are nested under the caller span.'],
    },
    {
      id: 'mcp-wrapper-json',
      title: 'MCP wrapper (JSON config)',
      description: 'For .mcp.json, Claude Desktop, Cursor and other JSON configs.',
      language: 'json',
      code: JSON.stringify(
        {
          mcpServers: {
            filesystem: {
              command: 'blackbox',
              args: ['mcp', '--name', 'filesystem', '--', 'npx', '-y', '@modelcontextprotocol/server-filesystem', '/path/to/dir'],
              env: { BLACKBOX_URL: base },
            },
          },
        },
        null,
        2,
      ),
    },
    {
      id: 'mcp-server',
      title: 'blackbox MCP server',
      description: 'Let agents query their own telemetry: search_traces, get_trace, list_issues, get_session, stats, score_trace.',
      language: 'bash',
      code: [`claude mcp add blackbox -e BLACKBOX_URL=${base} -- blackbox mcp-server`].join('\n'),
      notes: ['JSON form: {"command": "blackbox", "args": ["mcp-server"], "env": {"BLACKBOX_URL": "' + base + '"}}'],
    },
    {
      id: 'sdk-typescript',
      title: 'TypeScript SDK',
      description: 'Zero dependency tracing with automatic parenting, LLM client wrappers and scores. Copy sdk/typescript/index.ts into your project.',
      language: 'typescript',
      code: [
        "import { init, trace, span, wrapAnthropic, score } from './blackbox';",
        "import Anthropic from '@anthropic-ai/sdk';",
        '',
        `init({ url: '${base}', project: 'my-agent' });`,
        'const client = wrapAnthropic(new Anthropic());',
        '',
        "await trace('answer question', async () => {",
        "  const docs = await span('search docs', () => search(q), { kind: 'retriever' });",
        "  return client.messages.create({ model: 'claude-sonnet-4-5', max_tokens: 1024, messages: [{ role: 'user', content: q }] });",
        '});',
      ].join('\n'),
    },
    {
      id: 'sdk-python',
      title: 'Python SDK',
      description: 'Standard library only. Copy sdk/python/blackbox_sdk.py into your project.',
      language: 'python',
      code: [
        'import blackbox_sdk as bb',
        'from anthropic import Anthropic',
        '',
        `bb.init(url="${base}", project="my-agent")`,
        'client = bb.wrap_anthropic(Anthropic())',
        '',
        '@bb.observe(kind="tool")',
        'def search(q): ...',
        '',
        'with bb.trace("answer question"):',
        '    search("refund policy")',
        '    client.messages.create(model="claude-sonnet-4-5", max_tokens=1024, messages=[{"role": "user", "content": "hi"}])',
      ].join('\n'),
    },
    {
      id: 'rest',
      title: 'REST',
      description: 'Post spans directly.',
      language: 'bash',
      code: `curl -s ${base}/api/ingest -H 'content-type: application/json' -d '{"name":"my step","kind":"tool","tool_name":"search","input":{"q":"hi"},"output":"ok","status":"ok"}'`,
    },
  ];
  return { base, proxy, snippets };
}

export function registerIntegrationApi(r: Router): void {
  r.post('/api/mcp/tools', async (_req, _res, ctx) => {
    const b = (await ctx.json()) as Any;
    const server = typeof b.server === 'string' && b.server ? b.server : null;
    if (!server) throw new HttpError(400, 'server is required');
    if (!Array.isArray(b.tools)) throw new HttpError(400, 'tools must be an array');
    const tools: McpToolDef[] = b.tools.filter((t: Any) => t && typeof t.name === 'string').map((t: Any) => ({ name: t.name, description: t.description ?? undefined, inputSchema: t.inputSchema ?? t.input_schema ?? undefined }));
    return upsertMcpTools(getDb(), server, tools);
  });
  r.get('/api/mcp/tools', (_req, _res, ctx) => {
    const server = ctx.query.get('server');
    const db = getDb();
    const rows = (server ? db.prepare('select * from mcp_tools where server = ? order by name, last_seen desc').all(server) : db.prepare('select * from mcp_tools order by server, name, last_seen desc').all()) as Any[];
    return { items: rows };
  });
  r.get('/api/connect', (req) => connectSnippets(baseUrl(req)));
}
