import type { Log, LogReplay } from './types';

export interface VersionEntry {
  version: number;
  source: 'log' | 'replay';
  replayId: number | null;
  httpMethod: string | null;
  endpoint: string | null;
  queryParams: Record<string, string> | null;
  headers: Record<string, string> | null;
  requestData: unknown;
  responseData: unknown;
  statusCode: number | null;
  durationMs: number | null;
  error: string | null;
  createdAt: string;
}

export function buildVersionList(log: Log, replays: LogReplay[]): VersionEntry[] {
  const v1: VersionEntry = {
    version: 1,
    source: 'log',
    replayId: null,
    httpMethod: log.http_method,
    endpoint: log.endpoint,
    queryParams: null,
    headers: null,
    requestData: log.request_data,
    responseData: log.response_data,
    statusCode: log.status_code,
    durationMs: log.duration_ms,
    error: null,
    createdAt: log.created_at,
  };

  const rest: VersionEntry[] = [...replays]
    .sort((a, b) => a.version - b.version)
    .map(r => ({
      version: r.version,
      source: 'replay',
      replayId: r.id,
      httpMethod: r.http_method,
      endpoint: r.endpoint,
      queryParams: r.query_params,
      headers: r.headers,
      requestData: r.request_data,
      responseData: r.response_data,
      statusCode: r.status_code,
      durationMs: r.duration_ms,
      error: r.error,
      createdAt: r.created_at,
    }));

  return [v1, ...rest];
}

export function latestVersion(log: Log, replays: LogReplay[]): VersionEntry {
  const list = buildVersionList(log, replays);
  return list[list.length - 1];
}

export interface ReplayPrefill {
  body: unknown;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
}

export function prefillFromLatest(log: Log, replays: LogReplay[]): ReplayPrefill {
  const latest = latestVersion(log, replays);
  const headers: Record<string, string> = {};
  if (latest.headers) {
    for (const [k, v] of Object.entries(latest.headers)) {
      headers[k] = v === '***' ? '' : v;
    }
  }
  return {
    body: latest.requestData ?? null,
    queryParams: latest.queryParams ?? {},
    headers,
  };
}
