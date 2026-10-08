import { useState, type ReactNode } from 'react';
import { CopyButton } from './ui.tsx';
import { pretty } from '../format.ts';

function parseMaybe(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      return JSON.parse(t);
    } catch {
      return v;
    }
  }
  return v;
}

function Prim({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="z">null</span>;
  if (typeof v === 'string') return <span className="s">{JSON.stringify(v)}</span>;
  if (typeof v === 'number') return <span className="n">{String(v)}</span>;
  if (typeof v === 'boolean') return <span className="b">{String(v)}</span>;
  return <span>{String(v)}</span>;
}

function Node({ k, v, depth, last, openDepth }: { k?: string; v: unknown; depth: number; last: boolean; openDepth: number }) {
  const isArr = Array.isArray(v);
  const isObj = v !== null && typeof v === 'object';
  const [open, setOpen] = useState(depth < openDepth);
  const pad = { paddingLeft: depth ? 14 : 0 };
  const keyEl: ReactNode = k !== undefined ? (
    <>
      <span className="k">{JSON.stringify(k)}</span>
      {': '}
    </>
  ) : null;
  const comma = last ? '' : ',';
  if (!isObj) {
    return (
      <div style={pad}>
        <span className="tg" />
        {keyEl}
        <Prim v={v} />
        {comma}
      </div>
    );
  }
  const entries: [string, unknown][] = isArr ? (v as unknown[]).map((x, i) => [String(i), x]) : Object.entries(v as Record<string, unknown>);
  const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
  if (!entries.length) {
    return (
      <div style={pad}>
        <span className="tg" />
        {keyEl}
        {o + c}
        {comma}
      </div>
    );
  }
  if (!open) {
    return (
      <div style={pad}>
        <span className="tg" onClick={() => setOpen(true)}>
          ▸
        </span>
        {keyEl}
        <span className="coll" onClick={() => setOpen(true)}>
          {o} {entries.length} {isArr ? (entries.length === 1 ? 'item' : 'items') : entries.length === 1 ? 'key' : 'keys'} {c}
        </span>
        {comma}
      </div>
    );
  }
  return (
    <div style={pad}>
      <span className="tg" onClick={() => setOpen(false)}>
        ▾
      </span>
      {keyEl}
      {o}
      {entries.map(([ek, ev], i) => (
        <Node key={ek} k={isArr ? undefined : ek} v={ev} depth={depth + 1} last={i === entries.length - 1} openDepth={openDepth} />
      ))}
      <div style={{ paddingLeft: 12 }}>
        {c}
        {comma}
      </div>
    </div>
  );
}

export function JsonView({ value, openDepth = 3, copy = true, maxHeight = 520, bare }: { value: unknown; openDepth?: number; copy?: boolean; maxHeight?: number | 'none'; bare?: boolean }) {
  const v = parseMaybe(value);
  const isObj = v !== null && typeof v === 'object';
  const body = isObj ? (
    <div className="json">
      <Node v={v} depth={0} last openDepth={openDepth} />
    </div>
  ) : (
    <pre className="json">{v == null ? <span className="z">null</span> : typeof v === 'string' ? v : <Prim v={v} />}</pre>
  );
  if (bare) return body;
  return (
    <div className="code-block" style={{ position: 'relative', maxHeight: maxHeight === 'none' ? undefined : maxHeight }}>
      {copy && (
        <div style={{ position: 'sticky', top: 0, float: 'right', zIndex: 1 }}>
          <CopyButton text={typeof v === 'string' ? v : pretty(v)} />
        </div>
      )}
      {body}
    </div>
  );
}
