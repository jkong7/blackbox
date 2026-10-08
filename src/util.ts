import { createHash, randomBytes } from 'node:crypto';

export function newId(prefix = ''): string {
  return prefix + randomBytes(8).toString('hex');
}

export function hexId(bytes: number): string {
  return randomBytes(bytes).toString('hex');
}

export function sha(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function shortHash(s: string): string {
  return sha(s).slice(0, 16);
}

export function hashFraction(s: string): number {
  return parseInt(sha(s).slice(0, 8), 16) / 0xffffffff;
}

export function nowMs(): number {
  return Date.now();
}

export function nowNs(): number {
  return Date.now() * 1e6;
}

export function clip(s: string | null | undefined, n: number): string | null {
  if (s == null) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

export function safeJson(s: string | null | undefined): unknown {
  if (s == null || s === '') return null;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function maybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

export function toJson(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function num(v: unknown): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

export function first<T>(...vals: (T | null | undefined)[]): T | null {
  for (const v of vals) if (v !== undefined && v !== null && (v as unknown) !== '') return v;
  return null;
}

export function percentile(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx];
}

export function median(values: number[]): number | null {
  return percentile(values, 50);
}

export function estimateTokens(s: string | null | undefined): number {
  if (!s) return 0;
  return Math.ceil(s.length / 4);
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  return '{' + Object.keys(o).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}
