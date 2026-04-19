import { useEffect, useState } from 'react';
import type { Log, LogReplay } from './types';
import { fetchReplays, createReplay, deleteReplay } from './api';
import { buildVersionList, prefillFromLatest, type VersionEntry } from './replayVersions';

interface ReplayTabsProps {
  log: Log;
  JsonViewer: React.ComponentType<{ data: unknown; label: string }>;
}

export function ReplayTabs({ log, JsonViewer }: ReplayTabsProps) {
  const [replays, setReplays] = useState<LogReplay[]>([]);
  const [activeVersion, setActiveVersion] = useState<number>(1);
  const [editing, setEditing] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchReplays(log.id)
      .then(r => { if (!cancelled) { setReplays(r); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e.message || e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [log.id]);

  const versions = buildVersionList(log, replays);
  const active = versions.find(v => v.version === activeVersion) ?? versions[0];

  async function handleDelete(replayId: number) {
    if (!confirm('Delete this replay version?')) return;
    try {
      await deleteReplay(replayId);
      setReplays(prev => prev.filter(r => r.id !== replayId));
      if (active?.replayId === replayId) setActiveVersion(1);
    } catch (e) {
      alert(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSubmit(payload: {
    queryParams: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
  }) {
    if (!log.http_method || !log.endpoint) return;
    const created = await createReplay({
      parent_log_id: log.id,
      http_method: log.http_method,
      endpoint: log.endpoint,
      query_params: payload.queryParams,
      headers: payload.headers,
      body: payload.body,
    });
    setReplays(prev => [...prev, created]);
    setActiveVersion(created.version);
    setEditing(false);
  }

  if (loading) return <div className="replay-loading">Loading replays…</div>;
  if (error) return <div className="replay-error">Failed to load replays: {error}</div>;

  return (
    <div className="replay-tabs">
      <div className="replay-tab-bar">
        {versions.map(v => (
          <ReplayTab
            key={v.version}
            entry={v}
            active={!editing && v.version === active?.version}
            onSelect={() => { setEditing(false); setActiveVersion(v.version); }}
            onDelete={v.source === 'replay' && v.replayId !== null ? () => handleDelete(v.replayId!) : null}
          />
        ))}
        <button
          type="button"
          className={`replay-tab-add${editing ? ' active' : ''}`}
          onClick={() => setEditing(true)}
        >
          + Replay
        </button>
      </div>

      {editing ? (
        <ReplayEditor
          prefill={prefillFromLatest(log, replays)}
          method={log.http_method ?? ''}
          endpoint={log.endpoint ?? ''}
          onCancel={() => setEditing(false)}
          onSubmit={handleSubmit}
        />
      ) : active ? (
        <ReplayPanel entry={active} JsonViewer={JsonViewer} />
      ) : null}
    </div>
  );
}

function statusBadge(statusCode: number | null, error: string | null): string {
  if (error && statusCode === 0) return 'err';
  if (statusCode === null) return '—';
  return String(statusCode);
}

function ReplayTab({
  entry, active, onSelect, onDelete,
}: {
  entry: VersionEntry;
  active: boolean;
  onSelect: () => void;
  onDelete: (() => void) | null;
}) {
  const badge = statusBadge(entry.statusCode, entry.error);
  const duration = entry.durationMs !== null ? `${entry.durationMs}ms` : '';
  return (
    <div className={`replay-tab${active ? ' active' : ''}`}>
      <button type="button" onClick={onSelect}>
        v{entry.version} • {badge}{duration ? ` • ${duration}` : ''}
      </button>
      {onDelete && (
        <button
          type="button"
          className="replay-tab-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete this version"
        >×</button>
      )}
    </div>
  );
}

function ReplayPanel({
  entry, JsonViewer,
}: {
  entry: VersionEntry;
  JsonViewer: React.ComponentType<{ data: unknown; label: string }>;
}) {
  return (
    <div className="replay-panel">
      <div className="replay-panel-row">
        <span className="replay-panel-label">Endpoint</span>
        <code>{entry.httpMethod} {entry.endpoint}</code>
      </div>
      {entry.queryParams !== null && Object.keys(entry.queryParams).length > 0 && (
        <JsonViewer data={entry.queryParams} label="Query params" />
      )}
      {entry.headers !== null && Object.keys(entry.headers).length > 0 && (
        <JsonViewer data={entry.headers} label="Headers" />
      )}
      {entry.source === 'log' && (
        <div className="replay-panel-note">
          Headers and query params not recorded separately for the original call.
        </div>
      )}
      {entry.requestData !== null && entry.requestData !== undefined && (
        <JsonViewer data={entry.requestData} label="Request body" />
      )}
      <div className="replay-panel-row">
        <span className="replay-panel-label">Status</span>
        <span>{entry.statusCode ?? '—'}{entry.durationMs !== null ? ` • ${entry.durationMs}ms` : ''}</span>
      </div>
      {entry.error && <div className="replay-panel-error">Error: {entry.error}</div>}
      {entry.responseData !== null && entry.responseData !== undefined && (
        <JsonViewer data={entry.responseData} label="Response" />
      )}
    </div>
  );
}

function ReplayEditor({
  prefill, method, endpoint, onCancel, onSubmit,
}: {
  prefill: { body: unknown; queryParams: Record<string, string>; headers: Record<string, string> };
  method: string;
  endpoint: string;
  onCancel: () => void;
  onSubmit: (payload: {
    queryParams: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
  }) => Promise<void>;
}) {
  const [queryText, setQueryText] = useState(
    JSON.stringify(prefill.queryParams, null, 2),
  );
  const [headersText, setHeadersText] = useState(
    JSON.stringify(prefill.headers, null, 2),
  );
  const [bodyText, setBodyText] = useState(
    prefill.body === null || prefill.body === undefined
      ? ''
      : typeof prefill.body === 'string'
        ? prefill.body
        : JSON.stringify(prefill.body, null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function handleSend() {
    setErr(null);
    try {
      const queryTrim = queryText.trim();
      const queryParams: Record<string, string> = queryTrim === ''
        ? {}
        : JSON.parse(queryTrim);
      const headersTrim = headersText.trim();
      const headers: Record<string, string> = headersTrim === ''
        ? {}
        : JSON.parse(headersTrim);
      let body: unknown;
      const t = bodyText.trim();
      if (t === '') {
        body = undefined;
      } else {
        try {
          body = JSON.parse(t);
        } catch {
          body = bodyText;
        }
      }
      setSubmitting(true);
      await onSubmit({ queryParams, headers, body });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="replay-editor">
      <div className="replay-editor-row">
        <label>Method</label>
        <input type="text" value={method} disabled />
      </div>
      <div className="replay-editor-row">
        <label>URL</label>
        <input type="text" value={endpoint} disabled />
      </div>
      <div className="replay-editor-row">
        <label>Query params (JSON object)</label>
        <textarea
          value={queryText}
          onChange={e => setQueryText(e.target.value)}
          rows={4}
          spellCheck={false}
        />
      </div>
      <div className="replay-editor-row">
        <label>Headers (JSON object)</label>
        <textarea
          value={headersText}
          onChange={e => setHeadersText(e.target.value)}
          rows={6}
          spellCheck={false}
        />
        <div className="replay-editor-hint">
          ⚠ Sensitive headers (Authorization, cookies) not restored from prior versions.
          Paste a fresh token if required.
        </div>
      </div>
      <div className="replay-editor-row">
        <label>Body (JSON or raw string)</label>
        <textarea
          value={bodyText}
          onChange={e => setBodyText(e.target.value)}
          rows={10}
          spellCheck={false}
        />
      </div>
      {err && <div className="replay-editor-error">{err}</div>}
      <div className="replay-editor-actions">
        <button type="button" onClick={handleSend} disabled={submitting}>
          {submitting ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
      </div>
    </div>
  );
}
