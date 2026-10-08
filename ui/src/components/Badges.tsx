import type { ScoreBadge, Severity } from '../api.ts';
import { humanize, scoreText, scoreTone } from '../format.ts';

const SEV_CLASS: Record<string, string> = { high: 'bad', medium: 'serious', low: 'warn' };

export function SignalChip({ type, severity, count, onClick, title }: { type: string; severity: Severity | string; count?: number; onClick?: () => void; title?: string }) {
  return (
    <span className={'chip sq ' + (SEV_CLASS[severity] ?? 'warn') + (onClick ? ' btn-chip' : '')} onClick={onClick} title={title ?? `${humanize(type)} (${severity})`}>
      <span className={'sev ' + severity} />
      {humanize(type)}
      {count != null && count > 1 && <span className="num">×{count}</span>}
    </span>
  );
}

export function ScoreChip({ s, title, nameWidth = 110 }: { s: ScoreBadge; title?: string; nameWidth?: number }) {
  const tone = scoreTone(s);
  return (
    <span className={'chip ' + (tone === 'neutral' ? 'neutral' : tone)} title={title ?? `${s.name}: ${scoreText(s)}`}>
      <span className="ellipsis" style={{ maxWidth: nameWidth }}>{s.name}</span>
      <b className="num" style={{ fontWeight: 600 }}>{scoreText(s)}</b>
    </span>
  );
}

export function SeverityLabel({ severity }: { severity: string }) {
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className={'sev ' + severity} />
      <span className="dim">{humanize(severity)}</span>
    </span>
  );
}

export function TraceStatus({ errors, flagged, label = true }: { errors: number; flagged: number; label?: boolean }) {
  const s = errors > 0 ? 'error' : flagged > 0 ? 'flagged' : 'ok';
  const text = s === 'error' ? 'Error' : s === 'flagged' ? 'Flagged' : 'Clean';
  return (
    <span className="row" style={{ gap: 6 }} title={text}>
      <span className={'status-dot ' + s} />
      {label && <span className={s === 'ok' ? 'dim' : ''} style={{ color: s === 'error' ? 'var(--bad)' : s === 'flagged' ? 'var(--serious)' : undefined }}>{text}</span>}
    </span>
  );
}
