import { getDb, dbPath } from './db.ts';
import { seedPrices } from './pricing.ts';

const PORT = Number(process.env.BLACKBOX_PORT || 7777);
const OTLP_PORT = Number(process.env.BLACKBOX_OTLP_PORT || 4318);
const PROXY_PORT = Number(process.env.BLACKBOX_PROXY_PORT || 7778);

const HELP = `blackbox: local flight recorder and judge for AI agents

usage: blackbox <command> [options]

commands
  serve                 start the UI, API, OTLP receiver (${PORT}, ${OTLP_PORT}) and LLM proxy (${PROXY_PORT})
  demo [n]              seed n realistic demo traces (default 320) into project "demo"
  env [claude-code|codex|otel|proxy] [--json]
                        print setup for sending telemetry to blackbox
  mcp [--name n] -- <command...>
                        wrap a stdio MCP server and record every call, error and tool definition
  mcp-server            run the blackbox MCP server so agents can query their own traces
  status                show what is stored and whether the server is running
  purge <days>          delete traces older than <days> days
  help                  show this help

environment
  BLACKBOX_HOME             data directory (default ~/.blackbox)
  BLACKBOX_PORT             UI and API port (default 7777)
  BLACKBOX_OTLP_PORT        extra OTLP port (default 4318)
  BLACKBOX_PROXY_PORT       LLM proxy port (default 7778, 0 disables)
  BLACKBOX_RETENTION_DAYS   keep traces this many days (default 30)
  BLACKBOX_JUDGE_MODEL      judge model (default haiku)
  BLACKBOX_JUDGE_DAILY_CAP  max judge spend per day in USD (default 2)
  ANTHROPIC_API_KEY         judge through the API instead of the local claude CLI
`;

async function serve() {
  const db = getDb();
  seedPrices(db);
  const { startServer, buildRouter } = await import('./server.ts');
  const { startSignalWorker } = await import('./signals.ts');
  const { startEvalWorker } = await import('./evals/index.ts');
  const { startRetention } = await import('./retention.ts');
  const router = buildRouter();
  startSignalWorker(db);
  startEvalWorker();
  startRetention(db);
  await startServer(PORT, router);
  console.log(`[blackbox] ui, api, otlp   http://localhost:${PORT}`);
  try {
    await startServer(OTLP_PORT, router, { ui: false });
    console.log(`[blackbox] otlp            http://localhost:${OTLP_PORT}/v1/{traces,logs,metrics}`);
  } catch {
    console.log(`[blackbox] port ${OTLP_PORT} busy, OTLP only on ${PORT}`);
  }
  if (PROXY_PORT) {
    const { startProxy } = await import('./proxy.ts');
    try {
      await startProxy(PROXY_PORT);
      console.log(`[blackbox] llm proxy       http://localhost:${PROXY_PORT}  (ANTHROPIC_BASE_URL / OPENAI_BASE_URL)`);
    } catch {
      console.log(`[blackbox] port ${PROXY_PORT} busy, proxy disabled`);
    }
  }
  console.log(`[blackbox] data            ${dbPath()}`);
}

async function demo() {
  const db = getDb();
  seedPrices(db);
  const { seedDemo } = await import('./demo.ts');
  const n = Number(process.argv[3] || 320);
  const r = seedDemo({ traces: n });
  console.log(`[blackbox] seeded ${r.traces} demo traces (${r.spans} spans) into project "demo"`);
}

const CLAUDE_ENV: [string, string][] = [
  ['CLAUDE_CODE_ENABLE_TELEMETRY', '1'],
  ['CLAUDE_CODE_ENHANCED_TELEMETRY_BETA', '1'],
  ['OTEL_TRACES_EXPORTER', 'otlp'],
  ['OTEL_LOGS_EXPORTER', 'otlp'],
  ['OTEL_METRICS_EXPORTER', 'otlp'],
  ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf'],
  ['OTEL_EXPORTER_OTLP_ENDPOINT', `http://localhost:${OTLP_PORT}`],
  ['OTEL_LOG_USER_PROMPTS', '1'],
  ['OTEL_LOG_ASSISTANT_RESPONSES', '1'],
  ['OTEL_LOG_TOOL_DETAILS', '1'],
  ['OTEL_LOG_TOOL_CONTENT', '1'],
  ['OTEL_BSP_SCHEDULE_DELAY', '2000'],
  ['OTEL_LOGS_EXPORT_INTERVAL', '2000'],
  ['OTEL_METRIC_EXPORT_INTERVAL', '10000'],
];

function env() {
  const which = process.argv[3] ?? 'claude-code';
  const json = process.argv.includes('--json');
  let pairs: [string, string][];
  if (which === 'claude-code') pairs = CLAUDE_ENV;
  else if (which === 'proxy') pairs = [['ANTHROPIC_BASE_URL', `http://localhost:${PROXY_PORT}`], ['OPENAI_BASE_URL', `http://localhost:${PROXY_PORT}/v1`], ['CLAUDE_CODE_PROPAGATE_TRACEPARENT', '1']];
  else if (which === 'otel') pairs = [['OTEL_EXPORTER_OTLP_ENDPOINT', `http://localhost:${OTLP_PORT}`], ['OTEL_EXPORTER_OTLP_PROTOCOL', 'http/protobuf'], ['OTEL_SEMCONV_STABILITY_OPT_IN', 'gen_ai_latest_experimental'], ['OTEL_INSTRUMENTATION_GENAI_CAPTURE_MESSAGE_CONTENT', 'true']];
  else if (which === 'codex') {
    console.log(`# ~/.codex/config.toml\n[otel]\nexporter = { otlp-http = { endpoint = "http://localhost:${OTLP_PORT}/v1/logs", protocol = "binary" } }\nlog_user_prompt = true`);
    return;
  } else {
    console.error(`unknown target ${which}; use claude-code, codex, otel or proxy`);
    process.exit(1);
  }
  if (json) console.log(JSON.stringify({ env: Object.fromEntries(pairs) }, null, 2));
  else for (const [k, v] of pairs) console.log(`export ${k}=${v}`);
}

async function status() {
  const db = getDb();
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  console.log(`data      ${dbPath()}`);
  console.log(`traces    ${n('select count(*) n from traces')}`);
  console.log(`spans     ${n('select count(*) n from spans')}`);
  console.log(`sessions  ${n('select count(*) n from sessions')}`);
  console.log(`signals   ${n("select count(*) n from signals where status = 'open'")} open`);
  console.log(`scores    ${n('select count(*) n from scores')}`);
  try {
    const r = await fetch(`http://localhost:${PORT}/api/health`, { signal: AbortSignal.timeout(800) });
    console.log(`server    ${r.ok ? 'running' : 'error'} on http://localhost:${PORT}`);
  } catch {
    console.log('server    not running (blackbox serve)');
  }
}

async function purge() {
  const days = Number(process.argv[3]);
  if (!Number.isFinite(days) || days < 0) {
    console.error('usage: blackbox purge <days>');
    process.exit(1);
  }
  const { purgeOlderThan } = await import('./retention.ts');
  console.log(`[blackbox] removed ${purgeOlderThan(getDb(), days)} traces`);
}

const cmd = process.argv[2] ?? 'serve';
if (cmd === 'serve') await serve();
else if (cmd === 'demo') await demo();
else if (cmd === 'env') env();
else if (cmd === 'status') await status();
else if (cmd === 'purge') await purge();
else if (cmd === 'mcp') {
  const { parseWrapArgs, runMcpWrapper } = await import('./mcp/wrap.ts');
  const { cmd: child, opts } = parseWrapArgs(process.argv.slice(3));
  process.exit(await runMcpWrapper(child, opts));
} else if (cmd === 'mcp-server') {
  const { runMcpServer } = await import('./mcp/server.ts');
  await runMcpServer();
} else if (cmd === 'help' || cmd === '--help' || cmd === '-h') console.log(HELP);
else {
  console.error(`unknown command ${cmd}\n`);
  console.log(HELP);
  process.exit(1);
}
