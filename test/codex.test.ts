import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb, type DB } from '../src/db.ts';
import { seedPrices } from '../src/pricing.ts';
import { ingestLogs, flush } from '../src/ingest.ts';
import { listTraces, getTrace } from '../src/api.ts';
import { resetCodexTurns } from '../src/sources/codex.ts';

function fresh(): DB {
  const db = openDb(':memory:');
  setDb(db);
  seedPrices(db);
  resetCodexTurns();
  return db;
}

const T0 = Date.parse('2026-10-08T01:36:56.136Z');

function ev(name: string, attrs: Record<string, unknown>, offsetMs: number, conv = 'conv-1') {
  const ts = new Date(T0 + offsetMs).toISOString();
  return {
    timeNs: (T0 + offsetMs) * 1e6,
    name: `event otel/src/events/session_telemetry.rs:${offsetMs}`,
    severity: 'INFO',
    body: null,
    attributes: { 'event.name': `codex.${name}`, 'event.timestamp': ts, 'conversation.id': conv, model: 'gpt-5-codex', slug: 'gpt-5-codex', 'user.email': 'dev@example.com', ...attrs },
    resource: { 'service.name': 'codex_exec' },
    traceId: null,
    spanId: null,
    scope: 'codex_otel',
  };
}

test('codex log events become one trace per turn with llm, tool, mcp and memory spans', () => {
  const db = fresh();
  ingestLogs([
    ev('conversation_starts', { provider_name: 'OpenAI' }, -50),
    ev('user_prompt', { prompt: 'read deploy.yaml and check memory', prompt_length: '33' }, 0),
    ev('sse_event', { 'event.kind': 'response.completed', input_token_count: '13204', output_token_count: '40', cached_token_count: 8000, reasoning_token_count: 12, ttft_ms: 900 }, 1500),
    ev('tool_decision', { tool_name: 'exec_command', call_id: 'c1', decision: 'approved', source: 'config' }, 1510),
    ev('tool_result', { tool_name: 'exec_command', tool_namespace: 'functions', call_id: 'c1', arguments: '{"cmd":"cat deploy.yaml"}', duration_ms: '31', success: 'true', output: 'replicas: 2' }, 1600),
    ev('tool_result', { tool_name: 'memory_search', tool_namespace: 'mcp__engram', call_id: 'c2', arguments: '{"query":"staging db"}', duration_ms: '39', success: 'true', output: '{"memories":[]}' }, 1700),
    ev('tool_result', { tool_name: 'fetch', tool_namespace: 'mcp__web', call_id: 'c3', arguments: '{}', duration_ms: '12', success: 'false', output: 'network down' }, 1750),
    ev('sse_event', { 'event.kind': 'response.completed', input_token_count: '15000', output_token_count: '24', cached_token_count: 13000 }, 3200),
    ev('user_prompt', { prompt: 'thanks' }, 10000),
    ev('sse_event', { 'event.kind': 'response.completed', input_token_count: '15100', output_token_count: '5', cached_token_count: 15000 }, 10800),
  ]);
  flush(db);
  const traces = listTraces(db, new URLSearchParams('project=codex')).items;
  assert.equal(traces.length, 2);
  const first = traces.find((t: any) => t.input_preview === 'read deploy.yaml and check memory')!;
  assert.ok(first);
  assert.equal(first.session_id, 'conv-1');
  assert.equal(first.llm_calls, 2);
  const tr = getTrace(db, first.trace_id)!;
  const spans = tr.spans as any[];
  const root = spans.find((s) => !s.parent_id);
  assert.equal(root.kind, 'agent');
  assert.equal(root.agent_name, 'codex');
  assert.ok(root.duration_ms >= 3000, `root spans the turn (${root.duration_ms}ms)`);
  const llm = spans.filter((s) => s.kind === 'llm');
  assert.equal(llm[0].input_tokens, 5204);
  assert.equal(llm[0].cache_read_tokens, 8000);
  assert.equal(llm[0].reasoning_tokens, 12);
  assert.equal(llm[0].ttft_ms, 900);
  assert.equal(llm[0].provider, 'openai');
  const shell = spans.find((s) => s.tool_name === 'exec_command' && s.operation === 'execute_tool');
  assert.equal(shell.kind, 'tool');
  assert.equal(shell.mcp_server, null);
  const mem = spans.find((s) => s.tool_name === 'memory_search');
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.name, 'mcp__engram__memory_search');
  const fetchSpan = spans.find((s) => s.tool_name === 'fetch');
  assert.equal(fetchSpan.kind, 'mcp');
  assert.equal(fetchSpan.mcp_server, 'web');
  assert.equal(fetchSpan.status, 'error');
  assert.ok(spans.every((s) => s.trace_id === first.trace_id));
});

test('codex events from different conversations never share a trace, and non-codex logs are ignored', () => {
  const db = fresh();
  ingestLogs([
    ev('user_prompt', { prompt: 'a' }, 0, 'conv-a'),
    ev('user_prompt', { prompt: 'b' }, 5, 'conv-b'),
    ev('sse_event', { 'event.kind': 'response.completed', input_token_count: '10', output_token_count: '1' }, 100, 'conv-a'),
    ev('sse_event', { 'event.kind': 'response.completed', input_token_count: '10', output_token_count: '1' }, 120, 'conv-b'),
    { ...ev('user_prompt', { prompt: 'x' }, 0, 'conv-c'), attributes: { 'event.name': 'something_else', 'conversation.id': 'conv-c' } },
  ]);
  flush(db);
  const traces = listTraces(db, new URLSearchParams('project=codex')).items;
  assert.equal(traces.length, 2);
  assert.deepEqual(traces.map((t: any) => t.session_id).sort(), ['conv-a', 'conv-b']);
  assert.ok(traces.every((t: any) => t.llm_calls === 1));
});
