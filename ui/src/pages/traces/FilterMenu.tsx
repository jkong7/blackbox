import { useEffect, useRef, useState, type ReactNode } from 'react';
import { I } from '../../components/Icons.tsx';

export interface FilterOption {
  value: string;
  label: string;
}

export function FilterMenu({ label, value, options, onChange, render }: { label: string; value: string; options: FilterOption[]; onChange: (v: string | null) => void; render?: (o: FilterOption) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', h);
    return () => window.removeEventListener('mousedown', h);
  }, [open]);
  useEffect(() => {
    setQ('');
    setSel(0);
  }, [open]);
  const shown = options.filter((o) => !q || o.label.toLowerCase().includes(q.toLowerCase()));
  const active = options.find((o) => o.value === value);
  const pick = (v: string) => {
    onChange(v === value ? null : v);
    setOpen(false);
  };
  return (
    <div className="fmenu" ref={ref}>
      <span className={'chip fchip' + (value ? ' accent' : '')}>
        <button className="fchip-main" onClick={() => setOpen(!open)} aria-haspopup="listbox" aria-expanded={open}>
          <span className={value ? '' : 'dim'}>{label}</span>
          {value && <b className="ellipsis" style={{ maxWidth: 160 }}>{active?.label ?? value}</b>}
          {!value && <I.chevronDown size={10} />}
        </button>
        {value && (
          <button className="fchip-x" onClick={() => onChange(null)} aria-label={`Clear ${label}`}>
            <I.x size={10} />
          </button>
        )}
      </span>
      {open && (
        <div className="fmenu-pop">
          {options.length > 7 && (
            <input
              className="input"
              autoFocus
              placeholder={`Filter ${label.toLowerCase()}…`}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') setSel((s) => Math.min(shown.length - 1, s + 1));
                if (e.key === 'ArrowUp') setSel((s) => Math.max(0, s - 1));
                if (e.key === 'Enter' && shown[sel]) pick(shown[sel].value);
                if (e.key === 'Escape') setOpen(false);
              }}
            />
          )}
          <div className="fmenu-list" role="listbox">
            {shown.length === 0 && <div className="muted" style={{ padding: '8px 10px' }}>No values</div>}
            {shown.map((o, i) => (
              <div key={o.value} role="option" aria-selected={o.value === value} className={'fmenu-item' + (i === sel ? ' on' : '')} onMouseMove={() => setSel(i)} onClick={() => pick(o.value)}>
                <span className="fmenu-check">{o.value === value && <I.check size={12} />}</span>
                {render ? render(o) : <span className="ellipsis">{o.label}</span>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
