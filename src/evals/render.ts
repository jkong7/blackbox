import type { DB } from '../db.ts';
import type { Message } from '../types.ts';
import { parseSpan } from '../api.ts';
import { normalizeMessages, textOf } from '../messages.ts';
import { maybeJson } from '../util.ts';

type Row = Record<string, any>;

export const RENDER_BUDGET_CHARS = 48000;

const BUDGET = {
  input: 5000,
  trajectory: 26000,
  context: 10000,
  output: 7000,
  stepText: 500,
  args: 400,
  result: 600,
};

export interface RenderedTrace {
  input: string;
  output: string;
  trajectory: string;
  context: string;
  text: string;
  tools: string[];
  steps: number;
  errors: string[];
}

export function headTail(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.ceil(max * 0.6);
  const tail = Math.max(0, max - head);
  return s.slice(0, head) + `\n[... ${s.length - head - tail} chars omitted ...]\n` + s.slice(s.length - tail);
}

export function asText(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function oneLine(s: string, max: number): string {
  return headTail(s.replace(/\s+/g, ' ').trim(), max);
}

export function loadSpans(db: DB, traceId: string): Row[] {
  return (db.prepare('select * from spans where trace_id = ? order by start_ns, span_id').all(traceId) as Row[]).map(parseSpan);
}

export function loadSessionTraces(db: DB, sessionId: string): Row[] {
  return db.prepare('select * from traces where session_id = ? order by start_ns').all(sessionId) as Row[];
}

export function rootOf(spans: Row[]): Row | null {
  const ids = new Set(spans.map((s) => s.span_id));
  return spans.find((s) => !s.parent_id || !ids.has(s.parent_id)) ?? spans[0] ?? null;
}

export function messagesOf(v: unknown): Message[] | null {
  if (v == null) return null;
  const parsed = maybeJson(v);
  if (Array.isArray(parsed) && parsed.length && parsed.every((m) => m && typeof m === 'object' && 'role' in m)) return normalizeMessages(parsed);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && ('messages' in parsed || 'role' in parsed)) return normalizeMessages(parsed);
  return null;
}

function lastRole(msgs: Message[] | null, role: string): string | null {
  if (!msgs) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.role === role && m.content && m.content.trim()) return m.content;
  }
  return null;
}

export function userTextOf(v: unknown): string | null {
  if (v == null) return null;
  const parsed = maybeJson(v);
  if (typeof parsed === 'string') return parsed.trim() ? parsed : null;
  const msgs = messagesOf(parsed);
  if (msgs) return lastRole(msgs, 'user');
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Row;
    for (const k of ['input', 'query', 'question', 'prompt', 'message', 'task', 'goal']) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k];
    }
  }
  return asText(parsed) || null;
}

export function assistantTextOf(v: unknown): string | null {
  if (v == null) return null;
  const parsed = maybeJson(v);
  if (typeof parsed === 'string') return parsed.trim() ? parsed : null;
  const msgs = messagesOf(parsed);
  if (msgs) return lastRole(msgs, 'assistant') ?? msgs.map((m) => m.content).filter(Boolean).join('\n') ?? null;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const o = parsed as Row;
    for (const k of ['output', 'answer', 'response', 'result', 'text', 'content']) {
      if (typeof o[k] === 'string' && o[k].trim()) return o[k];
    }
  }
  return asText(parsed) || null;
}

export function goalOf(spans: Row[]): string {
  const root = rootOf(spans);
  if (root && root.kind !== 'llm') {
    const t = userTextOf(root.input);
    if (t) return t;
  }
  const firstLlm = spans.find((s) => s.kind === 'llm' && s.input != null);
  if (firstLlm) {
    const t = lastRole(messagesOf(firstLlm.input), 'user') ?? userTextOf(firstLlm.input);
    if (t) return t;
  }
  const any = spans.find((s) => s.input != null);
  return any ? asText(any.input) : '';
}

export function finalOutputOf(spans: Row[]): string {
  const root = rootOf(spans);
  if (root && root.kind !== 'llm' && root.output != null) {
    const t = assistantTextOf(root.output);
    if (t) return t;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (s.kind !== 'llm' || s.output == null) continue;
    const msgs = messagesOf(s.output);
    const t = msgs ? lastRole(msgs, 'assistant') : assistantTextOf(s.output);
    if (t) return t;
  }
  for (let i = spans.length - 1; i >= 0; i--) if (spans[i].output != null) return asText(spans[i].output);
  return '';
}

function isToolKind(k: string): boolean {
  return k === 'tool' || k === 'mcp' || k === 'memory';
}

function toolCallsOf(v: unknown): { id?: string; name: string; arguments?: unknown }[] {
  const msgs = messagesOf(v);
  if (!msgs) return [];
  return msgs.flatMap((m) => m.tool_calls ?? []).filter((c) => c && c.name);
}

export function toolSequence(spans: Row[]): string[] {
  const fromSpans = spans.filter((s) => isToolKind(s.kind)).map((s) => String(s.tool_name ?? s.name));
  if (fromSpans.length) return fromSpans;
  return spans.filter((s) => s.kind === 'llm').flatMap((s) => toolCallsOf(s.output).map((c) => c.name));
}

export function errorsOf(spans: Row[]): string[] {
  return spans.filter((s) => s.status === 'error').map((s) => `${s.tool_name ?? s.name}: ${s.status_message ?? 'error'}`);
}

export function stepCount(spans: Row[]): number {
  const llm = spans.filter((s) => s.kind === 'llm').length;
  const tools = spans.filter((s) => isToolKind(s.kind)).length;
  return llm + (tools || toolSequence(spans).length);
}

function errorLine(s: Row): string {
  return s.status === 'error' ? `\n   ERROR: ${oneLine(s.status_message ?? 'error status', 300)}` : '';
}

function llmStep(s: Row): string {
  const msgs = messagesOf(s.output);
  const lines = [`[llm${s.model ? ' ' + s.model : ''}] span ${s.span_id}`];
  if (msgs) {
    for (const m of msgs) {
      if (m.reasoning) lines.push(`   thinking: ${oneLine(m.reasoning, 300)}`);
      if (m.content && m.content.trim()) lines.push(`   says: ${oneLine(m.content, BUDGET.stepText)}`);
      for (const c of m.tool_calls ?? []) lines.push(`   calls ${c.name}(${oneLine(asText(c.arguments ?? {}), BUDGET.args)})`);
    }
  } else if (s.output != null) {
    lines.push(`   says: ${oneLine(asText(s.output), BUDGET.stepText)}`);
  }
  if (s.finish_reason) lines.push(`   finish: ${s.finish_reason}`);
  return lines.join('\n') + errorLine(s);
}

function toolStep(s: Row): string {
  const label = s.kind === 'memory' ? `memory ${s.memory_op ?? ''} ${s.tool_name ?? s.name}`.replace(/\s+/g, ' ') : `${s.kind === 'mcp' ? 'mcp' : 'tool'} ${s.tool_name ?? s.name}${s.mcp_server ? ' @' + s.mcp_server : ''}`;
  const lines = [`[${label}] span ${s.span_id}`];
  if (s.input != null) lines.push(`   args: ${oneLine(asText(s.input), BUDGET.args)}`);
  if (s.output != null) lines.push(`   result: ${oneLine(asText(s.output), BUDGET.result)}`);
  return lines.join('\n') + errorLine(s);
}

function genericStep(s: Row): string | null {
  if (s.kind === 'retriever') {
    return `[retrieve ${s.name}] span ${s.span_id}\n   query: ${oneLine(asText(s.input), BUDGET.args)}\n   docs: ${oneLine(asText(s.output), BUDGET.result)}` + errorLine(s);
  }
  if (s.kind === 'agent' || s.kind === 'handoff') return `[${s.kind} ${s.agent_name ?? s.name}] span ${s.span_id}` + errorLine(s);
  if (s.kind === 'guardrail') return `[guardrail ${s.name}] span ${s.span_id}\n   result: ${oneLine(asText(s.output), 300)}` + errorLine(s);
  if (s.status === 'error') return `[${s.kind} ${s.name}] span ${s.span_id}` + errorLine(s);
  return null;
}

export function trajectorySteps(spans: Row[]): string[] {
  const root = rootOf(spans);
  const hasToolSpans = spans.some((s) => isToolKind(s.kind));
  const callNames = new Map<string, string>();
  const seenResults = new Set<string>();
  const out: string[] = [];
  for (const s of spans) {
    if (s === root && s.kind !== 'llm' && s.kind !== 'tool' && s.status !== 'error' && spans.length > 1) continue;
    if (s.kind === 'llm') {
      if (!hasToolSpans) {
        for (const m of messagesOf(s.input) ?? []) {
          if (m.role !== 'tool') continue;
          const key = m.tool_call_id ?? textOf(m.content).slice(0, 200);
          if (seenResults.has(key)) continue;
          seenResults.add(key);
          const name = (m.tool_call_id && callNames.get(m.tool_call_id)) ?? m.name ?? 'tool';
          out.push(`[tool result ${name}]\n   result: ${oneLine(m.content ?? '', BUDGET.result)}`);
        }
      }
      for (const c of toolCallsOf(s.output)) if (c.id) callNames.set(c.id, c.name);
      out.push(llmStep(s));
    } else if (isToolKind(s.kind)) {
      out.push(toolStep(s));
    } else {
      const g = genericStep(s);
      if (g) out.push(g);
    }
  }
  return out.map((t, i) => `${i + 1}. ${t}`);
}

export function fitSteps(steps: string[], budget: number): string {
  const total = steps.reduce((a, s) => a + s.length + 1, 0);
  if (total <= budget) return steps.join('\n');
  const head: string[] = [];
  const tail: string[] = [];
  let used = 0;
  let i = 0;
  let j = steps.length - 1;
  while (i <= j && used + steps[i].length < budget * 0.45) {
    head.push(steps[i]);
    used += steps[i].length + 1;
    i++;
  }
  while (j >= i && used + steps[j].length < budget * 0.95) {
    tail.unshift(steps[j]);
    used += steps[j].length + 1;
    j--;
  }
  const omitted = j - i + 1;
  return [...head, omitted > 0 ? `[... ${omitted} steps omitted ...]` : '', ...tail].filter(Boolean).join('\n');
}

export function contextOf(spans: Row[], budget = BUDGET.context): string {
  const parts: string[] = [];
  for (const s of spans) {
    if (s.output == null) continue;
    if (s.kind === 'retriever') parts.push(`[retrieved by ${s.name}, span ${s.span_id}]\n${headTail(asText(s.output), 2000)}`);
    else if (s.kind === 'memory' && !/write|create|update|upsert|delete/.test(String(s.memory_op ?? ''))) parts.push(`[memory ${s.memory_op ?? 'read'} ${s.tool_name ?? s.name}, span ${s.span_id}]\n${headTail(asText(s.output), 1500)}`);
    else if (s.kind === 'tool' || s.kind === 'mcp') parts.push(`[tool ${s.tool_name ?? s.name}, span ${s.span_id}]\n${headTail(asText(s.output), 1500)}`);
  }
  if (!parts.length) {
    for (const s of spans) {
      if (s.kind !== 'llm') continue;
      for (const m of messagesOf(s.input) ?? []) if (m.role === 'tool' && m.content) parts.push(`[tool result ${m.name ?? m.tool_call_id ?? ''}]\n${headTail(m.content, 1500)}`);
      break;
    }
    const last = [...spans].reverse().find((s) => s.kind === 'llm');
    if (last && last !== spans.find((s) => s.kind === 'llm')) {
      for (const m of messagesOf(last.input) ?? []) if (m.role === 'tool' && m.content) parts.push(`[tool result ${m.name ?? m.tool_call_id ?? ''}]\n${headTail(m.content, 1500)}`);
    }
  }
  return headTail([...new Set(parts)].join('\n\n'), budget);
}

export function renderTrace(spans: Row[]): RenderedTrace {
  const input = headTail(goalOf(spans), BUDGET.input);
  const output = headTail(finalOutputOf(spans), BUDGET.output);
  const trajectory = fitSteps(trajectorySteps(spans), BUDGET.trajectory);
  const context = contextOf(spans);
  const text = [
    '## User goal',
    input || '(none recorded)',
    '',
    '## Trajectory',
    trajectory || '(no steps recorded)',
    '',
    '## Retrieved and tool context',
    context || '(none)',
    '',
    '## Final answer',
    output || '(none recorded)',
  ].join('\n');
  return { input, output, trajectory, context, text, tools: toolSequence(spans), steps: stepCount(spans), errors: errorsOf(spans) };
}

export function renderTraceById(db: DB, traceId: string): RenderedTrace {
  return renderTrace(loadSpans(db, traceId));
}

export function renderMessages(v: unknown, max = BUDGET.input): string {
  const msgs = messagesOf(v);
  if (!msgs) return headTail(asText(v), max);
  const lines = msgs.map((m) => {
    const calls = (m.tool_calls ?? []).map((c) => ` -> ${c.name}(${oneLine(asText(c.arguments ?? {}), 200)})`).join('');
    return `${m.role}: ${m.role === 'system' ? oneLine(m.content ?? '', 800) : m.content ?? ''}${calls}`;
  });
  return headTail(lines.join('\n'), max);
}

export function renderLlmSpan(span: Row): RenderedTrace {
  const input = renderMessages(span.input, BUDGET.input + BUDGET.trajectory);
  const output = headTail(assistantTextOf(span.output) ?? '', BUDGET.output);
  const tools = toolCallsOf(span.output).map((c) => c.name);
  const context = headTail((messagesOf(span.input) ?? []).filter((m) => m.role === 'tool').map((m) => m.content ?? '').join('\n\n'), BUDGET.context);
  const trajectory = `1. ${llmStep(span)}`;
  const text = `## Model input\n${input}\n\n## Model output\n${trajectory}\n\n## Final text\n${output}`;
  return { input, output, trajectory, context, text, tools, steps: 1, errors: errorsOf([span]) };
}

export function renderToolSpan(span: Row): RenderedTrace {
  const input = `${span.tool_name ?? span.name}(${headTail(asText(span.input), BUDGET.input)})`;
  const output = headTail(asText(span.output), BUDGET.output);
  const trajectory = `1. ${toolStep(span)}`;
  return { input, output, trajectory, context: output, text: `## Tool call\n${trajectory}`, tools: [String(span.tool_name ?? span.name)], steps: 1, errors: errorsOf([span]) };
}

export interface RenderedSession {
  conversation: string;
  input: string;
  output: string;
  turns: number;
  tools: string[];
  errors: string[];
}

export function renderSession(db: DB, sessionId: string, budget = 40000): RenderedSession {
  const traces = loadSessionTraces(db, sessionId);
  const turns: string[] = [];
  const tools: string[] = [];
  const errors: string[] = [];
  let firstInput = '';
  let lastOutput = '';
  traces.forEach((t, i) => {
    const spans = loadSpans(db, t.trace_id);
    const user = goalOf(spans);
    const assistant = finalOutputOf(spans);
    const seq = toolSequence(spans);
    tools.push(...seq);
    errors.push(...errorsOf(spans));
    if (!firstInput) firstInput = user;
    if (assistant) lastOutput = assistant;
    const lines = [`Turn ${i + 1} (trace ${t.trace_id})`, `User: ${headTail(user, 1500)}`];
    if (seq.length) lines.push(`Agent used tools: ${headTail(seq.join(', '), 300)}`);
    if (t.error_count) lines.push(`Errors: ${t.error_count}`);
    lines.push(`Assistant: ${headTail(assistant, 2000)}`);
    turns.push(lines.join('\n'));
  });
  return { conversation: fitSteps(turns, budget), input: headTail(firstInput, BUDGET.input), output: headTail(lastOutput, BUDGET.output), turns: traces.length, tools, errors };
}
