import { useMemo } from 'react';
import { api, type Issue } from '../../api.ts';
import { PageHeader } from '../../components/Layout.tsx';
import { Card, Empty, ErrorState, Seg, SkelRows } from '../../components/ui.tsx';
import { SeverityLabel } from '../../components/Badges.tsx';
import { useToast } from '../../components/Toast.tsx';
import { useApi, useLive } from '../../hooks.ts';
import { navigate, setSearch, useLocation, useTitle } from '../../router.tsx';
import { fmtAgo, humanize } from '../../format.ts';
import './issues.css';

type Win = '24h' | '7d' | '30d' | 'all';
type Status = 'open' | 'resolved' | 'ignored' | 'all';

export function Issues() {
  useTitle('Issues');
  const { search } = useLocation();
  const win = (search.get('window') as Win) || 'all';
  const status = (search.get('status') as Status) || 'open';
  const type = search.get('type') ?? '';
  const { tick } = useLive();
  const toast = useToast();
  const { data, error, reload, setData } = useApi<{ items: Issue[] }>(
    '/api/issues',
    { window: win === 'all' ? undefined : win, status: status === 'all' ? undefined : status },
    [tick],
  );

  const types = useMemo(() => {
    const m = new Map<string, number>();
    for (const i of data?.items ?? []) m.set(i.type, (m.get(i.type) ?? 0) + i.count);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [data]);

  const items = (data?.items ?? []).filter((i) => !type || i.type === type);
  const maxCount = Math.max(1, ...items.map((i) => i.count));

  const setStatus = async (fp: string, next: string, title: string) => {
    const prev = data;
    setData((d) => (d ? { items: status === 'all' ? d.items.map((i) => (i.fingerprint === fp ? { ...i, status: next } : i)) : d.items.filter((i) => i.fingerprint !== fp) } : d));
    try {
      await api.post(`/api/issues/${encodeURIComponent(fp)}/status`, { status: next });
      toast(next === 'open' ? `Reopened: ${title}` : `${humanize(next)}: ${title}`, 'good');
    } catch (e) {
      setData(() => prev);
      toast(`Could not update issue: ${e instanceof Error ? e.message : String(e)}`, 'bad');
      reload();
    }
  };

  return (
    <>
      <PageHeader
        title="Issues"
        right={
          <div className="row">
            <Seg<Status> label="Status" value={status} options={[{ value: 'open', label: 'Open' }, { value: 'resolved', label: 'Resolved' }, { value: 'ignored', label: 'Ignored' }, { value: 'all', label: 'All' }]} onChange={(v) => setSearch({ status: v === 'open' ? null : v })} />
            <Seg<Win> label="Window" value={win} options={[{ value: '24h', label: '24h' }, { value: '7d', label: '7d' }, { value: '30d', label: '30d' }, { value: 'all', label: 'All time' }]} onChange={(v) => setSearch({ window: v === 'all' ? null : v })} />
          </div>
        }
      />
      <div className="page">
        {types.length > 0 && (
          <div className="chips issue-types">
            <button className={'chip btn-chip' + (!type ? ' accent' : '')} onClick={() => setSearch({ type: null })}>
              All types
            </button>
            {types.map(([t, n]) => (
              <button key={t} className={'chip btn-chip' + (type === t ? ' accent' : '')} onClick={() => setSearch({ type: type === t ? null : t })}>
                {humanize(t)} <span className="num muted">{n}</span>
              </button>
            ))}
          </div>
        )}
        <Card flush>
          {error ? (
            <ErrorState error={error} what="Issues" retry={reload} />
          ) : !data ? (
            <SkelRows rows={10} cols={7} />
          ) : items.length === 0 ? (
            <Empty
              title={status === 'open' ? 'No open issues' : 'No issues here'}
              body={status === 'open' ? 'Detectors group repeated signals (loops, runaway cost, toxic flows, refusals and more) into issues. Nothing is open in this window.' : 'Nothing matches these filters.'}
            />
          ) : (
            <div className="table-wrap">
              <table className="tbl issues-tbl">
                <thead>
                  <tr>
                    <th>Severity</th>
                    <th>Type</th>
                    <th>Issue</th>
                    <th className="r">Events</th>
                    <th className="r">Traces</th>
                    <th>First seen</th>
                    <th>Last seen</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((i) => (
                    <tr key={i.fingerprint} className="click" onClick={() => navigate('/traces?signal=' + encodeURIComponent(i.fingerprint))}>
                      <td>
                        <SeverityLabel severity={i.severity} />
                      </td>
                      <td>
                        <span className="chip sq neutral">{humanize(i.type)}</span>
                      </td>
                      <td className="wrap">
                        <div className="cell-main issue-title">{i.title}</div>
                      </td>
                      <td className="r">
                        <div className="bar-cell">
                          <span>{i.count}</span>
                          <span className="bar">
                            <i style={{ width: `${Math.max(2, (i.count / maxCount) * 100)}%` }} />
                          </span>
                        </div>
                      </td>
                      <td className="r dim">{i.traces}</td>
                      <td className="dim">{fmtAgo(i.first_seen)}</td>
                      <td className="dim">{fmtAgo(i.last_seen)}</td>
                      <td>
                        <span className={'chip ' + (i.status === 'open' ? 'serious' : i.status === 'resolved' ? 'good' : 'neutral')}>{humanize(i.status)}</span>
                      </td>
                      <td className="r" onClick={(e) => e.stopPropagation()}>
                        <div className="row issue-actions">
                          {i.status === 'open' ? (
                            <>
                              <button className="btn sm" onClick={() => setStatus(i.fingerprint, 'resolved', i.title)}>
                                Resolve
                              </button>
                              <button className="btn sm ghost" onClick={() => setStatus(i.fingerprint, 'ignored', i.title)}>
                                Ignore
                              </button>
                            </>
                          ) : (
                            <button className="btn sm ghost" onClick={() => setStatus(i.fingerprint, 'open', i.title)}>
                              Reopen
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}
