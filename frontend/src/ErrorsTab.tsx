import { useEffect, useState, useCallback } from 'react';
import type { ErrorGroup, ErrorGroupStatus } from './types';
import { fetchErrorGroups, updateErrorGroupState } from './api';
import { ShieldCheck } from 'lucide-react';

const SINCE_OPTIONS = [
  { label: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function ErrorsTab({ onSelectGroup }: { onSelectGroup: (fingerprint: string) => void }) {
  const [groups, setGroups] = useState<ErrorGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [windowMs, setWindowMs] = useState(SINCE_OPTIONS[1].ms);
  const [environment, setEnvironment] = useState('');
  const [statusFilter, setStatusFilter] = useState<ErrorGroupStatus | 'all'>('open');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sinceIso = new Date(Date.now() - windowMs).toISOString();
      const res = await fetchErrorGroups({
        since: sinceIso,
        environment: environment || undefined,
        status: statusFilter,
        limit: 100,
      });
      setGroups(res.groups);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch error groups');
    } finally {
      setLoading(false);
    }
  }, [windowMs, environment, statusFilter]);

  const handleStatusChange = async (fingerprint: string, status: ErrorGroupStatus) => {
    setGroups(prev => prev.map(g => g.fingerprint === fingerprint ? { ...g, state_status: status } : g));
    try {
      await updateErrorGroupState(fingerprint, { status });
      // If filter is on a different status, reload to drop the row
      if (statusFilter !== 'all' && statusFilter !== status) {
        load();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update');
      load();
    }
  };

  useEffect(() => { load(); }, [load]);

  return (
    <div className="errors-tab">
      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-group">
          <label>Window</label>
          <select value={windowMs} onChange={(e) => setWindowMs(Number(e.target.value))}>
            {SINCE_OPTIONS.map(o => (<option key={o.label} value={o.ms}>{`Last ${o.label}`}</option>))}
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
        <div className="filter-group">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as ErrorGroupStatus | 'all')}>
            <option value="open">Open</option>
            <option value="monitoring">Monitoring</option>
            <option value="resolved">Resolved</option>
            <option value="ignored">Ignored</option>
            <option value="all">All</option>
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
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>
            {groups.length.toLocaleString()} error groups
          </span>
        </div>
      </div>

      <div className="logs-table logs-table-wide">
        <table className="resizable-table">
          <thead>
            <tr>
              <th style={{ width: 80 }}>Level</th>
              <th>Category / endpoint</th>
              <th>Sample message</th>
              <th>Source</th>
              <th>Status</th>
              <th style={{ textAlign: 'right' }}>Users</th>
              <th style={{ textAlign: 'right' }}>Count</th>
              <th>Last seen</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && groups.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center' }}>Loading…</td></tr>
            ) : groups.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
                <ShieldCheck size={28} strokeWidth={1.4} style={{ display: 'block', margin: '0 auto 8px', color: 'var(--success)' }} />
                No errors in this window — nice.
              </td></tr>
            ) : groups.map(g => (
              <tr key={g.fingerprint} className="log-row" style={{ cursor: 'pointer' }}>
                <td onClick={() => onSelectGroup(g.fingerprint)}>
                  <span className={`level-badge level-${g.level}`}>{g.level}</span>
                </td>
                <td onClick={() => onSelectGroup(g.fingerprint)} style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  <div>{g.category}</div>
                  {g.endpoint && <div style={{ color: 'var(--text-secondary)', fontSize: 11 }}>{g.endpoint}</div>}
                </td>
                <td onClick={() => onSelectGroup(g.fingerprint)} style={{ maxWidth: 480, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={g.sample_message}>
                  {g.sample_message}
                </td>
                <td onClick={() => onSelectGroup(g.fingerprint)}>{g.sample_source ?? '—'}</td>
                <td onClick={() => onSelectGroup(g.fingerprint)}>{g.status_code ?? '—'}</td>
                <td onClick={() => onSelectGroup(g.fingerprint)} style={{ textAlign: 'right' }}>{g.affected_users.toLocaleString()}</td>
                <td onClick={() => onSelectGroup(g.fingerprint)} style={{ textAlign: 'right' }}>{g.occurrences.toLocaleString()}</td>
                <td onClick={() => onSelectGroup(g.fingerprint)} title={g.last_seen}>{relativeTime(g.last_seen)}</td>
                <td onClick={(e) => e.stopPropagation()}>
                  <select
                    value={g.state_status ?? 'open'}
                    onChange={(e) => handleStatusChange(g.fingerprint, e.target.value as ErrorGroupStatus)}
                    style={{ padding: '3px 6px', fontSize: 11, fontFamily: 'var(--font-mono)' }}
                  >
                    <option value="open">open</option>
                    <option value="monitoring">monitoring</option>
                    <option value="resolved">resolved</option>
                    <option value="ignored">ignored</option>
                  </select>
                </td>
                <td onClick={() => onSelectGroup(g.fingerprint)}>
                  <button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }}>View logs</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
