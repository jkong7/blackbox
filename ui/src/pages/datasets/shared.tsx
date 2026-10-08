import type { ExperimentTarget, Score } from '../../api.ts';
import { oneLine } from '../../format.ts';

export interface ExperimentSummary {
  runs?: number;
  errors?: number;
  avg_latency_ms?: number | null;
  target_cost_usd?: number | null;
  judge_cost_usd?: number | null;
  scores?: Record<string, { n: number; avg: number | null; pass_rate: number | null }>;
  total?: number;
  done?: number;
}

export interface ExperimentRow {
  id: string;
  dataset_id: string;
  name: string;
  target: ExperimentTarget | string | null;
  evaluator_ids: string[] | string | null;
  baseline_id: string | null;
  status: string;
  summary: ExperimentSummary | null;
  created_at: number;
  finished_at: number | null;
  error?: string | null;
}

export interface RunRow {
  id: string;
  item_id: string;
  input: unknown;
  expected: unknown;
  output: unknown;
  trace_id?: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  error: string | null;
  scores: Score[];
}

export interface CompareSide {
  run_id: string;
  output: unknown;
  error: string | null;
  latency_ms: number | null;
  cost_usd: number | null;
  trace_id: string | null;
  scores: Record<string, number | null>;
}

export type Verdict = 'improved' | 'regressed' | 'tie' | 'tradeoff';

export interface CompareResult {
  baseline?: { id: string; name: string };
  experiment?: { id: string; name: string };
  rows: { item_id: string; input: unknown; expected: unknown; a: CompareSide | null; b: CompareSide | null; verdict: Verdict }[];
  summary: Record<string, { a_avg: number | null; b_avg: number | null; improved: number; regressed: number; ties: number }>;
  verdicts?: Record<Verdict, number>;
}

export function unwrap(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || t.startsWith('{') || t.startsWith('['))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

export function asText(v: unknown, max = 200): string {
  const u = unwrap(v);
  if (u == null) return '';
  if (typeof u === 'string') return oneLine(u, max);
  if (u && typeof u === 'object' && !Array.isArray(u)) {
    const o = u as Record<string, unknown>;
    for (const k of ['question', 'input', 'prompt', 'query', 'message', 'text', 'content']) {
      if (typeof o[k] === 'string') return oneLine(o[k], max);
    }
  }
  return oneLine(u, max);
}

export function targetText(t: ExperimentTarget | string | null | undefined): string {
  if (!t) return '-';
  let v: unknown = t;
  if (typeof t === 'string') {
    try {
      v = JSON.parse(t);
    } catch {
      return t;
    }
  }
  const o = v as ExperimentTarget;
  if (o.type === 'command') return o.command;
  if (o.type === 'http') return o.url;
  if (o.type === 'llm') return o.model ? `llm ${o.model}` : 'llm (default judge model)';
  return '-';
}

export function targetType(t: ExperimentTarget | string | null | undefined): string {
  if (!t) return '';
  if (typeof t === 'string') {
    try {
      return (JSON.parse(t) as ExperimentTarget).type;
    } catch {
      return '';
    }
  }
  return t.type;
}

export function evaluatorIds(v: string[] | string | null | undefined): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v;
  try {
    const p = JSON.parse(v);
    return Array.isArray(p) ? p : [];
  } catch {
    return [];
  }
}

export function StatusChip({ status }: { status: string }) {
  const cls = status === 'done' ? 'good' : status === 'failed' ? 'bad' : status === 'running' ? 'accent' : 'neutral';
  const label = status === 'done' ? 'Done' : status === 'failed' ? 'Failed' : status === 'running' ? 'Running' : status === 'pending' ? 'Pending' : status;
  return (
    <span className={'chip ' + cls}>
      <span className="dot" style={{ background: 'currentColor' }} />
      {label}
    </span>
  );
}

export const VERDICT_CLASS: Record<Verdict, string> = { improved: 'good', regressed: 'bad', tie: 'neutral', tradeoff: 'warn' };
export const VERDICT_LABEL: Record<Verdict, string> = { improved: 'Improved', regressed: 'Regressed', tie: 'Tie', tradeoff: 'Tradeoff' };

export function VerdictChip({ v }: { v: Verdict }) {
  return <span className={'chip ' + VERDICT_CLASS[v]}>{VERDICT_LABEL[v]}</span>;
}

export function fmtScore(v: number | null | undefined): string {
  if (v == null) return '-';
  return v.toFixed(2);
}

export function fmtDelta(a: number | null | undefined, b: number | null | undefined): string {
  if (a == null || b == null) return '';
  const d = b - a;
  if (Math.abs(d) < 1e-9) return '±0';
  return (d > 0 ? '+' : '') + d.toFixed(2);
}

export function parseItemsText(text: string): { items: { input: unknown; expected?: unknown; metadata?: unknown }[] } | { jsonl: string } | { error: string } {
  const t = text.trim();
  if (!t) return { error: 'Paste at least one item.' };
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (!Array.isArray(arr)) return { error: 'Expected a JSON array.' };
      return {
        items: arr.map((x) => (x && typeof x === 'object' && !Array.isArray(x) && 'input' in x ? x : { input: x })),
      };
    } catch (e) {
      return { error: 'Invalid JSON: ' + (e instanceof Error ? e.message : String(e)) };
    }
  }
  return { jsonl: t };
}
