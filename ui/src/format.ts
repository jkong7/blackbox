export function fmtCost(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '-';
  if (v === 0) return '$0';
  const a = Math.abs(v);
  if (a < 0.0001) return '<$0.0001';
  if (a < 0.01) return '$' + v.toFixed(4);
  if (a < 1) return '$' + v.toFixed(3);
  if (a < 1000) return '$' + v.toFixed(2);
  return '$' + fmtCompact(v);
}

export function fmtCompact(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '-';
  const a = Math.abs(v);
  if (a < 1000) return Number.isInteger(v) ? String(v) : v.toFixed(a < 10 ? 2 : 1).replace(/\.?0+$/, '');
  if (a < 1e6) return trim((v / 1e3).toFixed(a < 1e4 ? digits : a < 1e5 ? digits : 0)) + 'k';
  if (a < 1e9) return trim((v / 1e6).toFixed(a < 1e7 ? 2 : 1)) + 'M';
  return trim((v / 1e9).toFixed(2)) + 'B';
}

function trim(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

export function fmtTokens(v: number | null | undefined): string {
  if (v == null) return '-';
  return fmtCompact(v);
}

export function fmtInt(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '-';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtMs(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '-';
  if (v < 1) return v.toFixed(2) + 'ms';
  if (v < 1000) return Math.round(v) + 'ms';
  if (v < 10e3) return (v / 1000).toFixed(2).replace(/0$/, '') + 's';
  if (v < 60e3) return (v / 1000).toFixed(1) + 's';
  const m = Math.floor(v / 60e3);
  const s = Math.round((v % 60e3) / 1000);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '-';
  const p = v * 100;
  if (p !== 0 && Math.abs(p) < 0.1) return '<0.1%';
  if (p === 0 || p === 100) return p + '%';
  return p.toFixed(digits) + '%';
}

export function nsToMs(ns: number): number {
  return ns / 1e6;
}

export function fmtAgo(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null) return '-';
  const d = Math.max(0, now - ms);
  if (d < 5e3) return 'just now';
  if (d < 60e3) return Math.floor(d / 1e3) + 's ago';
  if (d < 3600e3) return Math.floor(d / 60e3) + 'm ago';
  if (d < 86400e3) return Math.floor(d / 3600e3) + 'h ago';
  if (d < 30 * 86400e3) return Math.floor(d / 86400e3) + 'd ago';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function agoNs(ns: number | null | undefined): string {
  return ns == null ? '-' : fmtAgo(ns / 1e6);
}

export function fmtTime(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  if (sameDay) return time;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' + time.slice(0, 5);
}

export function fmtDateTime(ms: number | null | undefined): string {
  if (ms == null) return '-';
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function shortId(id: string | null | undefined, n = 8): string {
  if (!id) return '-';
  return id.length > n ? id.slice(0, n) : id;
}

export function humanize(s: string | null | undefined): string {
  if (!s) return '';
  const t = s.replace(/_/g, ' ');
  return t.charAt(0).toUpperCase() + t.slice(1);
}

export function pretty(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') {
    const t = v.trim();
    if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
      try {
        return JSON.stringify(JSON.parse(t), null, 2);
      } catch {
        return v;
      }
    }
    return v;
  }
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function oneLine(v: unknown, max = 160): string {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  const c = s.replace(/\s+/g, ' ').trim();
  return c.length > max ? c.slice(0, max - 1) + '…' : c;
}

export function scoreText(s: { value: number | null; label: string | null }): string {
  if (s.label) return s.label;
  if (s.value == null) return '-';
  return s.value <= 1 ? s.value.toFixed(2) : String(s.value);
}

const PASS = ['pass', 'yes', 'true', 'correct', 'good', 'improved'];
const FAIL = ['fail', 'no', 'false', 'incorrect', 'bad', 'regressed'];

export function scoreTone(s: { value: number | null; label: string | null }): 'good' | 'bad' | 'mid' | 'neutral' {
  const l = s.label?.toLowerCase();
  if (l && PASS.includes(l)) return 'good';
  if (l && FAIL.includes(l)) return 'bad';
  if (s.value == null) return 'neutral';
  if (s.value >= 0.75) return 'good';
  if (s.value < 0.5) return 'bad';
  return 'mid';
}
