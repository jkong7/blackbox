import { createServer, type Server } from 'node:http';
import { readFileSync, existsSync, statSync, appendFileSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router, readBody, sendJson, cors, HttpError, type Ctx } from './http.ts';
import { decodeTraces, decodeLogs, decodeMetrics } from './otlp.ts';
import { ingestRawSpans, ingestLogs, ingestMetrics } from './ingest.ts';
import { registerApi } from './api.ts';
import { registerEvalApi } from './evals/index.ts';
import { registerIntegrationApi } from './integrations.ts';
import { bus, type BusEvent } from './bus.ts';

const UI_DIR = fileURLToPath(new URL('../ui/dist/', import.meta.url));

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
};

function dump(kind: string, items: unknown[]): void {
  const file = process.env.BLACKBOX_DUMP;
  if (!file) return;
  for (const it of items) appendFileSync(file, JSON.stringify({ _type: kind, ...(it as object) }) + '\n');
}

function otlpReply(res: import('node:http').ServerResponse, ct: string, accepted: number) {
  if (/protobuf/.test(ct)) {
    res.writeHead(200, { 'content-type': 'application/x-protobuf' });
    res.end();
  } else {
    sendJson(res, 200, { partialSuccess: {}, accepted });
  }
}

export function buildRouter(): Router {
  const r = new Router();
  r.post('/v1/traces', async (req, res, ctx) => {
    const ct = String(req.headers['content-type'] ?? 'application/json');
    const spans = decodeTraces(await ctx.body(), ct);
    dump('span', spans);
    const project = (req.headers['x-blackbox-project'] as string) || undefined;
    otlpReply(res, ct, ingestRawSpans(spans, project));
  });
  r.post('/v1/logs', async (req, res, ctx) => {
    const ct = String(req.headers['content-type'] ?? 'application/json');
    const logs = decodeLogs(await ctx.body(), ct);
    dump('log', logs);
    otlpReply(res, ct, ingestLogs(logs));
  });
  r.post('/v1/metrics', async (req, res, ctx) => {
    const ct = String(req.headers['content-type'] ?? 'application/json');
    const points = decodeMetrics(await ctx.body(), ct);
    dump('metric', points);
    otlpReply(res, ct, ingestMetrics(points));
  });
  r.get('/api/stream', (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'access-control-allow-origin': '*' });
    res.write(': hi\n\n');
    const on = (ev: BusEvent) => res.write(`data: ${JSON.stringify(ev)}\n\n`);
    bus.on('event', on);
    const ping = setInterval(() => res.write(': ping\n\n'), 20000);
    req.on('close', () => {
      clearInterval(ping);
      bus.off('event', on);
    });
  });
  registerApi(r);
  registerEvalApi(r);
  registerIntegrationApi(r);
  return r;
}

function serveStatic(path: string, res: import('node:http').ServerResponse): boolean {
  if (!existsSync(UI_DIR)) return false;
  const clean = normalize(decodeURIComponent(path)).replace(/^(\.\.[/\\])+/, '');
  let file = join(UI_DIR, clean);
  if (!file.startsWith(UI_DIR)) return false;
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(UI_DIR, 'index.html');
  if (!existsSync(file)) return false;
  const ext = extname(file);
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  res.end(readFileSync(file));
  return true;
}

export function startServer(port: number, router = buildRouter(), opts: { ui?: boolean } = {}): Promise<Server> {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'OPTIONS') return cors(res);
    const m = router.match(req.method ?? 'GET', url.pathname);
    if (m) {
      let cached: Buffer | null = null;
      const ctx: Ctx = {
        params: m.params,
        query: url.searchParams,
        body: async () => (cached ??= await readBody(req)),
        json: async () => {
          const b = (cached ??= await readBody(req));
          return b.length ? JSON.parse(b.toString('utf8')) : {};
        },
      };
      try {
        const out = await m.handler(req, res, ctx);
        if (!res.headersSent && out !== undefined) sendJson(res, 200, out);
        else if (!res.headersSent) sendJson(res, 200, { ok: true });
      } catch (e: any) {
        const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
        if (status === 500) console.error('[blackbox]', req.method, url.pathname, e);
        if (!res.headersSent) sendJson(res, status, { error: String(e?.message ?? e) });
        else res.end();
      }
      return;
    }
    if (opts.ui !== false && req.method === 'GET' && !url.pathname.startsWith('/api/') && serveStatic(url.pathname, res)) return;
    sendJson(res, 404, { error: 'not found' });
  });
  server.keepAliveTimeout = 65000;
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
