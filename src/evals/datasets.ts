import type { DB } from '../db.ts';
import { HttpError } from '../http.ts';
import { maybeJson, newId, nowMs, safeJson } from '../util.ts';
import { finalOutputOf, goalOf, loadSpans, rootOf, toolSequence } from './render.ts';

type Row = Record<string, any>;

export interface NewItem {
  input: unknown;
  expected?: unknown;
  metadata?: Row | null;
  source_trace_id?: string | null;
}

function enc(v: unknown): string | null {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

export function parseItem(r: Row): Row {
  return { ...r, input: safeJson(r.input), expected: safeJson(r.expected), metadata: safeJson(r.metadata) };
}

export function listDatasets(db: DB): Row[] {
  return db.prepare('select d.*, (select count(*) from dataset_items i where i.dataset_id = d.id) item_count from datasets d order by d.created_at desc').all() as Row[];
}

export function getDataset(db: DB, idOrName: string): Row {
  const d = db.prepare('select * from datasets where id = ? or name = ?').get(idOrName, idOrName) as Row | undefined;
  if (!d) throw new HttpError(404, 'dataset not found');
  return d;
}

export function createDataset(db: DB, name: string, description?: string | null): Row {
  if (!name || !String(name).trim()) throw new HttpError(400, 'name required');
  if (db.prepare('select 1 from datasets where name = ?').get(name)) throw new HttpError(409, `dataset ${name} already exists`);
  const row = { id: newId('ds_'), name: String(name).trim(), description: description ?? null, created_at: nowMs() };
  db.prepare('insert into datasets(id, name, description, created_at) values(?,?,?,?)').run(row.id, row.name, row.description, row.created_at);
  return row;
}

export function datasetItems(db: DB, datasetId: string): Row[] {
  return (db.prepare('select * from dataset_items where dataset_id = ? order by created_at, id').all(datasetId) as Row[]).map(parseItem);
}

export function addItems(db: DB, datasetId: string, items: NewItem[]): number {
  const ins = db.prepare('insert into dataset_items(id, dataset_id, input, expected, metadata, source_trace_id, created_at) values(?,?,?,?,?,?,?)');
  const base = nowMs();
  let n = 0;
  for (const it of items) {
    if (it.input === undefined) continue;
    ins.run(newId('di_'), datasetId, enc(it.input) ?? 'null', enc(it.expected), it.metadata ? JSON.stringify(it.metadata) : null, it.source_trace_id ?? null, base + n);
    n++;
  }
  return n;
}

export function itemFromTrace(db: DB, traceId: string): NewItem | null {
  const spans = loadSpans(db, traceId);
  if (!spans.length) return null;
  const root = rootOf(spans);
  const rootIn = root && root.kind !== 'llm' ? root.input : null;
  const input = rootIn != null && typeof rootIn === 'object' && !Array.isArray(rootIn) ? rootIn : goalOf(spans);
  const output = maybeJson(finalOutputOf(spans));
  const tools = toolSequence(spans);
  const t = db.prepare('select name, session_id, agent_names from traces where trace_id = ?').get(traceId) as Row | undefined;
  const metadata: Row = { source_trace_id: traceId };
  if (tools.length) metadata.expected_trajectory = tools;
  if (t?.name) metadata.trace_name = t.name;
  if (t?.agent_names) metadata.agent = t.agent_names;
  return { input, expected: output === '' ? null : output, metadata, source_trace_id: traceId };
}

export function addFromTraces(db: DB, datasetId: string, traceIds: string[]): number {
  const items = traceIds.map((id) => itemFromTrace(db, id)).filter((x): x is NewItem => !!x);
  return addItems(db, datasetId, items);
}

export function parseJsonl(text: string): NewItem[] {
  const out: NewItem[] = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    let v: unknown;
    try {
      v = JSON.parse(t);
    } catch {
      out.push({ input: t });
      continue;
    }
    out.push(toItem(v));
  }
  return out;
}

export function toItem(v: unknown): NewItem {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'input' in (v as Row)) {
    const o = v as Row;
    return { input: o.input, expected: o.expected ?? o.output ?? o.reference ?? null, metadata: o.metadata ?? null };
  }
  return { input: v };
}

export function deleteDataset(db: DB, id: string): void {
  db.prepare('delete from dataset_items where dataset_id = ?').run(id);
  db.prepare('delete from datasets where id = ?').run(id);
}
