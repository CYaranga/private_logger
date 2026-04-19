# Endpoint Replay with Versioned History — Design

**Date:** 2026-04-19
**Status:** Approved for implementation planning
**Author:** Brainstorming session with Claude

## Summary

Add a "Replay" feature to the log viewer that lets the user re-send a logged HTTP request and save every attempt as a numbered version (v1, v2, v3, …). The original log is v1; each replay creates a new version stored in a new `log_replays` table. The user can edit the body, query params, and headers before each replay.

## Goals

- Re-run a logged API call directly from the log viewer.
- Preserve every replay attempt for inspection and comparison.
- Allow edits to body, query params, and headers between attempts.
- Work across origins where the browser cannot make the request directly.

## Non-goals

- Diff view between versions (future work).
- Replaying non-API logs (logs without `http_method`).
- Editing HTTP method or URL (that would change parent identity).
- Rate limiting (private, single-user tool).
- Importing/exporting replay history.

## Architecture

```
Browser (frontend)
  │  POST /replay  (auth required, session cookie or Bearer)
  ▼
Hono Worker (backend)
  │  SSRF-guarded fetch()
  ▼
Target endpoint
  ▲
  │  response + timing
Hono Worker
  │  INSERT INTO log_replays, return row
  ▲
Browser — appends new tab v(N+1), selects it
```

The backend proxy is required because most logged endpoints are external (mobile app backends on different origins) and direct browser calls fail on CORS, cookies, and auth headers.

## Data Model

New D1 table in the primary `DB` (not `ANALYTICS_DB`):

```sql
CREATE TABLE log_replays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_log_id INTEGER NOT NULL,
  version INTEGER NOT NULL,
  http_method TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  query_params TEXT,        -- JSON object, may be null
  headers TEXT,             -- JSON object, sensitive values redacted
  request_data TEXT,        -- JSON or raw string, may be null
  response_data TEXT,       -- JSON or raw string, may be null
  status_code INTEGER,      -- 0 on network error / timeout
  duration_ms INTEGER,
  error TEXT,               -- null on success, message on failure
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_log_id) REFERENCES logs(id) ON DELETE CASCADE,
  UNIQUE(parent_log_id, version)
);
CREATE INDEX idx_log_replays_parent ON log_replays(parent_log_id);
```

**Versioning rule:** v1 is the original `logs` row and is NOT duplicated in `log_replays`. The first replay is v2, second is v3, etc. `MAX(version)` query returns 1 when the table has no rows for a parent, so next_version = max+1 with a floor of 2.

**Header sanitization before store:** the keys `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token` (case-insensitive) are replaced with `"***"` before insertion. The outbound request uses the real values.

## Backend API

All endpoints live in `backend/src/index.ts`. The replay endpoints require authentication via the existing `authMiddleware`.

### `POST /replay`

Request:
```ts
{
  parent_log_id: number;
  http_method: HttpMethod;         // must equal parent log's http_method
  endpoint: string;                // must equal parent log's endpoint
  query_params?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;                  // JSON value or string
}
```

Flow:
1. `authMiddleware` — 401 if not logged in.
2. Load parent log by id. 404 if missing. 400 if `http_method` is null (not an API log).
3. Verify `http_method` and `endpoint` in request body match the parent log (frozen identity).
4. SSRF guard on `endpoint`:
   - Parse URL. Must be `http:` or `https:`.
   - Reject hostnames: `localhost`, any that resolve to `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`, `fe80::/10`. Hostname suffix `.internal` rejected.
   - DNS resolution check deferred to fetch (Cloudflare Workers runtime does not expose DNS APIs); guard is applied to the literal hostname.
5. Compute `next_version = max(MAX(version) + 1 FROM log_replays WHERE parent_log_id = ?, 2)`.
6. Build outbound URL by appending `query_params` as a query string to `endpoint`. If `endpoint` already has a query string, merge.
7. Serialize `body`: if string, send as-is; if object, JSON-stringify and set `Content-Type: application/json` unless header already present.
8. `fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) })`.
9. Measure `duration_ms` with `performance.now()` or `Date.now()` around the fetch.
10. Read response body as text. Attempt `JSON.parse`; on failure, store raw string.
11. Sanitize headers (see above) before insert.
12. Insert row. Return the inserted row in the same shape as `GET /logs/:id/replays` returns.

Error cases:
- Timeout / network error / DNS failure / TLS error: still insert row with `status_code = 0`, `error = message`, empty `response_data`. Return 200 with the row so the UI shows the failed attempt as a version.
- Validation failure (mismatched method/url, SSRF block, missing parent): return 400 / 404 without inserting.
- Max outbound response body: 10 MB. Larger responses truncated; `error` field notes truncation.

### `GET /logs/:id/replays`

Returns all replay rows for a parent log, ordered by `version ASC`. Auth required.

### `DELETE /replays/:id`

Deletes one replay row. Does not renumber remaining versions. Auth required. v1 cannot be deleted here (it lives in `logs`, not `log_replays`).

## Frontend UI

### Log detail panel (desktop and mobile)

Currently, when `isApiCall` (i.e., `log.http_method !== null`), the detail panel shows a single Request / Response block via `JsonViewer`. This is replaced by a tabbed interface.

Layout:

```
┌──────────────────────────────────────────────────────────────┐
│ [v1 • 200 • 342ms] [v2 • 401 • 180ms] [v3 • 200 • 410ms] [+] │
├──────────────────────────────────────────────────────────────┤
│ Endpoint:       POST https://api.rebeca.app/foo    (frozen)  │
│ Query params:   { … }                                        │
│ Headers:        { Authorization: "***", … }                  │
│ Request body:   <JsonViewer>                                 │
│ Response:       <status badge> <duration>                    │
│                 <JsonViewer>                                 │
└──────────────────────────────────────────────────────────────┘
```

Tab semantics:
- **v1 tab** reads from the parent log row (`log.request_data`, `log.response_data`, `log.status_code`, `log.duration_ms`). `query_params` and `headers` show "not recorded" (the original log didn't capture them separately).
- **vN tab (N ≥ 2)** reads from the corresponding `log_replays` row.
- Each tab label: `vN • <status or "err"> • <duration>ms`.
- **Delete** via tab right-click menu (desktop) or long-press (mobile). v1 is not deletable from this UI.

### `+ Replay` tab

Clicking `[+]` switches the detail panel to editor mode:

```
Method:       POST                                 (disabled)
URL:          https://api.rebeca.app/foo           (disabled)
Query params: <JSON textarea>
Headers:      <JSON textarea>
              ⚠ Authorization and other sensitive headers
                are not restored from prior versions.
                Paste a fresh token if required.
Body:         <JSON textarea>
              [Send]  [Cancel]
```

Prefill from the latest existing version (highest vN):
- Body and query params from that version's stored values.
- Headers from that version's stored values, with redacted (`***`) entries replaced by empty string so the user notices them.

On `Send`:
1. Button shows spinner, disabled.
2. `POST /replay` with the edited payload.
3. On response, invalidate cached replay list, append new row, switch active tab to the new version.
4. On client-side validation failure (malformed JSON in a textarea), show error inline, do not submit.

### Fetching strategy

Replays for a log are fetched lazily on first expand of that log row. Results cached in component state, keyed by `parent_log_id`. After a successful `POST /replay`, the cache for that id is updated with the new row appended.

## Frontend API client additions (`frontend/src/api.ts`)

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

fetchReplays(logId: number): Promise<LogReplay[]>
createReplay(input: CreateReplayInput): Promise<LogReplay>
deleteReplay(replayId: number): Promise<void>
```

## Component boundaries

Add to `frontend/src/App.tsx` (or split if it simplifies):

- **`ReplayTabs`** — renders the tab bar, owns active-version state, loads replays on mount.
- **`ReplayEditor`** — JSON textareas, validation, submit handler. Takes prefill from latest version as props.
- **`ReplayResponseView`** — read-only, reuses existing `JsonViewer`. Renders active version's request + response.

Each component is small enough to hold in context. Extraction decision (keep in `App.tsx` vs new file) is left to implementation phase; the existing file is already 75 KB and would benefit from extraction.

## Testing

**Frontend (Vitest, new tests in `App.test.tsx` or a companion file):**
- Version numbers increment correctly after create.
- Switching tabs renders the right payload.
- Editor prefill comes from the latest version.
- Failed replay (status_code = 0) renders a tab with an "err" badge.
- v1 tab is not deletable; v2+ deletable.

**Backend (manual verification via curl / a quick integration script):**
- `/replay` without auth → 401.
- `/replay` with mismatched `http_method` or `endpoint` vs parent → 400.
- `/replay` targeting `http://localhost:8787` → 400 SSRF block.
- `/replay` targeting `http://10.0.0.1` → 400 SSRF block.
- `/replay` targeting a slow endpoint → after 30s, row saved with `status_code = 0`, `error = "timeout"`.
- Inserting with a colliding (`parent_log_id`, `version`) pair → UNIQUE constraint error (should not happen via the flow, but serves as a safety net).
- Deleting parent log cascades to `log_replays` rows.

## Migration

Add `backend/migrations/000X_log_replays.sql` with the table and index DDL. Run via `bun run db:migrate`.

## Deployment

Backend: deploy first (`cd backend && bun run deploy`). Frontend deploy depends on the `/replay` routes existing. Deploy frontend with a commit message containing "frontend" or "ui" to trigger `deploy.yml`.

## Open questions for implementation

- Exact placement of `ReplayTabs` — new file vs. inline in `App.tsx`. Recommendation: new file (`src/Replay.tsx`) given App.tsx size.
- Whether to show v1 headers as "not recorded" or hide the headers row when empty. Recommendation: show with placeholder so the UI is stable across versions.
