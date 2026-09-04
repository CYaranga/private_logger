import type { LogsResponse, Stats, Filters, Storage, Archive, TimeRange, TimeseriesResponse, LogReplay, CreateReplayInput, UserSummary, UserProfile, SessionTimeline, ErrorGroup, ErrorGroupStatus, BehaviourAction, BehaviourByVersion } from './types';

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
  offset: number,
  /** false = no pidas el total. Paginar en bucle con el COUNT activo cuesta ~1.300
   *  filas leidas de D1 por vuelta, y quien pagina en bucle no usa el total. */
  withCount = true
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
  if (filters.session_id) params.append('session_id', filters.session_id);
  if (filters.fingerprint) params.append('fingerprint', filters.fingerprint);
  if (filters.app_version) params.append('app_version', filters.app_version);
  if (filters.start_date) params.append('start_date', filters.start_date);
  if (filters.end_date) params.append('end_date', filters.end_date);
  params.append('limit', limit.toString());
  params.append('offset', offset.toString());
  if (!withCount) params.append('count', '0');

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

export function getStreamUrl(): string {
  return `${API_BASE}/logs/stream`;
}

export interface RichUsersResponse {
  users: UserSummary[];
  since: string;
  limit: number;
  offset: number;
}

export async function fetchRichUsers(opts: {
  limit?: number; offset?: number; search?: string; since?: string;
} = {}): Promise<RichUsersResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.append('limit', String(opts.limit));
  if (opts.offset) params.append('offset', String(opts.offset));
  if (opts.search) params.append('search', opts.search);
  if (opts.since) params.append('since', opts.since);
  const response = await fetch(`${API_BASE}/users/rich?${params}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch users');
  return response.json();
}

export async function fetchUserProfile(userId: string): Promise<UserProfile> {
  const response = await fetch(`${API_BASE}/users/${encodeURIComponent(userId)}/profile`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch user profile');
  return response.json();
}

export async function fetchSessionTimeline(sessionId: string): Promise<SessionTimeline> {
  const response = await fetch(`${API_BASE}/sessions/${encodeURIComponent(sessionId)}/timeline`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch session timeline');
  return response.json();
}

export interface ErrorGroupsResponse {
  groups: ErrorGroup[];
  since: string;
  limit: number;
  offset: number;
}

export async function fetchErrorGroups(opts: {
  limit?: number; offset?: number; environment?: string; source?: string; since?: string;
  status?: ErrorGroupStatus | 'all';
} = {}): Promise<ErrorGroupsResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.append('limit', String(opts.limit));
  if (opts.offset) params.append('offset', String(opts.offset));
  if (opts.environment) params.append('environment', opts.environment);
  if (opts.source) params.append('source', opts.source);
  if (opts.since) params.append('since', opts.since);
  if (opts.status) params.append('status', opts.status);
  const response = await fetch(`${API_BASE}/errors/groups?${params}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch error groups');
  return response.json();
}

export async function fetchBehaviourTopActions(opts: {
  limit?: number; since?: string; environment?: string; source?: string;
} = {}): Promise<{ actions: BehaviourAction[]; since: string }> {
  const params = new URLSearchParams();
  if (opts.limit) params.append('limit', String(opts.limit));
  if (opts.since) params.append('since', opts.since);
  if (opts.environment) params.append('environment', opts.environment);
  if (opts.source) params.append('source', opts.source);
  const response = await fetch(`${API_BASE}/behaviour/top-actions?${params}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch behaviour top actions');
  return response.json();
}

export async function fetchBehaviourByVersion(opts: {
  action?: string; subject?: string; since?: string;
} = {}): Promise<{ rows: BehaviourByVersion[]; since: string }> {
  const params = new URLSearchParams();
  if (opts.action) params.append('action', opts.action);
  if (opts.subject) params.append('subject', opts.subject);
  if (opts.since) params.append('since', opts.since);
  const response = await fetch(`${API_BASE}/behaviour/by-version?${params}`, getFetchOptions());
  if (!response.ok) throw new Error('Failed to fetch behaviour by version');
  return response.json();
}

export async function updateErrorGroupState(
  fingerprint: string,
  patch: { status?: ErrorGroupStatus; assigned_to?: string | null; note?: string | null },
): Promise<void> {
  const response = await fetch(`${API_BASE}/errors/groups/${encodeURIComponent(fingerprint)}/state`, getFetchOptions({
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  }));
  if (!response.ok) throw new Error('Failed to update error group state');
}

import type { BugReport, BugStatus, ApiToken, ApiTokenCreated, TriageSummary, TraceResult } from './types';

export async function fetchBugs(opts: { status?: BugStatus; user_id?: string; limit?: number; offset?: number } = {}): Promise<{ bugs: BugReport[]; limit: number; offset: number }> {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(opts)) if (v !== undefined) params.append(k, String(v));
  const res = await fetch(`${API_BASE}/bugs?${params}`, getFetchOptions());
  if (!res.ok) throw new Error('Failed to fetch bugs');
  return res.json();
}

export async function fetchBug(id: number): Promise<BugReport> {
  const res = await fetch(`${API_BASE}/bugs/${id}`, getFetchOptions());
  if (!res.ok) throw new Error('Failed to fetch bug');
  return res.json();
}

export async function triageBug(id: number, patch: { status?: BugStatus; assigned_to?: string | null; note?: string | null }): Promise<void> {
  const res = await fetch(`${API_BASE}/bugs/${id}`, getFetchOptions({
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
  }));
  if (!res.ok) throw new Error('Failed to update bug');
}

export function getBugScreenshotUrl(id: number): string {
  return `${API_BASE}/bugs/${id}/screenshot`;
}

export async function listApiTokens(): Promise<{ tokens: ApiToken[] }> {
  const res = await fetch(`${API_BASE}/auth/tokens`, getFetchOptions());
  if (!res.ok) throw new Error('Failed to list tokens');
  return res.json();
}

export async function createApiToken(name: string, expiresInDays?: number): Promise<ApiTokenCreated> {
  const res = await fetch(`${API_BASE}/auth/tokens`, getFetchOptions({
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, expires_in_days: expiresInDays }),
  }));
  if (!res.ok) throw new Error('Failed to create token');
  return res.json();
}

export async function revokeApiToken(id: number): Promise<void> {
  const res = await fetch(`${API_BASE}/auth/tokens/${id}`, getFetchOptions({ method: 'DELETE' }));
  if (!res.ok) throw new Error('Failed to revoke token');
}

export async function fetchTriageSummary(since?: string): Promise<TriageSummary> {
  const url = `${API_BASE}/agent/triage-summary${since ? `?since=${encodeURIComponent(since)}` : ''}`;
  const res = await fetch(url, getFetchOptions());
  if (!res.ok) throw new Error('Failed to fetch triage summary');
  return res.json();
}

export async function fetchTrace(traceId: string): Promise<TraceResult> {
  const res = await fetch(`${API_BASE}/trace/${encodeURIComponent(traceId)}`, getFetchOptions());
  if (!res.ok) throw new Error('Failed to fetch trace');
  return res.json();
}
