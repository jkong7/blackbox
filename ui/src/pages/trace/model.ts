import type { Message, Signal, Span } from '../../api.ts';

export interface TreeNode {
  span: Span;
  depth: number;
  children: TreeNode[];
  subtreeCost: number;
  subtreeTokens: number;
  hasError: boolean;
}

export interface Tree {
  roots: TreeNode[];
  byId: Map<string, TreeNode>;
  start: number;
  end: number;
}

export function buildTree(spans: Span[]): Tree {
  const byId = new Map<string, TreeNode>();
  for (const s of spans) byId.set(s.span_id, { span: s, depth: 0, children: [], subtreeCost: 0, subtreeTokens: 0, hasError: false });
  const roots: TreeNode[] = [];
  for (const n of byId.values()) {
    const p = n.span.parent_id ? byId.get(n.span.parent_id) : undefined;
    if (p && p !== n) p.children.push(n);
    else roots.push(n);
  }
  const sortKids = (xs: TreeNode[]) => xs.sort((a, b) => a.span.start_ns - b.span.start_ns || a.span.span_id.localeCompare(b.span.span_id));
  const visit = (n: TreeNode, depth: number, seen: Set<string>) => {
    if (seen.has(n.span.span_id)) return;
    seen.add(n.span.span_id);
    n.depth = depth;
    sortKids(n.children);
    n.subtreeCost = n.span.cost_usd ?? 0;
    n.subtreeTokens = spanTokens(n.span);
    n.hasError = n.span.status === 'error';
    for (const c of n.children) {
      visit(c, depth + 1, seen);
      n.subtreeCost += c.subtreeCost;
      n.subtreeTokens += c.subtreeTokens;
      n.hasError ||= c.hasError;
    }
  };
  sortKids(roots);
  const seen = new Set<string>();
  for (const r of roots) visit(r, 0, seen);
  let start = Infinity;
  let end = -Infinity;
  for (const s of spans) {
    start = Math.min(start, s.start_ns);
    end = Math.max(end, s.end_ns ?? s.start_ns + (s.duration_ms ?? 0) * 1e6);
  }
  if (!isFinite(start)) start = end = 0;
  return { roots, byId, start, end };
}

export function flatten(tree: Tree, collapsed: Set<string>, keep?: Set<string> | null): TreeNode[] {
  const out: TreeNode[] = [];
  const walk = (n: TreeNode) => {
    if (keep && !keep.has(n.span.span_id)) return;
    out.push(n);
    if (collapsed.has(n.span.span_id)) return;
    for (const c of n.children) walk(c);
  };
  for (const r of tree.roots) walk(r);
  return out;
}

export function withAncestors(tree: Tree, ids: Iterable<string>): Set<string> {
  const out = new Set<string>();
  for (const id of ids) {
    let n = tree.byId.get(id);
    while (n && !out.has(n.span.span_id)) {
      out.add(n.span.span_id);
      n = n.span.parent_id ? tree.byId.get(n.span.parent_id) : undefined;
    }
  }
  return out;
}

export function spanTokens(s: Span): number {
  return (s.input_tokens ?? 0) + (s.output_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0);
}

export function promptTokens(s: Span): number {
  return (s.input_tokens ?? 0) + (s.cache_read_tokens ?? 0) + (s.cache_write_tokens ?? 0);
}

export function displayName(s: Span): string {
  switch (s.kind) {
    case 'llm':
      return s.model ?? s.name;
    case 'tool':
      return s.tool_name ?? s.name;
    case 'mcp':
      return (s.mcp_server ? s.mcp_server + ' · ' : '') + (s.tool_name ?? s.mcp_method ?? s.name);
    case 'memory':
      return (s.memory_op ? s.memory_op + ' · ' : '') + (s.tool_name ?? s.name);
    case 'agent':
      return s.agent_name ?? s.name;
    default:
      return s.name;
  }
}

export function subtitle(s: Span): string {
  if (s.kind === 'llm') return s.finish_reason ? s.finish_reason : s.operation ?? '';
  if (s.kind === 'agent') return s.operation && s.operation !== 'invoke_agent' ? s.operation : '';
  return '';
}

export function asMessages(v: unknown): Message[] | null {
  if (!Array.isArray(v) || !v.length) return null;
  if (!v.every((m) => m && typeof m === 'object' && typeof (m as Message).role === 'string')) return null;
  return v as Message[];
}

export function signalSpanIds(sig: Signal, known: Map<string, unknown>): string[] {
  const out = new Set<string>();
  if (sig.span_id && known.has(sig.span_id)) out.add(sig.span_id);
  const scan = (v: unknown) => {
    if (typeof v === 'string') {
      if (known.has(v)) out.add(v);
    } else if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') Object.values(v).forEach(scan);
  };
  scan(sig.detail);
  return [...out];
}

export function firstUserInput(spans: Span[], tree: Tree): string | null {
  for (const r of tree.roots) {
    const v = r.span.input;
    if (typeof v === 'string' && v.trim()) return v;
    const msgs = asMessages(v);
    const u = msgs?.filter((m) => m.role === 'user' && m.content).pop();
    if (u?.content) return u.content;
  }
  for (const s of spans) {
    const msgs = asMessages(s.input);
    const u = msgs?.find((m) => m.role === 'user' && m.content);
    if (u?.content) return u.content;
  }
  return spans.find((s) => s.input_preview)?.input_preview ?? null;
}

export function finalOutput(tree: Tree, spans: Span[]): string | null {
  for (const r of tree.roots) {
    const v = r.span.output;
    if (typeof v === 'string' && v.trim()) return v;
    const msgs = asMessages(v);
    const a = msgs?.filter((m) => m.role === 'assistant' && m.content).pop();
    if (a?.content) return a.content;
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    const s = spans[i];
    if (s.kind !== 'llm') continue;
    const a = asMessages(s.output)?.filter((m) => m.role === 'assistant' && m.content).pop();
    if (a?.content) return a.content;
  }
  return null;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  calls: number;
  errors: number;
  cost: number;
  ms: number;
  spanIds: string[];
  layer: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  count: number;
}

export function graphKey(s: Span, parentAgent: string | null): { id: string; kind: string; label: string } {
  if (s.kind === 'agent') return { id: 'agent:' + (s.agent_name ?? s.name), kind: 'agent', label: s.agent_name ?? s.name };
  if (s.kind === 'llm') return { id: 'llm:' + (parentAgent ?? '') + ':' + (s.model ?? s.name), kind: 'llm', label: s.model ?? s.name };
  if (s.kind === 'tool' || s.kind === 'mcp' || s.kind === 'memory' || s.kind === 'retriever') {
    const n = s.tool_name ?? s.mcp_method ?? s.name;
    return { id: s.kind + ':' + (s.mcp_server ?? '') + ':' + n, kind: s.kind, label: (s.mcp_server ? s.mcp_server + ' · ' : '') + n };
  }
  return { id: s.kind + ':' + s.name, kind: s.kind, label: s.name };
}

export function buildGraph(tree: Tree): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const addEdge = (from: string, to: string) => {
    if (from === to) return;
    const k = from + '>' + to;
    const e = edges.get(k);
    if (e) e.count++;
    else edges.set(k, { from, to, count: 1 });
  };
  const walk = (n: TreeNode, parentNode: string | null, agent: string | null) => {
    const s = n.span;
    const passthrough = (s.kind === 'chain' || s.kind === 'span') && n.children.length > 0;
    let here = parentNode;
    let nextAgent = agent;
    if (!passthrough) {
      const g = graphKey(s, agent);
      let node = nodes.get(g.id);
      if (!node) {
        node = { ...g, calls: 0, errors: 0, cost: 0, ms: 0, spanIds: [], layer: 0 };
        nodes.set(g.id, node);
      }
      node.calls++;
      node.errors += s.status === 'error' ? 1 : 0;
      node.cost += s.cost_usd ?? 0;
      node.ms += s.duration_ms ?? 0;
      node.spanIds.push(s.span_id);
      if (parentNode) addEdge(parentNode, g.id);
      here = g.id;
      if (s.kind === 'agent') nextAgent = s.agent_name ?? s.name;
    }
    let prevLlm: string | null = null;
    for (const c of n.children) {
      const k = c.span.kind;
      const fromLlm = prevLlm && (k === 'tool' || k === 'mcp' || k === 'memory' || k === 'handoff' || k === 'retriever' || k === 'agent');
      walk(c, fromLlm ? prevLlm : here, nextAgent);
      if (k === 'llm') prevLlm = graphKey(c.span, nextAgent).id;
    }
  };
  for (const r of tree.roots) walk(r, null, null);
  const ns = [...nodes.values()];
  const es = [...edges.values()];
  const first = new Map<string, number>();
  for (const n of ns) first.set(n.id, Math.min(...n.spanIds.map((id) => tree.byId.get(id)?.span.start_ns ?? 0)));
  const before = (a: string, b: string) => {
    const fa = first.get(a) ?? 0;
    const fb = first.get(b) ?? 0;
    return fa < fb || (fa === fb && a < b);
  };
  const layer = new Map<string, number>(ns.map((n) => [n.id, 0]));
  for (let i = 0; i < ns.length; i++) {
    let changed = false;
    for (const e of es) {
      if (!before(e.from, e.to)) continue;
      const d = (layer.get(e.from) ?? 0) + 1;
      if (d > (layer.get(e.to) ?? 0)) {
        layer.set(e.to, d);
        changed = true;
      }
    }
    if (!changed) break;
  }
  for (const n of ns) n.layer = layer.get(n.id) ?? 0;
  return { nodes: ns, edges: es };
}
