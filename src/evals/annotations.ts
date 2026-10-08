import type { DB } from '../db.ts';
import { HttpError } from '../http.ts';
import { emit } from '../bus.ts';
import { newId, nowMs } from '../util.ts';
import { insertScore } from './runner.ts';

type Row = Record<string, any>;

export function listQueues(db: DB): Row[] {
  return db
    .prepare(`select queue, sum(status = 'pending') pending, sum(status = 'done') done from annotations group by queue order by queue`)
    .all() as Row[];
}

export function listAnnotations(db: DB, queue: string | null, status: string | null, limit = 200): Row[] {
  const where: string[] = ['1=1'];
  const params: any[] = [];
  if (queue) {
    where.push('a.queue = ?');
    params.push(queue);
  }
  if (status) {
    where.push('a.status = ?');
    params.push(status);
  }
  return db
    .prepare(
      `select a.*, t.name, t.input_preview, t.output_preview, t.start_ns, t.duration_ms, t.cost_usd, t.error_count, t.signal_count, t.llm_calls, t.tool_calls, t.agent_names, t.models,
        coalesce(a.session_id, t.session_id) session_id
       from annotations a left join traces t on t.trace_id = a.trace_id
       where ${where.join(' and ')} order by case a.status when 'pending' then 0 else 1 end, a.created_at limit ?`,
    )
    .all(...params, limit) as Row[];
}

export function addToQueue(db: DB, traceIds: string[], queue = 'default'): number {
  const ins = db.prepare(`insert or ignore into annotations(id, trace_id, session_id, queue, status, created_at) values(?,?,?,?, 'pending', ?)`);
  const sess = db.prepare('select session_id from traces where trace_id = ?');
  const now = nowMs();
  let n = 0;
  for (const id of traceIds) {
    if (!id) continue;
    const s = sess.get(id) as Row | undefined;
    n += Number(ins.run(newId('an_'), id, s?.session_id ?? null, queue || 'default', now + n).changes);
  }
  return n;
}

export function labelAnnotation(db: DB, id: string, body: Row): Row {
  const a = db.prepare('select * from annotations where id = ?').get(id) as Row | undefined;
  if (!a) throw new HttpError(404, 'annotation not found');
  const label = String(body.label ?? '').toLowerCase();
  if (label !== 'pass' && label !== 'fail') throw new HttpError(400, "label must be 'pass' or 'fail'");
  const value = label === 'pass' ? 1 : 0;
  const comment = body.comment ? String(body.comment) : null;
  const mode = body.failure_mode ? String(body.failure_mode) : null;
  const now = nowMs();
  db.prepare(`update annotations set status = 'done', label = ?, value = ?, comment = ?, failure_mode = ?, author = ?, labeled_at = ? where id = ?`).run(
    label, value, comment, mode, body.author ?? null, now, id,
  );
  const reasoning = [comment, mode ? `failure mode: ${mode}` : null].filter(Boolean).join('\n') || null;
  insertScore(db, {
    id: 'sc_h_' + id,
    trace_id: a.trace_id,
    session_id: a.session_id ?? null,
    name: 'human',
    value,
    label,
    reasoning,
    source: 'human',
    author: body.author ?? a.queue,
    created_at: now,
  });
  emit({ type: 'scores', ids: [a.trace_id] });
  return db.prepare('select * from annotations where id = ?').get(id) as Row;
}
