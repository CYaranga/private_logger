import { useState, useEffect, useCallback, useRef } from 'react';
import { FixedSizeList as List, ListOnItemsRenderedProps, ListChildComponentProps } from 'react-window';
import type { Log, Stats, Filters, Storage, Archive, LogLevel, HttpMethod } from './types';
import {
  fetchLogs,
  fetchStats,
  fetchUsers,
  fetchCategories,
  fetchDevices,
  deleteLog,
  bulkDeleteLogs,
  fetchStorage,
  fetchArchives,
  runArchive,
  deleteArchive,
  getArchiveDownloadUrl,
  getExportAllUrl,
  type BulkDeleteParams,
} from './api';

const BATCH_SIZE = 50;
const ROW_HEIGHT = 48;

// Column configuration for resizing
type ColumnKey = 'id' | 'timestamp' | 'level' | 'category' | 'user' | 'device' | 'env' | 'message' | 'method' | 'endpoint' | 'status' | 'duration' | 'actions';

const DEFAULT_COLUMN_WIDTHS: Record<ColumnKey, number> = {
  id: 60,
  timestamp: 160,
  level: 70,
  category: 90,
  user: 80,
  device: 100,
  env: 60,
  message: 250,
  method: 70,
  endpoint: 200,
  status: 60,
  duration: 80,
  actions: 80,
};

function getStoredColumnWidths(): Record<ColumnKey, number> {
  try {
    const stored = localStorage.getItem('columnWidths');
    if (stored) {
      return { ...DEFAULT_COLUMN_WIDTHS, ...JSON.parse(stored) };
    }
  } catch {
    // Ignore parse errors
  }
  return DEFAULT_COLUMN_WIDTHS;
}

function formatTimestamp(timestamp: string, timezone?: string): string {
  const date = new Date(timestamp);
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

function syntaxHighlightJson(json: string): JSX.Element[] {
  const elements: JSX.Element[] = [];
  let key = 0;

  // Regex to match JSON tokens
  const tokenRegex = /("(?:\\.|[^"\\])*")\s*:|("(?:\\.|[^"\\])*")|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(\btrue\b|\bfalse\b)|(\bnull\b)|([\[\]{}])|([,:])|(\s+)/g;

  let match;
  let lastIndex = 0;

  while ((match = tokenRegex.exec(json)) !== null) {
    // Add any unmatched text before this match
    if (match.index > lastIndex) {
      elements.push(<span key={key++}>{json.slice(lastIndex, match.index)}</span>);
    }
    lastIndex = tokenRegex.lastIndex;

    const [fullMatch, keyWithColon, stringVal, numberVal, boolVal, nullVal, bracket, punctuation, whitespace] = match;

    if (keyWithColon) {
      // Property key (remove the colon, we'll add it separately)
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

  // Add any remaining text
  if (lastIndex < json.length) {
    elements.push(<span key={key++}>{json.slice(lastIndex)}</span>);
  }

  return elements;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
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
    return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  }

  // Parse string data if it looks like JSON
  let parsedData = data;
  let isJson = false;
  if (typeof data === 'string') {
    try {
      parsedData = JSON.parse(data);
      isJson = true;
    } catch {
      // Not valid JSON, keep as string
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
  columnKey,
  label,
  width,
  onResize,
}: {
  columnKey: ColumnKey;
  label: string;
  width: number;
  onResize: (key: ColumnKey, width: number) => void;
}) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const diff = moveEvent.clientX - startX;
      const newWidth = Math.max(40, startWidth + diff);
      onResize(columnKey, newWidth);
    };

    const handleMouseUp = () => {
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

function HttpMethodBadge({ method }: { method: HttpMethod | null }) {
  if (!method) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  return <span className={`badge badge-http badge-http-${method.toLowerCase()}`}>{method}</span>;
}

function StatusCodeBadge({ code }: { code: number | null }) {
  if (code === null) return <span style={{ color: 'var(--text-secondary)' }}>—</span>;

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
    <div className="storage-bar">
      <div className="storage-header">
        <span>Storage: {formatBytes(storage.used_bytes)} / {formatBytes(storage.limit_bytes)}</span>
        <span>{storage.usage_percent.toFixed(2)}%</span>
      </div>
      <div className="storage-track">
        <div
          className="storage-fill"
          style={{
            width: `${Math.min(storage.usage_percent, 100)}%`,
            backgroundColor: usageColor,
          }}
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

  const envCounts = stats.byEnvironment.reduce(
    (acc, item) => ({ ...acc, [item.environment]: item.count }),
    { dev: 0, test: 0, prod: 0 }
  );

  const levelCounts = stats.byLevel?.reduce(
    (acc, item) => ({ ...acc, [item.level]: item.count }),
    { debug: 0, info: 0, warn: 0, error: 0 }
  ) || { debug: 0, info: 0, warn: 0, error: 0 };

  const totalAllLogs = stats.total + (stats.archives?.totalLogs || 0);

  return (
    <div className="stats-grid">
      <div className="stat-card">
        <div className="label">Recent Logs</div>
        <div className="value">{stats.total.toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="label">Archived Logs</div>
        <div className="value">{(stats.archives?.totalLogs || 0).toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="label">Total All Time</div>
        <div className="value">{totalAllLogs.toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="label">Unique Users</div>
        <div className="value">{stats.uniqueUsers.toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="label">Last 24 Hours</div>
        <div className="value">{stats.last24Hours.toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="label">API Calls</div>
        <div className="value">{(stats.apiCalls || 0).toLocaleString()}</div>
      </div>
      <div className="stat-card">
        <div className="label">Errors</div>
        <div className="value" style={{ color: stats.errorCount > 0 ? 'var(--error)' : 'inherit' }}>
          {(stats.errorCount || 0).toLocaleString()}
        </div>
      </div>
      <div className="stat-card">
        <div className="label">Dev / Test / Prod</div>
        <div className="value" style={{ fontSize: '20px' }}>
          {envCounts.dev} / {envCounts.test} / {envCounts.prod}
        </div>
      </div>
      <div className="stat-card">
        <div className="label">Debug / Info / Warn / Error</div>
        <div className="value" style={{ fontSize: '16px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>{levelCounts.debug}</span> /
          <span style={{ color: 'var(--accent)' }}> {levelCounts.info}</span> /
          <span style={{ color: 'var(--warning)' }}> {levelCounts.warn}</span> /
          <span style={{ color: 'var(--error)' }}> {levelCounts.error}</span>
        </div>
      </div>
    </div>
  );
}

function BulkDeleteModal({
  users,
  devices,
  categories,
  onClose,
  onDelete,
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

    if (!confirm(`Are you sure you want to delete all logs matching:\n\n${filterDesc}\n\nThis action cannot be undone!`)) {
      return;
    }

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
      <div className="modal-content" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>Bulk Delete Logs</h2>
          <button className="modal-close" onClick={onClose}>&times;</button>
        </div>
        <div className="modal-body">
          <p className="modal-warning">
            Select filters to delete multiple logs at once. At least one filter is required.
          </p>

          <div className="bulk-delete-filters">
            <div className="filter-group">
              <label>User</label>
              <select
                value={params.user_id || ''}
                onChange={(e) => setParams({ ...params, user_id: e.target.value || undefined })}
              >
                <option value="">All Users</option>
                {users.map((user) => (
                  <option key={user} value={user}>{user}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Device</label>
              <select
                value={params.device_id || ''}
                onChange={(e) => setParams({ ...params, device_id: e.target.value || undefined })}
              >
                <option value="">All Devices</option>
                {devices.map((device) => (
                  <option key={device} value={device}>{device}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Category</label>
              <select
                value={params.category || ''}
                onChange={(e) => setParams({ ...params, category: e.target.value || undefined })}
              >
                <option value="">All Categories</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Start Date</label>
              <input
                type="date"
                value={params.start_date || ''}
                onChange={(e) => setParams({ ...params, start_date: e.target.value || undefined })}
              />
            </div>

            <div className="filter-group">
              <label>End Date</label>
              <input
                type="date"
                value={params.end_date || ''}
                onChange={(e) => setParams({ ...params, end_date: e.target.value || undefined })}
              />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose} disabled={loading}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={handleDelete}
            disabled={!hasFilters || loading}
          >
            {loading ? 'Deleting...' : 'Delete Matching Logs'}
          </button>
        </div>
      </div>
    </div>
  );
}

function ArchivesSection({
  archives,
  onRunArchive,
  onDelete,
  timezone,
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
          <button className="btn btn-secondary" onClick={onRunArchive}>
            Archive Now
          </button>
          {archives.length > 0 && (
            <a href={getExportAllUrl()} className="btn btn-secondary" download>
              Export All
            </a>
          )}
        </div>
      </div>
      <p className="archives-info">
        Logs older than 7 days are automatically archived daily at 3:00 AM UTC.
        Download archives before deleting to keep a local backup.
      </p>
      {archives.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px' }}>
          No archives yet. Archives will appear here after logs are older than 7 days.
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
                  <td>{archive.log_count.toLocaleString()}</td>
                  <td className="timestamp">{formatTimestamp(archive.created_at, timezone)}</td>
                  <td>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <a
                        href={getArchiveDownloadUrl(archive.archive_date)}
                        className="btn btn-secondary"
                        style={{ padding: '6px 12px', fontSize: '12px', textDecoration: 'none' }}
                        download
                      >
                        Download
                      </a>
                      <button
                        className="btn btn-secondary"
                        style={{ padding: '6px 12px', fontSize: '12px' }}
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

function VirtualLogRow({
  log,
  onDelete,
  timezone,
  columnWidths,
  isExpanded,
  onToggleExpand,
}: {
  log: Log;
  onDelete: (id: number) => void;
  timezone?: string;
  columnWidths: Record<ColumnKey, number>;
  isExpanded: boolean;
  onToggleExpand: () => void;
}) {
  const isApiCall = log.http_method !== null;

  const cellStyle = (key: ColumnKey): React.CSSProperties => ({
    width: `${columnWidths[key]}px`,
    minWidth: `${columnWidths[key]}px`,
    maxWidth: `${columnWidths[key]}px`,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    padding: '12px 16px',
    display: 'inline-block',
    boxSizing: 'border-box',
    verticalAlign: 'middle',
  });

  return (
    <div
      className={`virtual-row log-level-${log.level}`}
      onClick={onToggleExpand}
    >
      <span style={{ ...cellStyle('id'), color: 'var(--text-secondary)' }}>#{log.id}</span>
      <span style={cellStyle('timestamp')} className="timestamp">{formatTimestamp(log.created_at, timezone)}</span>
      <span style={cellStyle('level')}><LevelBadge level={log.level} /></span>
      <span style={cellStyle('category')}><CategoryBadge category={log.category} /></span>
      <span style={cellStyle('user')} className="user-id">{log.user_id}</span>
      <span style={cellStyle('device')} className="device-id">{log.device_id || '—'}</span>
      <span style={cellStyle('env')}><EnvironmentBadge env={log.environment} /></span>
      <span style={cellStyle('message')} className="message-cell" title={log.message}>{log.message}</span>
      <span style={cellStyle('method')}><HttpMethodBadge method={log.http_method} /></span>
      <span style={cellStyle('endpoint')} className="endpoint-cell" title={log.endpoint || ''}>{log.endpoint || '—'}</span>
      <span style={cellStyle('status')}><StatusCodeBadge code={log.status_code} /></span>
      <span style={cellStyle('duration')} className="duration-cell">{formatDuration(log.duration_ms)}</span>
      <span style={cellStyle('actions')}>
        <button
          className="btn btn-secondary"
          style={{ padding: '4px 8px', fontSize: '11px' }}
          onClick={(e) => { e.stopPropagation(); onDelete(log.id); }}
        >
          Delete
        </button>
      </span>
      {isExpanded && (
        <div className="virtual-row-details" onClick={(e) => e.stopPropagation()}>
          <div className="log-details">
            <div className="log-detail-section log-detail-message">
              <h4>Full Message</h4>
              <pre className="full-message-content">{log.message}</pre>
            </div>
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
              {isApiCall && (
                <>
                  <div className="log-detail-section">
                    <h4>Request Data</h4>
                    <JsonViewer data={log.request_data} label="Request" />
                  </div>
                  <div className="log-detail-section">
                    <h4>Response Data</h4>
                    <JsonViewer data={log.response_data} label="Response" />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'logs' | 'archives'>('logs');
  const [logs, setLogs] = useState<Log[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [devices, setDevices] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    user_id: '',
    device_id: '',
    environment: '',
    search: '',
    level: '',
    category: '',
    http_method: '',
  });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [userTimezone, setUserTimezone] = useState<string | undefined>(undefined);
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>(getStoredColumnWidths);
  const [expandedRows, setExpandedRows] = useState<Set<number>>(new Set());
  const [showBulkDelete, setShowBulkDelete] = useState(false);
  const listRef = useRef<List>(null);

  const handleColumnResize = useCallback((key: ColumnKey, width: number) => {
    setColumnWidths(prev => {
      const newWidths = { ...prev, [key]: width };
      localStorage.setItem('columnWidths', JSON.stringify(newWidths));
      return newWidths;
    });
  }, []);

  const toggleRowExpanded = useCallback((id: number) => {
    setExpandedRows(prev => {
      const newSet = new Set(prev);
      if (newSet.has(id)) {
        newSet.delete(id);
      } else {
        newSet.add(id);
      }
      return newSet;
    });
  }, []);

  // Fetch user's timezone from IP geolocation
  useEffect(() => {
    async function fetchTimezone() {
      try {
        const response = await fetch('https://worldtimeapi.org/api/ip');
        if (response.ok) {
          const data = await response.json();
          setUserTimezone(data.timezone);
        }
      } catch {
        // Fall back to browser's default timezone if API fails
        console.warn('Could not detect timezone from IP, using browser default');
      }
    }
    fetchTimezone();
  }, []);

  // Load initial data
  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setExpandedRows(new Set());

      const [logsData, statsData, usersData, devicesData, categoriesData, storageData, archivesData] = await Promise.all([
        fetchLogs(filters, BATCH_SIZE, 0),
        fetchStats(),
        fetchUsers(),
        fetchDevices(),
        fetchCategories(),
        fetchStorage(),
        fetchArchives(),
      ]);

      setLogs(logsData.logs);
      setTotal(logsData.total);
      setHasMore(logsData.logs.length < logsData.total);
      setStats(statsData);
      setUsers(usersData);
      setDevices(devicesData);
      setCategories(categoriesData);
      setStorage(storageData);
      setArchives(archivesData);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters]);

  // Load more data for infinite scroll
  const loadMore = useCallback(async () => {
    if (loadingMore || !hasMore) return;

    try {
      setLoadingMore(true);
      const logsData = await fetchLogs(filters, BATCH_SIZE, logs.length);

      setLogs(prev => [...prev, ...logsData.logs]);
      setHasMore(logs.length + logsData.logs.length < logsData.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load more logs');
    } finally {
      setLoadingMore(false);
    }
  }, [filters, logs.length, loadingMore, hasMore]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Auto-refresh every 30 seconds
  useEffect(() => {
    const interval = setInterval(loadData, 30000);
    return () => clearInterval(interval);
  }, [loadData]);

  const handleFilterChange = (key: keyof Filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value }));
  };

  const clearFilters = () => {
    setFilters({
      user_id: '',
      device_id: '',
      environment: '',
      search: '',
      level: '',
      category: '',
      http_method: '',
    });
  };

  const hasActiveFilters = Object.values(filters).some(v => v !== '');

  const handleDelete = async (id: number) => {
    if (!confirm('Are you sure you want to delete this log?')) return;

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
    if (!confirm(`Are you sure you want to delete the archive for ${date}? Make sure you've downloaded it first!`)) {
      return;
    }

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

  return (
    <div className="container">
      <header className="header">
        <h1>Private Logger</h1>
        <div className="refresh-indicator">
          <div className="dot" />
          <span>Last updated: {lastRefresh.toLocaleTimeString()}</span>
          <button className="btn btn-secondary" onClick={loadData}>
            Refresh
          </button>
        </div>
      </header>

      {error && <div className="error">{error}</div>}

      <StorageBar storage={storage} />
      <StatsCards stats={stats} />

      <div className="tabs">
        <button
          className={`tab ${activeTab === 'logs' ? 'active' : ''}`}
          onClick={() => setActiveTab('logs')}
        >
          Recent Logs ({stats?.total || 0})
        </button>
        <button
          className={`tab ${activeTab === 'archives' ? 'active' : ''}`}
          onClick={() => setActiveTab('archives')}
        >
          Archives ({archives.length})
        </button>
      </div>

      {activeTab === 'logs' ? (
        <>
          <div className="filters">
            <input
              type="text"
              placeholder="Search messages, endpoints, data..."
              value={filters.search}
              onChange={(e) => handleFilterChange('search', e.target.value)}
            />
            <select
              value={filters.level}
              onChange={(e) => handleFilterChange('level', e.target.value)}
            >
              <option value="">All Levels</option>
              <option value="debug">Debug</option>
              <option value="info">Info</option>
              <option value="warn">Warning</option>
              <option value="error">Error</option>
            </select>
            <select
              value={filters.category}
              onChange={(e) => handleFilterChange('category', e.target.value)}
            >
              <option value="">All Categories</option>
              {categories.map((cat) => (
                <option key={cat} value={cat}>{cat}</option>
              ))}
            </select>
            <select
              value={filters.http_method}
              onChange={(e) => handleFilterChange('http_method', e.target.value)}
            >
              <option value="">All Methods</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
              <option value="PATCH">PATCH</option>
            </select>
            <select
              value={filters.user_id}
              onChange={(e) => handleFilterChange('user_id', e.target.value)}
            >
              <option value="">All Users</option>
              {users.map((user) => (
                <option key={user} value={user}>{user}</option>
              ))}
            </select>
            <select
              value={filters.device_id}
              onChange={(e) => handleFilterChange('device_id', e.target.value)}
            >
              <option value="">All Devices</option>
              {devices.map((device) => (
                <option key={device} value={device}>{device}</option>
              ))}
            </select>
            <select
              value={filters.environment}
              onChange={(e) => handleFilterChange('environment', e.target.value)}
            >
              <option value="">All Environments</option>
              <option value="dev">Development</option>
              <option value="test">Test</option>
              <option value="prod">Production</option>
            </select>
            {hasActiveFilters && (
              <button className="btn btn-secondary" onClick={clearFilters}>
                Clear Filters
              </button>
            )}
            <button className="btn btn-danger" onClick={() => setShowBulkDelete(true)}>
              Bulk Delete
            </button>
          </div>

          {loading && logs.length === 0 ? (
            <div className="loading">Loading logs...</div>
          ) : logs.length === 0 ? (
            <div className="empty-state">
              <p>No logs found</p>
              <p style={{ marginTop: '8px', fontSize: '14px' }}>
                {hasActiveFilters
                  ? 'Try adjusting your filters'
                  : 'Logs will appear here once your mobile app starts sending them'}
              </p>
            </div>
          ) : (
            <>
              <div className="logs-table logs-table-wide virtual-table">
                {/* Fixed header */}
                <div className="virtual-table-header">
                  <table className="resizable-table" style={{ tableLayout: 'fixed' }}>
                    <thead>
                      <tr>
                        <ResizableHeader columnKey="id" label="ID" width={columnWidths.id} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="timestamp" label="Timestamp" width={columnWidths.timestamp} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="level" label="Level" width={columnWidths.level} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="category" label="Category" width={columnWidths.category} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="user" label="User" width={columnWidths.user} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="device" label="Device" width={columnWidths.device} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="env" label="Env" width={columnWidths.env} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="message" label="Message" width={columnWidths.message} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="method" label="Method" width={columnWidths.method} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="endpoint" label="Endpoint" width={columnWidths.endpoint} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="status" label="Status" width={columnWidths.status} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="duration" label="Duration" width={columnWidths.duration} onResize={handleColumnResize} />
                        <ResizableHeader columnKey="actions" label="Actions" width={columnWidths.actions} onResize={handleColumnResize} />
                      </tr>
                    </thead>
                  </table>
                </div>

                {/* Virtual scrolling body */}
                <List
                  ref={listRef}
                  height={600}
                  itemCount={logs.length}
                  itemSize={ROW_HEIGHT}
                  width="100%"
                  onItemsRendered={({ visibleStopIndex }: ListOnItemsRenderedProps) => {
                    // Load more when near the end
                    if (visibleStopIndex >= logs.length - 10 && hasMore && !loadingMore) {
                      loadMore();
                    }
                  }}
                >
                  {({ index, style }: ListChildComponentProps) => {
                    const log = logs[index];
                    const isExpanded = expandedRows.has(log.id);
                    return (
                      <div style={style}>
                        <VirtualLogRow
                          log={log}
                          onDelete={handleDelete}
                          timezone={userTimezone}
                          columnWidths={columnWidths}
                          isExpanded={isExpanded}
                          onToggleExpand={() => toggleRowExpanded(log.id)}
                        />
                      </div>
                    );
                  }}
                </List>

                {loadingMore && (
                  <div className="loading-more">Loading more...</div>
                )}
              </div>

              <div className="scroll-info">
                Showing {logs.length} of {total} logs
                {hasMore && !loadingMore && (
                  <button className="btn btn-secondary" onClick={loadMore} style={{ marginLeft: '12px' }}>
                    Load More
                  </button>
                )}
              </div>
            </>
          )}
        </>
      ) : (
        <ArchivesSection
          archives={archives}
          onRunArchive={handleRunArchive}
          onDelete={handleDeleteArchive}
          timezone={userTimezone}
        />
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
