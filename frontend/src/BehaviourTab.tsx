import { useEffect, useState, useCallback } from 'react';
import type { BehaviourAction, BehaviourByVersion } from './types';
import { fetchBehaviourTopActions, fetchBehaviourByVersion } from './api';
import { Sparkles, GitCompare } from 'lucide-react';

const SINCE_OPTIONS = [
  { label: 'Last 24h', days: 1 },
  { label: 'Last 7d', days: 7 },
  { label: 'Last 30d', days: 30 },
];

function dayBack(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function BehaviourTab() {
  const [actions, setActions] = useState<BehaviourAction[]>([]);
  const [days, setDays] = useState(7);
  const [environment, setEnvironment] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ action: string; subject: string } | null>(null);
  const [versionRows, setVersionRows] = useState<BehaviourByVersion[]>([]);
  const [versionLoading, setVersionLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBehaviourTopActions({
        since: dayBack(days),
        environment: environment || undefined,
        limit: 100,
      });
      setActions(res.actions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch behaviour');
    } finally {
      setLoading(false);
    }
  }, [days, environment]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!selected) { setVersionRows([]); return; }
    setVersionLoading(true);
    fetchBehaviourByVersion({
      action: selected.action,
      subject: selected.subject,
      since: dayBack(days),
    })
      .then(r => setVersionRows(r.rows))
      .catch(err => setError(err instanceof Error ? err.message : 'Failed'))
      .finally(() => setVersionLoading(false));
  }, [selected, days]);

  // Group versionRows by app_version for compact display
  const byVersion = versionRows.reduce<Record<string, BehaviourByVersion[]>>((acc, r) => {
    const key = r.app_version ?? '(no version)';
    if (!acc[key]) acc[key] = [];
    acc[key].push(r);
    return acc;
  }, {});

  return (
    <div className="behaviour-tab">
      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-group">
          <label>Window</label>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {SINCE_OPTIONS.map(o => (<option key={o.days} value={o.days}>{o.label}</option>))}
          </select>
        </div>
        <div className="filter-group">
          <label>Environment</label>
          <select value={environment} onChange={(e) => setEnvironment(e.target.value)}>
            <option value="">All</option>
            <option value="dev">dev</option>
            <option value="test">test</option>
            <option value="prod">prod</option>
          </select>
        </div>
        <div className="filter-group" style={{ alignSelf: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="table-toolbar">
        <div className="table-toolbar-left">
          <span className="kicker">
            <Sparkles size={11} strokeWidth={1.6} style={{ marginRight: 4 }} />
            User behaviour · {actions.length} actions tracked
          </span>
        </div>
      </div>

      <div className="logs-table logs-table-wide">
        <table className="resizable-table">
          <thead>
            <tr>
              <th>Action</th>
              <th>Subject</th>
              <th style={{ textAlign: 'right' }}>Users</th>
              <th style={{ textAlign: 'right' }}>Events</th>
              <th>First day</th>
              <th>Last day</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && actions.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center' }}>Loading…</td></tr>
            ) : actions.length === 0 ? (
              <tr><td colSpan={7} style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>No behaviour events in this window.</td></tr>
            ) : actions.map(a => {
              const isSel = selected?.action === a.action && selected?.subject === a.subject;
              return (
                <tr
                  key={`${a.action}|${a.subject}`}
                  className="log-row"
                  style={{ cursor: 'pointer', background: isSel ? 'var(--accent-muted)' : undefined }}
                  onClick={() => setSelected(isSel ? null : { action: a.action, subject: a.subject })}
                >
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{a.action}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{a.subject}</td>
                  <td style={{ textAlign: 'right' }}>{a.total_users.toLocaleString()}</td>
                  <td style={{ textAlign: 'right' }}>{a.total_count.toLocaleString()}</td>
                  <td>{a.first_day}</td>
                  <td>{a.last_day}</td>
                  <td>
                    <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                      <GitCompare size={11} strokeWidth={1.8} /> versions
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <div style={{ marginTop: 18, border: '1px solid var(--border-strong)', borderRadius: 6, padding: 16, background: 'var(--bg-1)' }}>
          <div className="kicker" style={{ marginBottom: 10 }}>
            By app version · {selected.action} : {selected.subject}
          </div>
          {versionLoading ? (
            <p style={{ color: 'var(--text-secondary)' }}>Loading…</p>
          ) : Object.keys(byVersion).length === 0 ? (
            <p style={{ color: 'var(--text-secondary)' }}>No per-version data — clients may be on a build that predates app_version capture.</p>
          ) : (
            <table className="resizable-table" style={{ width: '100%' }}>
              <thead><tr><th>App version</th><th style={{ textAlign: 'right' }}>Users</th><th style={{ textAlign: 'right' }}>Events</th><th>Last day</th></tr></thead>
              <tbody>
                {Object.entries(byVersion).map(([v, rows]) => {
                  const users = rows.reduce((s, r) => s + r.total_users, 0);
                  const count = rows.reduce((s, r) => s + r.total_count, 0);
                  const last = rows.reduce((m, r) => r.last_day > m ? r.last_day : m, '');
                  return (
                    <tr key={v}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{v}</td>
                      <td style={{ textAlign: 'right' }}>{users.toLocaleString()}</td>
                      <td style={{ textAlign: 'right' }}>{count.toLocaleString()}</td>
                      <td>{last}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
