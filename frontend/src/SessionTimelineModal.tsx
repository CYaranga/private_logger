import { useEffect, useState } from 'react';
import type { SessionTimeline, Breadcrumb, Log } from './types';
import { fetchSessionTimeline } from './api';
import { Link2, Check } from 'lucide-react';

interface Props {
  sessionId: string;
  onClose: () => void;
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

function CopyShareButton({ sessionId }: { sessionId: string }) {
  const [copied, setCopied] = useState(false);
  const handle = async () => {
    const url = `${window.location.origin}${window.location.pathname}?session_id=${encodeURIComponent(sessionId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — secure context required for clipboard API
    }
  };
  return (
    <button
      className="btn btn-secondary"
      style={{ padding: '6px 10px', fontSize: 11, display: 'inline-flex', alignItems: 'center', gap: 6 }}
      onClick={handle}
      title="Copy a shareable URL filtered to this session"
    >
      {copied ? <Check size={12} strokeWidth={1.8} /> : <Link2 size={12} strokeWidth={1.8} />}
      {copied ? 'Copied' : 'Share'}
    </button>
  );
}

function levelBadge(level: Log['level']): JSX.Element {
  return <span className={`level-badge level-${level}`}>{level}</span>;
}

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function SessionTimelineModal({ sessionId, onClose }: Props) {
  const [data, setData] = useState<SessionTimeline | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  useEffect(() => {
    setLoading(true);
    fetchSessionTimeline(sessionId)
      .then(setData)
      .catch(err => setError(err instanceof Error ? err.message : 'Failed'))
      .finally(() => setLoading(false));
  }, [sessionId]);

  const toggle = (id: number) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 1000, width: '94%', maxHeight: '90vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h2>Session timeline</h2>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <CopyShareButton sessionId={sessionId} />
            <button className="modal-close" onClick={onClose}>×</button>
          </div>
        </div>

        {loading ? (
          <p style={{ padding: 24 }}>Loading session…</p>
        ) : error ? (
          <div className="error-banner">{error}</div>
        ) : data ? (
          <div style={{ padding: 16 }}>
            <div className="summary-grid" style={{ marginBottom: 16 }}>
              <div className="summary-cell"><div className="summary-label">User</div><div style={{ fontFamily: 'var(--font-mono)' }}>{data.user_id}</div></div>
              <div className="summary-cell"><div className="summary-label">Device</div><div>{data.device_model ?? '—'}</div></div>
              <div className="summary-cell"><div className="summary-label">OS</div><div>{data.os_version ?? '—'}</div></div>
              <div className="summary-cell"><div className="summary-label">App</div><div>{data.app_version ?? '—'}</div></div>
              <div className="summary-cell"><div className="summary-label">Source</div><div>{data.source ?? '—'}</div></div>
              <div className="summary-cell"><div className="summary-label">Started</div><div>{new Date(data.started_at).toLocaleString()}</div></div>
              <div className="summary-cell"><div className="summary-label">Logs</div><div>{data.log_count.toLocaleString()}</div></div>
              <div className="summary-cell"><div className="summary-label">Errors</div><div style={{ color: data.error_count ? 'var(--error)' : undefined }}>{data.error_count}</div></div>
            </div>

            <div className="timeline">
              {data.logs.map((log) => {
                const isOpen = expanded.has(log.id);
                const crumbs = (log.breadcrumbs ?? []) as Breadcrumb[];
                return (
                  <div key={log.id} className={`timeline-row level-${log.level}`} style={{
                    display: 'grid',
                    gridTemplateColumns: '90px 80px 1fr',
                    gap: 12,
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--border)',
                    cursor: 'pointer',
                    alignItems: 'start',
                  }} onClick={() => toggle(log.id)}>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-secondary)' }}>
                      {fmtTime(log.created_at)}
                    </div>
                    <div>{levelBadge(log.level)}</div>
                    <div>
                      <div style={{ fontWeight: 500 }}>{log.message}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {log.category}
                        {log.endpoint && ` · ${log.http_method ?? ''} ${log.endpoint}`}
                        {log.status_code !== null && ` · ${log.status_code}`}
                        {log.duration_ms !== null && ` · ${log.duration_ms}ms`}
                        {log.network_type && ` · ${log.network_type}`}
                      </div>

                      {isOpen && (
                        <div style={{ marginTop: 10, fontSize: 12 }}>
                          {crumbs.length > 0 && (
                            <details open style={{ marginBottom: 8 }}>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>
                                Breadcrumbs ({crumbs.length})
                              </summary>
                              <ol style={{ paddingLeft: 18, marginTop: 6 }}>
                                {crumbs.map((c, i) => (
                                  <li key={i} style={{ marginBottom: 2 }}>
                                    <span style={{ color: 'var(--text-secondary)' }}>{c.ts ? new Date(c.ts).toLocaleTimeString() : ''} · {c.type}</span>
                                    {' — '}
                                    {c.label}
                                  </li>
                                ))}
                              </ol>
                            </details>
                          )}
                          {log.metadata && (
                            <details>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Metadata</summary>
                              <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, overflowX: 'auto' }}>{pretty(log.metadata)}</pre>
                            </details>
                          )}
                          {log.request_data && (
                            <details>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Request</summary>
                              <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, overflowX: 'auto' }}>{pretty(log.request_data)}</pre>
                            </details>
                          )}
                          {log.response_data && (
                            <details>
                              <summary style={{ cursor: 'pointer', color: 'var(--text-secondary)' }}>Response</summary>
                              <pre style={{ background: 'var(--bg-secondary)', padding: 8, borderRadius: 4, overflowX: 'auto' }}>{pretty(log.response_data)}</pre>
                            </details>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
