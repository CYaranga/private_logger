import { useState, useEffect, useCallback, type CSSProperties } from 'react';
import type { Log, Stats, Filters, Storage, Archive, LogLevel, HttpMethod } from './types';
import { ReplayTabs } from './Replay';
import { UsersTab } from './UsersTab';
import { ErrorsTab } from './ErrorsTab';
import { BehaviourTab } from './BehaviourTab';
import { UserProfileModal } from './UserProfileModal';
import { SessionTimelineModal } from './SessionTimelineModal';
import {
  Activity, Users as UsersIcon, AlertTriangle, Archive as ArchiveIcon, BarChart3,
  Terminal, RefreshCw, LogOut, Download, Trash2, Inbox, Bookmark, BookmarkPlus, X,
  Footprints, Radio,
} from 'lucide-react';
import { loadViews, saveViews, createView, type SavedView } from './savedViews';
import {
  fetchLogs,
  fetchStats,
  fetchUsers,
  fetchCategories,
  fetchDevices,
  fetchSources,
  deleteLog,
  bulkDeleteLogs,
  fetchStorage,
  fetchArchives,
  runArchive,
  deleteArchive,
  getArchiveDownloadUrl,
  getExportAllUrl,
  getStreamUrl,
  type BulkDeleteParams,
} from './api';
import { useAuth } from './AuthContext';
import { fetchTimeseries } from './api';
import type { TimeRange, TimeseriesResponse } from './types';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell, Legend,
} from 'recharts';

const PAGE_SIZE_OPTIONS = [25, 50, 200] as const;

// Hoisted module-level constants — avoids re-creating on every render/call
const SKELETON_CELL_WIDTHS = [40, 80, 50, 70, 55, 75, 40, 60, 180, 55, 130, 40, 55, 40] as const;
const COLUMN_WIDTHS_KEY = 'columnWidths:v1';

// Hoisted regex — /g flag maintains lastIndex; reset before each use
const JSON_TOKEN_REGEX = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([\[\]{}])|([,:])|(\s+)/g;

type ColumnKey = 'id' | 'timestamp' | 'level' | 'category' | 'user' | 'device' | 'env' | 'source' | 'message' | 'method' | 'endpoint' | 'status' | 'duration' | 'actions';

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  id: 60,
  timestamp: 165,
  level: 70,
  category: 90,
  user: 80,
  device: 100,
  env: 60,
  source: 80,
  message: 250,
  method: 70,
  endpoint: 200,
  status: 60,
  duration: 80,
  actions: 70,
};

function getStoredColumnWidths(): Record<ColumnKey, number> {
  try {
    const stored = localStorage.getItem(COLUMN_WIDTHS_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (typeof parsed === 'object' && parsed !== null) {
        const result = { ...DEFAULT_COLUMN_WIDTHS };
        for (const key of Object.keys(DEFAULT_COLUMN_WIDTHS) as ColumnKey[]) {
          const val = parsed[key];
          if (typeof val === 'number' && val >= 40) result[key] = val;
        }
        return result;
      }
    }
  } catch {
    // ignore corrupt data
  }
  return DEFAULT_COLUMN_WIDTHS;
}

// SQLite CURRENT_TIMESTAMP stores UTC without 'Z', so we must add it explicitly
// to prevent JS from misinterpreting the value as local time.
function parseUtcTimestamp(timestamp: string): Date {
  const normalized = timestamp.includes('Z') || timestamp.includes('+')
    ? timestamp
    : timestamp.replace(' ', 'T') + 'Z';
  return new Date(normalized);
}

function formatTimestamp(timestamp: string, timezone?: string): string {
  const date = parseUtcTimestamp(timestamp);
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    timeZone: timezone,
  });
}

function formatRelativeTime(timestamp: string): string {
  const now = Date.now();
  const then = parseUtcTimestamp(timestamp).getTime();
  const diff = now - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return formatTimestamp(timestamp);
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function useIsMobile(breakpoint = 768) {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= breakpoint
  );
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`);
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mql.addEventListener('change', handler);
    setIsMobile(mql.matches);
    return () => mql.removeEventListener('change', handler);
  }, [breakpoint]);
  return isMobile;
}

function syntaxHighlightJson(json: string): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let key = 0;
  JSON_TOKEN_REGEX.lastIndex = 0; // reset global regex state before use
  let match;
  let lastIndex = 0;
  while ((match = JSON_TOKEN_REGEX.exec(json)) !== null) {
    if (match.index > lastIndex) {
      elements.push(<span key={key++}>{json.slice(lastIndex, match.index)}</span>);
    }
    lastIndex = JSON_TOKEN_REGEX.lastIndex;
    const [fullMatch, keyWithColon, stringVal, numberVal, boolVal, nullVal, bracket, punctuation, whitespace] = match;
    if (keyWithColon) {
      const keyName = keyWithColon.slice(0, -1).trim();
      elements.push(<span key={key++} className="json-key">{keyName}</span>);
    } else if (stringVal) {
      elements.push(<span key={key++} className="json-string">{stringVal}</span>);
    } else if (numberVal) {
      elements.push(<span key={key++} className="json-number">{numberVal}</span>);
    } else if (boolVal) {
      elements.push(<span key={key++} className="json-boolean">{boolVal}</span>);
    } else if (nullVal) {
      elements.push(<span key={key++} className="json-null">{nullVal}</span>);
    } else if (bracket) {
      elements.push(<span key={key++} className="json-bracket">{bracket}</span>);
    } else if (punctuation) {
      elements.push(<span key={key++} className="json-punctuation">{punctuation}</span>);
    } else if (whitespace) {
      elements.push(<span key={key++}>{whitespace}</span>);
    } else {
      elements.push(<span key={key++}>{fullMatch}</span>);
    }
  }
  if (lastIndex < json.length) {
    elements.push(<span key={key++}>{json.slice(lastIndex)}</span>);
  }
  return elements;
}


function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };
  return (
    <button className={`copy-btn ${copied ? 'copied' : ''}`} onClick={handleCopy}>
      {copied ? 'Copied!' : 'Copy'}
    </button>
  );
}

function JsonViewer({ data, label }: { data: unknown; label: string }) {
  const [expanded, setExpanded] = useState(false);
  if (data === null || data === undefined) {
    return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  }
  let parsedData = data;
  let isJson = false;
  if (typeof data === 'string') {
    try {
      parsedData = JSON.parse(data);
      isJson = true;
    } catch {
      parsedData = data;
    }
  } else if (typeof data === 'object') {
    isJson = true;
  }
  const content = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData, null, 2);
  const isLong = content.length > 50;
  if (!isLong) {
    return (
      <div className="json-inline-wrapper">
        <code className="json-inline json-highlighted">
          {syntaxHighlightJson(content.length > 100 ? content.substring(0, 100) + '...' : content)}
        </code>
        {isJson && <CopyButton text={content} />}
      </div>
    );
  }
  return (
    <div className="json-viewer">
      <div className="json-viewer-header">
        <button className="json-toggle" onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Hide' : 'View'} {label}
        </button>
        {isJson && <CopyButton text={content} />}
      </div>
      {expanded && (
        <pre className="json-content json-highlighted">{syntaxHighlightJson(content)}</pre>
      )}
    </div>
  );
}

function ResizableHeader({
  columnKey, label, width, onResize,
}: {
  columnKey: ColumnKey;
  label: string;
  width: number;
  onResize: (key: ColumnKey, width: number) => void;
}) {
  const handleMouseDown = (ev: React.MouseEvent) => {
    ev.preventDefault();
    const startX = ev.clientX;
    const startWidth = width;
    let rafId: number | null = null;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      // Throttle high-frequency mousemove to animation frames to avoid layout thrashing
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const diff = moveEvent.clientX - startX;
        onResize(columnKey, Math.max(40, startWidth + diff));
      });
    };
    const handleMouseUp = () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  return (
    <th style={{ width: `${width}px`, minWidth: `${width}px`, maxWidth: `${width}px` }}>
      <div className="resizable-header">
        <span>{label}</span>
        <div className="resize-handle" onMouseDown={handleMouseDown} />
      </div>
    </th>
  );
}

function LevelBadge({ level }: { level: LogLevel }) {
  return <span className={`badge badge-level-${level}`}>{level}</span>;
}
function EnvironmentBadge({ env }: { env: string }) {
  return <span className={`badge badge-${env}`}>{env}</span>;
}
function SourceBadge({ source }: { source: string | null }) {
  if (!source) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  return <span className={`badge badge-source badge-source-${source}`}>{source}</span>;
}
function HttpMethodBadge({ method }: { method: HttpMethod | null }) {
  if (!method) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  return <span className={`badge badge-http badge-http-${method.toLowerCase()}`}>{method}</span>;
}
function StatusCodeBadge({ code }: { code: number | null }) {
  if (code === null) return <span style={{ color: 'var(--text-tertiary)' }}>—</span>;
  let className = 'badge-status';
  if (code >= 200 && code < 300) className += ' badge-status-success';
  else if (code >= 300 && code < 400) className += ' badge-status-redirect';
  else if (code >= 400 && code < 500) className += ' badge-status-client-error';
  else if (code >= 500) className += ' badge-status-server-error';
  return <span className={`badge ${className}`}>{code}</span>;
}
function CategoryBadge({ category }: { category: string }) {
  return <span className="badge badge-category">{category}</span>;
}

function StorageBar({ storage }: { storage: Storage | null }) {
  if (!storage) return null;
  const usageColor = storage.warning
    ? 'var(--error)'
    : storage.usage_percent > 50
    ? 'var(--warning)'
    : 'var(--success)';
  return (
    <div className="storage-bar" style={{ flexDirection: 'column', alignItems: 'stretch', marginBottom: '12px' }}>
      <div className="storage-header">
        <span>Storage: {formatBytes(storage.used_bytes)} / {formatBytes(storage.limit_bytes)}</span>
        <span>{storage.usage_percent.toFixed(2)}%</span>
      </div>
      <div className="storage-track">
        <div
          className="storage-fill"
          style={{ width: `${Math.min(storage.usage_percent, 100)}%`, backgroundColor: usageColor }}
        />
      </div>
      {storage.warning && (
        <div className="storage-warning">
          Storage is running low. Consider downloading and deleting old archives.
        </div>
      )}
    </div>
  );
}

function StatsCards({ stats }: { stats: Stats | null }) {
  if (!stats) return null;
  const levelCounts = stats.byLevel?.reduce(
    (acc, item) => ({ ...acc, [item.level]: item.count }),
    { debug: 0, info: 0, warn: 0, error: 0 }
  ) || { debug: 0, info: 0, warn: 0, error: 0 };
  const totalAllLogs = stats.total + (stats.archives?.totalLogs || 0);
  const hasErrors = (stats.errorCount || 0) > 0;

  return (
    <>
      <div className="stats-primary-row">
        <div className="stat-card stat-primary">
          <div className="stat-label">Recent Logs</div>
          <div className="stat-value">{stats.total.toLocaleString()}</div>
        </div>
        <div className="stat-card stat-primary">
          <div className="stat-label">Last 24 Hours</div>
          <div className="stat-value">{stats.last24Hours.toLocaleString()}</div>
        </div>
        <div className="stat-card stat-primary">
          <div className="stat-label">API Calls</div>
          <div className="stat-value">{(stats.apiCalls || 0).toLocaleString()}</div>
        </div>
        <div className={`stat-card stat-primary stat-error ${hasErrors ? 'stat-error-pulse' : ''}`}>
          <div className="stat-label">Errors</div>
          <div className="stat-value">{(stats.errorCount || 0).toLocaleString()}</div>
        </div>
      </div>

      <div className="stats-secondary-row">
        <div className="stat-card">
          <div className="stat-label">Total All Time</div>
          <div className="stat-value" style={{ fontSize: '18px' }}>{totalAllLogs.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Archived</div>
          <div className="stat-value" style={{ fontSize: '18px' }}>{(stats.archives?.totalLogs || 0).toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">Unique Users</div>
          <div className="stat-value" style={{ fontSize: '18px' }}>{stats.uniqueUsers.toLocaleString()}</div>
        </div>
        <div className="stat-card">
          <div className="stat-label">By Level</div>
          <div style={{ fontSize: '12px', fontFamily: 'var(--font-mono)', marginTop: '6px', lineHeight: '1.8' }}>
            <span style={{ color: 'var(--text-secondary)' }}>dbg {levelCounts.debug}</span>
            {' · '}
            <span style={{ color: 'var(--accent)' }}>inf {levelCounts.info}</span>
            {' · '}
            <span style={{ color: 'var(--warning)' }}>wrn {levelCounts.warn}</span>
            {' · '}
            <span style={{ color: 'var(--error)' }}>err {levelCounts.error}</span>
          </div>
        </div>
        {stats.bySource && stats.bySource.length > 0 && (
          <div className="stat-card">
            <div className="stat-label">By Source</div>
            <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', marginTop: '6px', lineHeight: '1.9' }}>
              {stats.bySource.slice(0, 4).map((s, i) => (
                <span key={s.source}>
                  {i > 0 && ' · '}
                  <span style={{ color: 'var(--accent)' }}>{s.source}</span>
                  <span style={{ color: 'var(--text-secondary)' }}> {s.count}</span>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </>
  );
}

function TableSkeletonRows({ count = 8 }: { count?: number }) {
  return (
    <>
      {Array.from({ length: count }).map((_, i) => (
        <tr key={i} className="skeleton-row">
          {SKELETON_CELL_WIDTHS.map((w, j) => (
            <td key={j}>
              <div className="skeleton-cell" style={{ width: `${w}%` }} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

function BulkDeleteModal({
  users, devices, categories, onClose, onDelete,
}: {
  users: string[];
  devices: string[];
  categories: string[];
  onClose: () => void;
  onDelete: (params: BulkDeleteParams) => Promise<void>;
}) {
  const [params, setParams] = useState<BulkDeleteParams>({});
  const [loading, setLoading] = useState(false);
  const hasFilters = params.user_id || params.device_id || params.category || params.start_date || params.end_date;

  const handleDelete = async () => {
    if (!hasFilters) return;
    const filterDesc = [
      params.user_id && `User: ${params.user_id}`,
      params.device_id && `Device: ${params.device_id}`,
      params.category && `Category: ${params.category}`,
      params.start_date && `From: ${params.start_date}`,
      params.end_date && `To: ${params.end_date}`,
    ].filter(Boolean).join(', ');
    if (!confirm(`Delete all logs matching:\n\n${filterDesc}\n\nThis cannot be undone.`)) return;
    setLoading(true);
    try {
      await onDelete(params);
      onClose();
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content" onClick={(ev) => ev.stopPropagation()}>
        <div className="modal-header">
          <h2>Bulk Delete Logs</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-warning">Select filters below. At least one filter is required.</p>
          <div className="bulk-delete-filters">
            <div className="filter-group">
              <label>User</label>
              <select value={params.user_id || ''} onChange={(ev) => setParams({ ...params, user_id: ev.target.value || undefined })}>
                <option value="">All Users</option>
                {users.map((u) => <option key={u} value={u}>{u}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <label>Device</label>
              <select value={params.device_id || ''} onChange={(ev) => setParams({ ...params, device_id: ev.target.value || undefined })}>
                <option value="">All Devices</option>
                {devices.map((d) => <option key={d} value={d}>{d}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <label>Category</label>
              <select value={params.category || ''} onChange={(ev) => setParams({ ...params, category: ev.target.value || undefined })}>
                <option value="">All Categories</option>
                {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
              </select>
            </div>
            <div className="filter-group">
              <label>Start Date</label>
              <input type="date" value={params.start_date || ''} onChange={(ev) => setParams({ ...params, start_date: ev.target.value || undefined })} />
            </div>
            <div className="filter-group">
              <label>End Date</label>
              <input type="date" value={params.end_date || ''} onChange={(ev) => setParams({ ...params, end_date: ev.target.value || undefined })} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>Cancel</button>
          <button className="btn btn-danger" onClick={handleDelete} disabled={!hasFilters || loading}>
            {loading ? 'Deleting...' : 'Delete Matching Logs'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArchivesSection({
  archives, onRunArchive, onDelete, timezone,
}: {
  archives: Archive[];
  onRunArchive: () => void;
  onDelete: (date: string) => void;
  timezone?: string;
}) {
  return (
    <div className="archives-section">
      <div className="archives-header">
        <h2>Archives</h2>
        <div className="archives-actions">
          <button className="btn btn-secondary" onClick={onRunArchive}>Archive Now</button>
          {archives.length > 0 && (
            <a href={getExportAllUrl()} className="btn btn-secondary" download>Export All</a>
          )}
        </div>
      </div>
      <p className="archives-info">
        Logs older than 7 days are automatically archived daily at 3:00 AM UTC.
        Download archives before deleting to keep a local backup.
      </p>
      {archives.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><Inbox size={32} strokeWidth={1.4} /></div>
          <div className="empty-state-title">No archives yet</div>
          <div className="empty-state-sub">Archives appear here after logs are older than 7 days</div>
        </div>
      ) : (
        <div className="logs-table">
          <table>
            <thead>
              <tr>
                <th>Date</th>
                <th>Logs Count</th>
                <th>Archived At</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {archives.map((archive) => (
                <tr key={archive.id}>
                  <td className="timestamp">{archive.archive_date}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: '12px' }}>{archive.log_count.toLocaleString()}</td>
                  <td className="timestamp">{formatTimestamp(archive.created_at, timezone)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <a
                        href={getArchiveDownloadUrl(archive.archive_date)}
                        className="btn btn-secondary"
                        style={{ padding: '4px 10px', fontSize: '11px', textDecoration: 'none' }}
                        download
                      >
                        Download
                      </a>
                      <button
                        className="btn btn-danger"
                        style={{ padding: '4px 10px', fontSize: '11px' }}
                        onClick={() => onDelete(archive.archive_date)}
                      >
                        Delete
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function LogRow({
  log, onDelete, timezone, columnWidths, isExpanded, onToggleExpand,
}: {
  log: Log;
  onDelete: (id: number) => void;
  timezone?: string;
  columnWidths: Record<ColumnKey, number>;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const isApiCall = log.http_method !== null;
  const senderTimezone = (log.metadata as Record<string, unknown>)?.timezone as string | undefined;
  const senderUtcOffset = (log.metadata as Record<string, unknown>)?.utcOffset as number | undefined;
  const cellStyle = (key: ColumnKey): React.CSSProperties => ({
    width: `${columnWidths[key]}px`,
    minWidth: `${columnWidths[key]}px`,
    maxWidth: `${columnWidths[key]}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  });

  return (
    <>
      <tr className={`log-row log-level-${log.level}`} onClick={onToggleExpand}>
        <td style={{ ...cellStyle('id'), color: 'var(--text-tertiary)', fontFamily: 'var(--font-mono)', fontSize: '11px' }}>#{log.id}</td>
        <td style={cellStyle('timestamp')} className="timestamp">
          <span>{formatTimestamp(log.created_at, timezone)}</span>
          <span style={{ display: 'block', fontSize: '10px', color: 'var(--text-tertiary)', marginTop: '1px' }}>
            {formatRelativeTime(log.created_at)}
            {senderTimezone && (
              <span style={{ marginLeft: '4px', color: 'var(--accent)', fontSize: '9px' }} title={`Sender: ${senderTimezone} (UTC${senderUtcOffset !== undefined ? (senderUtcOffset <= 0 ? '+' : '-') + Math.abs(senderUtcOffset / 60) : ''})`}>
                {senderTimezone.split('/').pop()?.replace(/_/g, ' ')}
              </span>
            )}
          </span>
        </td>
        <td style={cellStyle('level')}><LevelBadge level={log.level} /></td>
        <td style={cellStyle('category')}><CategoryBadge category={log.category} /></td>
        <td style={cellStyle('user')} className="user-id">{log.user_id}</td>
        <td style={cellStyle('device')} className="device-id">{log.device_id || '—'}</td>
        <td style={cellStyle('env')}><EnvironmentBadge env={log.environment} /></td>
        <td style={cellStyle('source')}><SourceBadge source={log.source} /></td>
        <td style={cellStyle('message')} className="message-cell" title={log.message}>{log.message}</td>
        <td style={cellStyle('method')}><HttpMethodBadge method={log.http_method} /></td>
        <td style={cellStyle('endpoint')} className="endpoint-cell" title={log.endpoint || ''}>{log.endpoint || '—'}</td>
        <td style={cellStyle('status')}><StatusCodeBadge code={log.status_code} /></td>
        <td style={cellStyle('duration')} className="duration-cell">{formatDuration(log.duration_ms)}</td>
        <td style={cellStyle('actions')}>
          <button
            className="btn btn-danger"
            style={{ padding: '3px 8px', fontSize: '11px' }}
            onClick={(ev) => { ev.stopPropagation(); onDelete(log.id); }}
          >
            Del
          </button>
        </td>
      </tr>
      {isExpanded && (
        <tr className="log-details-row">
          <td colSpan={14} onClick={(ev) => ev.stopPropagation()}>
            <div className="log-details">
              <div className="log-detail-section log-detail-message">
                <h4>Full Message</h4>
                <pre className="full-message-content">{log.message}</pre>
              </div>
              {senderTimezone && (
                <div className="log-detail-section">
                  <h4>Sender Timezone</h4>
                  <code className="full-endpoint">{senderTimezone} (UTC{senderUtcOffset !== undefined ? (senderUtcOffset <= 0 ? '+' : '-') + Math.abs(senderUtcOffset / 60) : ''})</code>
                </div>
              )}
              {isApiCall && log.endpoint && (
                <div className="log-detail-section">
                  <h4>Full Endpoint</h4>
                  <code className="full-endpoint">{log.endpoint}</code>
                </div>
              )}
              <div className="log-details-grid">
                <div className="log-detail-section">
                  <h4>Metadata</h4>
                  <JsonViewer data={log.metadata} label="Metadata" />
                </div>
              </div>
              {isApiCall && (
                <div className="log-detail-section">
                  <h4>Replay &amp; Versions</h4>
                  <ReplayTabs log={log} JsonViewer={JsonViewer} />
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ─── Mobile Components ──────────────────────── */

function MobileStatsBar({ stats, storage, expanded, onToggle }: {
  stats: Stats | null;
  storage: Storage | null;
  expanded: boolean;
  onToggle: () => void;
}) {
  if (!stats) return null;
  const hasErrors = (stats.errorCount || 0) > 0;
  const levelCounts = stats.byLevel?.reduce(
    (acc, item) => ({ ...acc, [item.level]: item.count }),
    { debug: 0, info: 0, warn: 0, error: 0 }
  ) || { debug: 0, info: 0, warn: 0, error: 0 };
  const totalAllLogs = stats.total + (stats.archives?.totalLogs || 0);

  return (
    <div className="mobile-stats">
      <div className="mobile-stats-summary" onClick={onToggle}>
        <div className="mobile-stats-row">
          <span className="mobile-stat-item">
            <span className="mobile-stat-label">Recent</span>
            <span className="mobile-stat-value">{stats.total.toLocaleString()}</span>
          </span>
          <span className="mobile-stat-item">
            <span className="mobile-stat-label">Errors</span>
            <span className={`mobile-stat-value ${hasErrors ? 'mobile-stat-error' : ''}`}>
              {(stats.errorCount || 0).toLocaleString()}
            </span>
          </span>
          <span className="mobile-stat-item">
            <span className="mobile-stat-label">24h</span>
            <span className="mobile-stat-value">{stats.last24Hours.toLocaleString()}</span>
          </span>
          <span className="mobile-stats-chevron">{expanded ? '▲' : '▼'}</span>
        </div>
        {storage && (
          <div className="mobile-storage-row">
            <div className="mobile-storage-track">
              <div
                className="storage-fill"
                style={{
                  width: `${Math.min(storage.usage_percent, 100)}%`,
                  backgroundColor: storage.warning ? 'var(--error)' : storage.usage_percent > 50 ? 'var(--warning)' : 'var(--success)',
                }}
              />
            </div>
            <span className="mobile-storage-pct">{storage.usage_percent.toFixed(0)}%</span>
          </div>
        )}
      </div>
      {expanded && (
        <div className="mobile-stats-expanded">
          <div className="mobile-stats-grid">
            <div className="mobile-stat-card">
              <div className="stat-label">Recent</div>
              <div className="stat-value">{stats.total.toLocaleString()}</div>
            </div>
            <div className="mobile-stat-card">
              <div className="stat-label">Last 24h</div>
              <div className="stat-value">{stats.last24Hours.toLocaleString()}</div>
            </div>
            <div className="mobile-stat-card">
              <div className="stat-label">API Calls</div>
              <div className="stat-value">{(stats.apiCalls || 0).toLocaleString()}</div>
            </div>
            <div className={`mobile-stat-card ${hasErrors ? 'mobile-stat-card-error' : ''}`}>
              <div className="stat-label">Errors</div>
              <div className="stat-value" style={{ color: 'var(--error)' }}>{(stats.errorCount || 0).toLocaleString()}</div>
            </div>
            <div className="mobile-stat-card">
              <div className="stat-label">Total</div>
              <div className="stat-value">{totalAllLogs.toLocaleString()}</div>
            </div>
            <div className="mobile-stat-card">
              <div className="stat-label">Archived</div>
              <div className="stat-value">{(stats.archives?.totalLogs || 0).toLocaleString()}</div>
            </div>
            <div className="mobile-stat-card">
              <div className="stat-label">By Level</div>
              <div style={{ fontSize: '11px', fontFamily: 'var(--font-mono)', marginTop: '4px', lineHeight: '1.8' }}>
                <span style={{ color: 'var(--text-secondary)' }}>dbg {levelCounts.debug}</span>
                {' · '}
                <span style={{ color: 'var(--accent)' }}>inf {levelCounts.info}</span>
                {' · '}
                <span style={{ color: 'var(--warning)' }}>wrn {levelCounts.warn}</span>
                {' · '}
                <span style={{ color: 'var(--error)' }}>err {levelCounts.error}</span>
              </div>
            </div>
            <div className="mobile-stat-card">
              <div className="stat-label">Users</div>
              <div className="stat-value">{stats.uniqueUsers.toLocaleString()}</div>
            </div>
          </div>
          {storage && <StorageBar storage={storage} />}
        </div>
      )}
    </div>
  );
}

/**
 * Saved views toolbar. Lets users persist a named filter combo to
 * localStorage (e.g. "iOS errors last 24h") and re-apply it later.
 */
function SavedViewsBar({
  filters, onLoad,
}: {
  filters: Filters;
  onLoad: (f: Filters) => void;
}) {
  const [views, setViews] = useState<SavedView[]>(() => loadViews());
  const [open, setOpen] = useState(false);
  const persist = (next: SavedView[]) => { saveViews(next); setViews(next); };

  const handleSave = () => {
    const name = prompt('Name this view:');
    if (!name?.trim()) return;
    persist([...views, createView(name, filters)]);
    setOpen(false);
  };
  const handleDelete = (id: string) => persist(views.filter(v => v.id !== id));

  return (
    <div style={{ position: 'relative', display: 'inline-flex', gap: 6 }}>
      <button
        className="btn btn-secondary"
        style={{ padding: '6px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        onClick={() => setOpen(p => !p)}
        title="Saved views"
      >
        <Bookmark size={12} strokeWidth={1.8} />
        Views {views.length > 0 && <span style={{ color: 'var(--text-tertiary)' }}>({views.length})</span>}
      </button>
      <button
        className="btn btn-secondary"
        style={{ padding: '6px 12px', fontSize: 12, display: 'inline-flex', alignItems: 'center', gap: 6 }}
        onClick={handleSave}
        title="Save current filters as a new view"
      >
        <BookmarkPlus size={12} strokeWidth={1.8} />
        Save
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 4px)', left: 0,
            background: 'var(--bg-1)', border: '1px solid var(--border-strong)',
            borderRadius: 6, padding: 6, minWidth: 280, zIndex: 50,
            boxShadow: '0 12px 30px -8px rgba(0,0,0,0.5)',
          }}
        >
          {views.length === 0 ? (
            <div style={{ padding: '10px 12px', fontSize: 12, color: 'var(--text-secondary)' }}>
              No saved views yet. Set filters and hit <strong>Save</strong>.
            </div>
          ) : views.map(v => (
            <div
              key={v.id}
              style={{
                display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px',
                borderRadius: 4, cursor: 'pointer',
              }}
              onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--bg-2)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
              onClick={() => { onLoad(v.filters); setOpen(false); }}
            >
              <Bookmark size={12} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
              <span style={{ flex: 1, fontSize: 12, fontFamily: 'var(--font-mono)' }}>{v.name}</span>
              <button
                onClick={(e) => { e.stopPropagation(); handleDelete(v.id); }}
                style={{
                  background: 'transparent', border: 'none', color: 'var(--text-tertiary)',
                  cursor: 'pointer', padding: 4, borderRadius: 3,
                }}
                title="Delete view"
              >
                <X size={12} strokeWidth={1.8} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * Date range inputs. Uses native datetime-local for friendliness.
 * Stored value is SQLite-compatible "YYYY-MM-DD HH:MM:SS" in UTC so string
 * comparison against logs.created_at works reliably.
 */
function DateRangeInputs({
  startValue, endValue, onChangeStart, onChangeEnd, stacked,
}: {
  startValue: string;
  endValue: string;
  onChangeStart: (v: string) => void;
  onChangeEnd: (v: string) => void;
  stacked?: boolean;
}) {
  const toLocalInput = (sqliteUtc: string): string => {
    if (!sqliteUtc) return '';
    const iso = sqliteUtc.includes('T') ? sqliteUtc : sqliteUtc.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const pad = (n: number) => n.toString().padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const fromLocalInput = (local: string): string => {
    if (!local) return '';
    const d = new Date(local);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString().slice(0, 19).replace('T', ' ');
  };
  const wrapStyle: CSSProperties = stacked
    ? { display: 'contents' }
    : { display: 'flex', gap: 6, alignItems: 'center' };
  const groupCls = stacked ? 'filter-group' : '';
  return (
    <div style={wrapStyle}>
      <div className={groupCls}>
        {stacked && <label>From</label>}
        <input
          type="datetime-local"
          value={toLocalInput(startValue)}
          onChange={(e) => onChangeStart(fromLocalInput(e.target.value))}
          placeholder="From"
          title="From (local time)"
          style={stacked ? undefined : { padding: '7px 8px', fontSize: 12 }}
        />
      </div>
      <div className={groupCls}>
        {stacked && <label>To</label>}
        <input
          type="datetime-local"
          value={toLocalInput(endValue)}
          onChange={(e) => onChangeEnd(fromLocalInput(e.target.value))}
          placeholder="To"
          title="To (local time)"
          style={stacked ? undefined : { padding: '7px 8px', fontSize: 12 }}
        />
      </div>
    </div>
  );
}

function MobileFilterSheet({
  filters, onFilterChange, onClear, onClose,
  users, devices, sources, categories,
}: {
  filters: Filters;
  onFilterChange: (key: keyof Filters, value: string) => void;
  onClear: () => void;
  onClose: () => void;
  users: string[];
  devices: string[];
  sources: string[];
  categories: string[];
}) {
  return (
    <div className="filter-sheet-overlay" onClick={onClose}>
      <div className="filter-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="filter-sheet-header">
          <h3>Filters</h3>
          <button className="btn btn-secondary" style={{ padding: '6px 16px', fontSize: '12px' }} onClick={onClose}>Done</button>
        </div>
        <div className="filter-sheet-body">
          <div className="filter-group">
            <label>Level</label>
            <select value={filters.level} onChange={(e) => onFilterChange('level', e.target.value)}>
              <option value="">All Levels</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
          </div>
          <div className="filter-group">
            <label>Environment</label>
            <select value={filters.environment} onChange={(e) => onFilterChange('environment', e.target.value)}>
              <option value="">All Envs</option>
              <option value="dev">Dev</option>
              <option value="test">Test</option>
              <option value="prod">Prod</option>
            </select>
          </div>
          <div className="filter-group">
            <label>Source</label>
            <select value={filters.source} onChange={(e) => onFilterChange('source', e.target.value)}>
              <option value="">All Sources</option>
              {sources.map((src) => <option key={src} value={src}>{src}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label>Category</label>
            <select value={filters.category} onChange={(e) => onFilterChange('category', e.target.value)}>
              <option value="">All Categories</option>
              {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label>HTTP Method</label>
            <select value={filters.http_method} onChange={(e) => onFilterChange('http_method', e.target.value)}>
              <option value="">All Methods</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </select>
          </div>
          <div className="filter-group">
            <label>User</label>
            <select value={filters.user_id} onChange={(e) => onFilterChange('user_id', e.target.value)}>
              <option value="">All Users</option>
              {users.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
          <div className="filter-group">
            <label>Device</label>
            <select value={filters.device_id} onChange={(e) => onFilterChange('device_id', e.target.value)}>
              <option value="">All Devices</option>
              {devices.map((d) => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <DateRangeInputs
            startValue={filters.start_date ?? ''}
            endValue={filters.end_date ?? ''}
            onChangeStart={(v) => onFilterChange('start_date', v)}
            onChangeEnd={(v) => onFilterChange('end_date', v)}
            stacked
          />
        </div>
        <div className="filter-sheet-footer">
          <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => { onClear(); onClose(); }}>Clear All</button>
          <button className="btn" style={{ flex: 1 }} onClick={onClose}>Apply</button>
        </div>
      </div>
    </div>
  );
}

function MobileLogCard({
  log, onDelete, timezone, isExpanded, onToggleExpand,
}: {
  log: Log;
  onDelete: (id: number) => void;
  timezone?: string;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const isApiCall = log.http_method !== null;
  const senderTimezone = (log.metadata as Record<string, unknown>)?.timezone as string | undefined;

  return (
    <div className={`mobile-log-card mobile-log-level-${log.level}`}>
      <div className="mobile-log-card-main" onClick={onToggleExpand}>
        <div className="mobile-log-badges">
          <LevelBadge level={log.level} />
          <SourceBadge source={log.source} />
          <EnvironmentBadge env={log.environment} />
          {log.category && <CategoryBadge category={log.category} />}
        </div>
        {isApiCall && (
          <div className="mobile-log-api">
            <HttpMethodBadge method={log.http_method} />
            <span className="mobile-log-endpoint">{log.endpoint || ''}</span>
            {log.status_code !== null && <StatusCodeBadge code={log.status_code} />}
          </div>
        )}
        <div className="mobile-log-message">{log.message}</div>
        <div className="mobile-log-meta">
          <span className="mobile-log-time">{formatRelativeTime(log.created_at)}</span>
          {log.user_id && <span className="mobile-log-user">{log.user_id}</span>}
          {log.duration_ms !== null && (
            <span className="mobile-log-duration">{formatDuration(log.duration_ms)}</span>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="mobile-log-details" onClick={(e) => e.stopPropagation()}>
          <div className="mobile-log-detail-row">
            <span className="mobile-log-detail-label">ID</span>
            <span className="mobile-log-detail-value">#{log.id}</span>
          </div>
          <div className="mobile-log-detail-row">
            <span className="mobile-log-detail-label">Time</span>
            <span className="mobile-log-detail-value">{formatTimestamp(log.created_at, timezone)}</span>
          </div>
          {log.device_id && (
            <div className="mobile-log-detail-row">
              <span className="mobile-log-detail-label">Device</span>
              <span className="mobile-log-detail-value">{log.device_id}</span>
            </div>
          )}
          {senderTimezone && (
            <div className="mobile-log-detail-row">
              <span className="mobile-log-detail-label">Sender TZ</span>
              <span className="mobile-log-detail-value">{senderTimezone}</span>
            </div>
          )}
          <div className="log-detail-section log-detail-message">
            <h4>Full Message</h4>
            <pre className="full-message-content">{log.message}</pre>
          </div>
          <div className="log-detail-section">
            <h4>Metadata</h4>
            <JsonViewer data={log.metadata} label="Metadata" />
          </div>
          {isApiCall && (
            <>
              {log.endpoint && (
                <div className="log-detail-section">
                  <h4>Full Endpoint</h4>
                  <code className="full-endpoint">{log.endpoint}</code>
                </div>
              )}
              <div className="log-detail-section">
                <h4>Replay &amp; Versions</h4>
                <ReplayTabs log={log} JsonViewer={JsonViewer} />
              </div>
            </>
          )}
          <button
            className="btn btn-danger mobile-log-delete"
            onClick={() => { if (confirm('Delete this log?')) onDelete(log.id); }}
          >
            Delete Log
          </button>
        </div>
      )}
    </div>
  );
}

function MobileArchiveCard({ archive, onDelete, timezone }: {
  archive: Archive;
  onDelete: (date: string) => void;
  timezone?: string;
}) {
  return (
    <div className="mobile-archive-card">
      <div className="mobile-archive-date">{archive.archive_date}</div>
      <div className="mobile-archive-info">
        <span>{archive.log_count.toLocaleString()} logs</span>
        <span className="mobile-archive-time">{formatTimestamp(archive.created_at, timezone)}</span>
      </div>
      <div className="mobile-archive-actions">
        <a href={getArchiveDownloadUrl(archive.archive_date)} className="btn btn-secondary" style={{ flex: 1, textAlign: 'center', textDecoration: 'none', fontSize: '12px' }} download>
          Download
        </a>
        <button className="btn btn-danger" style={{ flex: 1, fontSize: '12px' }} onClick={() => onDelete(archive.archive_date)}>
          Delete
        </button>
      </div>
    </div>
  );
}

function MobileSkeletonCards({ count = 5 }: { count?: number }) {
  return (
    <div className="mobile-log-list">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="mobile-log-card mobile-skeleton-card">
          <div className="mobile-log-badges">
            <div className="skeleton-cell" style={{ width: '50px', height: '18px' }} />
            <div className="skeleton-cell" style={{ width: '40px', height: '18px' }} />
            <div className="skeleton-cell" style={{ width: '35px', height: '18px' }} />
          </div>
          <div className="skeleton-cell" style={{ width: '80%', height: '14px', marginTop: '8px' }} />
          <div className="skeleton-cell" style={{ width: '55%', height: '12px', marginTop: '6px' }} />
        </div>
      ))}
    </div>
  );
}

const CHART_COLORS = {
  debug: '#6b7280',
  info: '#3b82f6',
  warn: '#f59e0b',
  error: '#ef4444',
};

const STATUS_COLORS: Record<string, string> = {
  '2xx': '#22c55e',
  '3xx': '#3b82f6',
  '4xx': '#f59e0b',
  '5xx': '#ef4444',
  'other': '#6b7280',
};

function AnalyticsDashboard({ isMobile }: { isMobile: boolean }) {
  const [range, setRange] = useState<TimeRange>('24h');
  const [data, setData] = useState<TimeseriesResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchTimeseries(range).then(res => {
      if (!cancelled) {
        setData(res);
        setLoading(false);
      }
    }).catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [range]);

  const formatXAxis = (ts: string) => {
    const d = new Date(ts);
    if (range === '7d') return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const formatLabel = (label: unknown) => formatXAxis(String(label));

  const chartHeight = isMobile ? 250 : 300;

  const rangeSelector = (
    <div className="analytics-range-selector">
      {(['1h', '6h', '24h', '7d'] as TimeRange[]).map(r => (
        <button key={r} className={`range-btn ${range === r ? 'active' : ''}`} onClick={() => setRange(r)}>{r}</button>
      ))}
    </div>
  );

  if (loading) {
    return (
      <div className="analytics-dashboard">
        {rangeSelector}
        <div className="analytics-loading">Loading analytics...</div>
      </div>
    );
  }

  if (!data || data.buckets.length === 0) {
    return (
      <div className="analytics-dashboard">
        {rangeSelector}
        <div className="analytics-empty">No data available for this time range.</div>
      </div>
    );
  }

  const volumeData = data.buckets.map(b => ({
    time: b.timestamp,
    debug: b.by_level.debug,
    info: b.by_level.info,
    warn: b.by_level.warn,
    error: b.by_level.error,
  }));

  const errorRateData = data.buckets.map(b => ({
    time: b.timestamp,
    rate: b.error_rate,
  }));

  const perfData = data.buckets
    .filter(b => b.p50_duration_ms !== null)
    .map(b => ({
      time: b.timestamp,
      p50: b.p50_duration_ms,
      p95: b.p95_duration_ms,
      p99: b.p99_duration_ms,
    }));

  const statusData = data.status_code_distribution.map(s => ({
    name: s.group,
    value: s.count,
  }));

  return (
    <div className="analytics-dashboard">
      {rangeSelector}

      <div className="analytics-card">
        <h3>Log Volume</h3>
        <ResponsiveContainer width="100%" height={chartHeight}>
          <AreaChart data={volumeData}>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
            <XAxis dataKey="time" tickFormatter={formatXAxis} stroke="#6b7280" fontSize={11} />
            <YAxis stroke="#6b7280" fontSize={11} />
            <Tooltip
              contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
              labelFormatter={formatLabel}
            />
            <Area type="monotone" dataKey="error" stackId="1" fill={CHART_COLORS.error} stroke={CHART_COLORS.error} fillOpacity={0.7} />
            <Area type="monotone" dataKey="warn" stackId="1" fill={CHART_COLORS.warn} stroke={CHART_COLORS.warn} fillOpacity={0.7} />
            <Area type="monotone" dataKey="info" stackId="1" fill={CHART_COLORS.info} stroke={CHART_COLORS.info} fillOpacity={0.7} />
            <Area type="monotone" dataKey="debug" stackId="1" fill={CHART_COLORS.debug} stroke={CHART_COLORS.debug} fillOpacity={0.7} />
            <Legend />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      <div className={`analytics-row ${isMobile ? 'analytics-row-mobile' : ''}`}>
        <div className="analytics-card">
          <h3>Error Rate %</h3>
          <ResponsiveContainer width="100%" height={chartHeight}>
            <LineChart data={errorRateData}>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
              <XAxis dataKey="time" tickFormatter={formatXAxis} stroke="#6b7280" fontSize={11} />
              <YAxis stroke="#6b7280" fontSize={11} unit="%" />
              <Tooltip
                contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                labelFormatter={formatLabel}
                formatter={(value: number | undefined) => [`${value ?? 0}%`, 'Error Rate']}
              />
              <Line type="monotone" dataKey="rate" stroke={CHART_COLORS.error} strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>

        <div className="analytics-card">
          <h3>Top Error Categories</h3>
          {data.top_error_categories.length > 0 ? (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <BarChart data={data.top_error_categories} layout="vertical" margin={{ left: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis type="number" stroke="#6b7280" fontSize={11} />
                <YAxis dataKey="category" type="category" stroke="#6b7280" fontSize={11} width={80} />
                <Tooltip
                  contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                />
                <Bar dataKey="count" fill={CHART_COLORS.error} radius={[0, 4, 4, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="analytics-empty-chart">No errors in this period</div>
          )}
        </div>
      </div>

      <div className={`analytics-row ${isMobile ? 'analytics-row-mobile' : ''}`}>
        <div className="analytics-card">
          <h3>Response Times (ms)</h3>
          {perfData.length > 0 ? (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <LineChart data={perfData}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="time" tickFormatter={formatXAxis} stroke="#6b7280" fontSize={11} />
                <YAxis stroke="#6b7280" fontSize={11} />
                <Tooltip
                  contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                  labelFormatter={formatLabel}
                  formatter={(value: number | undefined) => [`${value ?? 0}ms`]}
                />
                <Line type="monotone" dataKey="p50" stroke="#22c55e" strokeWidth={2} dot={false} name="p50" />
                <Line type="monotone" dataKey="p95" stroke="#f59e0b" strokeWidth={2} dot={false} name="p95" />
                <Line type="monotone" dataKey="p99" stroke="#ef4444" strokeWidth={2} dot={false} name="p99" />
                <Legend />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="analytics-empty-chart">No duration data available</div>
          )}
        </div>

        <div className="analytics-card">
          <h3>Status Codes</h3>
          {statusData.length > 0 ? (
            <ResponsiveContainer width="100%" height={chartHeight}>
              <PieChart>
                <Pie
                  data={statusData}
                  cx="50%"
                  cy="50%"
                  innerRadius={isMobile ? 50 : 60}
                  outerRadius={isMobile ? 80 : 100}
                  dataKey="value"
                  label={({ name, value }) => `${name}: ${value}`}
                  labelLine={false}
                  fontSize={11}
                >
                  {statusData.map((entry) => (
                    <Cell key={entry.name} fill={STATUS_COLORS[entry.name] || '#6b7280'} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{ background: '#161616', border: '1px solid rgba(255,255,255,0.1)', borderRadius: '6px', fontSize: '12px' }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <div className="analytics-empty-chart">No API data available</div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const { user, logout } = useAuth();
  const [activeTab, setActiveTab] = useState<'logs' | 'users' | 'errors' | 'behaviour' | 'archives' | 'analytics'>('logs');
  const [openUserId, setOpenUserId] = useState<string | null>(null);
  const [openSessionId, setOpenSessionId] = useState<string | null>(null);
  const [logs, setLogs] = useState<Log[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [sources, setSources] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [liveTail, setLiveTail] = useState(false);
  const [liveCount, setLiveCount] = useState(0);
  const [filters, setFilters] = useState<Filters>({
    user_id: '',
    device_id: '',
    environment: '',
    source: '',
    search: '',
    level: '',
    category: '',
    http_method: '',
  });
  const [searchInput, setSearchInput] = useState('');

  useEffect(() => {
    const trimmed = searchInput.trim();
    if (trimmed === filters.search) return;
    const t = setTimeout(() => {
      setFilters(prev => (prev.search === trimmed ? prev : { ...prev, search: trimmed }));
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput, filters.search]);

  const isSearching = searchInput.trim() !== filters.search || (loading && filters.search.length > 0);
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [userTimezone, setUserTimezone] = useState<string | undefined>(undefined);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(getStoredColumnWidths);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [showMoreFilters, setShowMoreFilters] = useState(false);
  const isMobile = useIsMobile();
  const [showFilterSheet, setShowFilterSheet] = useState(false);
  const [mobileStatsExpanded, setMobileStatsExpanded] = useState(false);

  const handleColumnResize = useCallback((key: ColumnKey, width: number) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [key]: width };
      localStorage.setItem(COLUMN_WIDTHS_KEY, JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const toggleRowExpanded = useCallback((id: number) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) newSet.delete(id);
      else newSet.add(id);
      return newSet;
    });
  }, []);

  useEffect(() => {
    async function fetchTimezone() {
      try {
        const response = await fetch('https://worldtimeapi.org/api/ip');
        if (response.ok) {
          const data = await response.json();
          setUserTimezone(data.timezone);
        }
      } catch {
        console.warn('Could not detect timezone from IP, using browser default');
      }
    }
    fetchTimezone();
  }, []);

  const totalPages = Math.max(1, Math.ceil(total / perPage));

  const loadData = useCallback(async (targetPage?: number) => {
    const p = targetPage ?? page;
    try {
      setLoading(true);
      setError(null);
      setExpandedRows(new Set());
      const offset = (p - 1) * perPage;
      const [logsData, statsData, usersData, devicesData, sourcesData, categoriesData, storageData, archivesData] = await Promise.all([
        fetchLogs(filters, perPage, offset),
        fetchStats(),
        fetchUsers(),
        fetchDevices(),
        fetchSources(),
        fetchCategories(),
        fetchStorage(),
        fetchArchives(),
      ]);
      setLogs(logsData.logs);
      setTotal(logsData.total);
      setStats(statsData);
      setUsers(usersData);
      setDevices(devicesData);
      setSources(sourcesData);
      setCategories(categoriesData);
      setStorage(storageData);
      setArchives(archivesData);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters, page, perPage]);

  useEffect(() => { loadData(); }, [loadData]);

  useEffect(() => {
    // Auto-refresh polling pauses while live tail is active — the SSE stream
    // delivers entries as they land so a 30s reload would be wasted work.
    if (!autoRefresh || liveTail) return;
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData, autoRefresh, liveTail]);

  useEffect(() => {
    if (!liveTail) { setLiveCount(0); return; }
    const url = getStreamUrl();
    const es = new EventSource(url, { withCredentials: true });
    es.onmessage = (ev) => {
      try {
        const log = JSON.parse(ev.data) as Log;
        setLogs(prev => {
          if (prev.some(p => p.id === log.id)) return prev;
          // Prepend, cap at perPage so the table doesn't grow unbounded.
          return [log, ...prev].slice(0, perPage);
        });
        setLiveCount(c => c + 1);
      } catch {
        // ignore malformed events
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do beyond logging.
      console.warn('[live tail] connection blip — reconnecting');
    };
    return () => es.close();
  }, [liveTail, perPage]);

  useEffect(() => { setPage(1); }, [filters, perPage]);

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({ user_id: '', device_id: '', environment: '', source: '', search: '', level: '', category: '', http_method: '', session_id: '', fingerprint: '', app_version: '', start_date: '', end_date: '' });
    setSearchInput('');
  };

  // Single-pass to avoid iterating Object.values(filters) twice
  const activeFilterValues = Object.values(filters).filter(v => v !== '');
  const hasActiveFilters = activeFilterValues.length > 0;
  const activeFilterCount = activeFilterValues.length;

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this log?')) return;
    try {
      await deleteLog(id);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete log');
    }
  };

  const handleRunArchive = async () => {
    try {
      const result = await runArchive();
      if (result.archived > 0) {
        alert(`Archived ${result.archived} logs from: ${result.dates.join(', ')}`);
      } else {
        alert('No logs to archive. Logs must be older than 7 days.');
      }
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to run archive');
    }
  };

  const handleDeleteArchive = async (date: string) => {
    if (!confirm(`Delete archive for ${date}? Make sure you've downloaded it first.`)) return;
    try {
      await deleteArchive(date);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete archive');
    }
  };

  const handleBulkDelete = async (params: BulkDeleteParams) => {
    try {
      const result = await bulkDeleteLogs(params);
      alert(result.message);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to bulk delete logs');
      throw err;
    }
  };

  const handleDeleteAllFiltered = async () => {
    const filterDesc = [
      filters.level && `Level: ${filters.level}`,
      filters.environment && `Env: ${filters.environment}`,
      filters.category && `Category: ${filters.category}`,
      filters.user_id && `User: ${filters.user_id}`,
      filters.device_id && `Device: ${filters.device_id}`,
      filters.source && `Source: ${filters.source}`,
      filters.http_method && `Method: ${filters.http_method}`,
      filters.search && `Search: "${filters.search}"`,
    ].filter(Boolean).join(', ');

    const msg = hasActiveFilters
      ? `Delete all ${total.toLocaleString()} logs matching:\n\n${filterDesc}\n\nThis cannot be undone.`
      : `Delete ALL ${total.toLocaleString()} logs?\n\nNo filters are active — this deletes everything.\n\nThis cannot be undone.`;

    if (!confirm(msg)) return;

    const params: BulkDeleteParams = {};
    if (filters.user_id) params.user_id = filters.user_id;
    if (filters.device_id) params.device_id = filters.device_id;
    if (filters.category) params.category = filters.category;
    if (filters.level) params.level = filters.level;
    if (filters.environment) params.environment = filters.environment;
    if (filters.source) params.source = filters.source;
    if (filters.http_method) params.http_method = filters.http_method;
    if (filters.search) params.search = filters.search;

    try {
      const result = await bulkDeleteLogs(params);
      alert(result.message);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete logs');
    }
  };

  const handleExportCsv = async () => {
    if (exportingCsv) return;
    setExportingCsv(true);
    try {
      const PAGE = 500;
      const all: Log[] = [];
      let offset = 0;
      while (true) {
        const res = await fetchLogs(filters, PAGE, offset);
        all.push(...res.logs);
        if (all.length >= res.total || res.logs.length === 0) break;
        offset += res.logs.length;
        if (offset > 100000) break;
      }
      const cols: (keyof Log)[] = [
        'id', 'created_at', 'level', 'environment', 'source', 'user_id', 'device_id',
        'session_id', 'app_version', 'os_version', 'device_model', 'network_type',
        'category', 'http_method', 'endpoint', 'status_code', 'duration_ms',
        'message', 'metadata', 'request_data', 'response_data', 'breadcrumbs',
      ];
      const escape = (v: unknown): string => {
        if (v === null || v === undefined) return '';
        const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
        return `"${s.replace(/"/g, '""').replace(/\r?\n/g, '\\n')}"`;
      };
      const lines = [cols.join(',')];
      for (const log of all) {
        lines.push(cols.map(k => escape(log[k])).join(','));
      }
      const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date().toISOString().replace(/[:.]/g, '-').split('T')[0];
      a.href = url;
      a.download = `logs-${ts}${hasActiveFilters ? '-filtered' : ''}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to export CSV');
    } finally {
      setExportingCsv(false);
    }
  };

  /* ─── Mobile Layout ──────────────────────────── */
  if (isMobile) {
    return (
      <div className="container mobile">
        <header className="mobile-header">
          <div className="mobile-header-top">
            <h1><span className="header-prefix">~/</span>private-logger</h1>
            <div className="mobile-header-actions">
              <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={() => loadData()}>
                refresh
              </button>
              <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '12px' }} onClick={logout}>
                logout
              </button>
            </div>
          </div>
          <div className="mobile-auto-refresh">
            <div className={`dot ${autoRefresh ? '' : 'dot-paused'}`} />
            <span>{lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <label className="auto-refresh-toggle">
              <input type="checkbox" checked={autoRefresh} onChange={(ev) => setAutoRefresh(ev.target.checked)} />
              auto
            </label>
          </div>
        </header>

        {error && <div className="error">{error}</div>}

        <MobileStatsBar
          stats={stats}
          storage={storage}
          expanded={mobileStatsExpanded}
          onToggle={() => setMobileStatsExpanded(p => !p)}
        />

        <div className="tabs">
          <button className={`tab ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
            <Activity size={13} strokeWidth={1.6} /> logs
          </button>
          <button className={`tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
            <UsersIcon size={13} strokeWidth={1.6} /> users
          </button>
          <button className={`tab ${activeTab === 'errors' ? 'active' : ''}`} onClick={() => setActiveTab('errors')}>
            <AlertTriangle size={13} strokeWidth={1.6} /> errors
          </button>
          <button className={`tab ${activeTab === 'behaviour' ? 'active' : ''}`} onClick={() => setActiveTab('behaviour')}>
            <Footprints size={13} strokeWidth={1.6} /> behaviour
          </button>
          <button className={`tab ${activeTab === 'archives' ? 'active' : ''}`} onClick={() => setActiveTab('archives')}>
            <ArchiveIcon size={13} strokeWidth={1.6} /> archives
          </button>
          <button className={`tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
            <BarChart3 size={13} strokeWidth={1.6} /> analytics
          </button>
        </div>

        {activeTab === 'logs' ? (
          <>
            <div className="mobile-search-row">
              <div className="search-wrap">
                <input
                  type="text"
                  placeholder="Search any text..."
                  value={searchInput}
                  onChange={(ev) => setSearchInput(ev.target.value)}
                />
                {searchInput && (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="Clear search"
                    onClick={() => setSearchInput('')}
                  >×</button>
                )}
                <div className="search-progress" data-active={isSearching} aria-hidden="true" />
              </div>
              <button
                className={`mobile-filter-btn ${activeFilterCount > 0 ? 'has-filters' : ''}`}
                onClick={() => setShowFilterSheet(true)}
              >
                Filters{activeFilterCount > 0 && <span className="mobile-filter-count">{activeFilterCount}</span>}
              </button>
            </div>

            <div className="mobile-toolbar">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {total.toLocaleString()} logs
                {hasActiveFilters && <span style={{ color: 'var(--accent)' }}> · filtered</span>}
              </span>
              <div style={{ display: 'flex', gap: '6px' }}>
                <button
                  className="btn btn-secondary"
                  style={{ padding: '5px 10px', fontSize: '11px' }}
                  onClick={handleExportCsv}
                  disabled={exportingCsv || total === 0}
                >
                  {exportingCsv ? '...' : 'CSV'}
                </button>
                <button
                  className="btn btn-danger"
                  style={{ padding: '5px 10px', fontSize: '11px' }}
                  onClick={handleDeleteAllFiltered}
                >
                  {hasActiveFilters ? `Del (${total})` : `Del All`}
                </button>
                <button className="btn btn-danger" style={{ padding: '5px 10px', fontSize: '11px' }} onClick={() => setShowBulkDelete(true)}>
                  Bulk
                </button>
              </div>
            </div>

            {loading && logs.length === 0 ? (
              <MobileSkeletonCards count={6} />
            ) : logs.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon"><Inbox size={32} strokeWidth={1.4} /></div>
                <div className="empty-state-title">No logs found</div>
                <div className="empty-state-sub">
                  {hasActiveFilters ? 'Try adjusting your filters' : 'Logs will appear here once your app starts sending them'}
                </div>
              </div>
            ) : (
              <>
                <div className="mobile-log-list">
                  {logs.map((log) => (
                    <MobileLogCard
                      key={log.id}
                      log={log}
                      onDelete={handleDelete}
                      timezone={userTimezone}
                      isExpanded={expandedRows.has(log.id)}
                      onToggleExpand={() => toggleRowExpanded(log.id)}
                    />
                  ))}
                </div>

                <div className="pagination mobile-pagination">
                  <div className="pagination-info">
                    {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total.toLocaleString()}
                  </div>
                  <div className="pagination-controls">
                    <select className="per-page-select" value={perPage} onChange={(ev) => setPerPage(Number(ev.target.value))}>
                      {PAGE_SIZE_OPTIONS.map((size) => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                    <button className="btn btn-secondary" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>‹</button>
                    <span className="page-indicator">{page}/{totalPages}</span>
                    <button className="btn btn-secondary" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>›</button>
                  </div>
                </div>
              </>
            )}

            {showFilterSheet && (
              <MobileFilterSheet
                filters={filters}
                onFilterChange={handleFilterChange}
                onClear={clearFilters}
                onClose={() => setShowFilterSheet(false)}
                users={users}
                devices={devices}
                sources={sources}
                categories={categories}
              />
            )}
          </>
        ) : activeTab === 'archives' ? (
          <div className="mobile-archives">
            <div className="mobile-archives-header">
              <button className="btn btn-secondary" style={{ flex: 1, fontSize: '12px' }} onClick={handleRunArchive}>Archive Now</button>
              {archives.length > 0 && (
                <a href={getExportAllUrl()} className="btn btn-secondary" style={{ flex: 1, textAlign: 'center', textDecoration: 'none', fontSize: '12px' }} download>Export All</a>
              )}
            </div>
            <p className="archives-info">
              Logs older than 7 days are automatically archived daily at 3:00 AM UTC.
            </p>
            {archives.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state-icon"><Inbox size={32} strokeWidth={1.4} /></div>
                <div className="empty-state-title">No archives yet</div>
                <div className="empty-state-sub">Archives appear here after logs are older than 7 days</div>
              </div>
            ) : (
              <div className="mobile-archive-list">
                {archives.map((archive) => (
                  <MobileArchiveCard
                    key={archive.id}
                    archive={archive}
                    onDelete={handleDeleteArchive}
                    timezone={userTimezone}
                  />
                ))}
              </div>
            )}
          </div>
        ) : activeTab === 'users' ? (
          <UsersTab onSelectUser={setOpenUserId} />
        ) : activeTab === 'errors' ? (
          <ErrorsTab onSelectGroup={(fp) => {
            setFilters(prev => ({ ...prev, fingerprint: fp }));
            setActiveTab('logs');
          }} />
        ) : activeTab === 'behaviour' ? (
          <BehaviourTab />
        ) : (
          <AnalyticsDashboard isMobile={true} />
        )}

        {openUserId && (
          <UserProfileModal
            userId={openUserId}
            onClose={() => setOpenUserId(null)}
            onOpenSession={(sid) => { setOpenUserId(null); setOpenSessionId(sid); }}
            onApplyFingerprint={(fp) => {
              setFilters(prev => ({ ...prev, fingerprint: fp }));
              setOpenUserId(null);
              setActiveTab('logs');
            }}
          />
        )}
        {openSessionId && (
          <SessionTimelineModal sessionId={openSessionId} onClose={() => setOpenSessionId(null)} />
        )}

        {showBulkDelete && (
          <BulkDeleteModal
            users={users}
            devices={devices}
            categories={categories}
            onClose={() => setShowBulkDelete(false)}
            onDelete={handleBulkDelete}
          />
        )}
      </div>
    );
  }

  /* ─── Desktop Layout ─────────────────────────── */
  const tableHeaders = (
    <tr>
      <ResizableHeader columnKey="id" label="ID" width={columnWidths.id} onResize={handleColumnResize} />
      <ResizableHeader columnKey="timestamp" label="Time" width={columnWidths.timestamp} onResize={handleColumnResize} />
      <ResizableHeader columnKey="level" label="Level" width={columnWidths.level} onResize={handleColumnResize} />
      <ResizableHeader columnKey="category" label="Category" width={columnWidths.category} onResize={handleColumnResize} />
      <ResizableHeader columnKey="user" label="User" width={columnWidths.user} onResize={handleColumnResize} />
      <ResizableHeader columnKey="device" label="Device" width={columnWidths.device} onResize={handleColumnResize} />
      <ResizableHeader columnKey="env" label="Env" width={columnWidths.env} onResize={handleColumnResize} />
      <ResizableHeader columnKey="source" label="Source" width={columnWidths.source} onResize={handleColumnResize} />
      <ResizableHeader columnKey="message" label="Message" width={columnWidths.message} onResize={handleColumnResize} />
      <ResizableHeader columnKey="method" label="Method" width={columnWidths.method} onResize={handleColumnResize} />
      <ResizableHeader columnKey="endpoint" label="Endpoint" width={columnWidths.endpoint} onResize={handleColumnResize} />
      <ResizableHeader columnKey="status" label="Status" width={columnWidths.status} onResize={handleColumnResize} />
      <ResizableHeader columnKey="duration" label="Duration" width={columnWidths.duration} onResize={handleColumnResize} />
      <ResizableHeader columnKey="actions" label="" width={columnWidths.actions} onResize={handleColumnResize} />
    </tr>
  );

  const secondaryFiltersActive = !!(filters.user_id || filters.device_id || filters.category || filters.http_method || filters.source);

  return (
    <div className="container">
      <header className="header">
        <div>
          <div className="kicker">{stats?.total ? `${stats.total.toLocaleString()} entries · ${stats.uniqueUsers} users` : 'observability console'}</div>
          <h1 style={{ marginTop: 4, display: 'flex', alignItems: 'center', gap: 8 }}>
            <Terminal size={18} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
            <span className="header-prefix">~/</span>private-logger
          </h1>
        </div>
        <div className="header-right">
          <div className="refresh-indicator">
            <span className={autoRefresh ? 'dot-led' : ''} style={!autoRefresh ? { display: 'inline-block', width: 6, height: 6, borderRadius: '50%', background: 'var(--text-tertiary)', marginRight: 8 } : undefined} />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-secondary)' }}>{lastRefresh.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <label className="auto-refresh-toggle">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(ev) => setAutoRefresh(ev.target.checked)}
              />
              auto
            </label>
            <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => loadData()}>
              <RefreshCw size={12} strokeWidth={1.8} className={loading ? 'spin' : ''} /> refresh
            </button>
            <button
              className="btn btn-secondary"
              style={{
                padding: '5px 10px', fontSize: '12px', display: 'inline-flex',
                alignItems: 'center', gap: 6,
                color: liveTail ? 'var(--success)' : undefined,
                borderColor: liveTail ? 'rgba(134,215,161,0.45)' : undefined,
              }}
              onClick={() => setLiveTail(p => !p)}
              title={liveTail ? 'Stop live tail' : 'Start streaming new logs as they arrive'}
            >
              <Radio size={12} strokeWidth={1.8} className={liveTail ? 'spin' : ''} />
              {liveTail ? `live · ${liveCount}` : 'live'}
            </button>
          </div>
          <div className="user-menu">
            <span className="user-name">{user?.username}</span>
            <button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={logout}>
              <LogOut size={12} strokeWidth={1.8} /> logout
            </button>
          </div>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <StorageBar storage={storage} />
      <StatsCards stats={stats} />

      <div className="tabs">
        <button className={`tab ${activeTab === 'logs' ? 'active' : ''}`} onClick={() => setActiveTab('logs')}>
          <Activity size={14} strokeWidth={1.6} /> logs <span style={{ color: 'var(--text-tertiary)' }}>({stats?.total || 0})</span>
        </button>
        <button className={`tab ${activeTab === 'users' ? 'active' : ''}`} onClick={() => setActiveTab('users')}>
          <UsersIcon size={14} strokeWidth={1.6} /> users
        </button>
        <button className={`tab ${activeTab === 'errors' ? 'active' : ''}`} onClick={() => setActiveTab('errors')}>
          <AlertTriangle size={14} strokeWidth={1.6} /> errors
        </button>
        <button className={`tab ${activeTab === 'behaviour' ? 'active' : ''}`} onClick={() => setActiveTab('behaviour')}>
          <Footprints size={14} strokeWidth={1.6} /> behaviour
        </button>
        <button className={`tab ${activeTab === 'archives' ? 'active' : ''}`} onClick={() => setActiveTab('archives')}>
          <ArchiveIcon size={14} strokeWidth={1.6} /> archives <span style={{ color: 'var(--text-tertiary)' }}>({archives.length})</span>
        </button>
        <button className={`tab ${activeTab === 'analytics' ? 'active' : ''}`} onClick={() => setActiveTab('analytics')}>
          <BarChart3 size={14} strokeWidth={1.6} /> analytics
        </button>
      </div>

      {activeTab === 'logs' ? (
        <>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <SavedViewsBar
              filters={filters}
              onLoad={(f) => { setFilters(f); setSearchInput(f.search ?? ''); }}
            />
          </div>
          <div className="filters-container">
            <div className="filters-row-1">
              <div className="search-wrap">
                <input
                  type="text"
                  placeholder="Search any text — messages, metadata, request/response body..."
                  value={searchInput}
                  onChange={(ev) => setSearchInput(ev.target.value)}
                />
                {searchInput && (
                  <button
                    type="button"
                    className="search-clear"
                    aria-label="Clear search"
                    onClick={() => setSearchInput('')}
                  >×</button>
                )}
                <div className="search-progress" data-active={isSearching} aria-hidden="true" />
              </div>
              <select value={filters.level} onChange={(ev) => handleFilterChange('level', ev.target.value)}>
                <option value="">All Levels</option>
                <option value="debug">Debug</option>
                <option value="info">Info</option>
                <option value="warn">Warning</option>
                <option value="error">Error</option>
              </select>
              <select value={filters.environment} onChange={(ev) => handleFilterChange('environment', ev.target.value)}>
                <option value="">All Envs</option>
                <option value="dev">Dev</option>
                <option value="test">Test</option>
                <option value="prod">Prod</option>
              </select>
              <button
                className={`filters-toggle ${showMoreFilters || secondaryFiltersActive ? 'has-filters' : ''}`}
                onClick={() => setShowMoreFilters(p => !p)}
              >
                {showMoreFilters ? '▲' : '▼'} more
                {activeFilterCount > 0 && <span style={{ marginLeft: '2px' }}>({activeFilterCount})</span>}
              </button>
              {hasActiveFilters && (
                <button className="btn btn-secondary" style={{ padding: '7px 12px', fontSize: '12px' }} onClick={clearFilters}>
                  clear
                </button>
              )}
            </div>

            {showMoreFilters && (
              <div className="filters-row-2">
                <select value={filters.category} onChange={(ev) => handleFilterChange('category', ev.target.value)}>
                  <option value="">All Categories</option>
                  {categories.map((cat) => <option key={cat} value={cat}>{cat}</option>)}
                </select>
                <select value={filters.http_method} onChange={(ev) => handleFilterChange('http_method', ev.target.value)}>
                  <option value="">All Methods</option>
                  <option value="GET">GET</option>
                  <option value="POST">POST</option>
                  <option value="PUT">PUT</option>
                  <option value="DELETE">DELETE</option>
                  <option value="PATCH">PATCH</option>
                </select>
                <select value={filters.user_id} onChange={(ev) => handleFilterChange('user_id', ev.target.value)}>
                  <option value="">All Users</option>
                  {users.map((u) => <option key={u} value={u}>{u}</option>)}
                </select>
                <select value={filters.device_id} onChange={(ev) => handleFilterChange('device_id', ev.target.value)}>
                  <option value="">All Devices</option>
                  {devices.map((d) => <option key={d} value={d}>{d}</option>)}
                </select>
                <select value={filters.source} onChange={(ev) => handleFilterChange('source', ev.target.value)}>
                  <option value="">All Sources</option>
                  {sources.map((src) => <option key={src} value={src}>{src}</option>)}
                </select>
                <DateRangeInputs
                  startValue={filters.start_date ?? ''}
                  endValue={filters.end_date ?? ''}
                  onChangeStart={(v) => handleFilterChange('start_date', v)}
                  onChangeEnd={(v) => handleFilterChange('end_date', v)}
                />
              </div>
            )}
          </div>

          <div className="table-toolbar">
            <div className="table-toolbar-left">
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: '12px', color: 'var(--text-secondary)' }}>
                {total.toLocaleString()} logs
                {hasActiveFilters && <span style={{ color: 'var(--accent)' }}> · filtered</span>}
              </span>
            </div>
            <div className="table-toolbar-right">
              <button
                className="btn btn-secondary"
                style={{ padding: '5px 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={handleExportCsv}
                disabled={exportingCsv || total === 0}
                title={hasActiveFilters ? 'Export filtered logs to CSV' : 'Export all logs to CSV'}
              >
                <Download size={12} strokeWidth={1.8} />
                {exportingCsv ? 'Exporting…' : `CSV${hasActiveFilters ? ` (${total.toLocaleString()})` : ''}`}
              </button>
              <button
                className="btn btn-danger"
                style={{ padding: '5px 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                onClick={handleDeleteAllFiltered}
              >
                <Trash2 size={12} strokeWidth={1.8} />
                {hasActiveFilters ? `Delete (${total.toLocaleString()})` : `Delete All (${total.toLocaleString()})`}
              </button>
              <button className="btn btn-danger" style={{ padding: '5px 12px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setShowBulkDelete(true)}>
                <Trash2 size={12} strokeWidth={1.8} /> Bulk
              </button>
            </div>
          </div>

          {loading && logs.length === 0 ? (
            <div className="logs-table logs-table-wide">
              <table className="resizable-table" style={{ tableLayout: 'fixed' }}>
                <thead>{tableHeaders}</thead>
                <tbody><TableSkeletonRows count={8} /></tbody>
              </table>
            </div>
          ) : logs.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon"><Inbox size={32} strokeWidth={1.4} /></div>
              <div className="empty-state-title">No logs found</div>
              <div className="empty-state-sub">
                {hasActiveFilters ? 'Try adjusting your filters' : 'Logs will appear here once your app starts sending them'}
              </div>
            </div>
          ) : (
            <>
              <div className="logs-table logs-table-wide">
                <table className="resizable-table" style={{ tableLayout: 'fixed' }}>
                  <thead>{tableHeaders}</thead>
                  <tbody>
                    {logs.map((log) => (
                      <LogRow
                        key={log.id}
                        log={log}
                        onDelete={handleDelete}
                        timezone={userTimezone}
                        columnWidths={columnWidths}
                        isExpanded={expandedRows.has(log.id)}
                        onToggleExpand={() => toggleRowExpanded(log.id)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <div className="pagination-info">
                  {(page - 1) * perPage + 1}–{Math.min(page * perPage, total)} of {total.toLocaleString()}
                </div>
                <div className="pagination-controls">
                  <select className="per-page-select" value={perPage} onChange={(ev) => setPerPage(Number(ev.target.value))}>
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>{size} / page</option>
                    ))}
                  </select>
                  <button className="btn btn-secondary" disabled={page <= 1 || loading} onClick={() => setPage(1)}>«</button>
                  <button className="btn btn-secondary" disabled={page <= 1 || loading} onClick={() => setPage(p => p - 1)}>‹</button>
                  <span className="page-indicator">{page} / {totalPages}</span>
                  <button className="btn btn-secondary" disabled={page >= totalPages || loading} onClick={() => setPage(p => p + 1)}>›</button>
                  <button className="btn btn-secondary" disabled={page >= totalPages || loading} onClick={() => setPage(totalPages)}>»</button>
                </div>
              </div>
            </>
          )}
        </>
      ) : activeTab === 'archives' ? (
        <ArchivesSection
          archives={archives}
          onRunArchive={handleRunArchive}
          onDelete={handleDeleteArchive}
          timezone={userTimezone}
        />
      ) : activeTab === 'users' ? (
        <UsersTab onSelectUser={setOpenUserId} />
      ) : activeTab === 'errors' ? (
        <ErrorsTab onSelectGroup={(fp) => {
          setFilters(prev => ({ ...prev, fingerprint: fp }));
          setActiveTab('logs');
        }} />
      ) : activeTab === 'behaviour' ? (
        <BehaviourTab />
      ) : (
        <AnalyticsDashboard isMobile={false} />
      )}

      {openUserId && (
        <UserProfileModal
          userId={openUserId}
          onClose={() => setOpenUserId(null)}
          onOpenSession={(sid) => { setOpenUserId(null); setOpenSessionId(sid); }}
          onApplyFingerprint={(fp) => {
            setFilters(prev => ({ ...prev, fingerprint: fp }));
            setOpenUserId(null);
            setActiveTab('logs');
          }}
        />
      )}
      {openSessionId && (
        <SessionTimelineModal sessionId={openSessionId} onClose={() => setOpenSessionId(null)} />
      )}

      {showBulkDelete && (
        <BulkDeleteModal
          users={users}
          devices={devices}
          categories={categories}
          onClose={() => setShowBulkDelete(false)}
          onDelete={handleBulkDelete}
        />
      )}
    </div>
  );
}
