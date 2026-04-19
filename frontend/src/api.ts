import type { LogsResponse, Stats, Filters, Storage, Archive, TimeRange, TimeseriesResponse, LogReplay, CreateReplayInput } from './types';

const API_BASE = 'https://private-logger-api.christian-yaranga-05.workers.dev';

function getAuthHeaders(): HeadersInit {
  const token = localStorage.getItem('authToken');
  return token
    ? { 'Authorization': `Bearer ${token}` }
    : {};
}

function getFetchOptions(options: RequestInit = {}): RequestInit {
  return {
    ...options,
    credentials: 'include' as RequestCredentials,
    headers: {
      ...getAuthHeaders(),
      ...options.headers,
    },
  };
}

export async function fetchLogs(
  filters: Filters,
  limit: number,
  offset: number
): Promise<LogsResponse> {
  const params = new URLSearchParams();

  if (filters.user_id) params.append('user_id', filters.user_id);
  if (filters.device_id) params.append('device_id', filters.device_id);
  if (filters.environment) params.append('environment', filters.environment);
  if (filters.source) params.append('source', filters.source);
  if (filters.search) params.append('search', filters.search);
  if (filters.level) params.append('level', filters.level);
  if (filters.category) params.append('category', filters.category);
  if (filters.http_method) params.append('http_method', filters.http_method);
  params.append('limit', limit.toString());
  params.append('offset', offset.toString());

  const response = await fetch(`${API_BASE}/logs?${params}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch logs');
  return response.json();
}

export async function fetchStats(): Promise<Stats> {
  const response = await fetch(`${API_BASE}/stats`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch stats');
  return response.json();
}

export async function fetchUsers(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/users`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch users');
  const data = await response.json();
  return data.users;
}

export async function fetchCategories(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/categories`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch categories');
  const data = await response.json();
  return data.categories;
}

export async function fetchDevices(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/devices`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch devices');
  const data = await response.json();
  return data.devices;
}

export async function fetchSources(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/sources`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch sources');
  const data = await response.json();
  return data.sources;
}

export async function deleteLog(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/logs/${id}`, getFetchOptions({
    method: 'DELETE',
  }));
  if (!response.ok) throw new Error('Failed to delete log');
}

export interface BulkDeleteParams {
  user_id?: string;
  device_id?: string;
  category?: string;
  level?: string;
  environment?: string;
  source?: string;
  http_method?: string;
  search?: string;
  start_date?: string;
  end_date?: string;
}

export interface BulkDeleteResult {
  success: boolean;
  deleted: number;
  message: string;
}

export async function bulkDeleteLogs(params: BulkDeleteParams): Promise<BulkDeleteResult> {
  const response = await fetch(`${API_BASE}/logs/bulk-delete`, getFetchOptions({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  }));
  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.error || 'Failed to bulk delete logs');
  }
  return response.json();
}

export async function fetchStorage(): Promise<Storage> {
  const response = await fetch(`${API_BASE}/storage`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch storage');
  return response.json();
}

export async function fetchArchives(): Promise<Archive[]> {
  const response = await fetch(`${API_BASE}/archives`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch archives');
  const data = await response.json();
  return data.archives;
}

export async function runArchive(): Promise<{ archived: number; dates: string[] }> {
  const response = await fetch(`${API_BASE}/archives/run`, getFetchOptions({ method: 'POST' }));
  if (!response.ok) throw new Error('Failed to run archive');
  return response.json();
}

export async function deleteArchive(date: string): Promise<void> {
  const response = await fetch(`${API_BASE}/archives/${date}`, getFetchOptions({
    method: 'DELETE',
  }));
  if (!response.ok) throw new Error('Failed to delete archive');
}

export function getArchiveDownloadUrl(date: string): string {
  return `${API_BASE}/archives/${date}/download`;
}

export function getExportAllUrl(): string {
  return `${API_BASE}/archives/export-all`;
}

export async function fetchTimeseries(range: TimeRange = '24h'): Promise<TimeseriesResponse> {
  const response = await fetch(`${API_BASE}/stats/timeseries?range=${range}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch timeseries');
  return response.json();
}

export async function fetchReplays(logId: number): Promise<LogReplay[]> {
  const response = await fetch(`${API_BASE}/logs/${logId}/replays`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch replays');
  const data = await response.json();
  return data.replays;
}

export async function createReplay(input: CreateReplayInput): Promise<LogReplay> {
  const response = await fetch(`${API_BASE}/replay`, getFetchOptions({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  }));
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to create replay');
  }
  const data = await response.json();
  return data.replay;
}

export async function deleteReplay(replayId: number): Promise<void> {
  const response = await fetch(`${API_BASE}/replays/${replayId}`, getFetchOptions({
    method: 'DELETE',
  }));
  if (!response.ok) throw new Error('Failed to delete replay');
}
