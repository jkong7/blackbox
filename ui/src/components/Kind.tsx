import type { ReactElement } from 'react';
import type { Kind } from '../api.ts';
import { I } from './Icons.tsx';

export function kindColor(kind: string): string {
  return `var(--k-${kind in KIND_LABEL ? kind : 'span'})`;
}

export const KIND_LABEL: Record<Kind, string> = {
  agent: 'Agent',
  llm: 'LLM',
  tool: 'Tool',
  mcp: 'MCP',
  memory: 'Memory',
  retriever: 'Retriever',
  embedding: 'Embedding',
  chain: 'Chain',
  guardrail: 'Guardrail',
  handoff: 'Handoff',
  evaluator: 'Evaluator',
  span: 'Span',
};

export function KindIcon({ kind, size = 18 }: { kind: string; size?: number }) {
  const Ico = (I as Record<string, (p: { size?: number }) => ReactElement>)[kind] ?? I.span;
  const c = kindColor(kind);
  return (
    <span className="kind-ico" style={{ width: size, height: size, color: c, background: `color-mix(in srgb, ${c} 14%, transparent)` }} title={KIND_LABEL[kind as Kind] ?? kind}>
      <Ico size={Math.round(size * 0.68)} />
    </span>
  );
}

export function KindChip({ kind, count }: { kind: string; count?: number }) {
  return (
    <span className="chip sq">
      <span className="dot" style={{ background: kindColor(kind), borderRadius: 2 }} />
      {KIND_LABEL[kind as Kind] ?? kind}
      {count != null && <span className="muted num">{count}</span>}
    </span>
  );
}
