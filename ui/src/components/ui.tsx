import { useEffect, useState, type CSSProperties, type ReactNode, type Ref } from 'react';
import { I } from './Icons.tsx';
import { isMissing } from '../api.ts';
import { Link } from '../router.tsx';

export function Card({ title, sub, right, children, flush, className, style }: { title?: ReactNode; sub?: ReactNode; right?: ReactNode; children: ReactNode; flush?: boolean; className?: string; style?: CSSProperties }) {
  return (
    <section className={'card ' + (className ?? '')} style={style}>
      {(title || right) && (
        <div className="card-head">
          {title && <h2>{title}</h2>}
          {sub && <span className="sub">{sub}</span>}
          {right && <div className="right">{right}</div>}
        </div>
      )}
      <div className={'card-body' + (flush ? ' flush' : '')}>{children}</div>
    </section>
  );
}

export function Empty({ title, body, actions, icon, small }: { title: ReactNode; body?: ReactNode; actions?: ReactNode; icon?: ReactNode; small?: boolean }) {
  return (
    <div className={'empty' + (small ? ' sm' : '')}>
      {icon}
      <div className="title">{title}</div>
      {body && <div className="body">{body}</div>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function ErrorState({ error, what, retry }: { error: unknown; what?: string; retry?: () => void }) {
  if (isMissing(error)) {
    return <Empty title={`${what ?? 'This feature'} is not available yet`} body="The server does not expose this endpoint yet. It will appear here as soon as the backend ships it." small />;
  }
  return (
    <Empty
      title="Could not load"
      body={<span className="err-text">{error instanceof Error ? error.message : String(error)}</span>}
      actions={retry && <button className="btn sm" onClick={retry}>Retry</button>}
      small
    />
  );
}

export function Skel({ w = '100%', h = 12, style }: { w?: number | string; h?: number; style?: CSSProperties }) {
  return <div className="skel" style={{ width: w, height: h, ...style }} />;
}

export function SkelRows({ rows = 8, cols = 6, h = 33 }: { rows?: number; cols?: number; h?: number }) {
  return (
    <div>
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} style={{ display: 'flex', gap: 16, padding: '0 10px', alignItems: 'center', height: h, borderBottom: '1px solid var(--border)' }}>
          {Array.from({ length: cols }).map((_, j) => (
            <Skel key={j} w={j === 1 ? '28%' : `${8 + ((i + j) % 3) * 3}%`} h={10} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: ReactNode }[] | T[]; onChange: (v: T) => void; label?: string }) {
  const opts = (options as (T | { value: T; label: ReactNode })[]).map((o) => (typeof o === 'string' ? { value: o, label: o } : o));
  return (
    <div className="seg" role="radiogroup" aria-label={label}>
      {opts.map((o) => (
        <button key={o.value} role="radio" aria-checked={value === o.value} className={value === o.value ? 'on' : ''} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, tabs, onChange, right }: { value: T; tabs: { id: T; label: ReactNode; badge?: ReactNode; icon?: ReactNode }[]; onChange: (v: T) => void; right?: ReactNode }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={value === t.id ? 'on' : ''} onClick={() => onChange(t.id)}>
          {t.icon}
          {t.label}
          {t.badge != null && t.badge !== 0 && <span className="badge">{t.badge}</span>}
        </button>
      ))}
      {right && <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 6, paddingRight: 4 }}>{right}</div>}
    </div>
  );
}

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={'switch' + (on ? ' on' : '')} onClick={() => onChange(!on)} />;
}

export function CopyButton({ text, label, small = true }: { text: string; label?: string; small?: boolean }) {
  const [done, setDone] = useState(false);
  useEffect(() => {
    if (!done) return;
    const t = setTimeout(() => setDone(false), 1400);
    return () => clearTimeout(t);
  }, [done]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    setDone(true);
  };
  return (
    <button className={'btn ghost' + (small ? ' sm' : '') + (label ? '' : ' icon')} onClick={copy} title={label ?? 'Copy'} aria-label={label ?? 'Copy'}>
      {done ? <I.check /> : <I.copy />}
      {label && <span>{done ? 'Copied' : label}</span>}
    </button>
  );
}

export function Modal({ title, children, onClose, footer, wide }: { title: ReactNode; children: ReactNode; onClose: () => void; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={'modal' + (wide ? ' wide' : '')} role="dialog" aria-modal="true">
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="btn ghost sm icon" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close">
            <I.x />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Kpi({ label, value, foot, tone, to, loading }: { label: ReactNode; value: ReactNode; foot?: ReactNode; tone?: 'bad'; to?: string; loading?: boolean }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      {loading ? (
        <Skel w="60%" h={22} style={{ margin: '1px 0' }} />
      ) : to ? (
        <Link to={to} className={'value num' + (tone ? ' ' + tone : '')}>
          {value}
        </Link>
      ) : (
        <div className={'value num' + (tone ? ' ' + tone : '')}>{value}</div>
      )}
      <div className="foot">{loading ? ' ' : (foot ?? ' ')}</div>
    </div>
  );
}

export function BarCell({ value, max, children, color }: { value: number; max: number; children: ReactNode; color?: string }) {
  const w = max > 0 ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className="bar-cell">
      <span>{children}</span>
      <span className="bar">
        <i style={{ width: `${w}%`, background: color }} />
      </span>
    </div>
  );
}

export function SearchInput({ value, onChange, placeholder, autoFocus, inputRef, width, pageSearch }: { value: string; onChange: (v: string) => void; placeholder?: string; autoFocus?: boolean; inputRef?: Ref<HTMLInputElement>; width?: number | string; pageSearch?: boolean }) {
  return (
    <div className="search-box" style={{ width }}>
      <I.search />
      <input ref={inputRef} className="input" value={value} placeholder={placeholder} autoFocus={autoFocus} data-page-search={pageSearch ? '' : undefined} onChange={(e) => onChange(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLInputElement).blur()} />
    </div>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function Disclosure({ summary, children, defaultOpen }: { summary: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="disclosure">
      <button className="disclosure-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <I.chevronDown size={12} /> : <I.chevronRight size={12} />}
        {summary}
      </button>
      {open && <div className="disclosure-body">{children}</div>}
    </div>
  );
}
