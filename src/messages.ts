import type { Message, ToolCall } from './types.ts';
import { maybeJson, clip } from './util.ts';

type Any = Record<string, any>;

export function textOf(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (!p || typeof p !== 'object') return '';
        if (typeof p.text === 'string') return p.text;
        if (typeof p.content === 'string') return p.content;
        if (p.type === 'tool_result' || p.type === 'tool_call_response') return textOf(p.content ?? p.response ?? p.result);
        if (p.type === 'image' || p.type === 'image_url' || p.type === 'blob' || p.type === 'uri') return '[image]';
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  if (typeof content === 'object') {
    const o = content as Any;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.content === 'string') return o.content;
    return JSON.stringify(content);
  }
  return String(content);
}

function parseArgs(v: unknown): unknown {
  return maybeJson(v);
}

export function normalizeMessage(m: Any): Message[] {
  if (!m || typeof m !== 'object') return typeof m === 'string' ? [{ role: 'user', content: m }] : [];
  const role = String(m.role ?? m.type ?? 'user').toLowerCase();
  if (Array.isArray(m.parts)) return fromParts(role, m.parts, m);
  const content = m.content;
  if (Array.isArray(content)) {
    const toolResults = content.filter((p: Any) => p && p.type === 'tool_result');
    const toolUses = content.filter((p: Any) => p && (p.type === 'tool_use' || p.type === 'tool-call' || p.type === 'tool_call' || p.type === 'function_call'));
    const thinking = content.filter((p: Any) => p && (p.type === 'thinking' || p.type === 'reasoning' || p.type === 'redacted_thinking'));
    const textParts = content.filter((p: Any) => !toolResults.includes(p) && !toolUses.includes(p) && !thinking.includes(p));
    const out: Message[] = [];
    if (toolResults.length) {
      for (const tr of toolResults) out.push({ role: 'tool', tool_call_id: tr.tool_use_id ?? tr.toolCallId, content: textOf(tr.content ?? tr.result ?? tr.output) });
      const rest = textOf(textParts);
      if (rest) out.push({ role, content: rest });
      return out;
    }
    const msg: Message = { role, content: textOf(textParts) };
    if (toolUses.length) {
      msg.tool_calls = toolUses.map((t: Any) => ({
        id: t.id ?? t.toolCallId ?? t.call_id,
        name: t.name ?? t.toolName ?? t.function?.name,
        arguments: parseArgs(t.input ?? t.args ?? t.arguments ?? t.function?.arguments),
      }));
    }
    if (thinking.length) msg.reasoning = thinking.map((t: Any) => t.thinking ?? t.text ?? '').join('\n');
    out.push(msg);
    return out;
  }
  const msg: Message = { role, content: content == null ? '' : textOf(content) };
  const tc = m.tool_calls ?? m.toolCalls ?? m.function_call;
  if (Array.isArray(tc) && tc.length) {
    msg.tool_calls = tc.map((t: Any) => ({
      id: t.id ?? t.toolCallId,
      name: t.function?.name ?? t.name ?? t.toolName,
      arguments: parseArgs(t.function?.arguments ?? t.arguments ?? t.args),
    }));
  } else if (tc && typeof tc === 'object') {
    msg.tool_calls = [{ name: tc.name, arguments: parseArgs(tc.arguments) }];
  }
  if (m.tool_call_id || m.toolCallId) msg.tool_call_id = m.tool_call_id ?? m.toolCallId;
  if (m.name && role === 'tool') msg.name = m.name;
  if (m.reasoning_content || m.reasoning) msg.reasoning = textOf(m.reasoning_content ?? m.reasoning);
  return [msg];
}

function fromParts(role: string, parts: Any[], m: Any): Message[] {
  const out: Message[] = [];
  const texts: string[] = [];
  const calls: ToolCall[] = [];
  const reasoning: string[] = [];
  for (const p of parts) {
    if (!p) continue;
    const t = p.type;
    if (t === 'text') texts.push(String(p.content ?? p.text ?? ''));
    else if (t === 'tool_call') calls.push({ id: p.id, name: p.name, arguments: parseArgs(p.arguments) });
    else if (t === 'tool_call_response') out.push({ role: 'tool', tool_call_id: p.id, content: textOf(p.response ?? p.result) });
    else if (t === 'reasoning') reasoning.push(String(p.content ?? ''));
    else if (t === 'blob' || t === 'uri' || t === 'file') texts.push('[' + (p.modality ?? 'file') + ']');
    else texts.push(textOf(p.content ?? p));
  }
  if (texts.length || calls.length || reasoning.length || !out.length) {
    const msg: Message = { role: role === 'tool' && !texts.length ? 'assistant' : role, content: texts.join('\n') };
    if (calls.length) msg.tool_calls = calls;
    if (reasoning.length) msg.reasoning = reasoning.join('\n');
    if (m.name) msg.name = m.name;
    out.unshift(msg);
  }
  return out;
}

export function normalizeMessages(v: unknown): Message[] | null {
  const parsed = maybeJson(v);
  if (parsed == null) return null;
  if (Array.isArray(parsed)) {
    const out: Message[] = [];
    for (const m of parsed) out.push(...normalizeMessage(m as Any));
    return out.length ? out : null;
  }
  if (typeof parsed === 'object') {
    const o = parsed as Any;
    if (Array.isArray(o.messages)) {
      const out: Message[] = [];
      if (o.system) out.push({ role: 'system', content: textOf(o.system) });
      for (const m of o.messages) out.push(...normalizeMessage(m));
      return out;
    }
    if (o.prompt !== undefined) {
      const out: Message[] = [];
      if (o.system) out.push({ role: 'system', content: textOf(o.system) });
      out.push({ role: 'user', content: textOf(o.prompt) });
      return out;
    }
    if (o.role) return normalizeMessage(o);
  }
  return null;
}

export function unflattenIndexed(attrs: Record<string, unknown>, prefix: string): Any[] {
  const out: Any[] = [];
  const pre = prefix + '.';
  for (const [k, v] of Object.entries(attrs)) {
    if (!k.startsWith(pre)) continue;
    const rest = k.slice(pre.length).split('.');
    const idx = Number(rest[0]);
    if (!Number.isInteger(idx)) continue;
    out[idx] = out[idx] ?? {};
    setPath(out[idx], rest.slice(1), v);
  }
  return out.filter(Boolean);
}

function setPath(obj: Any, path: string[], v: unknown): void {
  let cur = obj;
  for (let i = 0; i < path.length - 1; i++) {
    const key = path[i];
    const nextIsIdx = /^\d+$/.test(path[i + 1]);
    if (cur[key] == null) cur[key] = nextIsIdx ? [] : {};
    cur = cur[key];
  }
  if (path.length) cur[path[path.length - 1]] = v;
}

export function openInferenceMessages(attrs: Record<string, unknown>, key: string): Message[] | null {
  const items = unflattenIndexed(attrs, key);
  if (!items.length) return null;
  return items.map((it) => {
    const m = it.message ?? it;
    const msg: Message = { role: String(m.role ?? 'user'), content: m.content != null ? String(m.content) : textOf(m.contents?.map((c: Any) => c.message_content ?? c)) };
    const calls = (m.tool_calls ?? []).filter(Boolean).map((c: Any) => {
      const tc = c.tool_call ?? c;
      return { id: tc.id, name: tc.function?.name ?? tc.name, arguments: parseArgs(tc.function?.arguments ?? tc.arguments) };
    });
    if (calls.length) msg.tool_calls = calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });
}

export function openLLMetryMessages(attrs: Record<string, unknown>, key: string): Message[] | null {
  const items = unflattenIndexed(attrs, key);
  if (!items.length) return null;
  return items.map((m) => {
    const msg: Message = { role: String(m.role ?? (key.includes('completion') ? 'assistant' : 'user')), content: m.content != null ? textOf(maybeJson(m.content)) : '' };
    const calls = (m.tool_calls ?? []).filter(Boolean).map((c: Any) => ({ id: c.id, name: c.name, arguments: parseArgs(c.arguments) }));
    if (calls.length) msg.tool_calls = calls;
    if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
    return msg;
  });
}

export function lastUserText(msgs: Message[] | null): string | null {
  if (!msgs) return null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    const t = m && m.content != null ? textOf(m.content) : '';
    if (m?.role === 'user' && t.trim()) return t;
  }
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = msgs[i]?.content != null ? textOf(msgs[i].content) : '';
    if (t) return t;
  }
  return null;
}

export function assistantText(msgs: Message[] | null): string | null {
  if (!msgs) return null;
  const parts: string[] = [];
  for (const m of msgs) {
    if (!m) continue;
    const t = m.content != null ? textOf(m.content) : '';
    if (t) parts.push(t);
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) parts.push(m.tool_calls.map((t) => `→ ${t.name}(${clip(typeof t.arguments === 'string' ? t.arguments : JSON.stringify(t.arguments ?? {}), 80)})`).join(' '));
  }
  return parts.join(' ') || null;
}

export function previewOf(v: unknown, n = 240): string | null {
  if (v == null) return null;
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'role' in v[0]) {
    return clip(lastUserText(v as Message[]) ?? assistantText(v as Message[]), n);
  }
  if (typeof v === 'string') return clip(v, n);
  return clip(JSON.stringify(v), n);
}

export function outputPreviewOf(v: unknown, n = 240): string | null {
  if (v == null) return null;
  if (Array.isArray(v) && v.length && typeof v[0] === 'object' && v[0] && 'role' in v[0]) return clip(assistantText(v as Message[]), n);
  if (typeof v === 'string') return clip(v, n);
  return clip(JSON.stringify(v), n);
}
