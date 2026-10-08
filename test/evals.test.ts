import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb, type DB } from '../src/db.ts';
import { ingestSpanRows, flush } from '../src/ingest.ts';
import { blankSpan } from '../src/normalize.ts';
import { hashFraction, nowMs } from '../src/util.ts';
import type { SpanRow } from '../src/types.ts';
import { ensureEvalSchema } from '../src/evals/index.ts';
import { builtinId, matchTrajectory, runCodeCheck, toolNames, type CodeContext } from '../src/evals/builtin.ts';
import { extractJson, parseVerdict, fillTemplate, judgeEnv, cliArgs } from '../src/evals/judge.ts';
import { getEvaluator, runEvaluator, evaluate, buildJudgePrompt } from '../src/evals/runner.ts';
import { enqueueForTraces, drain, jobId, jobCounts } from '../src/evals/worker.ts';
import { confusion, calibrate } from '../src/evals/calibration.ts';
import { createDataset, addItems, addFromTraces, datasetItems, parseJsonl } from '../src/evals/datasets.ts';
import { createExperiment, runExperiment, compareExperiments, verdictFor } from '../src/evals/experiments.ts';
import { explainTrace, getExplanation } from '../src/evals/explain.ts';
import { addToQueue, labelAnnotation, listAnnotations, listQueues } from '../src/evals/annotations.ts';
import { headTail, renderTraceById, fitSteps } from '../src/evals/render.ts';

process.env.BLACKBOX_JUDGE_PROVIDER = 'mock';

let db: DB;
const T0 = Date.now() * 1e6;

function span(p: Partial<SpanRow> & { span_id: string; trace_id: string; name: string }, offsetMs = 0, durMs = 100): SpanRow {
  const start = T0 + offsetMs * 1e6;
  const end = start + durMs * 1e6;
  return blankSpan({ start_ns: start, end_ns: end, duration_ms: durMs, status: 'ok', ...p });
}

function agentTrace(id: string, opts: { fail?: boolean; error?: boolean; tools?: string[]; session?: string; answer?: string; costly?: boolean; slowMs?: number } = {}): SpanRow[] {
  const tools = opts.tools ?? ['search', 'read_file'];
  const rows: SpanRow[] = [
    span({ span_id: id + '-root', trace_id: id, name: 'agent run', kind: 'agent', agent_name: 'helper', session_id: opts.session ?? null, input: 'Find the capital of France' + (opts.fail ? ' MOCK_FAIL' : ''), output: opts.answer ?? 'Paris is the capital of France.' }, 0, opts.slowMs ?? 2000),
    span({
      span_id: id + '-llm1', trace_id: id, parent_id: id + '-root', name: 'chat', kind: 'llm', model: 'claude-haiku-5-5', cost_usd: opts.costly ? 0.9 : 0.001,
      input: JSON.stringify([{ role: 'system', content: 'You are helpful.' }, { role: 'user', content: 'Find the capital of France' }]),
      output: JSON.stringify([{ role: 'assistant', content: 'Let me search.', tool_calls: tools.map((t, i) => ({ id: `c${i}`, name: t, arguments: { q: 'capital of France' } })) }]),
    }, 10),
  ];
  tools.forEach((t, i) => {
    rows.push(span({ span_id: `${id}-tool${i}`, trace_id: id, parent_id: id + '-root', name: t, kind: 'tool', tool_name: t, input: JSON.stringify({ q: 'capital of France' }), output: 'France: capital Paris, population 68M', status: opts.error && i === 0 ? 'error' : 'ok', status_message: opts.error && i === 0 ? 'timeout' : null }, 200 + i * 100));
  });
  rows.push(span({ span_id: id + '-llm2', trace_id: id, parent_id: id + '-root', name: 'chat', kind: 'llm', model: 'claude-haiku-5-5', output: JSON.stringify([{ role: 'assistant', content: opts.answer ?? 'Paris is the capital of France.' }]) }, 1500));
  return rows;
}

function load(rows: SpanRow[]): void {
  ingestSpanRows(rows);
  flush(db);
}

before(() => {
  db = openDb(':memory:');
  setDb(db);
  ensureEvalSchema(db);
});

function ctx(p: Partial<CodeContext> = {}): CodeContext {
  return { input: 'q', output: 'hello world', expected: null, tools: [], latency_ms: 100, cost_usd: 0.01, errors: [], steps: 3, ...p };
}

test('builtins are seeded idempotently', () => {
  const n1 = (db.prepare('select count(*) n from evaluators where builtin = 1').get() as any).n;
  ensureEvalSchema(openDb(':memory:'));
  const n2 = (db.prepare('select count(*) n from evaluators where builtin = 1').get() as any).n;
  assert.equal(n1, n2);
  assert.ok(n1 >= 15);
  assert.ok(getEvaluator(db, 'task_completion'));
  assert.equal(getEvaluator(db, 'max_steps')!.config.params.max, 25);
});

test('code checks: basic', () => {
  assert.equal(runCodeCheck({ check: 'no_error' }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'no_error' }, ctx({ errors: ['x: boom'] })).label, 'fail');
  assert.equal(runCodeCheck({ check: 'max_steps', params: { max: 2 } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'latency', params: { max_ms: 50 } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'latency', params: {} }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'cost', params: { max_usd: 0.005 } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'json_valid' }, ctx({ output: '{"a":1}' })).label, 'pass');
  assert.equal(runCodeCheck({ check: 'json_valid' }, ctx({ output: '```json\n{"a":1}\n```' })).label, 'pass');
  assert.equal(runCodeCheck({ check: 'json_valid' }, ctx({ output: '{a:1}' })).label, 'fail');
  assert.equal(runCodeCheck({ check: 'json_valid', params: { required_keys: ['b'] } }, ctx({ output: { a: 1 } })).label, 'fail');
  assert.equal(runCodeCheck({ check: 'regex', params: { pattern: 'hel+o' } }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'regex', params: { pattern: '^world', negate: true } }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'contains', params: { values: ['HELLO', 'world'] } }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'contains', params: { values: ['hello', 'mars'] } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'contains', params: { values: ['hello', 'mars'], any: true } }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'contains', params: { value: 'HELLO', case_sensitive: true } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'not_contains', params: { values: ['mars'] } }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'not_contains', params: { value: 'world' } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'tool_called', params: { tool: 'search' } }, ctx({ tools: ['search'] })).label, 'pass');
  assert.equal(runCodeCheck({ check: 'tool_called', params: { tools: ['search', 'write'] } }, ctx({ tools: ['search'] })).label, 'fail');
  assert.equal(runCodeCheck({ check: 'tool_called', params: { tool: 'rm', negate: true } }, ctx({ tools: ['search'] })).label, 'pass');
  assert.equal(runCodeCheck({ check: 'tool_called', params: { tool: 'search', min_count: 2 } }, ctx({ tools: ['search'] })).label, 'fail');
  assert.equal(runCodeCheck({ check: 'output_length', params: { max: 5 } }, ctx()).label, 'fail');
  assert.equal(runCodeCheck({ check: 'output_length', params: { min: 2, max: 2, unit: 'words' } }, ctx()).label, 'pass');
  assert.equal(runCodeCheck({ check: 'regex', params: {} }, ctx()).label, 'skipped');
  assert.throws(() => runCodeCheck({ check: 'nope' }, ctx()));
});

test('trajectory_match modes', () => {
  const exp = ['search', 'read', 'write'];
  assert.ok(matchTrajectory(['search', 'read', 'write'], exp, 'strict'));
  assert.ok(!matchTrajectory(['read', 'search', 'write'], exp, 'strict'));
  assert.ok(matchTrajectory(['read', 'search', 'write'], exp, 'unordered'));
  assert.ok(!matchTrajectory(['read', 'search', 'write', 'write'], exp, 'unordered'));
  assert.ok(matchTrajectory(['search', 'write'], exp, 'subset'));
  assert.ok(!matchTrajectory(['search', 'delete'], exp, 'subset'));
  assert.ok(matchTrajectory(['search', 'read', 'lint', 'write'], exp, 'superset'));
  assert.ok(!matchTrajectory(['search', 'write'], exp, 'superset'));
  assert.ok(matchTrajectory([], [], 'strict'));
  assert.deepEqual(toolNames([{ name: 'a' }, 'b', { tool: 'c' }]), ['a', 'b', 'c']);
  assert.deepEqual(toolNames({ trajectory: ['x'] }), ['x']);
  assert.equal(runCodeCheck({ check: 'trajectory_match', params: { mode: 'subset', expected: exp } }, ctx({ tools: ['read'] })).label, 'pass');
  assert.equal(runCodeCheck({ check: 'trajectory_match', params: { mode: 'strict' } }, ctx({ tools: ['read'], expected_trajectory: ['search'] })).label, 'fail');
  assert.equal(runCodeCheck({ check: 'trajectory_match', params: {} }, ctx()).label, 'skipped');
});

test('code evaluators run against a stored trace', async () => {
  load(agentTrace('t-code', { error: true, tools: ['search', 'search', 'read_file'] }));
  const s1 = await runEvaluator(db, getEvaluator(db, 'no_error')!, { trace_id: 't-code' });
  assert.equal(s1.label, 'fail');
  assert.equal(s1.source, 'code');
  assert.match(s1.reasoning, /timeout/);
  const s2 = await runEvaluator(db, getEvaluator(db, 'max_steps')!, { trace_id: 't-code' });
  assert.equal(s2.label, 'pass');
  const ev = { id: null, name: 'traj', type: 'code' as const, target: 'trace', config: { check: 'trajectory_match', params: { mode: 'strict', expected: ['search', 'search', 'read_file'] } } };
  const o = await evaluate(db, ev, { trace_id: 't-code' });
  assert.equal(o.label, 'pass');
  const stored = db.prepare('select count(*) n from scores where trace_id = ?').get('t-code') as any;
  assert.equal(stored.n, 2);
});

test('render produces a judge-ready trajectory with truncation', () => {
  load(agentTrace('t-render'));
  const r = renderTraceById(db, 't-render');
  assert.equal(r.input, 'Find the capital of France');
  assert.equal(r.output, 'Paris is the capital of France.');
  assert.match(r.trajectory, /1\. \[llm claude-haiku-5-5\] span t-render-llm1/);
  assert.match(r.trajectory, /calls search\(/);
  assert.match(r.trajectory, /\[tool read_file\] span t-render-tool1/);
  assert.match(r.context, /population 68M/);
  assert.deepEqual(r.tools, ['search', 'read_file']);
  const long = 'a'.repeat(1000) + 'b'.repeat(1000);
  const h = headTail(long, 200);
  assert.ok(h.startsWith('aaa') && h.endsWith('bbb') && h.length < 300);
  const steps = Array.from({ length: 200 }, (_, i) => `${i + 1}. step ${'x'.repeat(100)}`);
  const fit = fitSteps(steps, 3000);
  assert.ok(fit.length <= 3200);
  assert.match(fit, /^1\. step/);
  assert.match(fit, /200\. step/);
  assert.match(fit, /steps omitted/);
});

test('judge JSON parsing is robust', () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('Sure.\n```json\n{"reasoning":"ok","label":"pass","score":1}\n```\nDone'), { reasoning: 'ok', label: 'pass', score: 1 });
  assert.deepEqual(extractJson('Reasoning first {"reasoning":"has } brace and \\"quote\\" {","label":"FAIL","score":0} trailing'), { reasoning: 'has } brace and "quote" {', label: 'FAIL', score: 0 });
  assert.equal(extractJson('no json here'), null);
  const v1 = parseVerdict('{"reasoning":"r","label":"FAIL","score":1}');
  assert.equal(v1.label, 'fail');
  assert.equal(v1.score, 0);
  const v2 = parseVerdict('{"reasoning":"r","score":7}', { output: 'score', threshold: 0.8 });
  assert.equal(v2.score, 0.7);
  assert.equal(v2.label, 'fail');
  const v3 = parseVerdict('{"reasoning":"r","label":"step repetition","score":0}', { output: 'label', labels: ['none', 'step_repetition'], passLabels: ['none'] });
  assert.equal(v3.label, 'step_repetition');
  assert.equal(v3.score, 0);
  const v4 = parseVerdict('I looked closely. The answer is wrong.\nVerdict: FAIL');
  assert.equal(v4.label, 'fail');
  const v5 = parseVerdict('{"reasoning":"r","label":"yes"}');
  assert.equal(v5.label, 'pass');
  assert.equal(v5.score, 1);
  assert.throws(() => parseVerdict('nothing useful'));
  assert.equal(fillTemplate('a {{input}} b {{ output }} c {{expected}}', { input: 'X', output: 'Y' }), 'a X b Y c (none)');
});

test('judge env strips telemetry and claude cli flags disable tools', () => {
  const env = judgeEnv({ PATH: '/bin', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318', ANTHROPIC_BASE_URL: 'http://localhost:7778', CLAUDE_CODE_ENABLE_TELEMETRY: '1', CLAUDE_CODE_SESSION_ID: 'x', HOME: '/h' });
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  assert.equal(env.CLAUDE_CODE_SESSION_ID, undefined);
  assert.equal(env.CLAUDE_CODE_ENABLE_TELEMETRY, '0');
  assert.equal(env.HOME, '/h');
  const args = cliArgs('haiku', 'sys');
  assert.deepEqual(args.slice(0, 5), ['-p', '--output-format', 'json', '--model', 'haiku']);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--system-prompt') + 1], 'sys');
});

test('llm judge with mock provider stores a judge score', async () => {
  load(agentTrace('t-judge-pass'));
  load(agentTrace('t-judge-fail', { fail: true }));
  const ev = getEvaluator(db, 'task_completion')!;
  const p = buildJudgePrompt(ev, { input: 'goal', output: 'answer', trajectory: '1. step' });
  assert.match(p.prompt, /^\[blackbox-judge\]/);
  assert.match(p.prompt, /"reasoning"/);
  assert.ok(!/\u2014/.test(p.prompt + p.system));
  const a = await runEvaluator(db, ev, { trace_id: 't-judge-pass' });
  const b = await runEvaluator(db, ev, { trace_id: 't-judge-fail' });
  assert.equal(a.label, 'pass');
  assert.equal(a.value, 1);
  assert.equal(a.source, 'judge');
  assert.equal(a.judge_model, 'mock');
  assert.equal(b.label, 'fail');
  const tr = await runEvaluator(db, getEvaluator(db, 'trajectory_review')!, { trace_id: 't-judge-fail' });
  assert.equal(tr.value, 0);
  const faith = await runEvaluator(db, getEvaluator(db, 'faithfulness')!, { trace_id: 't-judge-pass' });
  assert.equal(faith.label, 'pass');
});

test('no em dashes in any built-in prompt', async () => {
  const { TEMPLATES, JUDGE_SYSTEM } = await import('../src/evals/builtin.ts');
  const { EXPLAIN_SYSTEM, explainPrompt } = await import('../src/evals/explain.ts');
  const all = JUDGE_SYSTEM + EXPLAIN_SYSTEM + explainPrompt('x', []) + Object.values(TEMPLATES).map((t) => t.prompt + t.description).join('');
  assert.ok(!all.includes('\u2014'));
});

test('online rules: filter, deterministic sampling and dedupe', async () => {
  const ids = Array.from({ length: 120 }, (_, i) => `t-samp-${i}`);
  for (const id of ids) ingestSpanRows(agentTrace(id, { tools: ['search'] }));
  ingestSpanRows(agentTrace('t-samp-err', { error: true, tools: ['search'] }));
  ingestSpanRows([span({ span_id: 'jt-1', trace_id: 'jt', name: 'chat', kind: 'llm', input: JSON.stringify([{ role: 'user', content: '[blackbox-judge] evaluator: x' }]) })]);
  flush(db);
  const ev = getEvaluator(db, 'no_error')!;
  db.prepare(`insert into eval_rules(id, name, evaluator_id, target, filter, sampling, delay_ms, enabled, created_at) values('rl-half','half',?,'trace','{"agent":"helper"}',0.5,0,1,?)`).run(ev.id, nowMs());
  db.prepare(`insert into eval_rules(id, name, evaluator_id, target, filter, sampling, delay_ms, enabled, created_at) values('rl-err','errors',?,'trace','{"status":"error"}',1,60000,1,?)`).run(ev.id, nowMs());
  db.prepare(`insert into eval_rules(id, name, evaluator_id, target, filter, sampling, delay_ms, enabled, created_at) values('rl-all','all',?,'trace','{}',1,60000,1,?)`).run(ev.id, nowMs());
  db.prepare(`insert into eval_rules(id, name, evaluator_id, target, filter, sampling, delay_ms, enabled, created_at) values('rl-llm','llm spans',?,'llm','{"status":"error","name_contains":"AGENT"}',1,0,1,?)`).run(ev.id, nowMs());
  db.prepare(`insert into eval_rules(id, name, evaluator_id, target, filter, sampling, delay_ms, enabled, created_at) values('rl-off','off',?,'trace','{}',1,0,0,?)`).run(ev.id, nowMs());
  const all = [...ids, 't-samp-err', 'jt'];
  const n1 = enqueueForTraces(db, all);
  const expectedHalf = [...ids, 't-samp-err'].filter((id) => hashFraction(id) < 0.5).length;
  const half = (db.prepare(`select count(*) n from eval_jobs where rule_id = 'rl-half'`).get() as any).n;
  assert.equal(half, expectedHalf);
  assert.ok(half > 30 && half < 90);
  const errJobs = db.prepare(`select * from eval_jobs where rule_id = 'rl-err'`).all() as any[];
  assert.equal(errJobs.length, 1);
  assert.equal(errJobs[0].trace_id, 't-samp-err');
  assert.ok(errJobs[0].run_after >= nowMs() + 50000);
  assert.equal(errJobs[0].id, jobId('rl-err', 't-samp-err', null));
  const llmJobs = db.prepare(`select * from eval_jobs where rule_id = 'rl-llm'`).all() as any[];
  assert.equal(llmJobs.length, 2);
  assert.ok(llmJobs.every((j) => j.span_id && j.trace_id === 't-samp-err'));
  assert.equal((db.prepare(`select count(*) n from eval_jobs where rule_id = 'rl-all'`).get() as any).n, ids.length + 1);
  assert.equal((db.prepare(`select count(*) n from eval_jobs where trace_id = 'jt'`).get() as any).n, 0);
  assert.equal((db.prepare(`select count(*) n from eval_jobs where rule_id = 'rl-off'`).get() as any).n, 0);
  const n2 = enqueueForTraces(db, all);
  assert.ok(n1 > 0);
  assert.equal(n2, 0);
  await drain(db);
  const counts = jobCounts(db);
  assert.equal(counts.done, expectedHalf + 2);
  assert.equal(counts.queued, ids.length + 2);
  const scored = (db.prepare(`select count(*) n from scores where rule_id = 'rl-half'`).get() as any).n;
  assert.equal(scored, expectedHalf);
  db.prepare('delete from eval_rules').run();
});

test('calibration math and kappa', () => {
  const pairs = [
    ...Array(20).fill({ judge: true, human: true }),
    ...Array(5).fill({ judge: true, human: false }),
    ...Array(10).fill({ judge: false, human: true }),
    ...Array(15).fill({ judge: false, human: false }),
  ];
  const c = confusion(pairs);
  assert.equal(c.n, 50);
  assert.equal(c.tp, 20);
  assert.equal(c.fn, 10);
  assert.ok(Math.abs(c.kappa! - 0.4) < 1e-9);
  assert.ok(Math.abs(c.tpr! - 20 / 30) < 1e-9);
  assert.ok(Math.abs(c.tnr! - 15 / 20) < 1e-9);
  assert.ok(Math.abs(c.precision! - 0.8) < 1e-9);
  assert.ok(Math.abs(c.accuracy! - 0.7) < 1e-9);
  const perfect = confusion([{ judge: true, human: true }, { judge: true, human: true }]);
  assert.equal(perfect.kappa, 1);
  assert.equal(perfect.tnr, null);
});

test('calibration against annotations and human scores', async () => {
  const ev = getEvaluator(db, 'answer_relevance')!;
  for (const [id, fail] of [['t-cal-1', false], ['t-cal-2', true], ['t-cal-3', false], ['t-cal-4', true]] as const) {
    load(agentTrace(id, { fail }));
    await runEvaluator(db, ev, { trace_id: id });
  }
  assert.equal(addToQueue(db, ['t-cal-1', 't-cal-2', 't-cal-3'], 'review'), 3);
  assert.equal(addToQueue(db, ['t-cal-1'], 'review'), 0);
  const pending = listAnnotations(db, 'review', 'pending');
  assert.equal(pending.length, 3);
  assert.equal(pending[0].name, 'agent run');
  const byTrace = new Map(pending.map((a) => [a.trace_id, a.id]));
  labelAnnotation(db, byTrace.get('t-cal-1'), { label: 'pass' });
  labelAnnotation(db, byTrace.get('t-cal-2'), { label: 'pass', comment: 'judge is too strict' });
  labelAnnotation(db, byTrace.get('t-cal-3'), { label: 'fail', failure_mode: 'premature_termination' });
  labelAnnotation(db, byTrace.get('t-cal-3'), { label: 'fail', failure_mode: 'premature_termination' });
  db.prepare(`insert into scores(id, trace_id, name, value, label, source, created_at) values('hs4','t-cal-4','human',0,'fail','human',?)`).run(nowMs());
  const humanScores = db.prepare(`select * from scores where source = 'human' and name = 'human'`).all() as any[];
  assert.equal(humanScores.length, 4);
  const cal = calibrate(db, ev.id!);
  assert.equal(cal.n, 4);
  assert.equal(cal.tp, 1);
  assert.equal(cal.fn, 1);
  assert.equal(cal.fp, 1);
  assert.equal(cal.tn, 1);
  assert.equal(cal.kappa, 0);
  assert.equal(cal.disagreements.length, 2);
  const q = listQueues(db).find((x) => x.queue === 'review')!;
  assert.equal(q.done, 3);
  assert.equal(q.pending, 0);
  assert.throws(() => labelAnnotation(db, byTrace.get('t-cal-1'), { label: 'maybe' }));
});

test('datasets from traces and jsonl', () => {
  load(agentTrace('t-ds-1', { tools: ['search', 'read_file'] }));
  const ds = createDataset(db, 'from-traces');
  assert.equal(addFromTraces(db, ds.id, ['t-ds-1', 'missing']), 1);
  const items = datasetItems(db, ds.id);
  assert.equal(items[0].input, 'Find the capital of France');
  assert.equal(items[0].expected, 'Paris is the capital of France.');
  assert.equal(items[0].metadata.source_trace_id, 't-ds-1');
  assert.deepEqual(items[0].metadata.expected_trajectory, ['search', 'read_file']);
  const parsed = parseJsonl('{"input":{"q":1},"expected":"a"}\n\n{"q":2}\nplain text');
  assert.equal(parsed.length, 3);
  assert.deepEqual(parsed[1].input, { q: 2 });
  assert.equal(parsed[2].input, 'plain text');
  assert.throws(() => createDataset(db, 'from-traces'));
});

test('experiments run a command target and compare against a baseline', async () => {
  const ds = createDataset(db, 'echo-set');
  addItems(db, ds.id, [
    { input: { text: 'alpha' }, expected: 'alpha' },
    { input: { text: 'beta' }, expected: 'beta' },
    { input: { text: 'gamma' }, expected: 'gamma' },
  ]);
  db.prepare(`insert into evaluators(id, name, type, description, target, config, builtin, created_at, updated_at) values('ev-x','has_alpha','code',null,'trace',?,0,?,?)`).run(JSON.stringify({ check: 'contains', params: { value: 'alpha' } }), nowMs(), nowMs());
  db.prepare(`insert into evaluators(id, name, type, description, target, config, builtin, created_at, updated_at) values('ev-y','short','code',null,'trace',?,0,?,?)`).run(JSON.stringify({ check: 'output_length', params: { max: 20 } }), nowMs(), nowMs());
  const a = createExperiment(db, { dataset_id: ds.id, name: 'baseline', target: { type: 'command', command: 'cat' }, evaluator_ids: ['ev-x', 'short', 'json_valid'] });
  const doneA = await runExperiment(db, a.id);
  assert.equal(doneA.status, 'done');
  assert.equal(doneA.summary.runs, 3);
  assert.equal(doneA.summary.scores.has_alpha.pass_rate, 1 / 3);
  const cmd = `node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const i=JSON.parse(s);if(i.text==='gamma')process.exit(3);const o=i.text==='beta'?{text:'beta alpha'}:{text:i.text+' padded with lots of extra words'};console.log(JSON.stringify(o))})"`;
  const b = createExperiment(db, { dataset_id: ds.id, name: 'candidate', target: { type: 'command', command: cmd }, evaluator_ids: ['ev-x', 'ev-y'], baseline_id: a.id });
  const doneB = await runExperiment(db, b.id);
  assert.equal(doneB.summary.errors, 1);
  const cmp = compareExperiments(db, b.id, null);
  const byText = new Map<string, any>(cmp.rows.map((r: any) => [r.input.text, r]));
  assert.equal(byText.get('alpha').verdict, 'regressed');
  assert.equal(byText.get('beta').verdict, 'tradeoff');
  assert.equal(byText.get('gamma').verdict, 'regressed');
  assert.equal(cmp.summary.has_alpha.a_avg, 1 / 3);
  assert.equal(cmp.summary.has_alpha.improved, 1);
  assert.equal(verdictFor({ scores: [{ name: 'x', value: 0 }] }, { scores: [{ name: 'x', value: 1 }] }), 'improved');
  assert.equal(verdictFor({ scores: [{ name: 'x', value: 1 }] }, { scores: [{ name: 'x', value: 1 }] }), 'tie');
  assert.equal(verdictFor({ error: 'boom', scores: [] }, { scores: [] }), 'improved');
});

test('experiments with llm target and llm judge (mock)', async () => {
  const ds = createDataset(db, 'llm-set');
  addItems(db, ds.id, [{ input: 'say hi', expected: 'hi' }, { input: 'MOCK_FAIL please', expected: 'x' }]);
  const exp = createExperiment(db, { dataset_id: ds.id, name: 'llm', target: { type: 'llm', system: 'be brief' }, evaluator_ids: ['task_completion'] });
  const done = await runExperiment(db, exp.id);
  assert.equal(done.status, 'done');
  assert.equal(done.summary.scores.task_completion.n, 2);
  assert.equal(done.summary.scores.task_completion.pass_rate, 0.5);
});

test('explain stores and serves a root cause analysis', async () => {
  load(agentTrace('t-explain', { fail: true, error: true }));
  const e = await explainTrace(db, 't-explain');
  assert.equal(e.outcome, 'failure');
  assert.equal(e.failure_modes.length, 1);
  assert.equal(e.judge_model, 'mock');
  const got = getExplanation(db, 't-explain');
  assert.equal(got?.summary, e.summary);
  assert.equal(getExplanation(db, 'nope'), null);
});

test('budget cap fails judge jobs with a clear error', async () => {
  load(agentTrace('t-budget'));
  db.prepare(`insert into scores(id, trace_id, name, value, source, cost_usd, created_at) values('spent','t-budget','x',1,'judge',5,?)`).run(nowMs());
  await assert.rejects(runEvaluator(db, getEvaluator(db, 'task_completion')!, { trace_id: 't-budget' }), /daily spend cap/);
  const code = await runEvaluator(db, getEvaluator(db, 'no_error')!, { trace_id: 't-budget' });
  assert.equal(code.label, 'pass');
  db.prepare(`delete from scores where id = 'spent'`).run();
  assert.equal(builtinId('x').length, 19);
});
