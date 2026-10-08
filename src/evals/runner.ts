import type { DB } from '../db.ts';
import { HttpError } from '../http.ts';
import { emit } from '../bus.ts';
import { parseSpan } from '../api.ts';
import { maybeJson, newId, nowMs, safeJson } from '../util.ts';
import { JUDGE_SYSTEM, TEMPLATES, runCodeCheck, type CodeContext } from './builtin.ts';
import { JUDGE_MARKER, complete, fillTemplate, outputInstructions, parseVerdict, type VerdictOptions } from './judge.ts';
import { asText, loadSpans, renderLlmSpan, renderSession, renderToolSpan, renderTrace, type RenderedTrace } from './render.ts';

type Row = Record<string, any>;

export interface EvalTarget {
  trace_id?: string | null;
  span_id?: string | null;
  session_id?: string | null;
  experiment_id?: string | null;
  run_id?: string | null;
  rule_id?: string | null;
}

export interface Evaluator {
  id: string | null;
  name: string;
  type: 'llm_judge' | 'code';
  target: string;
  config: Row;
  description?: string | null;
}

export interface Outcome {
  value: number | null;
  label: string | null;
  reasoning: string | null;
  source: 'judge' | 'code';
  judge_model: string | null;
  cost_usd: number | null;
}

interface Material {
  vars: Record<string, string>;
  code: CodeContext;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
}

export function parseEvaluator(r: Row): Evaluator {
  return { ...r, config: typeof r.config === 'string' ? (safeJson(r.config) as Row) ?? {} : r.config ?? {} } as Evaluator;
}

export function getEvaluator(db: DB, idOrName: string): Evaluator | null {
  const r = db.prepare('select * from evaluators where id = ? or name = ?').get(idOrName, idOrName) as Row | undefined;
  return r ? parseEvaluator(r) : null;
}

function fromRendered(r: RenderedTrace, extra: Partial<CodeContext> = {}): Pick<Material, 'vars' | 'code'> {
  return {
    vars: { input: r.input, output: r.output, trajectory: r.trajectory, context: r.context, expected: '', conversation: '' },
    code: { input: r.input, output: r.output, expected: null, tools: r.tools, latency_ms: null, cost_usd: null, errors: r.errors, steps: r.steps, ...extra },
  };
}

function runMaterial(db: DB, runId: string): Material {
  const run = db.prepare('select * from experiment_runs where id = ?').get(runId) as Row | undefined;
  if (!run) throw new HttpError(404, 'experiment run not found');
  const item = (db.prepare('select * from dataset_items where id = ?').get(run.item_id) as Row | undefined) ?? {};
  const input = safeJson(item.input);
  const expected = safeJson(item.expected);
  const metadata = (safeJson(item.metadata) as Row) ?? {};
  const output = safeJson(run.output);
  const spans = run.trace_id ? loadSpans(db, run.trace_id) : [];
  const rendered = spans.length ? renderTrace(spans) : null;
  const outObj = output && typeof output === 'object' ? (output as Row) : null;
  const tools = rendered?.tools.length ? rendered.tools : toolsFromOutput(outObj);
  const expectedTrajectory = metadata.expected_trajectory ?? (expected && typeof expected === 'object' ? (expected as Row).trajectory ?? (expected as Row).expected_trajectory : null);
  return {
    vars: {
      input: asText(input),
      output: asText(output),
      expected: asText(expected),
      trajectory: rendered?.trajectory ?? '',
      context: rendered?.context ?? '',
      conversation: '',
    },
    code: {
      input,
      output,
      expected,
      tools,
      latency_ms: run.latency_ms ?? null,
      cost_usd: run.cost_usd ?? null,
      errors: run.error ? [String(run.error)] : rendered?.errors ?? [],
      steps: rendered ? rendered.steps : tools.length,
      expected_trajectory: expectedTrajectory,
    },
    trace_id: run.trace_id ?? null,
    span_id: null,
    session_id: null,
  };
}

function toolsFromOutput(o: Row | null): string[] {
  if (!o) return [];
  const arr = o.trajectory ?? o.tools ?? o.tool_calls;
  if (!Array.isArray(arr)) return [];
  return arr.map((x: any) => (typeof x === 'string' ? x : x?.name ?? x?.tool ?? x?.function?.name)).filter(Boolean);
}

function sessionMaterial(db: DB, sessionId: string): Material {
  const s = db.prepare('select * from sessions where session_id = ?').get(sessionId) as Row | undefined;
  if (!s) throw new HttpError(404, 'session not found');
  const r = renderSession(db, sessionId);
  return {
    vars: { input: r.input, output: r.output, trajectory: '', context: '', expected: '', conversation: r.conversation },
    code: {
      input: r.input,
      output: r.output,
      expected: null,
      tools: r.tools,
      latency_ms: s.end_ns && s.start_ns ? (s.end_ns - s.start_ns) / 1e6 : null,
      cost_usd: s.cost_usd ?? null,
      errors: r.errors,
      steps: (s.llm_calls ?? 0) + (s.tool_calls ?? 0),
    },
    trace_id: null,
    span_id: null,
    session_id: sessionId,
  };
}

function spanMaterial(db: DB, spanId: string): Material {
  const raw = db.prepare('select * from spans where span_id = ?').get(spanId) as Row | undefined;
  if (!raw) throw new HttpError(404, 'span not found');
  const span = parseSpan(raw);
  const r = span.kind === 'llm' ? renderLlmSpan(span) : renderToolSpan(span);
  const base = fromRendered(r, { latency_ms: span.duration_ms ?? null, cost_usd: span.cost_usd ?? null });
  if (span.kind !== 'llm') base.code.output = span.output;
  return { ...base, trace_id: span.trace_id, span_id: spanId, session_id: span.session_id ?? null };
}

function traceMaterial(db: DB, traceId: string): Material {
  const t = db.prepare('select * from traces where trace_id = ?').get(traceId) as Row | undefined;
  const spans = loadSpans(db, traceId);
  if (!t && !spans.length) throw new HttpError(404, 'trace not found');
  const r = renderTrace(spans);
  const base = fromRendered(r, { latency_ms: t?.duration_ms ?? null, cost_usd: t?.cost_usd ?? null });
  base.code.output = maybeJson(r.output);
  return { ...base, trace_id: traceId, span_id: null, session_id: t?.session_id ?? null };
}

export function materialFor(db: DB, ev: Evaluator, target: EvalTarget): Material {
  if (target.run_id) return runMaterial(db, target.run_id);
  if (target.span_id) return spanMaterial(db, target.span_id);
  if (ev.target === 'session' || (target.session_id && !target.trace_id)) {
    let sid = target.session_id ?? null;
    if (!sid && target.trace_id) sid = (db.prepare('select session_id from traces where trace_id = ?').get(target.trace_id) as Row | undefined)?.session_id ?? null;
    if (!sid) throw new HttpError(400, `evaluator ${ev.name} targets sessions but the trace has no session`);
    return sessionMaterial(db, sid);
  }
  if (!target.trace_id) throw new HttpError(400, 'trace_id, span_id, session_id or run_id required');
  return traceMaterial(db, target.trace_id);
}

export function judgeSpec(ev: Evaluator): { prompt: string; opts: VerdictOptions; model: string | null } {
  const cfg = ev.config ?? {};
  const tpl = cfg.template ? TEMPLATES[cfg.template] : null;
  const prompt = cfg.prompt ?? tpl?.prompt;
  if (!prompt) throw new Error(`evaluator ${ev.name} has no prompt or known template`);
  return {
    prompt,
    opts: {
      output: cfg.output ?? tpl?.output ?? 'binary',
      labels: cfg.labels ?? tpl?.labels,
      passLabels: cfg.pass_labels ?? tpl?.pass_labels,
      threshold: cfg.threshold ?? tpl?.threshold ?? 0.5,
    },
    model: cfg.model ?? null,
  };
}

export function buildJudgePrompt(ev: Evaluator, vars: Record<string, string>): { system: string; prompt: string; opts: VerdictOptions; model: string | null } {
  const spec = judgeSpec(ev);
  const body = fillTemplate(spec.prompt, vars);
  const prompt = `${JUDGE_MARKER} evaluator: ${ev.name}\n\n${body}\n\n${outputInstructions(spec.opts)}`;
  return { system: JUDGE_SYSTEM, prompt, opts: spec.opts, model: spec.model };
}

export async function judgeOutcome(db: DB, ev: Evaluator, vars: Record<string, string>): Promise<Outcome> {
  const p = buildJudgePrompt(ev, vars);
  const res = await complete({ system: p.system, prompt: p.prompt, model: p.model, json: true, maxTokens: 2048 }, db);
  const v = parseVerdict(res.text, p.opts);
  return { value: v.score, label: v.label, reasoning: v.reasoning, source: 'judge', judge_model: res.model, cost_usd: res.cost_usd };
}

export async function evaluate(db: DB, ev: Evaluator, target: EvalTarget): Promise<Outcome & { material: Material }> {
  const m = materialFor(db, ev, target);
  if (ev.type === 'code') {
    const r = runCodeCheck(ev.config, m.code);
    return { value: r.value, label: r.label, reasoning: r.reasoning, source: 'code', judge_model: null, cost_usd: null, material: m };
  }
  if (ev.type !== 'llm_judge') throw new Error(`unknown evaluator type ${ev.type}`);
  const o = await judgeOutcome(db, ev, m.vars);
  return { ...o, material: m };
}

export function insertScore(db: DB, s: Row): Row {
  const row = {
    id: s.id ?? newId('sc_'),
    trace_id: s.trace_id ?? null,
    span_id: s.span_id ?? null,
    session_id: s.session_id ?? null,
    name: String(s.name),
    value: s.value ?? null,
    label: s.label ?? null,
    reasoning: s.reasoning ?? null,
    source: s.source ?? 'sdk',
    evaluator_id: s.evaluator_id ?? null,
    rule_id: s.rule_id ?? null,
    experiment_id: s.experiment_id ?? null,
    run_id: s.run_id ?? null,
    judge_model: s.judge_model ?? null,
    cost_usd: s.cost_usd ?? null,
    author: s.author ?? null,
    created_at: s.created_at ?? nowMs(),
  };
  db.prepare(
    `insert into scores(id, trace_id, span_id, session_id, name, value, label, reasoning, source, evaluator_id, rule_id, experiment_id, run_id, judge_model, cost_usd, author, created_at)
     values(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     on conflict(id) do update set value=excluded.value, label=excluded.label, reasoning=excluded.reasoning, author=excluded.author, created_at=excluded.created_at`,
  ).run(row.id, row.trace_id, row.span_id, row.session_id, row.name, row.value, row.label, row.reasoning, row.source, row.evaluator_id, row.rule_id, row.experiment_id, row.run_id, row.judge_model, row.cost_usd, row.author, row.created_at);
  return row;
}

export async function runEvaluator(db: DB, ev: Evaluator, target: EvalTarget, opts: { emit?: boolean } = {}): Promise<Row> {
  const o = await evaluate(db, ev, target);
  const row = insertScore(db, {
    trace_id: o.material.trace_id ?? target.trace_id ?? null,
    span_id: o.material.span_id,
    session_id: o.material.session_id,
    name: ev.name,
    value: o.value,
    label: o.label,
    reasoning: o.reasoning,
    source: o.source,
    evaluator_id: ev.id,
    rule_id: target.rule_id ?? null,
    experiment_id: target.experiment_id ?? null,
    run_id: target.run_id ?? null,
    judge_model: o.judge_model,
    cost_usd: o.cost_usd,
  });
  if (opts.emit !== false) emit({ type: 'scores', ids: [row.trace_id ?? row.session_id ?? row.run_id ?? row.id] });
  return row;
}
