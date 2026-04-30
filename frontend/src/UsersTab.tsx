import { useEffect, useState, useCallback } from 'react';
import type { UserSummary } from './types';
import { fetchRichUsers } from './api';
import { Inbox } from 'lucide-react';

const SINCE_OPTIONS: Array<{ label: string; value: string; ms: number }> = [
  { label: 'Last 24h', value: '24h', ms: 24 * 60 * 60 * 1000 },
  { label: 'Last 7d', value: '7d', ms: 7 * 24 * 60 * 60 * 1000 },
  { label: 'Last 30d', value: '30d', ms: 30 * 24 * 60 * 60 * 1000 },
];

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

export function UsersTab({ onSelectUser }: { onSelectUser: (userId: string) => void }) {
  const [users, setUsers] = useState<UserSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [since, setSince] = useState<string>('7d');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const opt = SINCE_OPTIONS.find(o => o.value === since) ?? SINCE_OPTIONS[1];
      const sinceIso = new Date(Date.now() - opt.ms).toISOString();
      const res = await fetchRichUsers({ limit: 200, search: search || undefined, since: sinceIso });
      setUsers(res.users);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  }, [search, since]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  return (
    <div className="users-tab">
      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-group">
          <label>Search user_id</label>
          <input
            className="filter-input"
            placeholder="user-123…"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
          />
        </div>
        <div className="filter-group">
          <label>Window</label>
          <select value={since} onChange={(e) => setSince(e.target.value)}>
            {SINCE_OPTIONS.map(o => (<option key={o.value} value={o.value}>{o.label}</option>))}
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
            {users.length.toLocaleString()} active users
          </span>
        </div>
      </div>

      <div className="logs-table logs-table-wide">
        <table className="resizable-table">
          <thead>
            <tr>
              <th>User</th>
              <th>Last seen</th>
              <th>Device</th>
              <th>OS</th>
              <th>App</th>
              <th>Source</th>
              <th style={{ textAlign: 'right' }}>Sessions</th>
              <th style={{ textAlign: 'right' }}>Logs</th>
              <th style={{ textAlign: 'right' }}>Errors</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && users.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 24, textAlign: 'center' }}>Loading…</td></tr>
            ) : users.length === 0 ? (
              <tr><td colSpan={10} style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Inbox size={28} strokeWidth={1.4} style={{ display: 'block', margin: '0 auto 8px', opacity: 0.6 }} />
                No users in this window
              </td></tr>
            ) : users.map((u) => (
              <tr key={u.user_id} className="log-row" onClick={() => onSelectUser(u.user_id)} style={{ cursor: 'pointer' }}>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{u.user_id}</td>
                <td title={u.last_seen}>{relativeTime(u.last_seen)}</td>
                <td>{u.last_device_model ?? '—'}</td>
                <td>{u.last_os_version ?? '—'}</td>
                <td>{u.last_app_version ?? '—'}</td>
                <td>{u.last_source ?? '—'}</td>
                <td style={{ textAlign: 'right' }}>{u.session_count.toLocaleString()}</td>
                <td style={{ textAlign: 'right' }}>{u.log_count.toLocaleString()}</td>
                <td style={{ textAlign: 'right', color: u.error_count > 0 ? 'var(--error)' : undefined }}>
                  {u.error_count.toLocaleString()}
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
