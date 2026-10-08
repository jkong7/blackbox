import type { DB } from './db.ts';
import { maybeJson } from './util.ts';

const CAP = 8000;

function searchable(kind: string, v: string | null): string {
  if (!v) return '';
  if (kind !== 'llm') return v.slice(0, CAP);
  const parsed = maybeJson(v);
  if (!Array.isArray(parsed)) return v.slice(0, CAP);
  return parsed
    .slice(-2)
    .map((m: any) => [m?.content ?? '', ...(m?.tool_calls ?? []).map((t: any) => `${t.name} ${JSON.stringify(t.arguments ?? '')}`)].join(' '))
    .join('\n')
    .slice(0, CAP);
}

export function indexSpanText(db: DB, spanId: string): void {
  const r = db.prepare('select rowid, span_id, trace_id, name, kind, input, output from spans where span_id = ?').get(spanId) as Record<string, any> | undefined;
  if (!r) return;
  db.prepare('delete from spans_fts where rowid = ?').run(r.rowid);
  if (!r.input && !r.output) return;
  db.prepare('insert into spans_fts(rowid, span_id, trace_id, name, input, output) values(?,?,?,?,?,?)').run(r.rowid, r.span_id, r.trace_id, r.name, searchable(r.kind, r.input), searchable(r.kind, r.output));
}

export function deleteTraceText(db: DB, traceId: string): void {
  db.prepare('delete from spans_fts where rowid in (select rowid from spans where trace_id = ?)').run(traceId);
}
