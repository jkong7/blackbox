import { useEffect, useState, type ReactNode } from 'react';
import { PageHeader } from '../../components/Layout.tsx';
import { CopyButton, Seg } from '../../components/ui.tsx';
import { I } from '../../components/Icons.tsx';
import { api, isMissing } from '../../api.ts';
import { useApi, useLive, type Health } from '../../hooks.ts';
import { Link, useTitle } from '../../router.tsx';
import { fmtInt } from '../../format.ts';
import './connect.css';

interface Snippet {
  id: string;
  title: string;
  description?: string;
  language?: string;
  code: string;
  variants?: { label: string; language?: string; code: string }[];
}

interface ConnectSection {
  id: string;
  title: string;
  description?: string;
  snippets: Snippet[];
}

interface ConnectInfo {
  ui_url?: string;
  otlp_url?: string;
  proxy_url?: string;
  sections?: ConnectSection[];
  snippets?: Snippet[];
}

const ORIGIN = typeof location !== 'undefined' ? location.origin : 'http://localhost:7777';

function fallback(info: ConnectInfo | null): ConnectSection[] {
  const otlp = info?.otlp_url ?? 'http://localhost:4318';
  const proxy = info?.proxy_url ?? 'http://localhost:7778';
  const api = info?.ui_url ?? ORIGIN;
  const ccEnv = [
    'export CLAUDE_CODE_ENABLE_TELEMETRY=1',
    'export CLAUDE_CODE_ENHANCED_TELEMETRY_BETA=1',
    'export OTEL_METRICS_EXPORTER=otlp',
    'export OTEL_LOGS_EXPORTER=otlp',
    'export OTEL_TRACES_EXPORTER=otlp',
    'export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf',
    `export OTEL_EXPORTER_OTLP_ENDPOINT=${otlp}`,
    'export OTEL_LOG_USER_PROMPTS=1',
    'export OTEL_LOG_TOOL_DETAILS=1',
    'export OTEL_LOG_TOOL_CONTENT=1',
    'export OTEL_LOG_RAW_API_BODIES=1',
    'export OTEL_METRIC_EXPORT_INTERVAL=10000',
    'export OTEL_LOGS_EXPORT_INTERVAL=2000',
  ].join('\n');
  const ccSettings = JSON.stringify(
    {
      env: {
        CLAUDE_CODE_ENABLE_TELEMETRY: '1',
        CLAUDE_CODE_ENHANCED_TELEMETRY_BETA: '1',
        OTEL_METRICS_EXPORTER: 'otlp',
        OTEL_LOGS_EXPORTER: 'otlp',
        OTEL_TRACES_EXPORTER: 'otlp',
        OTEL_EXPORTER_OTLP_PROTOCOL: 'http/protobuf',
        OTEL_EXPORTER_OTLP_ENDPOINT: otlp,
        OTEL_LOG_USER_PROMPTS: '1',
        OTEL_LOG_TOOL_DETAILS: '1',
        OTEL_LOG_TOOL_CONTENT: '1',
        OTEL_LOG_RAW_API_BODIES: '1',
      },
    },
    null,
    2,
  );
  const mcpJson = JSON.stringify(
    {
      mcpServers: {
        github: {
          command: 'blackbox',
          args: ['mcp', '--name', 'github', '--', 'npx', '-y', '@modelcontextprotocol/server-github'],
          env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
        },
      },
    },
    null,
    2,
  );
  return [
    {
      id: 'claude-code',
      title: 'Claude Code',
      description: 'Claude Code exports its events, metrics and traces over OTLP. Set these before launching claude, or put them in ~/.claude/settings.json so every session is recorded. The OTEL_LOG_* flags include prompt and tool content, which stays on this machine.',
      snippets: [
        {
          id: 'cc-env',
          title: 'Telemetry to blackbox',
          code: ccEnv,
          language: 'shell',
          variants: [
            { label: 'Shell', language: 'shell', code: ccEnv + '\nclaude' },
            { label: 'settings.json', language: 'json', code: ccSettings },
          ],
        },
        {
          id: 'cc-proxy',
          title: 'Full request bodies through the proxy',
          description: 'Optional. Routes Claude Code API calls through the local proxy so every prompt, response, token count and cache hit is captured exactly, then forwards to Anthropic unchanged.',
          code: `export ANTHROPIC_BASE_URL=${proxy}\nclaude`,
          language: 'shell',
        },
      ],
    },
    {
      id: 'proxy',
      title: 'LLM proxy',
      description: 'Zero code changes for any app that calls Anthropic or OpenAI. Point the SDK base URL at the proxy; keys pass through and are never stored. Tag traffic with x-blackbox-project, x-blackbox-agent and x-blackbox-session headers.',
      snippets: [
        {
          id: 'proxy-env',
          title: 'Environment',
          code: `export ANTHROPIC_BASE_URL=${proxy}\nexport OPENAI_BASE_URL=${proxy}/v1`,
          language: 'shell',
          variants: [
            { label: 'Environment', language: 'shell', code: `export ANTHROPIC_BASE_URL=${proxy}\nexport OPENAI_BASE_URL=${proxy}/v1` },
            {
              label: 'TypeScript',
              language: 'ts',
              code: `import Anthropic from '@anthropic-ai/sdk';\n\nconst client = new Anthropic({\n  baseURL: '${proxy}',\n  defaultHeaders: { 'x-blackbox-agent': 'support-agent', 'x-blackbox-project': 'demo' },\n});`,
            },
            {
              label: 'Python',
              language: 'python',
              code: `from anthropic import Anthropic\n\nclient = Anthropic(\n    base_url="${proxy}",\n    default_headers={"x-blackbox-agent": "support-agent", "x-blackbox-project": "demo"},\n)`,
            },
          ],
        },
      ],
    },
    {
      id: 'mcp',
      title: 'MCP servers',
      description: 'Wrap any stdio MCP server to record every JSON-RPC message, tool call, error, and the token cost and hash of its tool definitions, so definition drift shows up on the Agents & tools page.',
      snippets: [
        {
          id: 'mcp-cmd',
          title: 'Wrap a server',
          code: 'blackbox mcp -- npx -y @modelcontextprotocol/server-github',
          language: 'shell',
          variants: [
            { label: 'Command', language: 'shell', code: 'blackbox mcp -- <server command and args>\n\nblackbox mcp -- npx -y @modelcontextprotocol/server-github' },
            { label: '.mcp.json', language: 'json', code: mcpJson },
            { label: 'claude mcp add', language: 'shell', code: 'claude mcp add github -- blackbox mcp --name github -- npx -y @modelcontextprotocol/server-github' },
          ],
        },
      ],
    },
    {
      id: 'codex',
      title: 'Codex',
      description: 'Codex CLI exports OpenTelemetry log events. Add an otel block to ~/.codex/config.toml.',
      snippets: [
        {
          id: 'codex-toml',
          title: '~/.codex/config.toml',
          code: `[otel]\nlog_user_prompt = true\nexporter = { otlp-http = { endpoint = "${otlp}/v1/logs", protocol = "binary" } }`,
          language: 'toml',
        },
      ],
    },
    {
      id: 'otel',
      title: 'Any OpenTelemetry SDK',
      description: 'blackbox accepts plain OTLP over HTTP (protobuf or JSON) on port 4318 and on the UI port. It understands OTel GenAI, OpenInference, OpenLLMetry, Vercel AI SDK and OpenAI Agents SDK attributes, and computes cost server side.',
      snippets: [
        {
          id: 'otel-env',
          title: 'Exporter endpoint',
          code: `export OTEL_EXPORTER_OTLP_ENDPOINT=${otlp}\nexport OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nexport OTEL_SERVICE_NAME=my-agent`,
          language: 'shell',
          variants: [
            { label: 'Environment', language: 'shell', code: `export OTEL_EXPORTER_OTLP_ENDPOINT=${otlp}\nexport OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf\nexport OTEL_SERVICE_NAME=my-agent` },
            {
              label: 'Python',
              language: 'python',
              code: `from opentelemetry import trace\nfrom opentelemetry.sdk.trace import TracerProvider\nfrom opentelemetry.sdk.trace.export import BatchSpanProcessor\nfrom opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter\n\nprovider = TracerProvider()\nprovider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint="${otlp}/v1/traces")))\ntrace.set_tracer_provider(provider)`,
            },
            {
              label: 'Node',
              language: 'ts',
              code: `import { NodeSDK } from '@opentelemetry/sdk-node';\nimport { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';\n\nnew NodeSDK({\n  serviceName: 'my-agent',\n  traceExporter: new OTLPTraceExporter({ url: '${otlp}/v1/traces' }),\n}).start();`,
            },
          ],
        },
      ],
    },
    {
      id: 'rest',
      title: 'REST ingest',
      description: 'The simplest path from any language: POST spans as JSON. Only name is required; ids are generated when missing.',
      snippets: [
        {
          id: 'rest-curl',
          title: 'curl',
          code: `curl -s ${api}/api/ingest \\\n  -H 'content-type: application/json' \\\n  -d '{"flush": true, "spans": [{"trace_id": "t1", "span_id": "s1", "name": "chat", "kind": "llm", "model": "claude-sonnet-5-5", "input_tokens": 1200, "output_tokens": 180, "input": [{"role": "user", "content": "hi"}], "output": [{"role": "assistant", "content": "hello"}], "agent_name": "my-agent"}]}'`,
          language: 'shell',
        },
      ],
    },
  ];
}

function normalize(data: unknown): { info: ConnectInfo | null; sections: ConnectSection[] | null } {
  if (!data || typeof data !== 'object') return { info: null, sections: null };
  const d = data as ConnectInfo & Record<string, unknown>;
  const asSnippet = (x: unknown, i: number): Snippet | null => {
    if (!x || typeof x !== 'object') return null;
    const o = x as Record<string, unknown>;
    const code = typeof o.code === 'string' ? o.code : typeof o.snippet === 'string' ? o.snippet : typeof o.command === 'string' ? o.command : null;
    if (!code) return null;
    return { id: String(o.id ?? i), title: String(o.title ?? o.name ?? 'Snippet'), description: typeof o.description === 'string' ? o.description : undefined, language: typeof o.language === 'string' ? o.language : undefined, code };
  };
  if (Array.isArray(d.sections)) {
    const sections = d.sections
      .map((s, i) => {
        const o = s as unknown as Record<string, unknown>;
        const snippets = (Array.isArray(o.snippets) ? o.snippets : [o]).map(asSnippet).filter((x): x is Snippet => !!x);
        return { id: String(o.id ?? i), title: String(o.title ?? o.name ?? 'Setup'), description: typeof o.description === 'string' ? o.description : undefined, snippets };
      })
      .filter((s) => s.snippets.length);
    return { info: d, sections: sections.length ? sections : null };
  }
  const list = Array.isArray(d.snippets) ? d.snippets : Array.isArray(d.items) ? (d.items as unknown[]) : null;
  if (list) {
    const snippets = list.map(asSnippet).filter((x): x is Snippet => !!x);
    if (snippets.length) return { info: d, sections: snippets.map((s) => ({ id: s.id, title: s.title, description: s.description, snippets: [{ ...s, description: undefined }] })) };
  }
  return { info: d, sections: null };
}

export function Connect() {
  useTitle('Connect');
  const live = useLive();
  const conn = useApi<unknown>('/api/connect');
  const [health, setHealth] = useState<Health | null>(null);
  const [active, setActive] = useState('claude-code');

  useEffect(() => {
    let stop = false;
    const tick = () =>
      api
        .get<Health>('/api/health')
        .then((h) => !stop && setHealth(h))
        .catch(() => {});
    tick();
    const t = setInterval(tick, health && health.spans > 0 ? 15000 : 3000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [live.tick, health && health.spans > 0]);

  const fromServer = conn.data ? normalize(conn.data) : { info: null, sections: null };
  const sections = fromServer.sections ?? fallback(fromServer.info);
  const usingFallback = !fromServer.sections;
  const loading = !conn.data && !conn.error;

  return (
    <>
      <PageHeader title="Connect" />
      <div className="page cn-page">
        <StatusCard health={health} />
        {!!conn.error && !isMissing(conn.error) && <div className="banner warn">Could not load setup from the server, showing defaults.</div>}
        <div className="cn-layout">
          <nav className="cn-toc" aria-label="Sources">
            {sections.map((s) => (
              <a
                key={s.id}
                href={'#' + s.id}
                className={'cn-toc-item' + (active === s.id ? ' on' : '')}
                onClick={(e) => {
                  e.preventDefault();
                  setActive(s.id);
                  document.getElementById('cn-' + s.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {s.title}
              </a>
            ))}
          </nav>
          <div className="cn-sections" style={{ opacity: loading ? 0.6 : 1 }}>
            {sections.map((s) => (
              <section key={s.id} id={'cn-' + s.id} className="card cn-section">
                <div className="card-head">
                  <h2>{s.title}</h2>
                </div>
                <div className="card-body stack" style={{ gap: 12 }}>
                  {s.description && <p className="dim cn-desc">{s.description}</p>}
                  {s.snippets.map((sn) => (
                    <SnippetBlock key={sn.id} s={sn} showTitle={s.snippets.length > 1 || sn.title !== s.title} />
                  ))}
                </div>
              </section>
            ))}
            {usingFallback && (
              <p className="muted cn-foot">
                Ports: UI and API on {ORIGIN.replace(/^https?:\/\//, '')}, OTLP also on localhost:4318, LLM proxy on localhost:7778.
              </p>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

function StatusCard({ health }: { health: Health | null }) {
  const spans = health?.spans ?? 0;
  const receiving = spans > 0;
  return (
    <div className={'card cn-status' + (receiving ? ' ok' : '')}>
      <span className={'cn-beacon' + (health ? (receiving ? ' ok' : ' wait') : '')} />
      <div className="stack" style={{ gap: 2, minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{!health ? 'Checking the recorder' : receiving ? 'Recording' : 'Waiting for the first span'}</div>
        <div className="dim">
          {!health
            ? 'Connecting to the local server.'
            : receiving
              ? `${fmtInt(spans)} spans recorded so far. New data shows up live on every page.`
              : 'Run one of the setups below, then use your agent. This updates on its own as soon as anything arrives.'}
        </div>
      </div>
      <div className="row" style={{ marginLeft: 'auto', gap: 8 }}>
        {receiving ? (
          <>
            <Link to="/traces" className="btn">
              <I.traces /> Open traces
            </Link>
            <Link to="/" className="btn primary">
              Overview
            </Link>
          </>
        ) : (
          <span className="row code-block cn-inline">
            <span className="mono">blackbox demo</span>
            <CopyButton text="blackbox demo" />
          </span>
        )}
      </div>
    </div>
  );
}

function SnippetBlock({ s, showTitle }: { s: Snippet; showTitle: boolean }) {
  const variants = s.variants?.length ? s.variants : [{ label: s.title, language: s.language, code: s.code }];
  const [v, setV] = useState(variants[0].label);
  const cur = variants.find((x) => x.label === v) ?? variants[0];
  let head: ReactNode = null;
  if (variants.length > 1) head = <Seg value={cur.label} onChange={setV} options={variants.map((x) => ({ value: x.label, label: x.label }))} />;
  else if (showTitle) head = <span className="field-label">{s.title}</span>;
  return (
    <div className="stack" style={{ gap: 6 }}>
      {(head || (showTitle && variants.length > 1)) && (
        <div className="row" style={{ gap: 10 }}>
          {showTitle && variants.length > 1 && <span className="field-label">{s.title}</span>}
          {head}
        </div>
      )}
      {s.description && <div className="muted cn-desc">{s.description}</div>}
      <div className="cn-code">
        <pre className="mono">{cur.code}</pre>
        <div className="cn-copy">
          <CopyButton text={cur.code} label="Copy" />
        </div>
      </div>
    </div>
  );
}
