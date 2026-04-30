import { useEffect, useState } from 'react';
import type { ApiToken, ApiTokenCreated } from './types';
import { listApiTokens, createApiToken, revokeApiToken } from './api';
import { Key, Copy, Check, Trash2 } from 'lucide-react';

export function ApiTokensModal({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [expiresDays, setExpiresDays] = useState<string>('');
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await listApiTokens();
      setTokens(res.tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      const t = await createApiToken(name.trim(), expiresDays ? Number(expiresDays) : undefined);
      setCreated(t);
      setName('');
      setExpiresDays('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleRevoke = async (id: number) => {
    if (!confirm('Revoke this token?')) return;
    await revokeApiToken(id);
    load();
  };

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.plaintext);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: '92%' }}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Key size={18} strokeWidth={1.8} /> API tokens
          </h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: 16, display: 'grid', gap: 16 }}>
          {error && <div className="error-banner">{error}</div>}

          {created && (
            <div style={{ padding: 12, background: 'var(--success-muted)', border: '1px solid rgba(134,215,161,0.3)', borderRadius: 6 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>Token created — copy now, never shown again</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 12, overflowX: 'auto' }}>
                  {created.plaintext}
                </code>
                <button className="btn btn-secondary" onClick={copy}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          <section style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div className="filter-group" style={{ flex: 1 }}>
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code MCP" />
            </div>
            <div className="filter-group">
              <label>Expires (days)</label>
              <input type="number" value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)} placeholder="never" style={{ width: 100 }} />
            </div>
            <button className="btn btn-primary" onClick={handleCreate} disabled={!name.trim()}>Create</button>
          </section>

          <table className="resizable-table" style={{ width: '100%' }}>
            <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center' }}>Loading…</td></tr>
              ) : tokens.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)' }}>No tokens yet.</td></tr>
              ) : tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.prefix}…</td>
                  <td>{new Date(t.created_at).toLocaleDateString()}</td>
                  <td>{t.last_used ? new Date(t.last_used).toLocaleString() : '—'}</td>
                  <td>{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'never'}</td>
                  <td>
                    <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => handleRevoke(t.id)}>
                      <Trash2 size={11} strokeWidth={1.8} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
