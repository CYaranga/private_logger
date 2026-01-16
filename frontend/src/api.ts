import type { LogsResponse, Stats, Filters, Storage, Archive } from './types';

const API_BASE = 'https://private-logger-api.christian-yaranga-05.workers.dev';

export async function fetchLogs(
  filters: Filters,
  limit: number,
  offset: number
): Promise<LogsResponse> {
  const params = new URLSearchParams();

  if (filters.user_id) params.append('user_id', filters.user_id);
  if (filters.environment) params.append('environment', filters.environment);
  if (filters.search) params.append('search', filters.search);
  if (filters.level) params.append('level', filters.level);
  if (filters.category) params.append('category', filters.category);
  if (filters.http_method) params.append('http_method', filters.http_method);
  params.append('limit', limit.toString());
  params.append('offset', offset.toString());

  const response = await fetch(`${API_BASE}/logs?${params}`);
  if (!response.ok) throw new Error('Failed to fetch logs');
  return response.json();
}

export async function fetchStats(): Promise<Stats> {
  const response = await fetch(`${API_BASE}/stats`);
  if (!response.ok) throw new Error('Failed to fetch stats');
  return response.json();
}

export async function fetchUsers(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/users`);
  if (!response.ok) throw new Error('Failed to fetch users');
  const data = await response.json();
  return data.users;
}

export async function fetchCategories(): Promise<string[]> {
  const response = await fetch(`${API_BASE}/categories`);
  if (!response.ok) throw new Error('Failed to fetch categories');
  const data = await response.json();
  return data.categories;
}

export async function deleteLog(id: number): Promise<void> {
  const response = await fetch(`${API_BASE}/logs/${id}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to delete log');
}

export async function fetchStorage(): Promise<Storage> {
  const response = await fetch(`${API_BASE}/storage`);
  if (!response.ok) throw new Error('Failed to fetch storage');
  return response.json();
}

export async function fetchArchives(): Promise<Archive[]> {
  const response = await fetch(`${API_BASE}/archives`);
  if (!response.ok) throw new Error('Failed to fetch archives');
  const data = await response.json();
  return data.archives;
}

export async function runArchive(): Promise<{ archived: number; dates: string[] }> {
  const response = await fetch(`${API_BASE}/archives/run`, { method: 'POST' });
  if (!response.ok) throw new Error('Failed to run archive');
  return response.json();
}

export async function deleteArchive(date: string): Promise<void> {
  const response = await fetch(`${API_BASE}/archives/${date}`, {
    method: 'DELETE',
  });
  if (!response.ok) throw new Error('Failed to delete archive');
}

export function getArchiveDownloadUrl(date: string): string {
  return `${API_BASE}/archives/${date}/download`;
}

export function getExportAllUrl(): string {
  return `${API_BASE}/archives/export-all`;
}
