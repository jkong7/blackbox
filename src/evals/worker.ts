import type { DB } from '../db.ts';
import { getDb } from '../db.ts';
import { hashFraction, nowMs, safeJson, sha } from '../util.ts';
import { BudgetError, JUDGE_CONCURRENCY, JUDGE_MARKER } from './judge.ts';
import { getEvaluator, runEvaluator } from './runner.ts';

type Row = Record<string, any>;

export interface RuleFilter {
  project?: string;
  agent?: string;
  model?: string;
  tool?: string;
  status?: 'ok' | 'error';
  signal?: string;
  source?: string;
  name_contains?: string;
}

export const MAX_ATTEMPTS = 3;
export const LEASE_MS = 180000;
const WORKER_SLOTS = JUDGE_CONCURRENCY * 2;

export function parseRule(r: Row): Row {
  return { ...r, filter: (typeof r.filter === 'string' ? safeJson(r.filter) : r.filter) ?? {}, enabled: !!r.enabled };
}

export function jobId(ruleId: string, traceId: string, spanId: string | null): string {
  return sha(ruleId + traceId + (spanId ?? ''));
}

function listHas(csv: string | null | undefined, v: string): boolean {
  return String(csv ?? '').split(',').includes(v);
}

export function isJudgeTrace(db: DB, traceId: string): boolean {
  const t = db.prepare('select input_preview, name from traces where trace_id = ?').get(traceId) as Row | undefined;
  if (t && (String(t.input_preview ?? '').includes(JUDGE_MARKER) || String(t.name ?? '').includes(JUDGE_MARKER))) return true;
  const hit = db
    .prepare(`select 1 from spans where trace_id = ? and (agent_name = 'blackbox-judge' or (kind in ('llm','agent') and substr(input, 1, 4000) like ?)) limit 1`)
    .get(traceId, '%' + JUDGE_MARKER + '%');
  return !!hit;
}

export function matchesFilter(db: DB, f: RuleFilter, trace: Row, opts: { signals?: boolean } = {}): boolean {
  if (f.project && trace.project !== f.project) return false;
  if (f.agent && !listHas(trace.agent_names, f.agent)) return false;
  if (f.model && !listHas(trace.models, f.model)) return false;
  if (f.source && !listHas(trace.sources, f.source)) return false;
  if (f.status === 'error' && !(trace.error_count > 0)) return false;
  if (f.status === 'ok' && trace.error_count > 0) return false;
  if (f.name_contains && !String(trace.name ?? '').toLowerCase().includes(f.name_contains.toLowerCase())) return false;
  if (f.tool && !db.prepare('select 1 from spans where trace_id = ? and tool_name = ? limit 1').get(trace.trace_id, f.tool)) return false;
  if (f.signal && opts.signals !== false) {
    if (!db.prepare('select 1 from signals where trace_id = ? and (type = ? or fingerprint = ?) limit 1').get(trace.trace_id, f.signal, f.signal)) return false;
  }
  return true;
}

function targetSpans(db: DB, target: string, traceId: string): string[] {
  if (target === 'llm') return (db.prepare(`select span_id from spans where trace_id = ? and kind = 'llm' order by start_ns`).all(traceId) as Row[]).map((r) => r.span_id);
  if (target === 'tool') return (db.prepare(`select span_id from spans where trace_id = ? and kind in ('tool','mcp') order by start_ns`).all(traceId) as Row[]).map((r) => r.span_id);
  return [];
}

export function enqueueForTrace(db: DB, rule: Row, trace: Row, now = nowMs(), delayOverride?: number): number {
  const delay = delayOverride ?? Number(rule.delay_ms ?? 0);
  const runAfter = now + delay;
  const target = rule.target ?? 'trace';
  if (target === 'session') {
    if (!trace.session_id) return 0;
    const id = sha(rule.id + 'session:' + trace.session_id);
    const r = db
      .prepare(
        `insert into eval_jobs(id, rule_id, evaluator_id, trace_id, span_id, session_id, status, run_after, created_at) values(?,?,?,null,null,?,'queued',?,?)
         on conflict(id) do update set run_after = excluded.run_after where eval_jobs.status = 'queued'`,
      )
      .run(id, rule.id, rule.evaluator_id, trace.session_id, runAfter, now);
    return Number(r.changes);
  }
  const ins = db.prepare(
    `insert or ignore into eval_jobs(id, rule_id, evaluator_id, trace_id, span_id, session_id, status, run_after, created_at) values(?,?,?,?,?,?,'queued',?,?)`,
  );
  const spanIds = target === 'trace' ? [null] : targetSpans(db, target, trace.trace_id);
  let n = 0;
  for (const sid of spanIds) n += Number(ins.run(jobId(rule.id, trace.trace_id, sid), rule.id, rule.evaluator_id, trace.trace_id, sid, trace.session_id ?? null, runAfter, now).changes);
  return n;
}

export function enabledRules(db: DB): Row[] {
  return (db.prepare('select * from eval_rules where enabled = 1').all() as Row[]).map(parseRule);
}

export function enqueueForTraces(db: DB, traceIds: string[], now = nowMs()): number {
  const rules = enabledRules(db);
  if (!rules.length) return 0;
  let n = 0;
  const getTrace = db.prepare('select * from traces where trace_id = ?');
  for (const id of traceIds) {
    const trace = getTrace.get(id) as Row | undefined;
    if (!trace || isJudgeTrace(db, id)) continue;
    for (const rule of rules) {
      if (!matchesFilter(db, rule.filter, trace, { signals: false })) continue;
      const rate = Math.max(0, Math.min(1, Number(rule.sampling ?? 1)));
      if (rate < 1 && hashFraction(id) >= rate) continue;
      n += enqueueForTrace(db, rule, trace, now);
    }
  }
  return n;
}

export function backfillRule(db: DB, ruleId: string, limit = 100): number {
  const rule = db.prepare('select * from eval_rules where id = ?').get(ruleId) as Row | undefined;
  if (!rule) return 0;
  const r = parseRule(rule);
  const traces = db.prepare('select * from traces order by start_ns desc limit ?').all(Math.max(1, Math.min(5000, limit)) * 4) as Row[];
  const now = nowMs();
  let queued = 0;
  let considered = 0;
  for (const t of traces) {
    if (considered >= limit) break;
    if (isJudgeTrace(db, t.trace_id)) continue;
    if (!matchesFilter(db, r.filter, t)) continue;
    const rate = Math.max(0, Math.min(1, Number(r.sampling ?? 1)));
    if (rate < 1 && hashFraction(t.trace_id) >= rate) continue;
    considered++;
    queued += enqueueForTrace(db, r, t, now, 0);
  }
  if (queued) kick();
  return queued;
}

export function queueManual(db: DB, evaluatorId: string, targets: { trace_id?: string | null; span_id?: string | null; session_id?: string | null }[]): string[] {
  const now = nowMs();
  const ins = db.prepare(`insert into eval_jobs(id, rule_id, evaluator_id, trace_id, span_id, session_id, status, run_after, created_at) values(?,null,?,?,?,?,'queued',?,?)`);
  const ids: string[] = [];
  for (const t of targets) {
    const id = sha(`manual:${evaluatorId}:${t.trace_id ?? ''}:${t.span_id ?? ''}:${t.session_id ?? ''}:${now}:${Math.random()}`);
    ins.run(id, evaluatorId, t.trace_id ?? null, t.span_id ?? null, t.session_id ?? null, now, now);
    ids.push(id);
  }
  kick();
  return ids;
}

function reclaim(db: DB, now: number): void {
  db.prepare(`update eval_jobs set status = 'queued', lease_until = null where status = 'running' and lease_until < ?`).run(now);
}

function lease(db: DB, n: number, now: number): Row[] {
  if (n <= 0) return [];
  const due = db.prepare(`select * from eval_jobs where status = 'queued' and run_after <= ? order by run_after limit ?`).all(now, n) as Row[];
  const claim = db.prepare(`update eval_jobs set status = 'running', lease_until = ?, attempts = attempts + 1, started_at = ? where id = ? and status = 'queued'`);
  return due.filter((j) => Number(claim.run(now + LEASE_MS, now, j.id).changes) === 1).map((j) => ({ ...j, attempts: j.attempts + 1 }));
}

function finish(db: DB, id: string, status: string, error: string | null): void {
  db.prepare('update eval_jobs set status = ?, error = ?, lease_until = null, finished_at = ? where id = ?').run(status, error, nowMs(), id);
}

export function backoffMs(attempts: number): number {
  return Math.min(10 * 60000, 15000 * 2 ** Math.max(0, attempts - 1));
}

export async function runJob(db: DB, job: Row): Promise<void> {
  const beat = setInterval(() => {
    try {
      db.prepare(`update eval_jobs set lease_until = ? where id = ? and status = 'running'`).run(nowMs() + LEASE_MS, job.id);
    } catch {}
  }, LEASE_MS / 3);
  try {
    const ev = getEvaluator(db, job.evaluator_id);
    if (!ev) return finish(db, job.id, 'failed', 'evaluator not found');
    if (job.rule_id) {
      const rule = db.prepare('select * from eval_rules where id = ?').get(job.rule_id) as Row | undefined;
      if (!rule || !rule.enabled) return finish(db, job.id, 'skipped', 'rule disabled or deleted');
    }
    if (job.rule_id && job.trace_id) {
      const rule = db.prepare('select * from eval_rules where id = ?').get(job.rule_id) as Row;
      const trace = db.prepare('select * from traces where trace_id = ?').get(job.trace_id) as Row | undefined;
      if (!trace) return finish(db, job.id, 'failed', 'trace not found');
      if (!matchesFilter(db, parseRule(rule).filter, trace)) return finish(db, job.id, 'skipped', 'trace no longer matches the rule filter');
    }
    await runEvaluator(db, ev, { trace_id: job.trace_id, span_id: job.span_id, session_id: job.session_id, rule_id: job.rule_id, experiment_id: job.experiment_id, run_id: job.run_id });
    finish(db, job.id, 'done', null);
  } catch (e: any) {
    const msg = String(e?.message ?? e);
    if (e instanceof BudgetError || job.attempts >= MAX_ATTEMPTS || (e?.status && e.status < 500)) return finish(db, job.id, 'failed', msg);
    db.prepare(`update eval_jobs set status = 'queued', error = ?, lease_until = null, run_after = ? where id = ?`).run(msg, nowMs() + backoffMs(job.attempts), job.id);
  } finally {
    clearInterval(beat);
  }
}

let running = 0;
let timer: NodeJS.Timeout | null = null;
let ticking = false;
const inflight = new Set<Promise<void>>();

export async function tick(db: DB = getDb(), opts: { wait?: boolean } = {}): Promise<number> {
  if (ticking) return 0;
  ticking = true;
  let jobs: Row[] = [];
  try {
    const now = nowMs();
    reclaim(db, now);
    jobs = lease(db, WORKER_SLOTS - running, now);
  } finally {
    ticking = false;
  }
  for (const j of jobs) {
    running++;
    const p = runJob(db, j).finally(() => {
      running--;
      inflight.delete(p);
    });
    inflight.add(p);
  }
  if (opts.wait) await Promise.all([...inflight]);
  return jobs.length;
}

export async function drain(db: DB = getDb(), maxRounds = 50): Promise<void> {
  for (let i = 0; i < maxRounds; i++) {
    const n = await tick(db, { wait: true });
    if (!n && !inflight.size) return;
  }
}

let kickTimer: NodeJS.Timeout | null = null;

export function kick(): void {
  if (!timer || kickTimer) return;
  kickTimer = setTimeout(() => {
    kickTimer = null;
    tick().catch((e) => console.error('[blackbox] eval worker', e));
  }, 10);
}

export function startLoop(intervalMs = 1000): () => void {
  if (timer) return stopLoop;
  timer = setInterval(() => {
    tick().catch((e) => console.error('[blackbox] eval worker', e));
  }, intervalMs);
  timer.unref?.();
  return stopLoop;
}

export function stopLoop(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function jobCounts(db: DB): Row {
  const counts: Row = { queued: 0, running: 0, done: 0, failed: 0, skipped: 0 };
  for (const r of db.prepare('select status, count(*) n from eval_jobs group by status').all() as Row[]) counts[r.status] = r.n;
  return counts;
}

export function listJobs(db: DB, status: string | null, limit: number): Row {
  const items = status
    ? db.prepare(`select j.*, e.name evaluator_name from eval_jobs j left join evaluators e on e.id = j.evaluator_id where j.status = ? order by j.created_at desc limit ?`).all(status, limit)
    : db.prepare(`select j.*, e.name evaluator_name from eval_jobs j left join evaluators e on e.id = j.evaluator_id order by j.created_at desc limit ?`).all(limit);
  return { items, counts: jobCounts(db) };
}
