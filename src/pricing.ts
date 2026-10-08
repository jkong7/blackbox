import { readFileSync } from 'node:fs';
import type { DB } from './db.ts';

export interface Price {
  model: string;
  pattern: string | null;
  provider: string | null;
  input: number;
  output: number;
  cache_read: number | null;
  cache_write: number | null;
  reasoning: number | null;
  context: number | null;
  custom: number;
}

interface Bundled {
  model: string;
  provider: string;
  input: number;
  output: number;
  cacheRead: number | null;
  cacheWrite: number | null;
  reasoning: number | null;
  context: number | null;
}

let cache: { all: Price[]; byName: Map<string, Price>; custom: { re: RegExp; p: Price }[]; hits: Map<string, Price | null> } | null = null;

export function seedPrices(db: DB): void {
  const n = (db.prepare('select count(*) n from prices where custom = 0').get() as { n: number }).n;
  if (n > 0) return;
  const rows = JSON.parse(readFileSync(new URL('./pricing/prices.json', import.meta.url), 'utf8')) as Bundled[];
  const ins = db.prepare('insert or ignore into prices(model, pattern, provider, input, output, cache_read, cache_write, reasoning, context, custom) values(?,?,?,?,?,?,?,?,?,0)');
  db.exec('begin');
  for (const r of rows) ins.run(r.model, null, r.provider, r.input, r.output, r.cacheRead, r.cacheWrite, r.reasoning, r.context);
  db.exec('commit');
  cache = null;
}

export function invalidatePrices(): void {
  cache = null;
}

function load(db: DB) {
  if (cache) return cache;
  const all = db.prepare('select * from prices').all() as unknown as Price[];
  const byName = new Map<string, Price>();
  const custom: { re: RegExp; p: Price }[] = [];
  for (const p of all) {
    if (p.custom && p.pattern) {
      try {
        custom.push({ re: new RegExp(p.pattern, 'i'), p });
      } catch {}
    }
    if (!p.custom || !byName.has(p.model.toLowerCase())) byName.set(p.model.toLowerCase(), p);
  }
  for (const p of all) if (p.custom) byName.set(p.model.toLowerCase(), p);
  cache = { all, byName, custom, hits: new Map() };
  return cache;
}

export function findPrice(db: DB, model: string | null | undefined): Price | null {
  if (!model) return null;
  const c = load(db);
  const key = model.toLowerCase();
  if (c.hits.has(key)) return c.hits.get(key)!;
  let found: Price | null = null;
  for (const { re, p } of c.custom) if (re.test(model)) { found = p; break; }
  if (!found) {
    const candidates = [key, key.split('/').pop()!, key.replace(/^(us|eu|apac|global)\./, ''), key.replace(/^(anthropic|openai|google|models)[./]/, '')];
    for (const cand of candidates) {
      const stripped = [cand, cand.replace(/-\d{8}$/, ''), cand.replace(/-v\d+(:\d+)?$/, ''), cand.replace(/@.*$/, ''), cand.replace(/\[.*\]$/, '')];
      for (const s of stripped) {
        const p = c.byName.get(s);
        if (p) { found = p; break; }
      }
      if (found) break;
    }
  }
  if (!found) {
    const base = key.split('/').pop()!;
    let best: Price | null = null;
    for (const p of c.all) {
      const m = p.model.toLowerCase();
      if (m.includes('/') || m.includes('.')) continue;
      if (base.startsWith(m) && (!best || m.length > best.model.length)) best = p;
    }
    found = best;
  }
  c.hits.set(key, found);
  return found;
}

export interface Usage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_tokens?: number | null;
  cache_write_tokens?: number | null;
  reasoning_tokens?: number | null;
}

export function costFor(db: DB, model: string | null | undefined, u: Usage): number | null {
  const p = findPrice(db, model);
  if (!p) return null;
  const inp = u.input_tokens ?? 0;
  const out = u.output_tokens ?? 0;
  const cr = u.cache_read_tokens ?? 0;
  const cw = u.cache_write_tokens ?? 0;
  if (!inp && !out && !cr && !cw) return null;
  return inp * p.input + out * p.output + cr * (p.cache_read ?? p.input) + cw * (p.cache_write ?? p.input);
}

export function contextWindow(db: DB, model: string | null | undefined): number | null {
  return findPrice(db, model)?.context ?? null;
}
