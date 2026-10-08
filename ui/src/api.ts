export type Kind = 'agent' | 'llm' | 'tool' | 'mcp' | 'memory' | 'retriever' | 'embedding' | 'chain' | 'guardrail' | 'handoff' | 'evaluator' | 'span';

export const KINDS: Kind[] = ['agent', 'llm', 'tool', 'mcp', 'memory', 'retriever', 'embedding', 'chain', 'guardrail', 'handoff', 'evaluator', 'span'];

export type Severity = 'high' | 'medium' | 'low';
export type Window = '1h' | '24h' | '7d' | '30d';

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
}

export interface Message {
  role: string;
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_id: string | null;
  project: string;
  name: string;
  kind: Kind;
  source: string;
  operation: string | null;
  start_ns: number;
  end_ns: number | null;
  duration_ms: number | null;
  status: 'ok' | 'error' | 'unset';
  status_message: string | null;
  session_id: string | null;
  user_id: string | null;
  agent_name: string | null;
  model: string | null;
  provider: string | null;
  tool_name: string | null;
  tool_call_id: string | null;
  mcp_server: string | null;
  mcp_method: string | null;
  memory_op: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  reasoning_tokens: number | null;
  cost_usd: number | null;
  ttft_ms: number | null;
  finish_reason: string | null;
  input: unknown;
  output: unknown;
  input_preview: string | null;
  output_preview: string | null;
  attributes: Record<string, unknown> | null;
  events: unknown;
  resource: Record<string, unknown> | null;
}

export interface SignalBadge {
  type: string;
  severity: Severity;
}

export interface ScoreBadge {
  name: string;
  value: number | null;
  label: string | null;
}

export interface Trace {
  trace_id: string;
  project: string;
  name: string | null;
  root_span_id: string | null;
  session_id: string | null;
  user_id: string | null;
  agent_names: string | null;
  models: string | null;
  sources: string | null;
  start_ns: number;
  end_ns: number | null;
  duration_ms: number | null;
  span_count: number;
  llm_calls: number;
  tool_calls: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  cost_usd: number;
  input_preview: string | null;
  output_preview: string | null;
  tags: string | null;
  signal_count: number;
  signals?: SignalBadge[];
  scores?: ScoreBadge[];
}

export interface Signal {
  id: string;
  trace_id: string;
  span_id: string | null;
  session_id: string | null;
  type: string;
  severity: Severity;
  fingerprint: string;
  title: string;
  detail: unknown;
  created_at: number;
  status: string;
}

export interface Score {
  id: string;
  trace_id: string | null;
  span_id: string | null;
  session_id: string | null;
  name: string;
  value: number | null;
  label: string | null;
  reasoning: string | null;
  source: string;
  evaluator_id: string | null;
  rule_id: string | null;
  experiment_id: string | null;
  run_id: string | null;
  judge_model: string | null;
  cost_usd: number | null;
  author: string | null;
  created_at: number;
}

export interface Annotation {
  id: string;
  trace_id: string;
  queue: string;
  status: 'pending' | 'done';
  label: 'pass' | 'fail' | null;
  comment: string | null;
  failure_mode: string | null;
  created_at?: number;
  [k: string]: unknown;
}

export interface TraceDetail {
  trace: Trace;
  spans: Span[];
  scores: Score[];
  signals: Signal[];
  annotations: Annotation[];
  session_nav: { prev: string | null; next: string | null };
  context_windows: Record<string, number | null>;
}

export interface OverviewTotals {
  traces: number;
  spans: number;
  llm_calls: number;
  tool_calls: number;
  error_traces: number;
  cost_usd: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  sessions: number;
  cache_hit_ratio: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  llm_p50_ms: number | null;
  llm_p95_ms: number | null;
  error_rate: number;
  clean_traces: number;
  cost_per_clean_trace: number | null;
}

export interface SeriesPoint {
  bucket: number;
  traces: number;
  cost_usd: number;
  errors: number;
  tokens: number;
  llm_calls: number;
  signals: number;
}

export interface Issue {
  fingerprint: string;
  type: string;
  severity: Severity;
  title: string;
  count: number;
  traces: number;
  first_seen: number;
  last_seen: number;
  sample_trace_id: string;
  status: string;
}

export interface Overview {
  totals: OverviewTotals;
  series: SeriesPoint[];
  bucket_ms: number;
  models: { model: string; provider: string | null; calls: number; cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; errors: number; avg_ms: number | null }[];
  tools: { tool: string; kind: Kind; mcp_server: string | null; calls: number; errors: number; avg_ms: number | null; max_ms: number | null }[];
  agents: { agent: string; traces: number; llm_calls: number; cost_usd: number; errors: number }[];
  issues: Issue[];
  scores: { name: string; n: number; avg: number | null; passes: number }[];
}

export interface Facets {
  projects: string[];
  models: string[];
  agents: string[];
  tools: string[];
  sources: string[];
  kinds: Kind[];
  signal_types: string[];
  score_names: string[];
}

export interface Page<T> {
  items: T[];
  total?: number;
  next: number | null;
}

export interface Session {
  session_id: string;
  project: string;
  user_id: string | null;
  start_ns: number;
  end_ns: number;
  trace_count: number;
  llm_calls: number;
  tool_calls: number;
  error_count: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  first_input: string | null;
  sources: string | null;
  signals?: { type: string; count: number }[];
}

export interface TurnTool {
  span_id: string;
  name: string;
  tool_name: string | null;
  kind: Kind;
  status: string;
  duration_ms: number | null;
  input_preview: string | null;
  output_preview: string | null;
  memory_op: string | null;
}

export interface Turn {
  trace_id: string;
  start_ns: number;
  user: string | null;
  assistant: string | null;
  tools: TurnTool[];
  cost_usd: number;
  duration_ms: number | null;
  error_count: number;
  signals: SignalBadge[];
  scores: ScoreBadge[];
}

export interface SessionDetail {
  session: Session;
  traces: Trace[];
  turns: Turn[];
  scores: Score[];
  signals: Signal[];
}

export interface ToolStat {
  tool: string;
  kind: Kind;
  mcp_server: string | null;
  memory_op: string | null;
  calls: number;
  errors: number;
  error_rate: number;
  traces: number;
  avg_ms: number | null;
  p50_ms: number | null;
  p95_ms: number | null;
  max_ms: number | null;
  last_error: string | null;
}

export interface ToolsResponse {
  tools: ToolStat[];
  servers: { server: string; calls: number; errors: number; error_rate: number; tools: number; defined_tools: number; definition_tokens: number; avg_ms: number | null }[];
  definitions: { server: string; name: string; hash: string; description: string | null; tokens: number | null; first_seen: number; last_seen: number }[];
  drift: { server: string; name: string; versions: number }[];
}

export interface AgentsResponse {
  agents: { agent: string; traces: number; llm_calls: number; tool_calls: number; cost_usd: number; errors: number; tokens: number; flagged_traces: number; cost_per_trace: number; steps_per_trace: number }[];
  models: { model: string; provider: string | null; calls: number; cost_usd: number; input_tokens: number; output_tokens: number; cache_read_tokens: number; cache_write_tokens: number; cache_hit_ratio: number | null; errors: number; avg_ms: number | null; avg_ttft_ms: number | null }[];
}

export interface MemoryResponse {
  ops: { span_id: string; trace_id: string; session_id: string | null; name: string; tool_name: string | null; memory_op: string | null; status: string; start_ns: number; duration_ms: number | null; input_preview: string | null; output_preview: string | null; agent_name: string | null; source: string }[];
  summary: { op: string | null; n: number; errors: number }[];
  sessions: { session_id: string; writes: number; reads: number; deletes: number }[];
}

export interface EvaluatorStats {
  runs: number;
  avg: number | null;
  pass_rate: number | null;
  last_run: number | null;
}

export type CodeCheck = 'regex' | 'contains' | 'not_contains' | 'json_valid' | 'latency' | 'cost' | 'no_error' | 'max_steps' | 'tool_called' | 'trajectory_match' | 'output_length';

export interface Evaluator {
  id: string;
  name: string;
  type: 'llm_judge' | 'code';
  description: string | null;
  target: 'trace' | 'llm' | 'tool' | 'session';
  config: {
    prompt?: string;
    template?: string;
    output?: 'binary' | 'score' | 'label';
    labels?: string[];
    model?: string;
    check?: CodeCheck;
    params?: Record<string, unknown>;
  };
  builtin: 0 | 1;
  created_at: number;
  updated_at: number;
  stats?: EvaluatorStats;
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

export interface RuleFilter {
  project?: string;
  agent?: string;
  model?: string;
  tool?: string;
  status?: string;
  signal?: string;
  source?: string;
  name_contains?: string;
}

export interface Rule {
  id: string;
  name: string;
  evaluator_id: string;
  evaluator_name?: string;
  target: string;
  filter: RuleFilter | null;
  sampling: number;
  delay_ms: number;
  enabled: number | boolean;
  created_at: number;
}

export interface JudgeStatus {
  provider: 'anthropic' | 'claude-cli' | 'none';
  model: string | null;
  spend_today_usd: number;
  daily_cap_usd: number | null;
}

export interface JobsResponse {
  items: { id: string; status: string; evaluator_id: string; trace_id: string | null; error: string | null; created_at: number; finished_at: number | null }[];
  counts: { queued: number; running: number; done: number; failed: number };
}

export interface Dataset {
  id: string;
  name: string;
  description: string | null;
  created_at: number;
  item_count?: number;
}

export interface DatasetItem {
  id: string;
  dataset_id: string;
  input: unknown;
  expected: unknown;
  metadata: unknown;
  source_trace_id: string | null;
  created_at: number;
}

export type ExperimentTarget = { type: 'command'; command: string } | { type: 'http'; url: string } | { type: 'llm'; model: string; system?: string };

export interface Experiment {
  id: string;
  dataset_id: string;
  name: string;
  target: ExperimentTarget | string;
  evaluator_ids: string[] | string;
  baseline_id: string | null;
  status: string;
  summary: unknown;
  created_at: number;
  finished_at: number | null;
}

export interface ExperimentRun {
  id: string;
  item_id: string;
  input: unknown;
  expected: unknown;
  output: unknown;
  latency_ms: number | null;
  cost_usd: number | null;
  error: string | null;
  scores: ScoreBadge[] | Score[];
}

export interface CompareRow {
  item_id: string;
  input: unknown;
  expected: unknown;
  a: { output: unknown; scores?: Record<string, number | null>; [k: string]: unknown } | null;
  b: { output: unknown; scores?: Record<string, number | null>; [k: string]: unknown } | null;
  verdict: 'improved' | 'regressed' | 'tie' | 'tradeoff';
}

export interface CompareResponse {
  rows: CompareRow[];
  summary: Record<string, { a_avg: number | null; b_avg: number | null; improved: number; regressed: number; ties: number }>;
}

export interface Explanation {
  summary: string;
  outcome: string;
  root_cause: string;
  failure_modes: { mode: string; span_id: string | null; evidence: string }[];
  suggestions: string[] | string;
  judge_model: string | null;
}

export interface StreamEvent {
  type: 'traces' | 'signals' | 'scores' | 'experiment';
  ids: string[];
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export type Params = Record<string, string | number | boolean | null | undefined>;

export function qs(params?: Params): string {
  if (!params) return '';
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    u.set(k, String(v === true ? 1 : v));
  }
  const s = u.toString();
  return s ? '?' + s : '';
}

async function request<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) {
    const msg = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new ApiError(res.status, msg);
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, params?: Params, signal?: AbortSignal) => request<T>('GET', path + qs(params), undefined, signal),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  del: <T>(path: string) => request<T>('DELETE', path),
};

export function isMissing(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 404 || e.status === 501 || e.status === 405);
}
