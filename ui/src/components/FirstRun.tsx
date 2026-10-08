import { Link } from '../router.tsx';
import { CopyButton } from './ui.tsx';

export function FirstRun() {
  return (
    <div className="card" style={{ padding: '36px 24px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, textAlign: 'center' }}>
      <div style={{ width: 40, height: 40, borderRadius: 8, background: 'var(--text)', position: 'relative' }}>
        <span style={{ position: 'absolute', left: 9, right: 9, top: 19, height: 3, borderRadius: 2, background: 'var(--accent)' }} />
      </div>
      <div style={{ fontSize: 16, fontWeight: 600 }}>The recorder is on. Nothing has flown yet.</div>
      <div className="dim" style={{ maxWidth: 520, lineHeight: 1.6 }}>
        Point an agent at blackbox and every LLM call, tool call, MCP message and memory operation lands here. Or load realistic demo traces to look around first.
      </div>
      <div className="row" style={{ gap: 8, marginTop: 4 }}>
        <Link to="/connect" className="btn primary">
          Connect an agent
        </Link>
        <span className="row code-block" style={{ padding: '3px 4px 3px 10px', gap: 6 }}>
          <span className="mono">blackbox demo</span>
          <CopyButton text="blackbox demo" />
        </span>
      </div>
    </div>
  );
}
