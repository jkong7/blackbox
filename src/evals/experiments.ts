import { spawn } from 'node:child_process';
import type { DB } from '../db.ts';
import { HttpError } from '../http.ts';
import { emit } from '../bus.ts';
import { maybeJson, newId, nowMs, safeJson } from '../util.ts';
import { complete } from './judge.ts';
import { asText } from './render.ts';
import { getEvaluator, runEvaluator, type Evaluator } from './runner.ts';
import { datasetItems, getDataset } from './datasets.ts';

type Row = Record<string, any>;

export type Target = { type: 'command'; command: string; timeout_ms?: number } | { type: 'http'; url: string; headers?: Record<string, string>; timeout_ms?: number } | { type: 'llm'; model?: string; system?: string };

export interface TargetResult {
  output: unknown;
  cost_usd: number | null;
  trace_id: string | null;
}

const TARGET_TIMEOUT_MS = 120000;
const RUN_CONCURRENCY = 2;

export function parseExperiment(r: Row): Row {
  return { ...r, target: safeJson(r.target), evaluator_ids: safeJson(r.evaluator_ids) ?? [], summary: safeJson(r.summary) };
}

export function validateTarget(t: any): Target {
  if (!t || typeof t !== 'object') throw new HttpError(400, 'target required');
  if (t.type === 'command' && typeof t.command === 'string' && t.command.trim()) return t;
  if (t.type === 'http' && typeof t.url === 'string' && /^https?:\/\//.test(t.url)) return t;
  if (t.type === 'llm') return t;
  throw new HttpError(400, "target must be {type:'command', command} | {type:'http', url} | {type:'llm', model, system?}");
}

function traceIdOf(v: unknown): string | null {
  return v && typeof v === 'object' && !Array.isArray(v) && typeof (v as Row).trace_id === 'string' ? (v as Row).trace_id : null;
}

export function runCommand(command: string, input: unknown, timeoutMs = TARGET_TIMEOUT_MS): Promise<TargetResult> {
  const payload = JSON.stringify(input ?? null);
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', command], { env: { ...process.env, BLACKBOX_INPUT: payload }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      child.kill('SIGKILL');
      reject(new Error(`command timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`exit ${code}: ${(stderr || stdout).trim().slice(-500)}`));
      const text = stdout.trim();
      const output = maybeJson(text);
      resolve({ output, cost_usd: null, trace_id: traceIdOf(output) });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(payload);
  });
}

export async function runHttp(url: string, input: unknown, headers: Record<string, string> = {}, timeoutMs = TARGET_TIMEOUT_MS): Promise<TargetResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ input }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`http ${res.status}: ${text.slice(0, 300)}`);
  const body = maybeJson(text);
  const output = body && typeof body === 'object' && !Array.isArray(body) && 'output' in (body as Row) ? (body as Row).output : body;
  const cost = body && typeof body === 'object' ? Number((body as Row).cost_usd) : NaN;
  return { output, cost_usd: Number.isFinite(cost) ? cost : null, trace_id: traceIdOf(body) };
}

export async function runLlm(db: DB, t: { model?: string; system?: string }, input: unknown): Promise<TargetResult> {
  const res = await complete({ system: t.system, prompt: asText(input), model: t.model || null, maxTokens: 4096 }, db);
  return { output: res.text, cost_usd: res.cost_usd, trace_id: null };
}

export function callTarget(db: DB, target: Target, input: unknown): Promise<TargetResult> {
  if (target.type === 'command') return runCommand(target.command, input, target.timeout_ms);
  if (target.type === 'http') return runHttp(target.url, input, target.headers, target.timeout_ms);
  return runLlm(db, target, input);
}

export function createExperiment(db: DB, body: Row): Row {
  const ds = getDataset(db, body.dataset_id);
  const target = validateTarget(body.target);
  const evIds: string[] = [];
  for (const ref of Array.isArray(body.evaluator_ids) ? body.evaluator_ids : []) {
    const ev = getEvaluator(db, String(ref));
    if (!ev || !ev.id) throw new HttpError(400, `unknown evaluator ${ref}`);
    evIds.push(ev.id);
  }
  if (body.baseline_id && !db.prepare('select 1 from experiments where id = ?').get(body.baseline_id)) throw new HttpError(400, 'baseline experiment not found');
  const row = {
    id: newId('ex_'),
    dataset_id: ds.id,
    name: String(body.name || `${ds.name} ${new Date().toISOString().slice(0, 16)}`),
    target: JSON.stringify(target),
    evaluator_ids: JSON.stringify(evIds),
    baseline_id: body.baseline_id ?? null,
    status: 'pending',
    created_at: nowMs(),
  };
  db.prepare('insert into experiments(id, dataset_id, name, target, evaluator_ids, baseline_id, status, created_at) values(?,?,?,?,?,?,?,?)').run(
    row.id, row.dataset_id, row.name, row.target, row.evaluator_ids, row.baseline_id, row.status, row.created_at,
  );
  return parseExperiment(row);
}

function getExperimentRow(db: DB, id: string): Row {
  const r = db.prepare('select * from experiments where id = ?').get(id) as Row | undefined;
  if (!r) throw new HttpError(404, 'experiment not found');
  return r;
}

export function summarize(db: DB, experimentId: string): Row {
  const runs = db.prepare('select latency_ms, cost_usd, error from experiment_runs where experiment_id = ?').all(experimentId) as Row[];
  const scores = db
    .prepare(
      `select name, count(*) n, avg(value) avg, sum(case when value >= 0.5 then 1 else 0 end) passes, sum(case when value is not null then 1 else 0 end) scored, sum(coalesce(cost_usd,0)) cost
       from scores where experiment_id = ? group by name order by name`,
    )
    .all(experimentId) as Row[];
  const lat = runs.map((r) => r.latency_ms).filter((x): x is number => x != null);
  const out: Row = {
    runs: runs.length,
    errors: runs.filter((r) => r.error).length,
    avg_latency_ms: lat.length ? lat.reduce((a, b) => a + b, 0) / lat.length : null,
    target_cost_usd: runs.reduce((a, r) => a + (r.cost_usd ?? 0), 0),
    judge_cost_usd: scores.reduce((a, s) => a + (s.cost ?? 0), 0),
    scores: {} as Row,
  };
  for (const s of scores) out.scores[s.name] = { n: s.n, avg: s.avg, pass_rate: s.scored ? s.passes / s.scored : null };
  return out;
}

async function runItem(db: DB, exp: Row, target: Target, evaluators: Evaluator[], item: Row): Promise<void> {
  const t0 = performance.now();
  let result: TargetResult | null = null;
  let error: string | null = null;
  try {
    result = await callTarget(db, target, item.input);
  } catch (e: any) {
    error = String(e?.message ?? e);
  }
  const latency = performance.now() - t0;
  const runId = newId('er_');
  db.prepare('insert into experiment_runs(id, experiment_id, item_id, output, trace_id, latency_ms, cost_usd, error, created_at) values(?,?,?,?,?,?,?,?,?)').run(
    runId, exp.id, item.id, result ? JSON.stringify(result.output ?? null) : null, result?.trace_id ?? null, latency, result?.cost_usd ?? null, error, nowMs(),
  );
  for (const ev of evaluators) {
    try {
      await runEvaluator(db, ev, { experiment_id: exp.id, run_id: runId }, { emit: false });
    } catch (e: any) {
      db.prepare(`insert into scores(id, name, value, label, reasoning, source, evaluator_id, experiment_id, run_id, created_at) values(?,?,null,'error',?,?,?,?,?,?)`).run(
        newId('sc_'), ev.name, String(e?.message ?? e), ev.type === 'code' ? 'code' : 'judge', ev.id, exp.id, runId, nowMs(),
      );
    }
  }
}

export async function runExperiment(db: DB, id: string): Promise<Row> {
  const exp = parseExperiment(getExperimentRow(db, id));
  const items = datasetItems(db, exp.dataset_id);
  const evaluators = (exp.evaluator_ids as string[]).map((e) => getEvaluator(db, e)).filter((e): e is Evaluator => !!e);
  db.prepare(`update experiments set status = 'running' where id = ?`).run(id);
  emit({ type: 'experiment', ids: [id] });
  try {
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < items.length) {
        const item = items[next++];
        await runItem(db, exp, exp.target, evaluators, item);
        done++;
        const summary = { ...summarize(db, id), total: items.length, done };
        db.prepare('update experiments set summary = ? where id = ?').run(JSON.stringify(summary), id);
        emit({ type: 'experiment', ids: [id] });
      }
    };
    await Promise.all(Array.from({ length: Math.min(RUN_CONCURRENCY, items.length || 1) }, worker));
    const summary = { ...summarize(db, id), total: items.length, done: items.length };
    db.prepare(`update experiments set status = 'done', summary = ?, finished_at = ? where id = ?`).run(JSON.stringify(summary), nowMs(), id);
  } catch (e: any) {
    db.prepare(`update experiments set status = 'failed', error = ?, finished_at = ? where id = ?`).run(String(e?.message ?? e), nowMs(), id);
  }
  emit({ type: 'experiment', ids: [id] });
  return parseExperiment(getExperimentRow(db, id));
}

export function startExperiment(db: DB, id: string): void {
  runExperiment(db, id).catch((e) => console.error('[blackbox] experiment', id, e));
}

export function listExperiments(db: DB, datasetId: string | null): Row[] {
  const rows = datasetId
    ? db.prepare('select * from experiments where dataset_id = ? order by created_at desc').all(datasetId)
    : db.prepare('select * from experiments order by created_at desc').all();
  return (rows as Row[]).map(parseExperiment);
}

function runScores(db: DB, runIds: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>();
  if (!runIds.length) return out;
  const ph = runIds.map(() => '?').join(',');
  for (const s of db.prepare(`select * from scores where run_id in (${ph}) order by created_at`).all(...runIds) as Row[]) {
    const list = out.get(s.run_id) ?? [];
    list.push(s);
    out.set(s.run_id, list);
  }
  return out;
}

export function experimentRuns(db: DB, id: string): Row[] {
  const runs = db
    .prepare(
      `select r.*, i.input item_input, i.expected item_expected from experiment_runs r left join dataset_items i on i.id = r.item_id
       where r.experiment_id = ? order by i.created_at, r.created_at`,
    )
    .all(id) as Row[];
  const scores = runScores(db, runs.map((r) => r.id));
  return runs.map((r) => ({
    id: r.id,
    item_id: r.item_id,
    input: safeJson(r.item_input),
    expected: safeJson(r.item_expected),
    output: safeJson(r.output),
    trace_id: r.trace_id,
    latency_ms: r.latency_ms,
    cost_usd: r.cost_usd,
    error: r.error,
    scores: scores.get(r.id) ?? [],
  }));
}

export function getExperiment(db: DB, id: string): Row {
  return { experiment: parseExperiment(getExperimentRow(db, id)), runs: experimentRuns(db, id) };
}

function scoreMap(run: Row | undefined): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const s of run?.scores ?? []) out[s.name] = s.value;
  return out;
}

export function verdictFor(a: Row | undefined, b: Row | undefined): 'improved' | 'regressed' | 'tie' | 'tradeoff' {
  if (!a && b) return 'improved';
  if (a && !b) return 'regressed';
  if (a?.error && b && !b.error) return 'improved';
  if (b?.error && a && !a.error) return 'regressed';
  const sa = scoreMap(a);
  const sb = scoreMap(b);
  let up = 0;
  let down = 0;
  for (const name of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
    const x = sa[name];
    const y = sb[name];
    if (x == null || y == null) continue;
    if (y > x + 1e-9) up++;
    else if (y < x - 1e-9) down++;
  }
  if (up && down) return 'tradeoff';
  if (up) return 'improved';
  if (down) return 'regressed';
  return 'tie';
}

function side(run: Row | undefined): Row | null {
  if (!run) return null;
  return { run_id: run.id, output: run.output, error: run.error, latency_ms: run.latency_ms, cost_usd: run.cost_usd, trace_id: run.trace_id, scores: scoreMap(run) };
}

export function compareExperiments(db: DB, id: string, baselineId: string | null): Row {
  const exp = parseExperiment(getExperimentRow(db, id));
  const base = baselineId || exp.baseline_id;
  if (!base) throw new HttpError(400, 'baseline required: pass ?baseline=<experiment id> or set baseline_id');
  const baseExp = parseExperiment(getExperimentRow(db, base));
  const aRuns = experimentRuns(db, baseExp.id);
  const bRuns = experimentRuns(db, exp.id);
  const aBy = new Map(aRuns.map((r) => [r.item_id, r]));
  const bBy = new Map(bRuns.map((r) => [r.item_id, r]));
  const itemIds = [...new Set([...aRuns.map((r) => r.item_id), ...bRuns.map((r) => r.item_id)])];
  const summary: Row = {};
  const rows = itemIds.map((itemId) => {
    const a = aBy.get(itemId);
    const b = bBy.get(itemId);
    const sa = scoreMap(a);
    const sb = scoreMap(b);
    for (const name of new Set([...Object.keys(sa), ...Object.keys(sb)])) {
      const s = (summary[name] ??= { a_sum: 0, a_n: 0, b_sum: 0, b_n: 0, improved: 0, regressed: 0, ties: 0 });
      if (sa[name] != null) {
        s.a_sum += sa[name]!;
        s.a_n++;
      }
      if (sb[name] != null) {
        s.b_sum += sb[name]!;
        s.b_n++;
      }
      if (sa[name] != null && sb[name] != null) {
        if (sb[name]! > sa[name]! + 1e-9) s.improved++;
        else if (sb[name]! < sa[name]! - 1e-9) s.regressed++;
        else s.ties++;
      }
    }
    const ref = b ?? a;
    return { item_id: itemId, input: ref?.input ?? null, expected: ref?.expected ?? null, a: side(a), b: side(b), verdict: verdictFor(a, b) };
  });
  const out: Row = {};
  for (const [name, s] of Object.entries(summary)) {
    out[name] = { a_avg: s.a_n ? s.a_sum / s.a_n : null, b_avg: s.b_n ? s.b_sum / s.b_n : null, improved: s.improved, regressed: s.regressed, ties: s.ties };
  }
  const verdicts = { improved: 0, regressed: 0, tie: 0, tradeoff: 0 } as Row;
  for (const r of rows) verdicts[r.verdict]++;
  return { baseline: { id: baseExp.id, name: baseExp.name }, experiment: { id: exp.id, name: exp.name }, rows, summary: out, verdicts };
}

export function deleteExperiment(db: DB, id: string): void {
  db.prepare('delete from scores where experiment_id = ?').run(id);
  db.prepare('delete from experiment_runs where experiment_id = ?').run(id);
  db.prepare('delete from experiments where id = ?').run(id);
}
