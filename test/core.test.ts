import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, setDb, type DB } from '../src/db.ts';
import { seedPrices, findPrice, costFor } from '../src/pricing.ts';
import { normalizeSpan } from '../src/normalize.ts';
import { ingestRawSpans, ingestLogs, flush } from '../src/ingest.ts';
import { decodeTraces, encodeTraces, normId } from '../src/otlp.ts';
import { analyzeTrace } from '../src/signals.ts';
import { seedDemo } from '../src/demo.ts';
import { listTraces, getTrace, overview } from '../src/api.ts';
import type { RawSpan } from '../src/otlp.ts';

function fresh(): DB {
  const db = openDb(':memory:');
  setDb(db);
  seedPrices(db);
  return db;
}

function raw(p: Partial<RawSpan> & { attributes: Record<string, unknown> }): RawSpan {
  return {
    traceId: 'a'.repeat(32),
    spanId: Math.random().toString(16).slice(2, 10).padEnd(16, '0'),
    parentSpanId: null,
    name: 'span',
    kind: 1,
    startNs: 1_790_000_000_000_000_000,
    endNs: 1_790_000_001_000_000_000,
    events: [],
    links: [],
    statusCode: 0,
    statusMessage: null,
    resource: {},
    scope: null,
    ...p,
  };
}

test('price lookup handles dated, prefixed and suffixed model names', () => {
  const db = fresh();
  assert.equal(findPrice(db, 'anthropic/claude-opus-5-5')?.model, 'claude-opus-5-5');
  assert.equal(findPrice(db, 'claude-haiku-5-5[1m]')?.model, 'claude-haiku-5-5');
  assert.equal(findPrice(db, 'gpt-4o-mini-2024-07-18')?.model, 'gpt-4o-mini-2024-07-18');
  const c = costFor(db, 'claude-opus-5-5', { input_tokens: 1000, output_tokens: 1000 });
  assert.ok(c && c > 0);
});

test('OTel GenAI chat span normalizes messages, usage and kind', () => {
  fresh();
  const s = normalizeSpan(raw({
    name: 'chat claude-sonnet-5-5',
    attributes: {
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'anthropic',
      'gen_ai.request.model': 'claude-sonnet-5-5',
      'gen_ai.usage.input_tokens': 120,
      'gen_ai.usage.output_tokens': 40,
      'gen_ai.usage.cache_read.input_tokens': 900,
      'gen_ai.system_instructions': JSON.stringify([{ type: 'text', content: 'be brief' }]),
      'gen_ai.input.messages': JSON.stringify([{ role: 'user', parts: [{ type: 'text', content: 'hello there' }] }]),
      'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', id: 't1', name: 'lookup', arguments: { q: 1 } }] }]),
      'gen_ai.conversation.id': 'sess-1',
    },
  }));
  assert.equal(s.kind, 'llm');
  assert.equal(s.source, 'otel-genai');
  assert.equal(s.model, 'claude-sonnet-5-5');
  assert.equal(s.input_tokens, 120);
  assert.equal(s.cache_read_tokens, 900);
  assert.equal(s.session_id, 'sess-1');
  const input = JSON.parse(s.input!);
  assert.equal(input[0].role, 'system');
  assert.equal(input[1].content, 'hello there');
  const output = JSON.parse(s.output!);
  assert.equal(output[0].tool_calls[0].name, 'lookup');
  assert.equal(s.input_preview, 'hello there');
});

test('OpenAI style input tokens exclude cached tokens', () => {
  fresh();
  const s = normalizeSpan(raw({ attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.provider.name': 'openai', 'gen_ai.request.model': 'gpt-5', 'gen_ai.usage.input_tokens': 1000, 'gen_ai.usage.cache_read.input_tokens': 800 } }));
  assert.equal(s.input_tokens, 200);
});

test('OpenInference flattened messages and tool kinds', () => {
  fresh();
  const llm = normalizeSpan(raw({
    name: 'ChatCompletion',
    attributes: {
      'openinference.span.kind': 'LLM',
      'llm.model_name': 'gpt-5',
      'llm.input_messages.0.message.role': 'user',
      'llm.input_messages.0.message.content': 'find docs',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.name': 'search',
      'llm.output_messages.0.message.tool_calls.0.tool_call.function.arguments': '{"q":"docs"}',
      'llm.token_count.prompt': 50,
      'llm.token_count.completion': 5,
    },
  }));
  assert.equal(llm.kind, 'llm');
  assert.equal(JSON.parse(llm.output!)[0].tool_calls[0].arguments.q, 'docs');
  const mem = normalizeSpan(raw({ name: 'memory_search', attributes: { 'openinference.span.kind': 'TOOL', 'tool.name': 'memory_search', 'input.value': '{"query":"prefs"}' } }));
  assert.equal(mem.kind, 'memory');
  assert.equal(mem.memory_op, 'read');
});

test('OpenLLMetry indexed prompt attributes', () => {
  fresh();
  const s = normalizeSpan(raw({ name: 'openai.chat', attributes: { 'llm.request.type': 'chat', 'gen_ai.system': 'openai', 'gen_ai.request.model': 'gpt-4o', 'gen_ai.prompt.0.role': 'user', 'gen_ai.prompt.0.content': 'hi', 'gen_ai.completion.0.role': 'assistant', 'gen_ai.completion.0.content': 'hello' } }));
  assert.equal(s.source, 'openllmetry');
  assert.equal(s.kind, 'llm');
  assert.equal(JSON.parse(s.output!)[0].content, 'hello');
});

test('MCP span detection', () => {
  fresh();
  const s = normalizeSpan(raw({ name: 'tools/call search_issues', attributes: { 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'search_issues', 'mcp.server.name': 'github' } }));
  assert.equal(s.kind, 'mcp');
  assert.equal(s.mcp_server, 'github');
  assert.equal(s.tool_name, 'search_issues');
});

test('protobuf round trip and id normalization', () => {
  const tid = Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const sid = Buffer.from('0123456789abcdef', 'hex');
  const bin = encodeTraces({
    resourceSpans: [{
      resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] },
      scopeSpans: [{ spans: [{ traceId: tid, spanId: sid, name: 'chat x', startTimeUnixNano: '1790000000000000000', endTimeUnixNano: '1790000000500000000', attributes: [{ key: 'gen_ai.usage.input_tokens', value: { intValue: 7 } }] }] }],
    }],
  });
  const spans = decodeTraces(Buffer.from(bin), 'application/x-protobuf');
  assert.equal(spans.length, 1);
  assert.equal(spans[0].traceId, '0123456789abcdef0123456789abcdef');
  assert.equal(spans[0].attributes['gen_ai.usage.input_tokens'], 7);
  assert.equal(normId(Buffer.from(sid).toString('base64')), '0123456789abcdef');
});

test('children arriving before parents still roll up into one trace', () => {
  const db = fresh();
  const child = raw({ spanId: '1'.repeat(16), parentSpanId: '2'.repeat(16), name: 'chat m', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-haiku-5-5', 'gen_ai.usage.input_tokens': 10, 'gen_ai.usage.output_tokens': 5 } });
  ingestRawSpans([child]);
  flush(db);
  const parent = raw({ spanId: '2'.repeat(16), name: 'invoke_agent a', startNs: 1_789_999_999_000_000_000, attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'a', 'input.value': 'do it' } });
  ingestRawSpans([parent]);
  flush(db);
  const t = getTrace(db, 'a'.repeat(32));
  assert.equal(t.trace.span_count, 2);
  assert.equal(t.trace.root_span_id, '2'.repeat(16));
  assert.equal(t.trace.llm_calls, 1);
  assert.ok(t.trace.cost_usd > 0);
  assert.equal(t.trace.input_preview, 'do it');
});

test('Claude Code log events synthesize a trace when no spans exist', () => {
  const db = fresh();
  const base = { 'session.id': 's1', 'prompt.id': 'p1' };
  const mk = (name: string, attrs: Record<string, unknown>, t: number) => ({ timeNs: t, name: 'claude_code.' + name, severity: null, body: 'claude_code.' + name, attributes: { ...base, 'event.name': name, ...attrs }, resource: { 'service.name': 'claude-code' }, traceId: null, spanId: null, scope: 'com.anthropic.claude_code.events' });
  ingestLogs([
    mk('user_prompt', { prompt: 'fix the bug' }, 1e18),
    mk('api_request', { model: 'claude-haiku-5-5', input_tokens: '10', output_tokens: '20', cost_usd: '0.01', duration_ms: '900' }, 1e18 + 1e9),
    mk('tool_result', { tool_name: 'Bash', success: 'false', duration_ms: '20', tool_input: '{"command":"npm test"}', error: 'exit 1' }, 1e18 + 2e9),
  ]);
  flush(db);
  const tr = listTraces(db, new URLSearchParams()).items;
  assert.equal(tr.length, 1);
  assert.equal(tr[0].session_id, 's1');
  assert.equal(tr[0].llm_calls, 1);
  assert.equal(tr[0].error_count, 1);
  assert.equal(tr[0].cost_usd, 0.01);
  assert.equal(tr[0].input_preview, 'fix the bug');
});

test('detectors flag loops, destructive commands and hallucinated success', () => {
  const db = fresh();
  const tid = 'b'.repeat(32);
  const root = raw({ traceId: tid, spanId: '9'.repeat(16), name: 'invoke_agent coder', attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'coder', 'input.value': 'fix tests', 'output.value': 'Done, all tests pass.' } });
  const spans = [root];
  for (let i = 0; i < 4; i++) spans.push(raw({ traceId: tid, spanId: `${i}`.repeat(16), parentSpanId: root.spanId, name: 'execute_tool grep', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'grep', 'gen_ai.tool.call.arguments': '{"pattern":"x"}' } }));
  spans.push(raw({ traceId: tid, spanId: 'e'.repeat(16), parentSpanId: root.spanId, name: 'execute_tool bash', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'bash', 'gen_ai.tool.call.arguments': '{"command":"rm -rf build && npm test"}', 'gen_ai.tool.call.result': 'FAIL src/a.test.ts' } }));
  ingestRawSpans(spans);
  flush(db);
  analyzeTrace(db, tid);
  const types = (db.prepare('select type from signals where trace_id = ?').all(tid) as { type: string }[]).map((r) => r.type).sort();
  assert.ok(types.includes('tool_loop'));
  assert.ok(types.includes('destructive_action'));
  assert.ok(types.includes('hallucinated_success'));
});

test('demo seed covers every major signal and the overview aggregates', () => {
  const db = fresh();
  const r = seedDemo({ traces: 320, db });
  assert.equal(r.traces, 320);
  const types = new Set((db.prepare('select distinct type from signals').all() as { type: string }[]).map((x) => x.type));
  for (const t of ['tool_loop', 'toxic_flow', 'hallucinated_success', 'destructive_action', 'context_pressure', 'toolset_tax', 'refusal', 'user_frustration', 'retry_storm', 'runaway_cost', 'prompt_injection']) assert.ok(types.has(t), t);
  const o = overview(db, new URLSearchParams('window=30d'));
  assert.equal(o.totals.traces, 320);
  assert.ok(o.totals.cost_usd > 0);
  assert.ok(o.issues.length > 0);
  const search = listTraces(db, new URLSearchParams('q=Ridgeline'));
  assert.ok(search.items.length > 0);
});
