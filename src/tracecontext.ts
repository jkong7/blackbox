export interface TraceParent {
  traceId: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(v: unknown): TraceParent | null {
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== 'string') return null;
  const m = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-|$)/.exec(s.trim().toLowerCase());
  if (!m || m[1] === 'ff') return null;
  if (m[1] === '00' && m[5] === '-') return null;
  if (/^0+$/.test(m[2]) || /^0+$/.test(m[3])) return null;
  return { traceId: m[2], spanId: m[3], flags: m[4] };
}

export function formatTraceparent(traceId: string, spanId: string, sampled = true): string {
  return `00-${traceId}-${spanId}-${sampled ? '01' : '00'}`;
}
