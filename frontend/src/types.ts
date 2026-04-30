export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
export type LogSource = 'ios' | 'android' | 'web' | 'desktop' | 'backend' | 'simulator' | 'cli' | 'api' | 'watch' | 'tv' | 'extension' | 'iot' | 'rebeca-web-desktop' | 'rebeca-web-mobile';

export interface Breadcrumb {
  ts: string;
  type: string;
  label: string;
  data?: Record<string, unknown>;
}

export interface Log {
  id: number;
  user_id: string;
  device_id: string | null;
  message: string;
  metadata: Record<string, unknown> | null;
  environment: 'dev' | 'test' | 'prod';
  source: LogSource | null;
  created_at: string;
  level: LogLevel;
  category: string;
  http_method: HttpMethod | null;
  endpoint: string | null;
  request_data: Record<string, unknown> | string | null;
  response_data: Record<string, unknown> | string | null;
  status_code: number | null;
  duration_ms: number | null;
  session_id: string | null;
  trace_id: string | null;
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  network_type: string | null;
  fingerprint: string | null;
  breadcrumbs: Breadcrumb[] | null;
}

export interface LogsResponse {
  logs: Log[];
  total: number;
  limit: number;
  offset: number;
}

export interface Stats {
  total: number;
  uniqueUsers: number;
  last24Hours: number;
  byEnvironment: { environment: string; count: number }[];
  byLevel: { level: string; count: number }[];
  byCategory: { category: string; count: number }[];
  bySource: { source: string; count: number }[];
  apiCalls: number;
  errorCount: number;
  archives: {
    count: number;
    totalLogs: number;
  };
}

export interface Storage {
  used_bytes: number;
  limit_bytes: number;
  usage_percent: number;
  logs_count: number;
  archives_count: number;
  archived_logs_total: number;
  warning: boolean;
  should_archive: boolean;
}

export interface Archive {
  id: number;
  archive_date: string;
  log_count: number;
  created_at: string;
}

export interface Filters {
  user_id: string;
  device_id: string;
  environment: string;
  source: string;
  search: string;
  level: string;
  category: string;
  http_method: string;
  session_id?: string;
  fingerprint?: string;
  app_version?: string;
  start_date?: string;
  end_date?: string;
}

export interface UserSummary {
  user_id: string;
  log_count: number;
  error_count: number;
  last_seen: string;
  first_seen: string;
  session_count: number;
  last_device_model: string | null;
  last_os_version: string | null;
  last_app_version: string | null;
  last_source: LogSource | null;
}

export interface UserProfile {
  user_id: string;
  summary: {
    total_logs: number;
    error_count: number;
    warn_count: number;
    first_seen: string | null;
    last_seen: string | null;
    session_count: number;
    device_count: number;
  };
  devices: Array<{
    device_id: string;
    device_model: string | null;
    os_version: string | null;
    last_seen: string;
    log_count: number;
  }>;
  sources: Array<{ source: string; count: number }>;
  app_versions: Array<{ app_version: string; last_seen: string; count: number }>;
  top_errors: Array<{
    fingerprint: string;
    sample_message: string;
    category: string;
    endpoint: string | null;
    status_code: number | null;
    count: number;
    last_seen: string;
  }>;
  recent_sessions: Array<{
    session_id: string;
    started_at: string;
    ended_at: string;
    log_count: number;
    error_count: number;
  }>;
}

export interface SessionTimeline {
  session_id: string;
  user_id: string;
  device_id: string | null;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  source: LogSource | null;
  started_at: string;
  ended_at: string;
  log_count: number;
  error_count: number;
  warn_count: number;
  logs: Log[];
}

export type ErrorGroupStatus = 'open' | 'ignored' | 'resolved' | 'monitoring';

export interface BehaviourAction {
  action: string;
  subject: string;
  total_count: number;
  total_users: number;
  last_day: string;
  first_day: string;
}

export interface BehaviourByVersion {
  app_version: string | null;
  action: string;
  subject: string;
  total_count: number;
  total_users: number;
  last_day: string;
}

export interface ErrorGroup {
  fingerprint: string;
  level: LogLevel;
  category: string;
  endpoint: string | null;
  status_code: number | null;
  sample_message: string;
  sample_source: LogSource | null;
  occurrences: number;
  affected_users: number;
  first_seen: string;
  last_seen: string;
  state_status: ErrorGroupStatus;
  state_assigned_to: string | null;
  state_note: string | null;
  state_updated_at: string | null;
}

export type TimeRange = '1h' | '6h' | '24h' | '7d';

export interface TimeseriesBucket {
  timestamp: string;
  total: number;
  by_level: { debug: number; info: number; warn: number; error: number };
  error_rate: number;
  avg_duration_ms: number | null;
  p50_duration_ms: number | null;
  p95_duration_ms: number | null;
  p99_duration_ms: number | null;
}

export interface TimeseriesResponse {
  buckets: TimeseriesBucket[];
  top_error_categories: { category: string; count: number }[];
  status_code_distribution: { group: string; count: number }[];
  range: TimeRange;
}

export interface LogReplay {
  id: number;
  parent_log_id: number;
  version: number;
  http_method: HttpMethod;
  endpoint: string;
  query_params: Record<string, string> | null;
  headers: Record<string, string> | null;
  request_data: unknown;
  response_data: unknown;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
}

export interface CreateReplayInput {
  parent_log_id: number;
  http_method: HttpMethod;
  endpoint: string;
  query_params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
}
