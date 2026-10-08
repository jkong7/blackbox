import type { CodeCheck, Evaluator, Rule, Score } from '../../api.ts';

export type EvalConfig = Evaluator['config'] & { pass_labels?: string[]; threshold?: number };

export type EvaluatorRow = Omit<Evaluator, 'config'> & { config: EvalConfig };

export interface JudgeStatusRow {
  provider: 'anthropic' | 'claude-cli' | 'mock' | 'none' | string;
  model: string | null;
  spend_today_usd: number;
  daily_cap_usd: number | null;
  concurrency?: number;
  active?: number;
  queued?: number;
}

export interface JobCounts {
  queued: number;
  running: number;
  done: number;
  failed: number;
  skipped?: number;
}

export interface JobRow {
  id: string;
  status: string;
  evaluator_id: string;
  evaluator_name?: string | null;
  trace_id: string | null;
  error: string | null;
  created_at: number;
  finished_at: number | null;
}

export type RuleRow = Rule & { enabled: boolean | number };

export type ScoreRow = Score;

export const VARIABLES: { name: string; hint: string }[] = [
  { name: 'input', hint: 'the user request or first input' },
  { name: 'output', hint: 'the final answer or span output' },
  { name: 'trajectory', hint: 'numbered LLM and tool steps' },
  { name: 'context', hint: 'tool results and retrieved documents' },
  { name: 'expected', hint: 'reference answer from a dataset item' },
  { name: 'conversation', hint: 'all turns of a session' },
];

export const CHECKS: { id: CodeCheck; label: string; hint: string }[] = [
  { id: 'no_error', label: 'No error', hint: 'No span in the run ended in error.' },
  { id: 'regex', label: 'Regex', hint: 'Pattern must match the chosen field.' },
  { id: 'contains', label: 'Contains', hint: 'Field contains all (or any) of the values.' },
  { id: 'not_contains', label: 'Does not contain', hint: 'None of the values appear in the field.' },
  { id: 'json_valid', label: 'Valid JSON', hint: 'Output parses as JSON, optionally with required keys.' },
  { id: 'latency', label: 'Latency', hint: 'Run finishes under a time limit.' },
  { id: 'cost', label: 'Cost', hint: 'Run costs under a USD limit.' },
  { id: 'max_steps', label: 'Max steps', hint: 'At most N LLM and tool steps.' },
  { id: 'tool_called', label: 'Tool called', hint: 'Specific tools were (or were not) called.' },
  { id: 'trajectory_match', label: 'Trajectory match', hint: 'Tool sequence matches an expected list.' },
  { id: 'output_length', label: 'Output length', hint: 'Output length within bounds.' },
];

export function isPass(s: { value: number | null; label: string | null }): boolean | null {
  const l = s.label?.toLowerCase();
  if (l && ['pass', 'yes', 'true', 'correct', 'good'].includes(l)) return true;
  if (l && ['fail', 'no', 'false', 'incorrect', 'bad'].includes(l)) return false;
  if (s.value == null) return null;
  return s.value >= 0.5;
}

export function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
