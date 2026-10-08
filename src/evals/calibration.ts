import type { DB } from '../db.ts';
import { isPassLabel } from './judge.ts';

type Row = Record<string, any>;

export interface Pair {
  trace_id: string;
  judge: boolean;
  human: boolean;
  judge_label: string | null;
  human_label: string | null;
  reasoning: string | null;
}

export interface Calibration {
  n: number;
  tp: number;
  fp: number;
  tn: number;
  fn: number;
  tpr: number | null;
  tnr: number | null;
  precision: number | null;
  accuracy: number | null;
  kappa: number | null;
  disagreements: { trace_id: string; judge_label: string | null; human_label: string | null; reasoning: string | null }[];
}

export function toPass(label: string | null | undefined, value: number | null | undefined): boolean | null {
  if (value != null && Number.isFinite(value)) return value >= 0.5;
  return isPassLabel(label ?? null);
}

function ratio(a: number, b: number): number | null {
  return b ? a / b : null;
}

export function confusion(pairs: { judge: boolean; human: boolean }[]): Omit<Calibration, 'disagreements'> {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const p of pairs) {
    if (p.judge && p.human) tp++;
    else if (p.judge && !p.human) fp++;
    else if (!p.judge && !p.human) tn++;
    else fn++;
  }
  const n = tp + fp + tn + fn;
  const po = n ? (tp + tn) / n : 0;
  const pe = n ? ((tp + fp) * (tp + fn) + (fn + tn) * (fp + tn)) / (n * n) : 0;
  const kappa = !n ? null : pe === 1 ? (po === 1 ? 1 : null) : (po - pe) / (1 - pe);
  return {
    n,
    tp,
    fp,
    tn,
    fn,
    tpr: ratio(tp, tp + fn),
    tnr: ratio(tn, tn + fp),
    precision: ratio(tp, tp + fp),
    accuracy: ratio(tp + tn, n),
    kappa,
  };
}

export function humanLabels(db: DB): Map<string, { pass: boolean; label: string | null; at: number }> {
  const out = new Map<string, { pass: boolean; label: string | null; at: number }>();
  const put = (trace: string, label: string | null, value: number | null, at: number) => {
    const pass = toPass(label, value);
    if (pass == null) return;
    const prev = out.get(trace);
    if (!prev || at >= prev.at) out.set(trace, { pass, label, at });
  };
  for (const a of db.prepare(`select trace_id, label, value, labeled_at from annotations where status = 'done' and label is not null`).all() as Row[]) {
    put(a.trace_id, a.label, a.value, a.labeled_at ?? 0);
  }
  for (const s of db.prepare(`select trace_id, label, value, created_at from scores where source = 'human' and trace_id is not null`).all() as Row[]) {
    put(s.trace_id, s.label, s.value, s.created_at);
  }
  return out;
}

export function pairsFor(db: DB, evaluatorId: string): Pair[] {
  const humans = humanLabels(db);
  const rows = db
    .prepare(`select trace_id, label, value, reasoning, created_at from scores where evaluator_id = ? and source in ('judge','code') and trace_id is not null and span_id is null and run_id is null order by created_at`)
    .all(evaluatorId) as Row[];
  const latest = new Map<string, Row>();
  for (const r of rows) latest.set(r.trace_id, r);
  const pairs: Pair[] = [];
  for (const [trace, r] of latest) {
    const h = humans.get(trace);
    const j = toPass(r.label, r.value);
    if (!h || j == null) continue;
    pairs.push({ trace_id: trace, judge: j, human: h.pass, judge_label: r.label, human_label: h.label, reasoning: r.reasoning });
  }
  return pairs;
}

export function calibrate(db: DB, evaluatorId: string): Calibration {
  const pairs = pairsFor(db, evaluatorId);
  const c = confusion(pairs);
  const disagreements = pairs
    .filter((p) => p.judge !== p.human)
    .map((p) => ({ trace_id: p.trace_id, judge_label: p.judge_label, human_label: p.human_label, reasoning: p.reasoning }));
  return { ...c, disagreements };
}
