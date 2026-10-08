import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { openDb, setDb, type DB } from '../src/db.ts';
import { seedPrices } from '../src/pricing.ts';
import { decodeLogs, decodeMetrics, type RawSpan } from '../src/otlp.ts';
import { ingestLogs, ingestMetrics, ingestRawSpans, flush } from '../src/ingest.ts';
import { normalizeSpan } from '../src/normalize.ts';
import { previewOf } from '../src/messages.ts';
import { analyzeTrace } from '../src/signals.ts';
import { startServer, buildRouter } from '../src/server.ts';
import { LineSplitter } from '../src/mcp/wrap.ts';
import { request } from 'node:http';

function fresh(): DB {
  const db = openDb(':memory:');
  setDb(db);
  seedPrices(db);
  return db;
}

function raw(p: Partial<RawSpan> & { attributes: Record<string, unknown> }): RawSpan {
  return { traceId: 'c'.repeat(32), spanId: Math.random().toString(16).slice(2, 10).padEnd(16, '0'), parentSpanId: null, name: 'span', kind: 1, startNs: 1.79e18, endNs: 1.79e18 + 1e9, events: [], links: [], statusCode: 0, statusMessage: null, resource: {}, scope: null, ...p };
}

test('non-string log event names and NaN metrics do not break a flush', () => {
  const db = fresh();
  const logs = decodeLogs(Buffer.from(JSON.stringify({ resourceLogs: [{ scopeLogs: [{ logRecords: [{ timeUnixNano: '1790000000000000000', attributes: [{ key: 'event.name', value: { intValue: '7' } }] }] }] }] })), 'application/json');
  const points = decodeMetrics(Buffer.from(JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'm', gauge: { dataPoints: [{ asDouble: 'NaN', timeUnixNano: '1' }, { asDouble: 2, timeUnixNano: '2' }] } }] }] }] })), 'application/json');
  assert.equal(points.length, 1);
  ingestLogs(logs);
  ingestMetrics(points);
  assert.doesNotThrow(() => flush(db));
  assert.equal((db.prepare('select count(*) n from logs').get() as { n: number }).n, 1);
});

test('message arrays with block content preview without throwing', () => {
  fresh();
  const msgs = [{ role: 'user', content: [{ type: 'text', text: 'block content' }] }];
  assert.equal(previewOf(msgs), 'block content');
  const s = normalizeSpan(raw({ attributes: { 'openinference.span.kind': 'AGENT', 'input.value': JSON.stringify(msgs) } }));
  assert.equal(s.input_preview, 'block content');
});

test('parent spans with aggregate usage are not double counted', () => {
  const db = fresh();
  const parent = raw({ spanId: 'a'.repeat(16), name: 'ai.generateText', attributes: { 'ai.model.id': 'gpt-4o', 'ai.usage.promptTokens': 1000, 'ai.usage.completionTokens': 100 } });
  const c1 = raw({ spanId: 'b'.repeat(16), parentSpanId: parent.spanId, name: 'ai.generateText.doGenerate', attributes: { 'ai.model.id': 'gpt-4o', 'ai.usage.promptTokens': 600, 'ai.usage.completionTokens': 60 } });
  const c2 = raw({ spanId: 'd'.repeat(16), parentSpanId: parent.spanId, name: 'ai.generateText.doGenerate', attributes: { 'ai.model.id': 'gpt-4o', 'ai.usage.promptTokens': 400, 'ai.usage.completionTokens': 40 } });
  ingestRawSpans([parent, c1, c2]);
  flush(db);
  const t = db.prepare('select input_tokens, output_tokens, cost_usd from traces').get() as { input_tokens: number; output_tokens: number; cost_usd: number };
  assert.equal(t.input_tokens, 1000);
  assert.equal(t.output_tokens, 100);
});

test('passing test output and tool-call endings do not raise false signals', () => {
  const db = fresh();
  const tid = 'e'.repeat(32);
  const root = raw({ traceId: tid, spanId: '1'.repeat(16), name: 'invoke_agent coder', attributes: { 'gen_ai.operation.name': 'invoke_agent', 'gen_ai.agent.name': 'coder', 'input.value': 'make sure you keep the old export', 'output.value': 'Done, all tests pass.' } });
  const t = raw({ traceId: tid, spanId: '2'.repeat(16), parentSpanId: root.spanId, name: 'execute_tool bash', attributes: { 'gen_ai.operation.name': 'execute_tool', 'gen_ai.tool.name': 'bash', 'gen_ai.tool.call.arguments': '{"command":"cargo test"}', 'gen_ai.tool.call.result': 'test result: ok. 12 passed; 0 failed' } });
  ingestRawSpans([root, t]);
  flush(db);
  analyzeTrace(db, tid);
  const types = (db.prepare('select type from signals where trace_id = ?').all(tid) as { type: string }[]).map((r) => r.type);
  assert.ok(!types.includes('hallucinated_success'));
  assert.ok(!types.includes('user_frustration'));

  const tid2 = 'f'.repeat(32);
  ingestRawSpans([raw({ traceId: tid2, spanId: '3'.repeat(16), name: 'chat m', attributes: { 'gen_ai.operation.name': 'chat', 'gen_ai.request.model': 'claude-haiku-5-5', 'gen_ai.output.messages': JSON.stringify([{ role: 'assistant', parts: [{ type: 'tool_call', id: 'x', name: 'Read', arguments: {} }], finish_reason: 'tool_use' }]) } })]);
  flush(db);
  analyzeTrace(db, tid2);
  const t2 = (db.prepare('select type from signals where trace_id = ?').all(tid2) as { type: string }[]).map((r) => r.type);
  assert.ok(!t2.includes('empty_output'));
});

test('malformed request urls get a 400 and the server stays up', async () => {
  fresh();
  const server = await startServer(0, buildRouter(), { ui: false });
  const port = (server.address() as AddressInfo).port;
  const get = (path: string) =>
    new Promise<number>((resolve, reject) => {
      const r = request({ host: '127.0.0.1', port, path, method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.on('error', reject);
      r.end();
    });
  assert.equal(await get('/api/traces/%E0%A4%A'), 400);
  assert.equal(await get('/api/health'), 200);
  server.close();
});

test('line splitter handles lines split across many chunks', () => {
  const lines: string[] = [];
  const sp = new LineSplitter((l) => lines.push(l));
  const big = JSON.stringify({ x: 'y'.repeat(200000) });
  for (let i = 0; i < big.length; i += 1000) sp.push(Buffer.from(big.slice(i, i + 1000)));
  sp.push(Buffer.from('\n{"a":1}\n{"b"'));
  sp.push(Buffer.from(':2}\n'));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].length, big.length);
  assert.equal(lines[2], '{"b":2}');
});
