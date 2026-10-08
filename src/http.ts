import type { IncomingMessage, ServerResponse } from 'node:http';
import { gunzipSync, inflateSync, brotliDecompressSync } from 'node:zlib';

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: Ctx) => unknown | Promise<unknown>;

export interface Ctx {
  params: Record<string, string>;
  query: URLSearchParams;
  body: () => Promise<Buffer>;
  json: <T = any>() => Promise<T>;
}

interface Route {
  method: string;
  re: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  routes: Route[] = [];

  add(method: string, path: string, handler: Handler): this {
    const keys: string[] = [];
    const re = new RegExp('^' + path.replace(/:([a-zA-Z_]+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '/?$');
    this.routes.push({ method, re, keys, handler });
    return this;
  }

  get(p: string, h: Handler) { return this.add('GET', p, h); }
  post(p: string, h: Handler) { return this.add('POST', p, h); }
  put(p: string, h: Handler) { return this.add('PUT', p, h); }
  patch(p: string, h: Handler) { return this.add('PATCH', p, h); }
  delete(p: string, h: Handler) { return this.add('DELETE', p, h); }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.re.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { handler: r.handler, params };
    }
    return null;
  }
}

export function readBody(req: IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'payload too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      let buf = Buffer.concat(chunks);
      const enc = String(req.headers['content-encoding'] ?? '').toLowerCase();
      try {
        if (enc === 'gzip') buf = gunzipSync(buf);
        else if (enc === 'deflate') buf = inflateSync(buf);
        else if (enc === 'br') buf = brotliDecompressSync(buf);
      } catch (e) {
        reject(new HttpError(400, 'bad content-encoding'));
        return;
      }
      resolve(buf);
    });
    req.on('error', reject);
  });
}

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(body);
}

export function cors(res: ServerResponse): void {
  res.writeHead(204, {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': '*',
    'access-control-max-age': '86400',
  });
  res.end();
}
