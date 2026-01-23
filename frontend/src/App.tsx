import { useState, useEffect, useCallback } from 'react';
import type { Log, Stats, Filters, Storage, Archive, LogLevel, HttpMethod } from './types';
import {
  fetchLogs,
  fetchStats,
  fetchUsers,
  fetchCategories,
  deleteLog,
  fetchStorage,
  fetchArchives,
  runArchive,
  deleteArchive,
  getArchiveDownloadUrl,
  getExportAllUrl,
} from './api';

const ITEMS_PER_PAGE = 25;

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

function JsonViewer({ data, label }: { data: unknown; label: string }) {
  const [expanded, setExpanded] = useState(false);

  if (data === null || data === undefined) {
    return <span style={{ color: 'var(--text-secondary)' }}>—</span>;
  }

  // Parse string data if it looks like JSON
  let parsedData = data;
  if (typeof data === 'string') {
    try {
      parsedData = JSON.parse(data);
    } catch {
      // Not valid JSON, keep as string
      parsedData = data;
    }
  }

  const content = typeof parsedData === 'string' ? parsedData : JSON.stringify(parsedData, null, 2);
  const isLong = content.length > 50;

  if (!isLong) {
    return (
      <code className="json-inline json-highlighted">
        {syntaxHighlightJson(content.length > 100 ? content.substring(0, 100) + '...' : content)}
      </code>
    );
  }

  return (
    <div className="json-viewer">
      <button className="json-toggle" onClick={() => setExpanded(!expanded)}>
        {expanded ? 'Hide' : 'View'} {label}
      </button>
      {expanded && (
        <pre className="json-content json-highlighted">{syntaxHighlightJson(content)}</pre>
      )}
    </div>
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

function LogRow({ log, onDelete, timezone }: { log: Log; onDelete: (id: number) => void; timezone?: string }) {
  const [expanded, setExpanded] = useState(false);
  const isApiCall = log.http_method !== null;

  return (
    <>
      <tr className={`log-row log-level-${log.level}`} onClick={() => setExpanded(!expanded)}>
        <td style={{ color: 'var(--text-secondary)' }}>#{log.id}</td>
        <td className="timestamp">{formatTimestamp(log.created_at, timezone)}</td>
        <td><LevelBadge level={log.level} /></td>
        <td><CategoryBadge category={log.category} /></td>
        <td className="user-id">{log.user_id}</td>
        <td><EnvironmentBadge env={log.environment} /></td>
        <td className="message-cell" title={log.message}>{log.message}</td>
        <td><HttpMethodBadge method={log.http_method} /></td>
        <td className="endpoint-cell" title={log.endpoint || ''}>{log.endpoint || '—'}</td>
        <td><StatusCodeBadge code={log.status_code} /></td>
        <td className="duration-cell">{formatDuration(log.duration_ms)}</td>
        <td>
          <button
            className="btn btn-secondary"
            style={{ padding: '6px 12px', fontSize: '12px' }}
            onClick={(e) => { e.stopPropagation(); onDelete(log.id); }}
          >
            Delete
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="log-details-row">
          <td colSpan={12}>
            <div className="log-details">
              {/* Full message section */}
              <div className="log-detail-section log-detail-message">
                <h4>Full Message</h4>
                <pre className="full-message-content">{log.message}</pre>
              </div>

              {/* Endpoint info for API calls */}
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
          </td>
        </tr>
      )}
    </>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState<'logs' | 'archives'>('logs');
  const [logs, setLogs] = useState<Log[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [storage, setStorage] = useState<Storage | null>(null);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [users, setUsers] = useState<string[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>({
    user_id: '',
    environment: '',
    search: '',
    level: '',
    category: '',
    http_method: '',
  });
  const [lastRefresh, setLastRefresh] = useState(new Date());
  const [userTimezone, setUserTimezone] = useState<string | undefined>(undefined);

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

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const [logsData, statsData, usersData, categoriesData, storageData, archivesData] = await Promise.all([
        fetchLogs(filters, ITEMS_PER_PAGE, page * ITEMS_PER_PAGE),
        fetchStats(),
        fetchUsers(),
        fetchCategories(),
        fetchStorage(),
        fetchArchives(),
      ]);

      setLogs(logsData.logs);
      setTotal(logsData.total);
      setStats(statsData);
      setUsers(usersData);
      setCategories(categoriesData);
      setStorage(storageData);
      setArchives(archivesData);
      setLastRefresh(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      setLoading(false);
    }
  }, [filters, page]);

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
    setPage(0);
  };

  const clearFilters = () => {
    setFilters({
      user_id: '',
      environment: '',
      search: '',
      level: '',
      category: '',
      http_method: '',
    });
    setPage(0);
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

  const totalPages = Math.ceil(total / ITEMS_PER_PAGE);

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
              <div className="logs-table logs-table-wide">
                <table className="resizable-table">
                  <thead>
                    <tr>
                      <th className="col-id">ID</th>
                      <th className="col-timestamp">Timestamp</th>
                      <th className="col-level">Level</th>
                      <th className="col-category">Category</th>
                      <th className="col-user">User</th>
                      <th className="col-env">Env</th>
                      <th className="col-message resizable">Message</th>
                      <th className="col-method">Method</th>
                      <th className="col-endpoint resizable">Endpoint</th>
                      <th className="col-status">Status</th>
                      <th className="col-duration">Duration</th>
                      <th className="col-actions">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {logs.map((log) => (
                      <LogRow key={log.id} log={log} onDelete={handleDelete} timezone={userTimezone} />
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="pagination">
                <div className="pagination-info">
                  Showing {page * ITEMS_PER_PAGE + 1} -{' '}
                  {Math.min((page + 1) * ITEMS_PER_PAGE, total)} of {total} logs
                </div>
                <div className="pagination-buttons">
                  <button
                    className="btn btn-secondary"
                    disabled={page === 0}
                    onClick={() => setPage((p) => p - 1)}
                  >
                    Previous
                  </button>
                  <button
                    className="btn btn-secondary"
                    disabled={page >= totalPages - 1}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    Next
                  </button>
                </div>
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
    </div>
  );
}
