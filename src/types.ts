export type Kind = 'agent' | 'llm' | 'tool' | 'mcp' | 'memory' | 'retriever' | 'embedding' | 'chain' | 'guardrail' | 'handoff' | 'evaluator' | 'span';

export const KINDS: Kind[] = ['agent', 'llm', 'tool', 'mcp', 'memory', 'retriever', 'embedding', 'chain', 'guardrail', 'handoff', 'evaluator', 'span'];

export interface ToolCall {
  id?: string;
  name: string;
  arguments?: unknown;
}

export interface Message {
  role: string;
  content?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  reasoning?: string;
}

export interface SpanRow {
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
  input: string | null;
  output: string | null;
  input_preview: string | null;
  output_preview: string | null;
  attributes: string | null;
  events: string | null;
  resource: string | null;
}

export const SPAN_COLUMNS: (keyof SpanRow)[] = [
  'span_id', 'trace_id', 'parent_id', 'project', 'name', 'kind', 'source', 'operation', 'start_ns', 'end_ns', 'duration_ms',
  'status', 'status_message', 'session_id', 'user_id', 'agent_name', 'model', 'provider', 'tool_name', 'tool_call_id',
  'mcp_server', 'mcp_method', 'memory_op', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
  'reasoning_tokens', 'cost_usd', 'ttft_ms', 'finish_reason', 'input', 'output', 'input_preview', 'output_preview',
  'attributes', 'events', 'resource',
];

export interface SpanInput extends Partial<SpanRow> {
  span_id: string;
  trace_id: string;
  name: string;
  start_ns: number;
}
