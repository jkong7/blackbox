import { useEffect, useRef, useState } from 'react';
import { api, type Page, type Session } from '../../api.ts';
import { PageHeader } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, SearchInput, SkelRows } from '../../components/ui.tsx';
import { SignalChip } from '../../components/Badges.tsx';
import { FirstRun } from '../../components/FirstRun.tsx';
import { useHealth, useLive } from '../../hooks.ts';
import { navigate, useSearchParam, useTitle } from '../../router.tsx';
import { agoNs, fmtCost, fmtMs, fmtTokens, oneLine } from '../../format.ts';
import { severityOf } from './signalSeverity.ts';
import './sessions.css';

export function Sessions() {
  useTitle('Sessions');
  const [q, setQ] = useSearchParam('q');
  const [draft, setDraft] = useState(q);
  const [items, setItems] = useState<Session[] | undefined>(undefined);
  const [next, setNext] = useState<number | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const { tick } = useLive();
  const { health } = useHealth();
  const sentinel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => {
      if (draft !== q) setQ(draft);
    }, 250);
    return () => clearTimeout(t);
  }, [draft]);

  useEffect(() => {
    const ctl = new AbortController();
    api
      .get<Page<Session>>('/api/sessions', { q, limit: 50 }, ctl.signal)
      .then((r) => {
        setItems(r.items);
        setNext(r.next);
        setError(null);
      })
      .catch((e) => {
        if (!ctl.signal.aborted) setError(e);
      });
    return () => ctl.abort();
  }, [q, tick]);

  const loadMore = () => {
    if (!next || loadingMore) return;
    setLoadingMore(true);
    api
      .get<Page<Session>>('/api/sessions', { q, limit: 50, cursor: next })
      .then((r) => {
        setItems((xs) => {
          const seen = new Set((xs ?? []).map((s) => s.session_id));
          return [...(xs ?? []), ...r.items.filter((s) => !seen.has(s.session_id))];
        });
        setNext(r.next);
      })
      .finally(() => setLoadingMore(false));
  };

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => {
      if (es.some((e) => e.isIntersecting)) loadMore();
    });
    io.observe(el);
    return () => io.disconnect();
  });

  const noData = health && health.spans === 0;

  return (
    <>
      <PageHeader title="Sessions" right={<SearchInput value={draft} onChange={setDraft} placeholder="Search sessions, users, first input" width={300} pageSearch />} />
      <div className="page">
        {noData ? (
          <FirstRun />
        ) : (
          <Card flush>
            {error ? (
              <ErrorState error={error} what="Sessions" />
            ) : !items ? (
              <SkelRows rows={12} cols={7} />
            ) : items.length === 0 ? (
              <Empty title={q ? 'No sessions match' : 'No sessions yet'} body={q ? 'Try a different search term.' : 'Sessions appear when spans carry a session or conversation id (gen_ai.conversation.id, session.id).'} />
            ) : (
              <div className="table-wrap">
                <table className="tbl sessions-tbl">
                  <thead>
                    <tr>
                      <th>Last activity</th>
                      <th>First input</th>
                      <th>User</th>
                      <th className="r">Turns</th>
                      <th className="r">Steps</th>
                      <th className="r">Tokens</th>
                      <th className="r">Cost</th>
                      <th className="r">Duration</th>
                      <th>Signals</th>
                    </tr>
                  </thead>
                  <tbody>
                    {items.map((s) => (
                      <tr key={s.session_id} className="click" onClick={() => navigate('/sessions/' + encodeURIComponent(s.session_id))}>
                        <td className="dim">{agoNs(s.end_ns)}</td>
                        <td className="wrap">
                          <div className="cell-main ellipsis sess-input">{oneLine(s.first_input, 140) || <span className="muted">No input captured</span>}</div>
                          <div className="mono muted sess-id">{s.session_id}</div>
                        </td>
                        <td className="dim">{s.user_id ?? <span className="muted">-</span>}</td>
                        <td className="r">{s.trace_count}</td>
                        <td className="r dim">
                          {s.llm_calls + s.tool_calls}
                          {s.error_count > 0 && <span className="err-text"> · {s.error_count} err</span>}
                        </td>
                        <td className="r dim">{fmtTokens(s.input_tokens + s.output_tokens)}</td>
                        <td className="r">{fmtCost(s.cost_usd)}</td>
                        <td className="r dim">{fmtMs((s.end_ns - s.start_ns) / 1e6)}</td>
                        <td>
                          <div className="chips nowrap" style={{ maxWidth: 220 }}>
                            {(s.signals ?? []).slice(0, 1).map((g) => (
                              <SignalChip key={g.type} type={g.type} severity={severityOf(g.type)} count={g.count} />
                            ))}
                            {(s.signals ?? []).length > 1 && <span className="chip neutral" title={(s.signals ?? []).slice(1).map((g) => g.type).join(', ')}>+{(s.signals ?? []).length - 1}</span>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div ref={sentinel} className="sess-more">
                  {next ? (
                    <button className="btn sm" onClick={loadMore} disabled={loadingMore}>
                      {loadingMore ? 'Loading' : 'Load more'}
                    </button>
                  ) : (
                    <span className="muted">{items.length} sessions</span>
                  )}
                </div>
              </div>
            )}
          </Card>
        )}
      </div>
    </>
  );
}
