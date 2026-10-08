import type { DB } from './db.ts';
import { getDb } from './db.ts';
import { deleteTraceText } from './fts.ts';

export function purgeOlderThan(db: DB, days: number): number {
  const cutoff = (Date.now() - days * 86400e3) * 1e6;
  const ids = (db.prepare('select trace_id from traces where end_ns < ?').all(cutoff) as { trace_id: string }[]).map((r) => r.trace_id);
  for (let i = 0; i < ids.length; i += 500) {
    const batch = ids.slice(i, i + 500);
    db.exec('begin immediate');
    try {
      for (const id of batch) {
        deleteTraceText(db, id);
        db.prepare('delete from spans where trace_id = ?').run(id);
        db.prepare('delete from signals where trace_id = ?').run(id);
        db.prepare("delete from scores where trace_id = ? and source != 'human'").run(id);
        db.prepare('delete from traces where trace_id = ?').run(id);
      }
      db.exec('commit');
    } catch (e) {
      db.exec('rollback');
      throw e;
    }
  }
  db.prepare('delete from sessions where session_id not in (select session_id from traces where session_id is not null)').run();
  db.prepare('delete from logs where ts_ns < ?').run(cutoff);
  db.prepare('delete from metric_points where ts_ns < ?').run(cutoff);
  return ids.length;
}

export function startRetention(db: DB = getDb()): void {
  const days = Number(process.env.BLACKBOX_RETENTION_DAYS || 30);
  if (!days || days <= 0) return;
  const run = () => {
    try {
      const n = purgeOlderThan(db, days);
      if (n) console.log(`[blackbox] retention removed ${n} traces older than ${days} days`);
    } catch (e) {
      console.error('[blackbox] retention', e);
    }
  };
  setTimeout(run, 30000);
  setInterval(run, 6 * 3600e3).unref();
}
