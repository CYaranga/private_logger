import { describe, it, expect } from 'vitest';
import { buildVersionList, latestVersion, prefillFromLatest } from './replayVersions';
import type { Log, LogReplay } from './types';

const baseLog: Log = {
  id: 1,
  user_id: 'u',
  device_id: null,
  message: 'm',
  metadata: null,
  environment: 'dev',
  source: null,
  created_at: '2026-04-19T00:00:00Z',
  level: 'info',
  category: 'API',
  http_method: 'POST',
  endpoint: 'https://api.example.com/x',
  request_data: { foo: 'bar' },
  response_data: { ok: true },
  status_code: 200,
  duration_ms: 100,
};

describe('buildVersionList', () => {
  it('returns only v1 when no replays', () => {
    const list = buildVersionList(baseLog, []);
    expect(list).toHaveLength(1);
    expect(list[0].version).toBe(1);
    expect(list[0].source).toBe('log');
    expect(list[0].statusCode).toBe(200);
  });

  it('includes v1 + replays in version order', () => {
    const replays: LogReplay[] = [
      { id: 10, parent_log_id: 1, version: 2, http_method: 'POST',
        endpoint: 'https://api.example.com/x', query_params: null, headers: null,
        request_data: null, response_data: { ok: false }, status_code: 500,
        duration_ms: 50, error: null, created_at: '2026-04-19T00:01:00Z' },
      { id: 11, parent_log_id: 1, version: 3, http_method: 'POST',
        endpoint: 'https://api.example.com/x', query_params: null, headers: null,
        request_data: null, response_data: null, status_code: 0,
        duration_ms: 0, error: 'timeout', created_at: '2026-04-19T00:02:00Z' },
    ];
    const list = buildVersionList(baseLog, replays);
    expect(list.map(v => v.version)).toEqual([1, 2, 3]);
    expect(list[2].source).toBe('replay');
  });
});

describe('latestVersion', () => {
  it('returns v1 when no replays', () => {
    expect(latestVersion(baseLog, []).version).toBe(1);
  });
  it('returns highest version from replays', () => {
    const replays: LogReplay[] = [
      { id: 10, parent_log_id: 1, version: 2, http_method: 'POST',
        endpoint: 'https://api.example.com/x', query_params: null, headers: null,
        request_data: { edited: true }, response_data: null, status_code: 200,
        duration_ms: 10, error: null, created_at: '2026-04-19T00:01:00Z' },
    ];
    expect(latestVersion(baseLog, replays).version).toBe(2);
  });
});

describe('prefillFromLatest', () => {
  it('prefills from v1 log when no replays', () => {
    const p = prefillFromLatest(baseLog, []);
    expect(p.body).toEqual({ foo: 'bar' });
    expect(p.queryParams).toEqual({});
    expect(p.headers).toEqual({});
  });

  it('prefills from latest replay and blanks redacted headers', () => {
    const replays: LogReplay[] = [
      { id: 10, parent_log_id: 1, version: 2, http_method: 'POST',
        endpoint: 'https://api.example.com/x',
        query_params: { a: '1' },
        headers: { Authorization: '***', 'Content-Type': 'application/json' },
        request_data: { foo: 'edited' }, response_data: null, status_code: 200,
        duration_ms: 10, error: null, created_at: '2026-04-19T00:01:00Z' },
    ];
    const p = prefillFromLatest(baseLog, replays);
    expect(p.body).toEqual({ foo: 'edited' });
    expect(p.queryParams).toEqual({ a: '1' });
    expect(p.headers).toEqual({ Authorization: '', 'Content-Type': 'application/json' });
  });
});
