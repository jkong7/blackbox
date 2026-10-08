import { useState } from 'react';
import type { CodeCheck } from '../../api.ts';
import { Field, Switch } from '../../components/ui.tsx';

type ParamKind = 'text' | 'number' | 'list' | 'bool' | 'select';

interface ParamSpec {
  key: string;
  label: string;
  kind: ParamKind;
  options?: string[];
  placeholder?: string;
  hint?: string;
}

const FIELD: ParamSpec = { key: 'field', label: 'Field', kind: 'select', options: ['output', 'input', 'expected'] };

export const PARAM_SPECS: Record<CodeCheck, ParamSpec[]> = {
  no_error: [],
  regex: [{ key: 'pattern', label: 'Pattern', kind: 'text', placeholder: '^\\{.*\\}$' }, { key: 'flags', label: 'Flags', kind: 'text', placeholder: 'i' }, FIELD, { key: 'negate', label: 'Fail on match', kind: 'bool' }],
  contains: [{ key: 'values', label: 'Values', kind: 'list', placeholder: 'refund, order number', hint: 'Comma separated' }, FIELD, { key: 'any', label: 'Pass if any value is present', kind: 'bool' }, { key: 'case_sensitive', label: 'Case sensitive', kind: 'bool' }],
  not_contains: [{ key: 'values', label: 'Forbidden values', kind: 'list', placeholder: 'as an AI, I cannot', hint: 'Comma separated' }, FIELD, { key: 'case_sensitive', label: 'Case sensitive', kind: 'bool' }],
  json_valid: [{ key: 'required_keys', label: 'Required keys', kind: 'list', placeholder: 'answer, sources', hint: 'Comma separated, optional' }, { key: 'field', label: 'Field', kind: 'select', options: ['output', 'input'] }],
  latency: [{ key: 'max_ms', label: 'Max duration (ms)', kind: 'number', placeholder: '60000' }],
  cost: [{ key: 'max_usd', label: 'Max cost (USD)', kind: 'number', placeholder: '0.5' }],
  max_steps: [{ key: 'max', label: 'Max steps', kind: 'number', placeholder: '25' }],
  tool_called: [{ key: 'tools', label: 'Tools', kind: 'list', placeholder: 'run_tests', hint: 'Comma separated' }, { key: 'min_count', label: 'Min calls each', kind: 'number', placeholder: '1' }, { key: 'any', label: 'Pass if any tool was called', kind: 'bool' }, { key: 'negate', label: 'Fail if called', kind: 'bool' }],
  trajectory_match: [{ key: 'expected', label: 'Expected tool sequence', kind: 'list', placeholder: 'search_docs, read_file, run_tests', hint: 'Comma separated. Leave empty to use the dataset item trajectory.' }, { key: 'mode', label: 'Mode', kind: 'select', options: ['strict', 'unordered', 'subset', 'superset'] }],
  output_length: [{ key: 'min', label: 'Min', kind: 'number' }, { key: 'max', label: 'Max', kind: 'number' }, { key: 'unit', label: 'Unit', kind: 'select', options: ['chars', 'words'] }, FIELD],
};

export function CodeParams({ check, params, onChange }: { check: CodeCheck; params: Record<string, unknown>; onChange: (p: Record<string, unknown>) => void }) {
  const specs = PARAM_SPECS[check] ?? [];
  if (!specs.length) return <div className="muted">This check takes no parameters.</div>;
  const set = (k: string, v: unknown) => {
    const next = { ...params };
    if (v === '' || v === undefined || v === false || (Array.isArray(v) && !v.length)) delete next[k];
    else next[k] = v;
    onChange(next);
  };
  return (
    <div className="ev-params">
      {specs.map((s) => {
        const v = params[s.key];
        if (s.kind === 'bool') {
          return (
            <label key={s.key} className="row ev-bool">
              <Switch on={!!v} onChange={(x) => set(s.key, x)} label={s.label} />
              <span>{s.label}</span>
            </label>
          );
        }
        let input;
        if (s.kind === 'select') {
          input = (
            <select className="select" value={String(v ?? s.options![0])} onChange={(e) => set(s.key, e.target.value === s.options![0] ? '' : e.target.value)}>
              {s.options!.map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>
          );
        } else if (s.kind === 'number') {
          input = <input className="input num" type="number" step="any" value={v == null ? '' : String(v)} placeholder={s.placeholder} onChange={(e) => set(s.key, e.target.value === '' ? '' : Number(e.target.value))} />;
        } else if (s.kind === 'list') {
          input = <ListInput value={Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)]} placeholder={s.placeholder} onChange={(x) => set(s.key, x)} />;
        } else {
          input = <input className="input mono" value={v == null ? '' : String(v)} placeholder={s.placeholder} onChange={(e) => set(s.key, e.target.value)} />;
        }
        return (
          <Field key={s.key} label={s.label} hint={s.hint}>
            {input}
          </Field>
        );
      })}
    </div>
  );
}

function ListInput({ value, onChange, placeholder }: { value: string[]; onChange: (v: string[]) => void; placeholder?: string }) {
  const [raw, setRaw] = useState(value.join(', '));
  return (
    <input
      className="input mono"
      value={raw}
      placeholder={placeholder}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(
          e.target.value
            .split(',')
            .map((x) => x.trim())
            .filter(Boolean),
        );
      }}
    />
  );
}
