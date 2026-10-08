import { useState } from 'react';
import type { Message, ToolCall } from '../../api.ts';
import { JsonView } from '../../components/JsonView.tsx';
import { Disclosure } from '../../components/ui.tsx';
import { I } from '../../components/Icons.tsx';
import { oneLine } from '../../format.ts';

const ROLE_COLOR: Record<string, string> = {
  system: 'var(--muted)',
  user: 'var(--k-handoff)',
  assistant: 'var(--k-llm)',
  tool: 'var(--k-tool)',
};

function Body({ text, cls }: { text: string; cls?: string }) {
  const long = text.length > 1200 || text.split('\n').length > 14;
  const [open, setOpen] = useState(!long);
  return (
    <div>
      <div className={'msg-body' + (cls ? ' ' + cls : '')}>
        <div className={open ? '' : 'msg-clamp'}>{text}</div>
      </div>
      {long && (
        <button className="btn ghost sm" style={{ marginTop: 4 }} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

export function ToolCallCard({ call, result, resultError }: { call: ToolCall; result?: string | null; resultError?: boolean }) {
  return (
    <div className="stack" style={{ gap: 4 }}>
      <div className="toolcall">
        <div className="toolcall-head">
          <I.tool size={13} style={{ color: 'var(--k-tool)' }} />
          <span className="nm">{call.name}</span>
          {call.id && <span className="muted mono" style={{ fontSize: 11, marginLeft: 'auto' }}>{call.id}</span>}
        </div>
        <JsonView value={call.arguments ?? {}} bare openDepth={4} />
      </div>
      {result != null && (
        <div className="toolres">
          <Disclosure
            summary={
              <span className="row ellipsis" style={{ gap: 6, minWidth: 0 }}>
                <span style={{ color: resultError ? 'var(--bad)' : 'var(--text-2)' }}>{resultError ? 'Error result' : 'Result'}</span>
                <span className="muted ellipsis" style={{ fontWeight: 400 }}>
                  {oneLine(result, 90)}
                </span>
              </span>
            }
          >
            <JsonView value={result} copy={false} bare />
          </Disclosure>
        </div>
      )}
    </div>
  );
}

function contentText(m: Message): string {
  if (typeof m.content === 'string') return m.content;
  if (m.content == null) return '';
  return JSON.stringify(m.content, null, 2);
}

export function MessageList({ messages, output, collapseHistory }: { messages: Message[]; output?: Message[] | null; collapseHistory?: boolean }) {
  const results = new Map<string, Message>();
  for (const m of messages) if (m.role === 'tool' && m.tool_call_id) results.set(m.tool_call_id, m);
  const shown = messages.filter((m) => !(m.role === 'tool' && m.tool_call_id && messages.some((x) => x.tool_calls?.some((c) => c.id === m.tool_call_id))));
  const [showAll, setShowAll] = useState(!collapseHistory || shown.length <= 7);
  const firstUser = shown.findIndex((m) => m.role === 'user');
  const head = showAll ? shown : shown.slice(0, Math.max(1, Math.min(3, firstUser + 1)));
  const tail = showAll ? [] : shown.slice(-3);
  const hidden = shown.length - head.length - tail.length;
  return (
    <div className="stack" style={{ gap: 14 }}>
      {head.map((m, i) => (
        <MessageView key={'h' + i} m={m} results={results} />
      ))}
      {hidden > 0 && (
        <button className="btn sm" style={{ alignSelf: 'center' }} onClick={() => setShowAll(true)}>
          Show {hidden} earlier {hidden === 1 ? 'message' : 'messages'}
        </button>
      )}
      {tail.map((m, i) => (
        <MessageView key={'t' + i} m={m} results={results} />
      ))}
      {output && output.length > 0 && (
        <>
          <div className="row" style={{ gap: 8 }}>
            <div className="msg-sep" style={{ flex: 1 }} />
            <span className="muted" style={{ fontSize: 11 }}>
              Output
            </span>
            <div className="msg-sep" style={{ flex: 1 }} />
          </div>
          {output.map((m, i) => (
            <MessageView key={'o' + i} m={m} results={results} isOutput />
          ))}
        </>
      )}
    </div>
  );
}

function MessageView({ m, results, isOutput }: { m: Message; results: Map<string, Message>; isOutput?: boolean }) {
  const text = contentText(m);
  const color = ROLE_COLOR[m.role] ?? 'var(--muted)';
  return (
    <div className={'msg ' + m.role + (isOutput ? ' output' : '')}>
      <div className="msg-role">
        <span className="ri" style={{ background: color }} />
        {m.role}
        {m.name && <span className="muted mono" style={{ fontWeight: 400 }}>{m.name}</span>}
        {m.role === 'tool' && m.tool_call_id && <span className="muted mono" style={{ fontWeight: 400, fontSize: 11 }}>{m.tool_call_id}</span>}
      </div>
      {m.reasoning && (
        <div className="toolres">
          <Disclosure summary={<span className="dim">Reasoning</span>}>
            <div className="prose dim" style={{ fontSize: 12.5 }}>
              {m.reasoning}
            </div>
          </Disclosure>
        </div>
      )}
      {text && (m.role === 'tool' ? <JsonView value={text} copy={false} maxHeight={260} /> : <Body text={text} />)}
      {m.tool_calls?.map((c, i) => {
        const r = c.id ? results.get(c.id) : undefined;
        const rt = r ? contentText(r) : undefined;
        return <ToolCallCard key={c.id ?? i} call={c} result={rt} resultError={!!rt && /error|failed|exception|denied|forbidden|\b4\d\d\b/i.test(rt.slice(0, 200))} />;
      })}
      {!text && !m.tool_calls?.length && !m.reasoning && <div className="muted" style={{ fontSize: 12 }}>Empty message</div>}
    </div>
  );
}
