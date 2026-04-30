import { useEffect, useState } from 'react';
import type { BugReport, BugStatus } from './types';
import { fetchBug, triageBug, getBugScreenshotUrl } from './api';
import { Bug, ImageIcon } from 'lucide-react';

const STATUSES: BugStatus[] = ['new', 'triaged', 'in_progress', 'resolved', 'wontfix'];

interface Props {
  bugId: number;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : '—'; }

export function BugDetailModal({ bugId, onClose, onOpenSession }: Props) {
  const [bug, setBug] = useState<BugReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showImage, setShowImage] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchBug(bugId).then(setBug).catch((e) => setError(e instanceof Error ? e.message : 'Failed')).finally(() => setLoading(false));
  }, [bugId]);

  const update = async (patch: { status?: BugStatus; assigned_to?: string | null; note?: string | null }) => {
    if (!bug) return;
    try {
      await triageBug(bug.id, patch);
      setBug({ ...bug, ...patch, updated_at: new Date().toISOString() } as BugReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bug size={18} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
            Bug #{bugId}
          </h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {loading ? (
          <p style={{ padding: 24 }}>Loading…</p>
        ) : error ? (
          <div className="error-banner">{error}</div>
        ) : bug ? (
          <div style={{ padding: 16, display: 'grid', gap: 18 }}>
            <section>
              <div className="kicker">Description</div>
              <p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{bug.description}</p>
            </section>

            <section>
              <div className="summary-grid">
                <div className="summary-cell"><div className="summary-label">User</div><div style={{ fontFamily: 'var(--font-mono)' }}>{bug.user_id}</div></div>
                <div className="summary-cell"><div className="summary-label">Severity</div><div>{bug.severity}</div></div>
                <div className="summary-cell"><div className="summary-label">Reported</div><div>{fmt(bug.created_at)}</div></div>
                <div className="summary-cell"><div className="summary-label">Updated</div><div>{fmt(bug.updated_at)}</div></div>
                <div className="summary-cell"><div className="summary-label">Device</div><div>{bug.device_model ?? '—'}</div></div>
                <div className="summary-cell"><div className="summary-label">OS</div><div>{bug.os_version ?? '—'}</div></div>
                <div className="summary-cell"><div className="summary-label">App</div><div>{bug.app_version ?? '—'}</div></div>
                <div className="summary-cell"><div className="summary-label">Network</div><div>{bug.network_type ?? '—'}</div></div>
              </div>
            </section>

            {bug.screenshot_url && (
              <section>
                <div className="kicker" style={{ marginBottom: 6 }}>
                  <ImageIcon size={11} strokeWidth={1.6} style={{ marginRight: 4 }} /> Screenshot
                </div>
                {showImage ? (
                  <img src={getBugScreenshotUrl(bug.id)} alt="screenshot" style={{ maxWidth: '100%', borderRadius: 6 }} />
                ) : (
                  <button className="btn btn-secondary" onClick={() => setShowImage(true)}>Load screenshot</button>
                )}
              </section>
            )}

            <section>
              <div className="kicker" style={{ marginBottom: 6 }}>Triage</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={bug.status} onChange={(e) => update({ status: e.target.value as BugStatus })}>
                  {STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
                <input
                  placeholder="assigned_to"
                  defaultValue={bug.assigned_to ?? ''}
                  onBlur={(e) => update({ assigned_to: e.target.value || null })}
                  style={{ padding: '6px 10px' }}
                />
                <input
                  placeholder="note"
                  defaultValue={bug.note ?? ''}
                  onBlur={(e) => update({ note: e.target.value || null })}
                  style={{ flex: 1, padding: '6px 10px' }}
                />
              </div>
            </section>

            {bug.session_id && (
              <section>
                <button className="btn btn-secondary" onClick={() => onOpenSession(bug.session_id!)}>
                  Open session timeline
                </button>
              </section>
            )}

            {bug.related_logs && bug.related_logs.length > 0 && (
              <section>
                <div className="kicker" style={{ marginBottom: 6 }}>Related logs ({bug.related_logs.length})</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {bug.related_logs.map((l) => (
                    <li key={l.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>#{l.id}</span> · <span className={`level-badge level-${l.level}`}>{l.level}</span> · {l.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
