import { useEffect, useState, useCallback } from 'react';
import type { BugReport, BugStatus } from './types';
import { fetchBugs } from './api';
import { Bug, Inbox } from 'lucide-react';

const STATUSES: Array<BugStatus | 'all'> = ['new', 'triaged', 'in_progress', 'resolved', 'wontfix', 'all'];

function relativeTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function BugsTab({ onSelectBug }: { onSelectBug: (id: number) => void }) {
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [statusFilter, setStatusFilter] = useState<BugStatus | 'all'>('new');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBugs({ status: statusFilter === 'all' ? undefined : statusFilter, limit: 100 });
      setBugs(res.bugs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bugs');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="bugs-tab">
      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-group">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as BugStatus | 'all')}>
            {STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
        <div className="filter-group" style={{ alignSelf: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="logs-table logs-table-wide">
        <table className="resizable-table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Severity</th>
              <th>Description</th>
              <th>User</th>
              <th>Device</th>
              <th>App</th>
              <th>Reported</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && bugs.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center' }}>Loading…</td></tr>
            ) : bugs.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Inbox size={28} strokeWidth={1.4} style={{ display: 'block', margin: '0 auto 8px', opacity: 0.6 }} />
                No bug reports in this view.
              </td></tr>
            ) : bugs.map((b) => (
              <tr key={b.id} className="log-row" onClick={() => onSelectBug(b.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className={`level-badge level-${b.severity === 'critical' || b.severity === 'high' ? 'error' : b.severity === 'medium' ? 'warn' : 'info'}`}>
                    {b.severity}
                  </span>
                </td>
                <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.description}>
                  <Bug size={11} strokeWidth={1.8} style={{ marginRight: 6, color: 'var(--text-tertiary)' }} />
                  {b.description}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{b.user_id}</td>
                <td>{b.device_model ?? '—'}</td>
                <td>{b.app_version ?? '—'}</td>
                <td title={b.created_at}>{relativeTime(b.created_at)}</td>
                <td>
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{b.status}</span>
                </td>
                <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
