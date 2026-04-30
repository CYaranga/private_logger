import { useEffect, useState } from 'react';
import type { UserProfile } from './types';
import { fetchUserProfile } from './api';

interface Props {
  userId: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  onApplyFingerprint: (fingerprint: string) => void;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function durationLabel(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 3_600_000)}h`;
}

export function UserProfileModal({ userId, onClose, onOpenSession, onApplyFingerprint }: Props) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetchUserProfile(userId)
      .then(setProfile)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed'))
      .finally(() => setLoading(false));
  }, [userId]);

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h2 style={{ fontFamily: 'var(--font-mono)' }}>{userId}</h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {loading ? (
          <p style={{ padding: 24 }}>Loading profile…</p>
        ) : error ? (
          <div className="error-banner">{error}</div>
        ) : profile ? (
          <div style={{ padding: 16, display: 'grid', gap: 18 }}>

            <section>
              <h3 style={{ marginBottom: 8 }}>Summary</h3>
              <div className="summary-grid">
                <div className="summary-cell"><div className="summary-label">First seen</div><div>{fmt(profile.summary.first_seen)}</div></div>
                <div className="summary-cell"><div className="summary-label">Last seen</div><div>{fmt(profile.summary.last_seen)}</div></div>
                <div className="summary-cell"><div className="summary-label">Total logs</div><div>{profile.summary.total_logs.toLocaleString()}</div></div>
                <div className="summary-cell"><div className="summary-label">Sessions</div><div>{profile.summary.session_count}</div></div>
                <div className="summary-cell"><div className="summary-label">Devices</div><div>{profile.summary.device_count}</div></div>
                <div className="summary-cell"><div className="summary-label">Errors</div><div style={{ color: profile.summary.error_count ? 'var(--error)' : undefined }}>{profile.summary.error_count}</div></div>
                <div className="summary-cell"><div className="summary-label">Warnings</div><div>{profile.summary.warn_count}</div></div>
              </div>
            </section>

            <section>
              <h3 style={{ marginBottom: 8 }}>Devices</h3>
              {profile.devices.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No device info recorded.</p> : (
                <table className="resizable-table" style={{ width: '100%' }}>
                  <thead><tr><th>Device ID</th><th>Model</th><th>OS</th><th>Last seen</th><th style={{ textAlign: 'right' }}>Logs</th></tr></thead>
                  <tbody>
                    {profile.devices.map((d) => (
                      <tr key={d.device_id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{d.device_id}</td>
                        <td>{d.device_model ?? '—'}</td>
                        <td>{d.os_version ?? '—'}</td>
                        <td>{fmt(d.last_seen)}</td>
                        <td style={{ textAlign: 'right' }}>{d.log_count.toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3 style={{ marginBottom: 8 }}>App versions</h3>
              {profile.app_versions.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No app versions recorded.</p> : (
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {profile.app_versions.map(av => (
                    <li key={av.app_version} style={{ background: 'var(--bg-secondary)', padding: '4px 10px', borderRadius: 4, fontSize: 12 }}>
                      <strong>{av.app_version}</strong> · last {fmt(av.last_seen)} · {av.count.toLocaleString()} logs
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section>
              <h3 style={{ marginBottom: 8 }}>Top errors</h3>
              {profile.top_errors.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>None — clean record.</p> : (
                <table className="resizable-table" style={{ width: '100%' }}>
                  <thead><tr><th>Category</th><th>Sample message</th><th>Endpoint</th><th>Status</th><th style={{ textAlign: 'right' }}>Count</th><th /></tr></thead>
                  <tbody>
                    {profile.top_errors.map(err => (
                      <tr key={err.fingerprint}>
                        <td>{err.category}</td>
                        <td style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={err.sample_message}>{err.sample_message}</td>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{err.endpoint ?? '—'}</td>
                        <td>{err.status_code ?? '—'}</td>
                        <td style={{ textAlign: 'right' }}>{err.count.toLocaleString()}</td>
                        <td><button className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => onApplyFingerprint(err.fingerprint)}>Logs</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section>
              <h3 style={{ marginBottom: 8 }}>Recent sessions</h3>
              {profile.recent_sessions.length === 0 ? <p style={{ color: 'var(--text-secondary)' }}>No sessions recorded — clients are not sending session_id yet.</p> : (
                <table className="resizable-table" style={{ width: '100%' }}>
                  <thead><tr><th>Session</th><th>Started</th><th>Duration</th><th style={{ textAlign: 'right' }}>Logs</th><th style={{ textAlign: 'right' }}>Errors</th><th /></tr></thead>
                  <tbody>
                    {profile.recent_sessions.map(s => (
                      <tr key={s.session_id}>
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{s.session_id.slice(0, 12)}…</td>
                        <td>{fmt(s.started_at)}</td>
                        <td>{durationLabel(s.started_at, s.ended_at)}</td>
                        <td style={{ textAlign: 'right' }}>{s.log_count.toLocaleString()}</td>
                        <td style={{ textAlign: 'right', color: s.error_count > 0 ? 'var(--error)' : undefined }}>{s.error_count}</td>
                        <td><button className="btn btn-secondary" style={{ padding: '3px 8px', fontSize: 11 }} onClick={() => onOpenSession(s.session_id)}>Timeline</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  );
}
