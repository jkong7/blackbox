import type { Router } from '../http.ts';
import { HttpError } from '../http.ts';
import { getDb, type DB } from '../db.ts';
import { onFlush } from '../ingest.ts';
import { emit } from '../bus.ts';
import { newId, nowMs, num, safeJson } from '../util.ts';
import { migrateEvals } from './schema.ts';
import { CODE_CHECKS, TEMPLATES, seedBuiltins } from './builtin.ts';
import { judgeStatus } from './judge.ts';
import { evaluate, getEvaluator, insertScore, parseEvaluator, type Evaluator } from './runner.ts';
import { backfillRule, enqueueForTraces, listJobs, parseRule, queueManual, startLoop, stopLoop } from './worker.ts';
import { calibrate } from './calibration.ts';
import { addFromTraces, addItems, createDataset, datasetItems, deleteDataset, getDataset, listDatasets, parseJsonl, toItem } from './datasets.ts';
import { compareExperiments, createExperiment, deleteExperiment, getExperiment, listExperiments, startExperiment } from './experiments.ts';
import { explainTrace, getExplanation } from './explain.ts';
import { addToQueue, labelAnnotation, listAnnotations, listQueues } from './annotations.ts';

type Row = Record<string, any>;

const TYPES = ['llm_judge', 'code'];
const TARGETS = ['trace', 'llm', 'tool', 'session'];

let readyDb: DB | null = null;

export function ensureEvalSchema(db: DB = getDb()): void {
  if (readyDb === db) return;
  migrateEvals(db);
  seedBuiltins(db);
  readyDb = db;
}

function evaluatorStats(db: DB): Map<string, Row> {
  const rows = db
    .prepare(
      `select evaluator_id, count(*) runs, avg(value) avg,
        sum(case when value >= 0.5 then 1 else 0 end) * 1.0 / nullif(sum(case when value is not null then 1 else 0 end), 0) pass_rate,
        max(created_at) last_run
       from scores where evaluator_id is not null group by evaluator_id`,
    )
    .all() as Row[];
  return new Map(rows.map((r) => [r.evaluator_id, { runs: r.runs, avg: r.avg, pass_rate: r.pass_rate, last_run: r.last_run }]));
}

function publicEvaluator(ev: Row, stats?: Row): Row {
  const e = parseEvaluator(ev);
  return { ...e, stats: stats ?? { runs: 0, avg: null, pass_rate: null, last_run: null } };
}

function validateEvaluator(b: Row, partial = false): Row {
  const out: Row = {};
  if (!partial || b.name !== undefined) {
    if (!b.name || !String(b.name).trim()) throw new HttpError(400, 'name required');
    out.name = String(b.name).trim();
  }
  if (!partial || b.type !== undefined) {
    if (!TYPES.includes(b.type)) throw new HttpError(400, "type must be 'llm_judge' or 'code'");
    out.type = b.type;
  }
  if (b.target !== undefined || !partial) {
    const t = b.target ?? 'trace';
    if (!TARGETS.includes(t)) throw new HttpError(400, 'target must be trace, llm, tool or session');
    out.target = t;
  }
  if (b.description !== undefined) out.description = b.description == null ? null : String(b.description);
  if (!partial || b.config !== undefined) {
    const cfg = typeof b.config === 'string' ? safeJson(b.config) : b.config;
    if (!cfg || typeof cfg !== 'object') throw new HttpError(400, 'config object required');
    out.config = cfg;
  }
  return out;
}

function checkConfig(type: string, cfg: Row): void {
  if (type === 'code') {
    if (!CODE_CHECKS.includes(cfg.check)) throw new HttpError(400, `config.check must be one of ${CODE_CHECKS.join(', ')}`);
    if (cfg.check === 'regex' && cfg.params?.pattern) {
      try {
        new RegExp(cfg.params.pattern, cfg.params.flags ?? '');
      } catch (e: any) {
        throw new HttpError(400, `bad regex: ${e.message}`);
      }
    }
  } else if (!cfg.prompt && !(cfg.template && TEMPLATES[cfg.template])) {
    throw new HttpError(400, 'llm_judge config needs a prompt or a known template');
  }
}

function getEvaluatorRow(db: DB, id: string): Row {
  const r = db.prepare('select * from evaluators where id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'evaluator not found');
  return r;
}

function registerEvaluators(r: Router): void {
  r.get('/api/judge/status', () => judgeStatus(getDb()));
  r.get('/api/evaluators', () => {
    const db = getDb();
    const stats = evaluatorStats(db);
    const rows = db.prepare('select * from evaluators order by builtin desc, type desc, name').all() as Row[];
    return { items: rows.map((e) => publicEvaluator(e, stats.get(e.id))) };
  });
  r.get('/api/evaluators/:id', (_q, _r, ctx) => {
    const db = getDb();
    const row = getEvaluatorRow(db, ctx.params.id);
    return publicEvaluator(row, evaluatorStats(db).get(row.id));
  });
  r.post('/api/evaluators/test', async (_q, _r, ctx) => {
    const db = getDb();
    const b = await ctx.json();
    let ev: Evaluator | null;
    if (typeof b.evaluator === 'string') ev = getEvaluator(db, b.evaluator);
    else {
      const v = validateEvaluator({ name: 'test', ...b.evaluator });
      checkConfig(v.type, v.config);
      ev = { id: null, name: v.name, type: v.type, target: v.target, config: v.config };
    }
    if (!ev) throw new HttpError(404, 'evaluator not found');
    if (!b.trace_id && !b.span_id && !b.session_id) throw new HttpError(400, 'trace_id required');
    const o = await evaluate(db, ev, { trace_id: b.trace_id, span_id: b.span_id, session_id: b.session_id });
    const { material, ...score } = o;
    return { score: { ...score, name: ev.name, trace_id: material.trace_id, span_id: material.span_id, session_id: material.session_id } };
  });
  r.post('/api/evaluators', async (_q, _r, ctx) => {
    const db = getDb();
    const v = validateEvaluator(await ctx.json());
    checkConfig(v.type, v.config);
    if (db.prepare('select 1 from evaluators where name = ?').get(v.name)) throw new HttpError(409, `evaluator ${v.name} already exists`);
    const now = nowMs();
    const id = newId('ev_');
    db.prepare('insert into evaluators(id, name, type, description, target, config, builtin, created_at, updated_at) values(?,?,?,?,?,?,0,?,?)').run(
      id, v.name, v.type, v.description ?? null, v.target, JSON.stringify(v.config), now, now,
    );
    return publicEvaluator(getEvaluatorRow(db, id));
  });
  r.put('/api/evaluators/:id', async (_q, _r, ctx) => {
    const db = getDb();
    const cur = parseEvaluator(getEvaluatorRow(db, ctx.params.id));
    const v = validateEvaluator(await ctx.json(), true);
    const next = { ...cur, ...v };
    checkConfig(next.type, next.config);
    if (v.name && v.name !== cur.name && db.prepare('select 1 from evaluators where name = ? and id != ?').get(v.name, cur.id)) throw new HttpError(409, `evaluator ${v.name} already exists`);
    db.prepare('update evaluators set name = ?, type = ?, description = ?, target = ?, config = ?, updated_at = ? where id = ?').run(
      next.name, next.type, next.description ?? null, next.target, JSON.stringify(next.config), nowMs(), cur.id,
    );
    return publicEvaluator(getEvaluatorRow(db, cur.id!));
  });
  r.delete('/api/evaluators/:id', (_q, _r, ctx) => {
    const db = getDb();
    const row = getEvaluatorRow(db, ctx.params.id);
    if (row.builtin) throw new HttpError(400, 'built-in evaluators cannot be deleted; disable their rules instead');
    db.prepare('delete from eval_rules where evaluator_id = ?').run(row.id);
    db.prepare(`delete from eval_jobs where evaluator_id = ? and status = 'queued'`).run(row.id);
    db.prepare('delete from evaluators where id = ?').run(row.id);
    return { ok: true };
  });
  r.post('/api/evaluators/:id/run', async (_q, _r, ctx) => {
    const db = getDb();
    const row = getEvaluatorRow(db, ctx.params.id);
    const b = await ctx.json();
    const targets: Row[] = [];
    if (Array.isArray(b.trace_ids)) for (const t of b.trace_ids) targets.push({ trace_id: String(t) });
    if (b.trace_id || b.span_id || b.session_id) targets.push({ trace_id: b.trace_id ?? null, span_id: b.span_id ?? null, session_id: b.session_id ?? null });
    if (!targets.length) throw new HttpError(400, 'trace_id, span_id, session_id or trace_ids required');
    return { jobs: queueManual(db, row.id, targets) };
  });
  r.get('/api/evaluators/:id/calibration', (_q, _r, ctx) => {
    const db = getDb();
    const row = getEvaluatorRow(db, ctx.params.id);
    return calibrate(db, row.id);
  });
}

function ruleRow(db: DB, id: string): Row {
  const r = db.prepare('select r.*, e.name evaluator_name from eval_rules r left join evaluators e on e.id = r.evaluator_id where r.id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'rule not found');
  return parseRule(r);
}

function ruleFields(db: DB, b: Row, cur?: Row): Row {
  const out: Row = {};
  if (b.evaluator_id !== undefined || !cur) {
    const ev = b.evaluator_id ? getEvaluator(db, String(b.evaluator_id)) : null;
    if (!ev) throw new HttpError(400, 'evaluator_id must reference an evaluator');
    out.evaluator_id = ev.id;
    if (b.target === undefined && !cur) out.target = ev.target;
  }
  if (b.name !== undefined || !cur) out.name = String(b.name ?? '').trim() || `rule ${new Date().toISOString().slice(0, 16)}`;
  if (b.target !== undefined) {
    if (!TARGETS.includes(b.target)) throw new HttpError(400, 'target must be trace, llm, tool or session');
    out.target = b.target;
  }
  if (b.filter !== undefined) out.filter = JSON.stringify(b.filter && typeof b.filter === 'object' ? b.filter : {});
  if (b.sampling !== undefined) out.sampling = Math.max(0, Math.min(1, num(b.sampling) ?? 1));
  if (b.delay_ms !== undefined) out.delay_ms = Math.max(0, Math.round(num(b.delay_ms) ?? 0));
  if (b.enabled !== undefined) out.enabled = b.enabled ? 1 : 0;
  return out;
}

function registerRules(r: Router): void {
  r.get('/api/rules', () => {
    const rows = getDb().prepare('select r.*, e.name evaluator_name from eval_rules r left join evaluators e on e.id = r.evaluator_id order by r.created_at desc').all() as Row[];
    return { items: rows.map(parseRule) };
  });
  r.post('/api/rules', async (_q, _r, ctx) => {
    const db = getDb();
    const f = ruleFields(db, await ctx.json());
    const id = newId('rl_');
    db.prepare('insert into eval_rules(id, name, evaluator_id, target, filter, sampling, delay_ms, enabled, created_at) values(?,?,?,?,?,?,?,?,?)').run(
      id, f.name, f.evaluator_id, f.target ?? 'trace', f.filter ?? '{}', f.sampling ?? 1, f.delay_ms ?? 5000, f.enabled ?? 1, nowMs(),
    );
    return ruleRow(db, id);
  });
  r.patch('/api/rules/:id', async (_q, _r, ctx) => {
    const db = getDb();
    const cur = ruleRow(db, ctx.params.id);
    const f = ruleFields(db, await ctx.json(), cur);
    const keys = Object.keys(f);
    if (keys.length) db.prepare(`update eval_rules set ${keys.map((k) => `${k} = ?`).join(', ')} where id = ?`).run(...keys.map((k) => f[k]), cur.id);
    return ruleRow(db, cur.id);
  });
  r.delete('/api/rules/:id', (_q, _r, ctx) => {
    const db = getDb();
    db.prepare(`delete from eval_jobs where rule_id = ? and status = 'queued'`).run(ctx.params.id);
    db.prepare('delete from eval_rules where id = ?').run(ctx.params.id);
    return { ok: true };
  });
  r.post('/api/rules/:id/backfill', async (_q, _r, ctx) => {
    const db = getDb();
    ruleRow(db, ctx.params.id);
    const b = await ctx.json();
    return { queued: backfillRule(db, ctx.params.id, num(b.limit) ?? 100) };
  });
  r.get('/api/jobs', (_q, _r, ctx) => listJobs(getDb(), ctx.query.get('status'), Math.min(1000, num(ctx.query.get('limit')) ?? 100)));
}

function registerScores(r: Router): void {
  r.get('/api/scores', (_q, _r, ctx) => {
    const q = ctx.query;
    const where: string[] = ['1=1'];
    const params: any[] = [];
    for (const k of ['name', 'evaluator_id', 'trace_id', 'source', 'session_id', 'experiment_id', 'run_id', 'rule_id']) {
      const v = q.get(k);
      if (v) {
        where.push(`${k} = ?`);
        params.push(v);
      }
    }
    const items = getDb().prepare(`select * from scores where ${where.join(' and ')} order by created_at desc limit ?`).all(...params, Math.min(1000, num(q.get('limit')) ?? 100));
    return { items };
  });
  r.post('/api/scores', async (_q, _r, ctx) => {
    const b = await ctx.json();
    if (!b.name) throw new HttpError(400, 'name required');
    if (!b.trace_id && !b.session_id) throw new HttpError(400, 'trace_id or session_id required');
    const value = num(b.value);
    const source = ['judge', 'code', 'human', 'sdk'].includes(b.source) ? b.source : 'sdk';
    const row = insertScore(getDb(), {
      trace_id: b.trace_id ?? null,
      span_id: b.span_id ?? null,
      session_id: b.session_id ?? null,
      name: String(b.name),
      value,
      label: b.label != null ? String(b.label) : null,
      reasoning: b.reasoning != null ? String(b.reasoning) : b.comment != null ? String(b.comment) : null,
      source,
      author: b.author ?? null,
    });
    emit({ type: 'scores', ids: [row.trace_id ?? row.session_id] });
    return row;
  });
}

function registerAnnotations(r: Router): void {
  r.get('/api/annotations/queues', () => ({ items: listQueues(getDb()) }));
  r.get('/api/annotations', (_q, _r, ctx) => ({ items: listAnnotations(getDb(), ctx.query.get('queue'), ctx.query.get('status'), Math.min(1000, num(ctx.query.get('limit')) ?? 200)) }));
  r.post('/api/annotations', async (_q, _r, ctx) => {
    const b = await ctx.json();
    const ids = Array.isArray(b.trace_ids) ? b.trace_ids.map(String) : b.trace_id ? [String(b.trace_id)] : [];
    if (!ids.length) throw new HttpError(400, 'trace_ids required');
    return { added: addToQueue(getDb(), ids, b.queue ? String(b.queue) : 'default') };
  });
  r.post('/api/annotations/:id', async (_q, _r, ctx) => labelAnnotation(getDb(), ctx.params.id, await ctx.json()));
}

function registerDatasets(r: Router): void {
  r.get('/api/datasets', () => ({ items: listDatasets(getDb()) }));
  r.post('/api/datasets', async (_q, _r, ctx) => {
    const b = await ctx.json();
    return createDataset(getDb(), b.name, b.description);
  });
  r.get('/api/datasets/:id', (_q, _r, ctx) => {
    const db = getDb();
    const dataset = getDataset(db, ctx.params.id);
    return { dataset, items: datasetItems(db, dataset.id) };
  });
  r.post('/api/datasets/:id/items', async (_q, _r, ctx) => {
    const db = getDb();
    const ds = getDataset(db, ctx.params.id);
    const b = await ctx.json();
    let added = 0;
    if (Array.isArray(b.trace_ids)) added += addFromTraces(db, ds.id, b.trace_ids.map(String));
    if (Array.isArray(b.items)) added += addItems(db, ds.id, b.items.map(toItem));
    if (typeof b.jsonl === 'string') added += addItems(db, ds.id, parseJsonl(b.jsonl));
    if (!Array.isArray(b.trace_ids) && !Array.isArray(b.items) && typeof b.jsonl !== 'string') throw new HttpError(400, 'items, jsonl or trace_ids required');
    return { added };
  });
  r.delete('/api/datasets/:id/items/:itemId', (_q, _r, ctx) => {
    getDb().prepare('delete from dataset_items where id = ? and dataset_id = ?').run(ctx.params.itemId, ctx.params.id);
    return { ok: true };
  });
  r.delete('/api/datasets/:id', (_q, _r, ctx) => {
    const db = getDb();
    const ds = getDataset(db, ctx.params.id);
    deleteDataset(db, ds.id);
    return { ok: true };
  });
}

function registerExperiments(r: Router): void {
  r.get('/api/experiments', (_q, _r, ctx) => ({ items: listExperiments(getDb(), ctx.query.get('dataset_id')) }));
  r.post('/api/experiments', async (_q, _r, ctx) => {
    const db = getDb();
    const exp = createExperiment(db, await ctx.json());
    startExperiment(db, exp.id);
    return exp;
  });
  r.get('/api/experiments/:id', (_q, _r, ctx) => getExperiment(getDb(), ctx.params.id));
  r.get('/api/experiments/:id/compare', (_q, _r, ctx) => compareExperiments(getDb(), ctx.params.id, ctx.query.get('baseline')));
  r.delete('/api/experiments/:id', (_q, _r, ctx) => {
    deleteExperiment(getDb(), ctx.params.id);
    return { ok: true };
  });
}

function registerExplain(r: Router): void {
  r.post('/api/traces/:id/explain', async (_q, _r, ctx) => explainTrace(getDb(), ctx.params.id));
  r.get('/api/traces/:id/explain', (_q, _r, ctx) => getExplanation(getDb(), ctx.params.id));
}

export function registerEvalApi(r: Router): void {
  ensureEvalSchema();
  registerEvaluators(r);
  registerRules(r);
  registerScores(r);
  registerAnnotations(r);
  registerDatasets(r);
  registerExperiments(r);
  registerExplain(r);
}

let unhook = false;

export function startEvalWorker(opts: { intervalMs?: number } = {}): () => void {
  const db = getDb();
  ensureEvalSchema(db);
  db.prepare(`update eval_jobs set status = 'queued', lease_until = null where status = 'running'`).run();
  if (!unhook) {
    unhook = true;
    onFlush((ids) => {
      try {
        enqueueForTraces(getDb(), ids);
      } catch (e) {
        console.error('[blackbox] eval enqueue', e);
      }
    });
  }
  startLoop(opts.intervalMs ?? 1000);
  return stopLoop;
}

export { migrateEvals, seedBuiltins };
