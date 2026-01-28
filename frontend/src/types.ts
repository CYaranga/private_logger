export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';
export type LogSource = 'ios' | 'android' | 'web' | 'desktop' | 'backend' | 'simulator' | 'cli' | 'api' | 'watch' | 'tv' | 'extension' | 'iot';

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
}
