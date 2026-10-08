import { useRef, useState } from 'react';
import { api, type CodeCheck } from '../../api.ts';
import { Field, Modal, Seg } from '../../components/ui.tsx';
import { useToast } from '../../components/Toast.tsx';
import { CHECKS, VARIABLES, errText, type EvalConfig, type EvaluatorRow } from './types.ts';
import { CodeParams } from './CodeParams.tsx';
import { TestOnTrace } from './TestOnTrace.tsx';

type Type = 'llm_judge' | 'code';
type Target = 'trace' | 'llm' | 'tool' | 'session';
type Output = 'binary' | 'score' | 'label';

const STARTER = `Question: did the agent do what the user asked, without inventing results?

Pass if: the final answer delivers the request and every claim is backed by a successful step.
Fail if: the answer is partial, unverified, or claims work that the trajectory does not show.

<user_input>
{{input}}
</user_input>

<trajectory>
{{trajectory}}
</trajectory>

<final_output>
{{output}}
</final_output>`;

export function EvaluatorForm({ initial, onClose, onSaved }: { initial?: EvaluatorRow | null; onClose: () => void; onSaved: (e: EvaluatorRow) => void }) {
  const toast = useToast();
  const editing = !!initial && !initial.builtin;
  const cfg: EvalConfig = initial?.config ?? {};
  const [name, setName] = useState(initial ? (initial.builtin ? initial.name + '_custom' : initial.name) : '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [type, setType] = useState<Type>(initial?.type ?? 'llm_judge');
  const [target, setTarget] = useState<Target>(initial?.target ?? 'trace');
  const [prompt, setPrompt] = useState(cfg.prompt ?? (initial?.config.template ? '' : STARTER));
  const [output, setOutput] = useState<Output>(cfg.output ?? 'binary');
  const [labels, setLabels] = useState((cfg.labels ?? []).join(', '));
  const [model, setModel] = useState(cfg.model ?? '');
  const [check, setCheck] = useState<CodeCheck>(cfg.check ?? 'no_error');
  const [params, setParams] = useState<Record<string, unknown>>(cfg.params ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const usesTemplate = type === 'llm_judge' && !!cfg.template && !prompt.trim();

  const config = (): EvalConfig => {
    if (type === 'code') return { check, params };
    const c: EvalConfig = { output };
    if (prompt.trim()) c.prompt = prompt;
    else if (cfg.template) c.template = cfg.template;
    if (output === 'label') c.labels = labels.split(',').map((x) => x.trim()).filter(Boolean);
    if (model.trim()) c.model = model.trim();
    if (cfg.pass_labels && output === 'label') c.pass_labels = cfg.pass_labels;
    if (cfg.threshold != null && output === 'score') c.threshold = cfg.threshold;
    return c;
  };

  const body = () => ({ name: name.trim(), description: description.trim() || null, type, target, config: config() });

  const insertVar = (v: string) => {
    const ta = taRef.current;
    const token = `{{${v}}}`;
    if (!ta) {
      setPrompt((p) => p + token);
      return;
    }
    const s = ta.selectionStart ?? prompt.length;
    const e = ta.selectionEnd ?? prompt.length;
    const next = prompt.slice(0, s) + token + prompt.slice(e);
    setPrompt(next);
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(s + token.length, s + token.length);
    });
  };

  const save = async () => {
    if (!name.trim()) {
      setError('Name is required.');
      return;
    }
    if (type === 'llm_judge' && !prompt.trim() && !cfg.template) {
      setError('Write a rubric prompt for the judge.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const saved = editing ? await api.put<EvaluatorRow>(`/api/evaluators/${initial!.id}`, body()) : await api.post<EvaluatorRow>('/api/evaluators', body());
      toast(editing ? 'Evaluator saved' : 'Evaluator created', 'good');
      onSaved(saved);
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(false);
    }
  };

  const used = VARIABLES.filter((v) => prompt.includes(`{{${v.name}}}`)).map((v) => v.name);

  return (
    <Modal
      wide
      title={editing ? `Edit ${initial!.name}` : initial?.builtin ? `New evaluator from ${initial.name}` : 'New evaluator'}
      onClose={onClose}
      footer={
        <>
          {error && <span className="err-text" style={{ marginRight: 'auto', alignSelf: 'center', fontSize: 12 }}>{error}</span>}
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" onClick={save} disabled={busy}>
            {busy ? 'Saving' : editing ? 'Save changes' : 'Create evaluator'}
          </button>
        </>
      }
    >
      <div className="ev-form-grid">
        <Field label="Name">
          <input className="input mono" value={name} autoFocus onChange={(e) => setName(e.target.value)} placeholder="refund_policy_followed" />
        </Field>
        <Field label="Type">
          <Seg<Type> value={type} onChange={setType} options={[{ value: 'llm_judge', label: 'LLM judge' }, { value: 'code', label: 'Code check' }]} />
        </Field>
        <Field label="Target">
          <Seg<Target> value={target} onChange={setTarget} options={['trace', 'llm', 'tool', 'session']} />
        </Field>
      </div>
      <Field label="Description">
        <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What a pass means, in one sentence" />
      </Field>
      {type === 'llm_judge' ? (
        <>
          <Field
            label="Rubric prompt"
            hint={usesTemplate ? `Using the built-in ${cfg.template} template. Write a prompt to override it.` : 'The judge reasons first, then returns {reasoning, label, score}. Keep one binary question per judge.'}
          >
            <div className="ev-vars">
              <span className="muted">Insert</span>
              {VARIABLES.map((v) => (
                <button key={v.name} type="button" className={'chip btn-chip mono' + (used.includes(v.name) ? ' accent' : '')} title={v.hint} onClick={() => insertVar(v.name)}>
                  {`{{${v.name}}}`}
                </button>
              ))}
            </div>
            <textarea ref={taRef} className="textarea mono ev-prompt" rows={14} value={prompt} placeholder={usesTemplate ? `Built-in template: ${cfg.template}` : 'Write the rubric'} onChange={(e) => setPrompt(e.target.value)} spellCheck={false} />
          </Field>
          <div className="ev-form-grid">
            <Field label="Output">
              <Seg<Output> value={output} onChange={setOutput} options={[{ value: 'binary', label: 'Pass / fail' }, { value: 'score', label: 'Score 0 to 1' }, { value: 'label', label: 'Labels' }]} />
            </Field>
            {output === 'label' && (
              <Field label="Labels" hint="Comma separated">
                <input className="input mono" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="good, partial, bad" />
              </Field>
            )}
            <Field label="Judge model" hint="Empty uses the judge default">
              <input className="input mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="claude-haiku-5-5" />
            </Field>
          </div>
        </>
      ) : (
        <>
          <Field label="Check" hint={CHECKS.find((c) => c.id === check)?.hint}>
            <select
              className="select"
              value={check}
              onChange={(e) => {
                setCheck(e.target.value as CodeCheck);
                setParams({});
              }}
            >
              {CHECKS.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </Field>
          <CodeParams key={check} check={check} params={params} onChange={setParams} />
        </>
      )}
      <hr className="sep" />
      <TestOnTrace evaluator={{ name: name.trim() || 'test', type, target, config: config() }} />
    </Modal>
  );
}
