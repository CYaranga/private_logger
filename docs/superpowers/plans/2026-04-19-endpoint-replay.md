# Endpoint Replay Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Replay feature to the log viewer that re-sends a logged HTTP request via a backend proxy and stores each attempt as a numbered version (v1 = original, v2+ = replays) with editable body/headers/query params.

**Architecture:** New D1 table `log_replays`. New Hono endpoints (`POST /replay`, `GET /logs/:id/replays`, `DELETE /replays/:id`) protected by the existing `authMiddleware`. Backend proxies outbound fetches with SSRF guard and header sanitization. Frontend adds a tabbed interface to the log detail panel showing v1 (from logs) plus vN rows from `log_replays`, with a `+` tab that opens an editor.

**Tech Stack:** Hono 4.x on Cloudflare Workers, D1 SQLite, React 18 + TypeScript + Vite (frontend), Vitest for tests.

**Spec:** `docs/superpowers/specs/2026-04-19-endpoint-replay-design.md`

---

## File Structure

**Backend (`backend/`):**
- Create: `migrations/0004_log_replays.sql` — table DDL.
- Create: `src/replay/ssrf.ts` — SSRF guard (pure function).
- Create: `src/replay/sanitize.ts` — header sanitizer (pure function).
- Create: `src/replay/handler.ts` — replay execution (pure-ish: takes `fetch` as arg for testability).
- Modify: `src/index.ts` — wire up 3 new routes + auth gate.
- Create: `src/replay/ssrf.test.ts`, `src/replay/sanitize.test.ts`, `src/replay/handler.test.ts` — Vitest unit tests.

**Frontend (`frontend/`):**
- Modify: `src/types.ts` — add `LogReplay`, `CreateReplayInput`.
- Modify: `src/api.ts` — add `fetchReplays`, `createReplay`, `deleteReplay`.
- Create: `src/Replay.tsx` — `ReplayTabs`, `ReplayEditor`, `ReplayResponseView` components.
- Create: `src/Replay.test.tsx` — Vitest unit tests for version logic helpers.
- Modify: `src/App.tsx` — swap single Request/Response block for `ReplayTabs` inside `LogDetail` and `MobileLogDetail` sections.

Each file has one clear responsibility. `replay/` directory in backend keeps the proxy logic out of the 1300-line `index.ts`.

---

## Task 1: D1 Migration for `log_replays`

**Files:**
- Create: `backend/migrations/0004_log_replays.sql`

- [ ] **Step 1: Write migration SQL**

Create `backend/migrations/0004_log_replays.sql`:

```sql
-- Add table to store endpoint replay attempts (v2+) for logged API calls.
-- v1 is the original log row in `logs` and is not duplicated here.
CREATE TABLE IF NOT EXISTS log_replays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_log_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  http_method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  query_params TEXT,
  headers TEXT,
  request_data TEXT,
  response_data TEXT,
  status_code INTEGER,
  duration_ms INTEGER,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_log_id) REFERENCES logs(id) ON DELETE CASCADE,
  UNIQUE(parent_log_id, version)
);

CREATE INDEX IF NOT EXISTS idx_log_replays_parent ON log_replays(parent_log_id);
```

- [ ] **Step 2: Apply migration to local D1**

Run from `backend/`:
```bash
bunx wrangler d1 execute private_logs_db --local --file=./migrations/0004_log_replays.sql
```
Expected: `Executed X commands in Y ms`.

- [ ] **Step 3: Apply migration to remote D1**

Run from `backend/`:
```bash
bunx wrangler d1 execute private_logs_db --remote --file=./migrations/0004_log_replays.sql
```
Expected: remote confirmation, `Executed X commands`.

- [ ] **Step 4: Commit**

```bash
git add backend/migrations/0004_log_replays.sql
git commit -m "feat(db): add log_replays table for endpoint replay history"
```

---

## Task 2: SSRF Guard (pure function + tests)

**Files:**
- Create: `backend/src/replay/ssrf.ts`
- Create: `backend/src/replay/ssrf.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/replay/ssrf.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { validateReplayUrl } from './ssrf';

describe('validateReplayUrl', () => {
  it('accepts public https URL', () => {
    expect(validateReplayUrl('https://api.rebeca.app/foo')).toEqual({ ok: true });
  });

  it('accepts public http URL', () => {
    expect(validateReplayUrl('http://example.com/bar')).toEqual({ ok: true });
  });

  it('rejects non-http(s) schemes', () => {
    expect(validateReplayUrl('ftp://example.com')).toEqual({ ok: false, reason: 'scheme' });
    expect(validateReplayUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'scheme' });
  });

  it('rejects localhost', () => {
    expect(validateReplayUrl('http://localhost/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://LOCALHOST:8787/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects loopback IPv4', () => {
    expect(validateReplayUrl('http://127.0.0.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://127.255.255.254/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects private IPv4 ranges', () => {
    expect(validateReplayUrl('http://10.0.0.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://172.16.0.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://172.31.255.255/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://192.168.1.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://169.254.169.254/')).toEqual({ ok: false, reason: 'private' });
  });

  it('accepts IPv4 just outside private ranges', () => {
    expect(validateReplayUrl('http://172.32.0.1/')).toEqual({ ok: true });
    expect(validateReplayUrl('http://172.15.255.255/')).toEqual({ ok: true });
    expect(validateReplayUrl('http://11.0.0.1/')).toEqual({ ok: true });
  });

  it('rejects IPv6 loopback and link-local', () => {
    expect(validateReplayUrl('http://[::1]/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://[fe80::1]/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://[fc00::1]/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects .internal hostnames', () => {
    expect(validateReplayUrl('http://service.internal/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://FOO.INTERNAL/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects malformed URLs', () => {
    expect(validateReplayUrl('not a url')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateReplayUrl('')).toEqual({ ok: false, reason: 'malformed' });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run from `backend/`:
```bash
bun run test ssrf
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `validateReplayUrl`**

Create `backend/src/replay/ssrf.ts`:

```ts
export type SsrfResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'scheme' | 'private' };

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true;                           // loopback
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
  if (a === 192 && b === 168) return true;              // 192.168.0.0/16
  if (a === 169 && b === 254) return true;              // link-local
  if (a === 0) return true;                             // 0.0.0.0/8
  return false;
}

function isPrivateIPv6(host: string): boolean {
  // host as written, without brackets
  const h = host.toLowerCase();
  if (h === '::1') return true;                         // loopback
  if (h.startsWith('fe80:') || h.startsWith('fe80::')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) {       // unique local fc00::/7
    // more precise: first byte between 0xfc and 0xfd
    return true;
  }
  return false;
}

export function validateReplayUrl(raw: string): SsrfResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }

  let host = url.hostname.toLowerCase();

  // Strip IPv6 brackets if URL parser left them; URL.hostname usually omits them.
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost') return { ok: false, reason: 'private' };
  if (host.endsWith('.internal')) return { ok: false, reason: 'private' };

  const ipv4 = parseIPv4(host);
  if (ipv4 && isPrivateIPv4(ipv4)) return { ok: false, reason: 'private' };

  if (host.includes(':') && isPrivateIPv6(host)) return { ok: false, reason: 'private' };

  return { ok: true };
}
```

- [ ] **Step 4: Run tests, verify pass**

Run from `backend/`:
```bash
bun run test ssrf
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/replay/ssrf.ts backend/src/replay/ssrf.test.ts
git commit -m "feat(replay): add SSRF guard for outbound replay URLs"
```

---

## Task 3: Header Sanitizer (pure function + tests)

**Files:**
- Create: `backend/src/replay/sanitize.ts`
- Create: `backend/src/replay/sanitize.test.ts`

- [ ] **Step 1: Write failing tests**

Create `backend/src/replay/sanitize.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sanitizeHeadersForStorage } from './sanitize';

describe('sanitizeHeadersForStorage', () => {
  it('returns empty object for null/undefined', () => {
    expect(sanitizeHeadersForStorage(null)).toEqual({});
    expect(sanitizeHeadersForStorage(undefined)).toEqual({});
  });

  it('preserves non-sensitive headers verbatim', () => {
    expect(sanitizeHeadersForStorage({
      'Content-Type': 'application/json',
      'X-Request-Id': 'abc-123',
    })).toEqual({
      'Content-Type': 'application/json',
      'X-Request-Id': 'abc-123',
    });
  });

  it('redacts sensitive headers case-insensitively', () => {
    const result = sanitizeHeadersForStorage({
      'Authorization': 'Bearer abc',
      'cookie': 'sid=xyz',
      'Set-Cookie': 'sid=xyz',
      'X-API-Key': 'secret',
      'x-auth-token': 't',
      'Content-Type': 'application/json',
    });
    expect(result).toEqual({
      'Authorization': '***',
      'cookie': '***',
      'Set-Cookie': '***',
      'X-API-Key': '***',
      'x-auth-token': '***',
      'Content-Type': 'application/json',
    });
  });

  it('only redacts non-empty values', () => {
    expect(sanitizeHeadersForStorage({ Authorization: '' })).toEqual({ Authorization: '' });
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run from `backend/`:
```bash
bun run test sanitize
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement sanitizer**

Create `backend/src/replay/sanitize.ts`:

```ts
const SENSITIVE = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

export function sanitizeHeadersForStorage(
  headers: Record<string, string> | null | undefined
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== '' && SENSITIVE.has(k.toLowerCase())) {
      out[k] = '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun run test sanitize
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/replay/sanitize.ts backend/src/replay/sanitize.test.ts
git commit -m "feat(replay): add header sanitizer for stored replay records"
```

---

## Task 4: Replay Execution Handler (fetch wrapper + tests)

**Files:**
- Create: `backend/src/replay/handler.ts`
- Create: `backend/src/replay/handler.test.ts`

The handler takes `fetchImpl` as a parameter so tests can inject a mock without relying on global fetch semantics inside the Workers pool.

- [ ] **Step 1: Write failing tests**

Create `backend/src/replay/handler.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { executeReplay } from './handler';

describe('executeReplay', () => {
  it('builds URL with query params appended', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/items',
      queryParams: { a: '1', b: 'two' },
      headers: {},
      body: undefined,
      fetchImpl,
      timeoutMs: 1000,
    });
    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain('https://api.example.com/items?');
    expect(calledUrl).toContain('a=1');
    expect(calledUrl).toContain('b=two');
  });

  it('merges with existing query string on endpoint', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/items?x=1',
      queryParams: { y: '2' },
      headers: {},
      body: undefined,
      fetchImpl,
      timeoutMs: 1000,
    });
    const calledUrl = fetchImpl.mock.calls[0][0] as string;
    expect(calledUrl).toContain('x=1');
    expect(calledUrl).toContain('y=2');
  });

  it('serializes object body as JSON and sets Content-Type', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'POST',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: { hello: 'world' },
      fetchImpl,
      timeoutMs: 1000,
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('{"hello":"world"}');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('preserves string body and does not override Content-Type', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'POST',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: { 'Content-Type': 'text/plain' },
      body: 'raw text',
      fetchImpl,
      timeoutMs: 1000,
    });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe('raw text');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });

  it('returns parsed JSON response when response is JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const result = await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: undefined,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(result.statusCode).toBe(200);
    expect(result.responseData).toEqual({ ok: true });
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns raw string when response is not JSON', async () => {
    const fetchImpl = vi.fn(async () => new Response('hello', { status: 200 }));
    const result = await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: undefined,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(result.responseData).toBe('hello');
  });

  it('records status_code 0 and error on fetch failure', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error('boom'); });
    const result = await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: undefined,
      fetchImpl,
      timeoutMs: 1000,
    });
    expect(result.statusCode).toBe(0);
    expect(result.error).toBe('boom');
    expect(result.responseData).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

```bash
bun run test handler
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `executeReplay`**

Create `backend/src/replay/handler.ts`:

```ts
export interface ExecuteReplayArgs {
  method: string;
  endpoint: string;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export interface ExecuteReplayResult {
  statusCode: number;             // 0 on network error
  durationMs: number;
  responseData: unknown;          // parsed JSON, raw string, or null on error
  error: string | null;
  finalUrl: string;
  sentHeaders: Record<string, string>;
  sentBody: string | null;
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

function buildUrl(endpoint: string, queryParams: Record<string, string>): string {
  const entries = Object.entries(queryParams);
  if (entries.length === 0) return endpoint;
  const url = new URL(endpoint);
  for (const [k, v] of entries) url.searchParams.append(k, v);
  return url.toString();
}

export async function executeReplay(args: ExecuteReplayArgs): Promise<ExecuteReplayResult> {
  const { method, endpoint, queryParams, headers, body, fetchImpl, timeoutMs } = args;

  const finalUrl = buildUrl(endpoint, queryParams);
  const sentHeaders: Record<string, string> = { ...headers };
  let sentBody: string | null = null;

  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      sentBody = body;
    } else {
      sentBody = JSON.stringify(body);
      if (!hasHeader(sentHeaders, 'Content-Type')) {
        sentHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const start = Date.now();

  try {
    const response = await fetchImpl(finalUrl, {
      method,
      headers: sentHeaders,
      body: sentBody ?? undefined,
      signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - start;

    let responseData: unknown;
    let error: string | null = null;
    if (text.length > MAX_RESPONSE_BYTES) {
      responseData = text.slice(0, MAX_RESPONSE_BYTES);
      error = `response truncated: original length ${text.length} bytes`;
    } else {
      try {
        responseData = JSON.parse(text);
      } catch {
        responseData = text;
      }
    }

    return {
      statusCode: response.status,
      durationMs,
      responseData,
      error,
      finalUrl,
      sentHeaders,
      sentBody,
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const message = e instanceof Error ? e.message : String(e);
    return {
      statusCode: 0,
      durationMs,
      responseData: null,
      error: message,
      finalUrl,
      sentHeaders,
      sentBody,
    };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bun run test handler
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add backend/src/replay/handler.ts backend/src/replay/handler.test.ts
git commit -m "feat(replay): add executeReplay wrapper with JSON + timeout handling"
```

---

## Task 5: Wire Replay Routes into Hono App

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add type and helper at top of `index.ts` (after existing `Log` type declarations)**

Locate the section ending with `type Archive = { ... };` (around line 148). Immediately after it, insert:

```ts
type LogReplay = {
  id: number;
  parent_log_id: number;
  version: number;
  http_method: string;
  endpoint: string;
  query_params: string | null;
  headers: string | null;
  request_data: string | null;
  response_data: string | null;
  status_code: number | null;
  duration_ms: number | null;
  error: string | null;
  created_at: string;
};

function parseReplayFields(r: LogReplay): Record<string, unknown> {
  return {
    ...r,
    query_params: r.query_params ? tryParseJSON(r.query_params) : null,
    headers: r.headers ? tryParseJSON(r.headers) : null,
    request_data: r.request_data ? tryParseJSON(r.request_data) : null,
    response_data: r.response_data ? tryParseJSON(r.response_data) : null,
  };
}
```

Note: `tryParseJSON` is defined later in the file (around line 446). Move the `LogReplay`/`parseReplayFields` declarations below the `tryParseJSON` definition instead — i.e., insert the block right after `function tryParseJSON` ends (around line 452).

- [ ] **Step 2: Add imports at top of `index.ts`**

After `import { getCookie, setCookie, deleteCookie } from 'hono/cookie';` (line 3), add:

```ts
import { validateReplayUrl } from './replay/ssrf';
import { sanitizeHeadersForStorage } from './replay/sanitize';
import { executeReplay } from './replay/handler';
```

- [ ] **Step 3: Add routes — insert before `export default` (around line 1329)**

Immediately before `export default {`, insert:

```ts
// ============================================================
// Endpoint Replay
// ============================================================

const REPLAY_TIMEOUT_MS = 30_000;

app.get('/logs/:id/replays', authMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.json({ error: 'Invalid log id' }, 400);

    const { results } = await c.env.DB.prepare(
      'SELECT * FROM log_replays WHERE parent_log_id = ? ORDER BY version ASC'
    ).bind(id).all<LogReplay>();

    return c.json({ replays: (results ?? []).map(parseReplayFields) });
  } catch (error) {
    console.error('Error fetching replays:', error);
    return c.json({ error: 'Failed to fetch replays' }, 500);
  }
});

app.post('/replay', authMiddleware, async (c) => {
  try {
    const body = await c.req.json<{
      parent_log_id: number;
      http_method: string;
      endpoint: string;
      query_params?: Record<string, string>;
      headers?: Record<string, string>;
      body?: unknown;
    }>();

    if (!body.parent_log_id || !body.http_method || !body.endpoint) {
      return c.json({ error: 'parent_log_id, http_method, endpoint required' }, 400);
    }

    const parent = await c.env.DB.prepare(
      'SELECT id, http_method, endpoint FROM logs WHERE id = ?'
    ).bind(body.parent_log_id).first<{ id: number; http_method: string | null; endpoint: string | null }>();

    if (!parent) return c.json({ error: 'Parent log not found' }, 404);
    if (!parent.http_method || !parent.endpoint) {
      return c.json({ error: 'Parent log is not an API call' }, 400);
    }
    if (parent.http_method !== body.http_method || parent.endpoint !== body.endpoint) {
      return c.json({ error: 'http_method and endpoint must match parent log' }, 400);
    }

    const ssrf = validateReplayUrl(body.endpoint);
    if (!ssrf.ok) {
      return c.json({ error: `URL rejected: ${ssrf.reason}` }, 400);
    }

    const maxRow = await c.env.DB.prepare(
      'SELECT MAX(version) as max_version FROM log_replays WHERE parent_log_id = ?'
    ).bind(body.parent_log_id).first<{ max_version: number | null }>();

    const nextVersion = Math.max((maxRow?.max_version ?? 1) + 1, 2);

    const result = await executeReplay({
      method: body.http_method,
      endpoint: body.endpoint,
      queryParams: body.query_params ?? {},
      headers: body.headers ?? {},
      body: body.body,
      fetchImpl: fetch,
      timeoutMs: REPLAY_TIMEOUT_MS,
    });

    const storedHeaders = sanitizeHeadersForStorage(body.headers ?? {});

    const inserted = await c.env.DB.prepare(
      `INSERT INTO log_replays
       (parent_log_id, version, http_method, endpoint, query_params, headers,
        request_data, response_data, status_code, duration_ms, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    ).bind(
      body.parent_log_id,
      nextVersion,
      body.http_method,
      body.endpoint,
      body.query_params ? JSON.stringify(body.query_params) : null,
      Object.keys(storedHeaders).length ? JSON.stringify(storedHeaders) : null,
      body.body === undefined
        ? null
        : (typeof body.body === 'string' ? body.body : JSON.stringify(body.body)),
      result.responseData === null
        ? null
        : (typeof result.responseData === 'string'
            ? result.responseData
            : JSON.stringify(result.responseData)),
      result.statusCode,
      result.durationMs,
      result.error,
    ).first<LogReplay>();

    return c.json({ replay: inserted ? parseReplayFields(inserted) : null }, 201);
  } catch (error) {
    console.error('Replay error:', error);
    return c.json({ error: 'Failed to execute replay' }, 500);
  }
});

app.delete('/replays/:id', authMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.json({ error: 'Invalid replay id' }, 400);

    const result = await c.env.DB.prepare('DELETE FROM log_replays WHERE id = ?')
      .bind(id).run();

    if (result.meta.changes === 0) return c.json({ error: 'Replay not found' }, 404);
    return c.json({ success: true });
  } catch (error) {
    console.error('Error deleting replay:', error);
    return c.json({ error: 'Failed to delete replay' }, 500);
  }
});
```

- [ ] **Step 4: Update CORS to include PUT, PATCH not needed, but add to allowMethods**

Modify the CORS block (around line 245) to include the existing methods plus nothing new — the POST/GET/DELETE are already allowed. No change required. Verify by reading lines 235–248.

- [ ] **Step 5: Run type check**

From `backend/`:
```bash
bunx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 6: Run all backend tests**

```bash
bun run test
```
Expected: all green (handler, ssrf, sanitize).

- [ ] **Step 7: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(replay): add POST /replay, GET /logs/:id/replays, DELETE /replays/:id"
```

---

## Task 6: Frontend Types and API Client

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Add types in `frontend/src/types.ts`**

Append to the end of `frontend/src/types.ts`:

```ts
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
```

- [ ] **Step 2: Add API functions in `frontend/src/api.ts`**

Append to the end of `frontend/src/api.ts`:

```ts
import type { LogReplay, CreateReplayInput } from './types';

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
```

Update the top-of-file import to include the new types. Change line 1 from:

```ts
import type { LogsResponse, Stats, Filters, Storage, Archive, TimeRange, TimeseriesResponse } from './types';
```

to a single union import (keeping it one line, existing style). Since the new functions have their own import at the bottom, leave the top import untouched — the duplicate `import type` lines are tolerated by TypeScript. Verify via tsc (step 4).

- [ ] **Step 3: Run type check**

From `frontend/`:
```bash
bunx tsc -b
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts
git commit -m "feat(frontend): add LogReplay types and replay API client"
```

---

## Task 7: Version Helper Function + Test

**Files:**
- Create: `frontend/src/replayVersions.ts`
- Create: `frontend/src/replayVersions.test.ts`

The helpers encapsulate the "merge v1 from log + v2+ from replays" logic so it is testable without rendering React.

- [ ] **Step 1: Write failing tests**

Create `frontend/src/replayVersions.test.ts`:

```ts
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
```

- [ ] **Step 2: Run tests, verify fail**

From `frontend/`:
```bash
bunx vitest run replayVersions
```
Expected: FAIL, module not found.

- [ ] **Step 3: Implement helpers**

Create `frontend/src/replayVersions.ts`:

```ts
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
```

- [ ] **Step 4: Run tests, verify pass**

```bash
bunx vitest run replayVersions
```
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/replayVersions.ts frontend/src/replayVersions.test.ts
git commit -m "feat(frontend): add replay version list + prefill helpers"
```

---

## Task 8: `ReplayTabs` Component

**Files:**
- Create: `frontend/src/Replay.tsx`

This component renders the tab bar + active panel + editor. It owns local state for: replays list, active version, editor mode, submitting flag.

- [ ] **Step 1: Create `Replay.tsx`**

Create `frontend/src/Replay.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Log, LogReplay } from './types';
import { fetchReplays, createReplay, deleteReplay } from './api';
import { buildVersionList, prefillFromLatest, type VersionEntry } from './replayVersions';

interface ReplayTabsProps {
  log: Log;
  JsonViewer: React.ComponentType<{ data: unknown; label: string }>;
}

export function ReplayTabs({ log, JsonViewer }: ReplayTabsProps) {
  const [replays, setReplays] = useState<LogReplay[]>([]);
  const [activeVersion, setActiveVersion] = useState<number>(1);
  const [editing, setEditing] = useState<boolean>(false);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchReplays(log.id)
      .then(r => { if (!cancelled) { setReplays(r); setLoading(false); } })
      .catch(e => { if (!cancelled) { setError(String(e.message || e)); setLoading(false); } });
    return () => { cancelled = true; };
  }, [log.id]);

  const versions = buildVersionList(log, replays);
  const active = versions.find(v => v.version === activeVersion) ?? versions[0];

  async function handleDelete(replayId: number) {
    if (!confirm('Delete this replay version?')) return;
    try {
      await deleteReplay(replayId);
      setReplays(prev => prev.filter(r => r.id !== replayId));
      if (active?.replayId === replayId) setActiveVersion(1);
    } catch (e) {
      alert(`Failed to delete: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async function handleSubmit(payload: {
    queryParams: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
  }) {
    if (!log.http_method || !log.endpoint) return;
    const created = await createReplay({
      parent_log_id: log.id,
      http_method: log.http_method,
      endpoint: log.endpoint,
      query_params: payload.queryParams,
      headers: payload.headers,
      body: payload.body,
    });
    setReplays(prev => [...prev, created]);
    setActiveVersion(created.version);
    setEditing(false);
  }

  if (loading) return <div className="replay-loading">Loading replays…</div>;
  if (error) return <div className="replay-error">Failed to load replays: {error}</div>;

  return (
    <div className="replay-tabs">
      <div className="replay-tab-bar">
        {versions.map(v => (
          <ReplayTab
            key={v.version}
            entry={v}
            active={!editing && v.version === active?.version}
            onSelect={() => { setEditing(false); setActiveVersion(v.version); }}
            onDelete={v.source === 'replay' && v.replayId !== null ? () => handleDelete(v.replayId!) : null}
          />
        ))}
        <button
          type="button"
          className={`replay-tab replay-tab-add${editing ? ' active' : ''}`}
          onClick={() => setEditing(true)}
        >
          + Replay
        </button>
      </div>

      {editing ? (
        <ReplayEditor
          prefill={prefillFromLatest(log, replays)}
          method={log.http_method ?? ''}
          endpoint={log.endpoint ?? ''}
          onCancel={() => setEditing(false)}
          onSubmit={handleSubmit}
        />
      ) : active ? (
        <ReplayPanel entry={active} JsonViewer={JsonViewer} />
      ) : null}
    </div>
  );
}

function statusBadge(statusCode: number | null, error: string | null): string {
  if (error && statusCode === 0) return 'err';
  if (statusCode === null) return '—';
  return String(statusCode);
}

function ReplayTab({
  entry, active, onSelect, onDelete,
}: {
  entry: VersionEntry;
  active: boolean;
  onSelect: () => void;
  onDelete: (() => void) | null;
}) {
  const badge = statusBadge(entry.statusCode, entry.error);
  const duration = entry.durationMs !== null ? `${entry.durationMs}ms` : '';
  return (
    <div className={`replay-tab${active ? ' active' : ''}`}>
      <button type="button" onClick={onSelect}>
        v{entry.version} • {badge}{duration ? ` • ${duration}` : ''}
      </button>
      {onDelete && (
        <button
          type="button"
          className="replay-tab-delete"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title="Delete this version"
        >×</button>
      )}
    </div>
  );
}

function ReplayPanel({
  entry, JsonViewer,
}: {
  entry: VersionEntry;
  JsonViewer: React.ComponentType<{ data: unknown; label: string }>;
}) {
  return (
    <div className="replay-panel">
      <div className="replay-panel-row">
        <span className="replay-panel-label">Endpoint</span>
        <code>{entry.httpMethod} {entry.endpoint}</code>
      </div>
      {entry.queryParams !== null && Object.keys(entry.queryParams).length > 0 && (
        <JsonViewer data={entry.queryParams} label="Query params" />
      )}
      {entry.headers !== null && Object.keys(entry.headers).length > 0 && (
        <JsonViewer data={entry.headers} label="Headers" />
      )}
      {entry.source === 'log' && (
        <div className="replay-panel-note">
          Headers and query params not recorded separately for the original call.
        </div>
      )}
      {entry.requestData !== null && entry.requestData !== undefined && (
        <JsonViewer data={entry.requestData} label="Request body" />
      )}
      <div className="replay-panel-row">
        <span className="replay-panel-label">Status</span>
        <span>{entry.statusCode ?? '—'}{entry.durationMs !== null ? ` • ${entry.durationMs}ms` : ''}</span>
      </div>
      {entry.error && <div className="replay-panel-error">Error: {entry.error}</div>}
      {entry.responseData !== null && entry.responseData !== undefined && (
        <JsonViewer data={entry.responseData} label="Response" />
      )}
    </div>
  );
}

function ReplayEditor({
  prefill, method, endpoint, onCancel, onSubmit,
}: {
  prefill: { body: unknown; queryParams: Record<string, string>; headers: Record<string, string> };
  method: string;
  endpoint: string;
  onCancel: () => void;
  onSubmit: (payload: {
    queryParams: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
  }) => Promise<void>;
}) {
  const [queryText, setQueryText] = useState(
    JSON.stringify(prefill.queryParams, null, 2),
  );
  const [headersText, setHeadersText] = useState(
    JSON.stringify(prefill.headers, null, 2),
  );
  const [bodyText, setBodyText] = useState(
    prefill.body === null || prefill.body === undefined
      ? ''
      : typeof prefill.body === 'string'
        ? prefill.body
        : JSON.stringify(prefill.body, null, 2),
  );
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function parseOrThrow(label: string, text: string, allowEmpty: boolean): unknown {
    const trimmed = text.trim();
    if (trimmed === '') return allowEmpty ? (label === 'body' ? undefined : {}) : undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new Error(`${label}: invalid JSON`);
    }
  }

  async function handleSend() {
    setErr(null);
    try {
      const queryParams = parseOrThrow('query params', queryText, true) as Record<string, string>;
      const headers = parseOrThrow('headers', headersText, true) as Record<string, string>;
      let body: unknown;
      const t = bodyText.trim();
      if (t === '') {
        body = undefined;
      } else {
        try {
          body = JSON.parse(t);
        } catch {
          body = bodyText;  // treat as raw string
        }
      }
      setSubmitting(true);
      await onSubmit({ queryParams, headers, body });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="replay-editor">
      <div className="replay-editor-row">
        <label>Method</label>
        <input type="text" value={method} disabled />
      </div>
      <div className="replay-editor-row">
        <label>URL</label>
        <input type="text" value={endpoint} disabled />
      </div>
      <div className="replay-editor-row">
        <label>Query params (JSON object)</label>
        <textarea
          value={queryText}
          onChange={e => setQueryText(e.target.value)}
          rows={4}
          spellCheck={false}
        />
      </div>
      <div className="replay-editor-row">
        <label>Headers (JSON object)</label>
        <textarea
          value={headersText}
          onChange={e => setHeadersText(e.target.value)}
          rows={6}
          spellCheck={false}
        />
        <div className="replay-editor-hint">
          ⚠ Sensitive headers (Authorization, cookies) not restored from prior versions.
          Paste a fresh token if required.
        </div>
      </div>
      <div className="replay-editor-row">
        <label>Body (JSON or raw string)</label>
        <textarea
          value={bodyText}
          onChange={e => setBodyText(e.target.value)}
          rows={10}
          spellCheck={false}
        />
      </div>
      {err && <div className="replay-editor-error">{err}</div>}
      <div className="replay-editor-actions">
        <button type="button" onClick={handleSend} disabled={submitting}>
          {submitting ? 'Sending…' : 'Send'}
        </button>
        <button type="button" onClick={onCancel} disabled={submitting}>Cancel</button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Add minimal CSS**

Append to `frontend/src/index.css`:

```css
/* ===== Replay Tabs ===== */
.replay-tabs { margin-top: 12px; }
.replay-tab-bar { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; border-bottom: 1px solid var(--border, #333); padding-bottom: 4px; }
.replay-tab { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--border, #333); border-radius: 4px 4px 0 0; background: var(--bg-alt, #1a1a1a); }
.replay-tab.active { background: var(--bg, #000); border-bottom-color: transparent; }
.replay-tab button { padding: 4px 10px; background: transparent; color: inherit; border: 0; font-family: inherit; font-size: 12px; cursor: pointer; }
.replay-tab-delete { color: #888 !important; padding: 4px 6px !important; }
.replay-tab-delete:hover { color: #e66 !important; }
.replay-tab-add { padding: 4px 10px; background: var(--bg-alt, #1a1a1a); color: inherit; border: 1px dashed var(--border, #444); border-radius: 4px; font-family: inherit; font-size: 12px; cursor: pointer; }
.replay-tab-add.active { background: var(--bg, #000); border-style: solid; }
.replay-panel { display: flex; flex-direction: column; gap: 8px; padding: 8px 0; }
.replay-panel-row { display: flex; gap: 8px; align-items: baseline; font-size: 12px; }
.replay-panel-label { font-weight: 600; color: var(--muted, #888); min-width: 80px; }
.replay-panel-note { font-size: 11px; color: var(--muted, #888); font-style: italic; }
.replay-panel-error { color: #e66; font-size: 12px; }
.replay-editor { display: flex; flex-direction: column; gap: 10px; padding: 8px 0; }
.replay-editor-row { display: flex; flex-direction: column; gap: 4px; }
.replay-editor-row label { font-size: 11px; font-weight: 600; color: var(--muted, #888); text-transform: uppercase; letter-spacing: 0.5px; }
.replay-editor-row input, .replay-editor-row textarea { background: var(--bg-alt, #1a1a1a); color: inherit; border: 1px solid var(--border, #333); border-radius: 4px; padding: 6px 8px; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
.replay-editor-row input:disabled { opacity: 0.6; }
.replay-editor-row textarea { resize: vertical; }
.replay-editor-hint { font-size: 11px; color: var(--muted, #888); margin-top: 2px; }
.replay-editor-error { color: #e66; font-size: 12px; padding: 6px 8px; background: rgba(230, 102, 102, 0.1); border-radius: 4px; }
.replay-editor-actions { display: flex; gap: 8px; }
.replay-editor-actions button { padding: 6px 16px; background: var(--accent, #3b82f6); color: white; border: 0; border-radius: 4px; font-family: inherit; font-size: 12px; cursor: pointer; }
.replay-editor-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
.replay-loading, .replay-error { padding: 12px; font-size: 12px; color: var(--muted, #888); }
.replay-error { color: #e66; }
```

- [ ] **Step 3: Run type check**

From `frontend/`:
```bash
bunx tsc -b
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/Replay.tsx frontend/src/index.css
git commit -m "feat(frontend): add ReplayTabs, ReplayEditor, ReplayPanel components"
```

---

## Task 9: Integrate `ReplayTabs` into Log Detail

**Files:**
- Modify: `frontend/src/App.tsx`

The log detail currently shows `<JsonViewer data={log.request_data} label="Request" />` and `<JsonViewer data={log.response_data} label="Response" />` inside an `isApiCall` block. Replace that pair with `<ReplayTabs>`.

- [ ] **Step 1: Add import at top of `App.tsx`**

Near the other component imports (after the existing imports block at the top of the file), add:

```tsx
import { ReplayTabs } from './Replay';
```

- [ ] **Step 2: Replace desktop Request/Response block**

Locate the lines around 678–685 in `App.tsx`:

```tsx
                  {log.request_data !== null && log.request_data !== undefined && (
                    <JsonViewer data={log.request_data} label="Request" />
                  )}

                  {log.response_data !== null && log.response_data !== undefined && (
                    <JsonViewer data={log.response_data} label="Response" />
                  )}
```

Replace with:

```tsx
                  {isApiCall && <ReplayTabs log={log} JsonViewer={JsonViewer} />}
```

Important: `JsonViewer` must be passed as a component reference. Verify that `JsonViewer` is already in scope at this location (it is, per the existing usage). Remove now-unused direct `JsonViewer` calls inside this branch only — not elsewhere in the file.

- [ ] **Step 3: Replace mobile Request/Response block**

Locate the lines around 963–970 in `App.tsx` (inside the mobile detail view):

```tsx
              <JsonViewer data={log.request_data} label="Request" />
              ...
              <JsonViewer data={log.response_data} label="Response" />
```

Replace the two calls with the single:

```tsx
              {isApiCall && <ReplayTabs log={log} JsonViewer={JsonViewer} />}
```

Preserve the surrounding endpoint display (the `full-endpoint` line) as-is since it sits outside the request/response block.

- [ ] **Step 4: Run type check**

From `frontend/`:
```bash
bunx tsc -b
```
Expected: no errors.

- [ ] **Step 5: Run frontend tests**

```bash
bunx vitest run
```
Expected: all green (existing `App.test.tsx` + new `replayVersions.test.ts`).

- [ ] **Step 6: Start dev server and verify UI manually**

From `frontend/`:
```bash
bun run dev
```
Open `http://localhost:3000`. Log in. Expand a log with `http_method` set. Verify:
- `v1` tab shows, with status + duration.
- `+ Replay` tab exists.
- Clicking `+ Replay` opens the editor with prefilled body.
- "Cancel" returns to v1 view.
- Sending against a reachable endpoint creates `v2` tab and switches to it.

Stop the dev server with Ctrl-C when done.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(frontend): wire ReplayTabs into desktop and mobile log detail"
```

---

## Task 10: Deploy

Backend deployed first because the frontend depends on the new routes.

- [ ] **Step 1: Verify production D1 migration applied**

If Task 1 Step 3 (remote migration) was skipped, run now from `backend/`:
```bash
bunx wrangler d1 execute private_logs_db --remote --file=./migrations/0004_log_replays.sql
```

- [ ] **Step 2: Deploy backend**

From `backend/`:
```bash
bun run deploy
```
Expected: `Deployed private-logger-api`.

- [ ] **Step 3: Smoke-test production backend**

```bash
curl -sS https://private-logger-api.christian-yaranga-05.workers.dev/logs/1/replays
```
Expected: `{"error":"Authentication required"}` (401). Confirms route exists and is auth-gated.

- [ ] **Step 4: Deploy frontend**

From `frontend/`:
```bash
bun run deploy
```
Expected: `Deployed`.

- [ ] **Step 5: Manual verification in production**

Open `https://logger.chrisyaranga.dev`, log in, expand an API-call log, try a replay against a known public endpoint. Confirm new version persists after page reload.

- [ ] **Step 6: Final commit (if deploy produced any generated files) and push**

```bash
git status
git push
```
(`git push` only if the user confirms; skip otherwise.)

---

## Spec Coverage Check

- D1 `log_replays` table with exact schema → Task 1.
- SSRF guard for private IPs + `localhost` + `.internal` → Task 2.
- Header sanitization → Task 3.
- Outbound fetch with 30s timeout, error capture, JSON parsing, 10 MB cap → Task 4.
- `POST /replay`, `GET /logs/:id/replays`, `DELETE /replays/:id` with auth, identity validation, version increment → Task 5.
- Frontend types + API client → Task 6.
- Version list + prefill helpers (v1 = log, vN = replay) → Task 7.
- Tabbed UI with editor + response panel, v1 protected, v2+ deletable → Tasks 8 + 9.
- Mobile + desktop integration → Task 9.
- Deployment order (backend → frontend) → Task 10.
