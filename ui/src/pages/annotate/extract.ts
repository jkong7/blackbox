import type { Message, Span, TraceDetail } from '../../api.ts';

function isMsgs(v: unknown): v is Message[] {
  return Array.isArray(v) && v.every((m) => m && typeof m === 'object' && 'role' in (m as object));
}

function lastOf(v: unknown, role: string): string | null {
  if (!isMsgs(v)) return null;
  for (let i = v.length - 1; i >= 0; i--) {
    const c = v[i].content;
    if (v[i].role === role && typeof c === 'string' && c.trim()) return c;
  }
  return null;
}

function asText(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.trim() ? v : null;
  if (isMsgs(v)) return null;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function rootSpan(d: TraceDetail): Span | undefined {
  return d.spans.find((s) => s.span_id === d.trace.root_span_id) ?? d.spans.find((s) => !s.parent_id) ?? d.spans[0];
}

export function userInput(d: TraceDetail): string | null {
  const root = rootSpan(d);
  const fromRoot = root ? (lastOf(root.input, 'user') ?? asText(root.input)) : null;
  if (fromRoot) return fromRoot;
  for (const s of d.spans) {
    if (s.kind !== 'llm') continue;
    const u = lastOf(s.input, 'user');
    if (u) return u;
  }
  return d.trace.input_preview;
}

export function finalOutput(d: TraceDetail): string | null {
  const root = rootSpan(d);
  const fromRoot = root ? (lastOf(root.output, 'assistant') ?? asText(root.output)) : null;
  if (fromRoot) return fromRoot;
  const llms = d.spans.filter((s) => s.kind === 'llm');
  for (let i = llms.length - 1; i >= 0; i--) {
    const a = lastOf(llms[i].output, 'assistant');
    if (a) return a;
  }
  return d.trace.output_preview;
}

export function toolCallsOf(s: Span): string[] {
  if (!isMsgs(s.output)) return [];
  const out: string[] = [];
  for (const m of s.output) for (const c of m.tool_calls ?? []) out.push(c.name);
  return out;
}

export function trajectory(d: TraceDetail): Span[] {
  const root = rootSpan(d);
  return d.spans.filter((s) => s !== root).sort((a, b) => a.start_ns - b.start_ns);
}
