# Agent-Friendly Private Logger — Design

**Status:** approved · **Date:** 2026-04-29 · **Author:** christian.yaranga.05@gmail.com (with Claude)

## Goal

Make `private-logger` first-class for AI agents to search, correlate, and triage real-device bugs. Add an MCP server, API tokens, mobile bug-report ingestion, cross-system trace correlation, an agent-oriented triage summary, and an OpenAPI manifest. Stay entirely on Cloudflare free tier.

## Non-goals

- Federating logs from `rebeca-backend` over the network (deferred to v2).
- Webhook / Slack push of triage summary (deferred — pull-only v1).
- Multi-tenant auth. Single-user installation.

## Decisions

| Topic | Choice | Why |
|---|---|---|
| MCP transport | HTTP-only, mounted at `/mcp/*` on existing Worker | One deploy, free, works for cloud and local agents |
| Bug report auth | Public POST, no rate limit | Single-user, parity with `POST /logs` |
| Screenshot storage | R2 (free 10GB) | Out-of-row, agents fetch via signed URL |
| Trace correlation | Local D1s only | Ships in v1; federation needs rebeca-backend changes |
| Triage delivery | Pull-only `GET /agent/triage-summary` | No webhook plumbing; cron can come later |
| API tokens | Random 32-byte, SHA-256 stored | Standard Stripe/GitHub PAT shape; revocable |

## Architecture

Single Cloudflare Worker (`private-logger-api`) gains:
- New REST endpoints under existing Hono router
- Hono sub-router at `/mcp` running MCP over Streamable HTTP transport
- R2 binding `SCREENSHOTS` → `private-logger-bug-screenshots`
- Two D1 tables in existing `private_logs_db`: `api_tokens`, `bug_reports`

```
mobile ─POST─▶ /logs                         (existing)
mobile ─POST─▶ /bugs                         (NEW, public)
mobile ─PUT──▶ /bugs/:id/screenshot          (NEW → R2)

agent ─MCP-HTTP─▶ /mcp/*                     (NEW, bearer)
agent ─REST─────▶ /agent/triage-summary      (NEW, bearer)
agent ─REST─────▶ /trace/:trace_id           (NEW, bearer)
agent ─REST─────▶ /openapi.json              (NEW, public)
agent ─REST─────▶ /auth/tokens               (NEW, bearer/cookie)

dashboard ─cookie─▶ existing routes + new Bugs tab + Tokens settings
```

## Migrations

### `0008_api_tokens.sql`
```sql
CREATE TABLE api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hash        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  name        TEXT NOT NULL,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME,
  last_used   DATETIME
);
CREATE INDEX idx_tokens_hash ON api_tokens(hash);
```

### `0009_bug_reports.sql`
```sql
CREATE TABLE bug_reports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT NOT NULL,
  session_id      TEXT,
  severity        TEXT CHECK(severity IN ('low','medium','high','critical')) DEFAULT 'medium',
  description     TEXT NOT NULL,
  device_model    TEXT,
  os_version      TEXT,
  app_version     TEXT,
  network_type    TEXT,
  breadcrumbs     TEXT,
  related_log_ids TEXT,
  screenshot_url  TEXT,
  status          TEXT CHECK(status IN ('new','triaged','in_progress','resolved','wontfix')) DEFAULT 'new',
  assigned_to     TEXT,
  note            TEXT,
  created_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at      DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_bugs_status ON bug_reports(status);
CREATE INDEX idx_bugs_user ON bug_reports(user_id);
CREATE INDEX idx_bugs_session ON bug_reports(session_id);
CREATE INDEX idx_bugs_created ON bug_reports(created_at DESC);
```

### `wrangler.toml`
```toml
[[r2_buckets]]
binding = "SCREENSHOTS"
bucket_name = "private-logger-bug-screenshots"
```

## REST endpoints

### Auth tokens
- `POST /auth/tokens` (auth) — `{name, expires_in_days?}` → `{id, plaintext, prefix}`. Plaintext returned **once**.
- `GET /auth/tokens` (auth) — list (no plaintext).
- `DELETE /auth/tokens/:id` (auth) — revoke.

`authMiddleware` is extended:
1. If `Authorization: Bearer pl_live_<32>` header present, SHA-256 it, look up `api_tokens.hash`. If found and not expired, set `c.set('user', ...)` with the owner user. Update `last_used` (fire-and-forget).
2. Otherwise fall back to existing session cookie path.

### Bug reports
- `POST /bugs` (public) — body documented below; server snapshots last 10 logs by `(user_id, session_id)` into `related_log_ids` automatically.
- `PUT /bugs/:id/screenshot` (public, content-type `image/*`, ≤ 2 MB) — uploads to `bugs/{id}/screenshot.png` in R2, sets `screenshot_url`.
- `GET /bugs?status=&user_id=&limit=&offset=` (auth) — paginated list. Each row includes a 24h-signed screenshot URL so the dashboard renders thumbs without further auth.
- `GET /bugs/:id` (auth) — full report + 24h-signed screenshot URL + related logs inline (joined from `logs` by id).
- `PATCH /bugs/:id` (auth) — `{status?, assigned_to?, note?}`. Updates `updated_at`.

`POST /bugs` body:
```json
{
  "user_id": "rebeca-user-123",
  "session_id": "...",            // optional
  "description": "Save trip never finishes",
  "severity": "medium",           // optional
  "device_model": "iPhone 15 Pro",
  "os_version": "iOS 17.5",
  "app_version": "2.0.23",
  "network_type": "wifi",
  "breadcrumbs": [ ... ]          // last N from logger
}
```

Response: `{ id, screenshot_upload_url }`. The screenshot URL is the same as the `PUT` route — kept explicit so the mobile client can branch on whether it has a screenshot.

`description` and every breadcrumb leaf string run through `redactPii()` on insert (same module used by `POST /logs`). Stored row carries no live secrets.

### Trace correlation
- `GET /trace/:trace_id` (auth) — `{ logs: Log[], behaviour_events: BehaviourEvent[] }`, both sorted by `created_at ASC`. Behaviour query reads `behaviour_analytics_db.behaviour_events`.

### Triage summary
- `GET /agent/triage-summary?since=ISO` (auth) — single response, no pagination. Default `since` = 24h ago.

```json
{
  "since": "2026-04-28T03:00:00Z",
  "open_error_groups": [ /* top 10 status='open' from /errors/groups */ ],
  "regressed_errors":   [ /* groups whose first_seen >= since */ ],
  "affected_users_24h": 12,
  "top_endpoints_by_error_rate": [ {"endpoint": "...", "rate": 0.18} ],
  "active_app_versions": [ {"app_version": "2.0.23", "errors": 3 } ],
  "untriaged_bug_reports": 4,
  "summary_for_humans": "Hello Christian — 3 new error groups today on app 2.0.23, mostly /trips/get returning 500 (8 users). 4 bug reports waiting triage."
}
```

The `summary_for_humans` line is built server-side from a deterministic template. No LLM call.

### OpenAPI
- `GET /openapi.json` (public) — handcrafted in `backend/src/openapi.ts`. No code-gen dep. Documents every endpoint above plus existing `/logs`, `/users`, `/sessions`, `/errors`, `/replays`.

## MCP server

Module `backend/src/mcp.ts` mounted via `app.route('/mcp', mcpRouter)`. Auth: `Authorization: Bearer pl_live_<32>` only — cookies disallowed (avoid CSRF on a tool surface).

Implementation strategy: try `@modelcontextprotocol/sdk` Streamable HTTP transport first. If it fails to bundle for Workers, hand-roll the JSON-RPC subset (~150 lines) covering `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`. Either way the public surface is the same.

### Tools

| Tool | Args | Calls |
|---|---|---|
| `search_logs` | `{level?, environment?, source?, user_id?, session_id?, fingerprint?, search?, start_date?, end_date?, limit?}` | `GET /logs` |
| `get_log` | `{id}` | `GET /logs/:id` |
| `get_user_profile` | `{user_id}` | `GET /users/:id/profile` |
| `get_session_timeline` | `{session_id}` | `GET /sessions/:id/timeline` |
| `get_error_groups` | `{status?, since?, environment?}` | `GET /errors/groups` |
| `update_error_group` | `{fingerprint, status?, assigned_to?, note?}` | `PATCH /errors/groups/:fp/state` |
| `find_by_trace` | `{trace_id}` | `GET /trace/:trace_id` |
| `list_bugs` | `{status?, user_id?, limit?}` | `GET /bugs` |
| `get_bug` | `{id}` | `GET /bugs/:id` |
| `triage_bug` | `{id, status?, assigned_to?, note?}` | `PATCH /bugs/:id` |
| `get_triage_summary` | `{since?}` | `GET /agent/triage-summary` |
| `tail_logs` | `{seconds: number ≤ 25}` | polls D1 in-process (same query the SSE handler uses) every 2s for N seconds, returns accumulated array. Avoids HTTP loopback. |

### Resources

Browseable via MCP `resources/list` + `resources/read`:
- `logger://users/{user_id}` → user profile JSON
- `logger://sessions/{session_id}` → session timeline JSON
- `logger://bugs/{id}` → bug report JSON
- `logger://errors/{fingerprint}` → error group JSON

## Frontend changes

### Bugs tab
New tab between Errors and Behaviour. Lucide icon `Bug`. Mobile + desktop. Columns: status badge, severity, user, device, app, last seen, screenshot thumb. Click → modal:
- Description (Markdown rendered)
- Screenshot (lightbox)
- Related logs inline (each expandable)
- Breadcrumbs vertical timeline
- Triage controls: status dropdown, assigned_to text input, note textarea
- "Open session timeline" button → reuses `SessionTimelineModal`
- "Find similar bugs" → applies `user_id` filter to bugs list

### API tokens settings
Modal opened from header user menu. List of tokens with prefix, name, last used, expires. "New token" form → name + expiry days → shows plaintext once with copy button. "Revoke" per row.

### Triage banner
Top of logs view: 1-line pill rendering `triage_summary.summary_for_humans` if `untriaged_bug_reports > 0` or `regressed_errors.length > 0`. Click → opens Errors tab pre-filtered to `status=open`.

### Deep links
`?bug_id=X` opens bug modal on load (mirrors existing `?session_id=` pattern).

### Type additions (`types.ts`)
`BugReport`, `BugStatus`, `BugSeverity`, `ApiToken`, `ApiTokenCreated`, `TraceResult`, `TriageSummary`.

## Mobile changes (worktree)

Worktree `feat/bug-reporting` in `rebeca-mobile-app`. Two units:

### `packages/api/src/services/logger.ts`
New method:
```ts
async reportBug(input: {
  description: string;
  severity?: BugSeverity;
  screenshotBase64?: string;
}): Promise<{ id: number }>
```
Posts to `${API_BASE}/bugs` with current `user_id`, `session_id`, last 50 breadcrumbs, device context. If `screenshotBase64` provided, decodes and PUTs to `/bugs/:id/screenshot`.

### `packages/ui` + `app/`
New `BugReportSheet` (BottomSheet matching existing `ModalCard` pattern). Description textarea (required), severity radio, "Attach screenshot" using `expo-screen-capture`. Submit calls `logger.reportBug`. Toast on success.

Floating "Report bug" button in dev/test environments only. Optional long-press on Settings app-version label opens it in prod for power users.

## Free-tier impact

| Resource | Free limit | Projected |
|---|---|---|
| Worker requests | 100k/day | 1–2k/day |
| D1 storage | 5 GB | 250 MB → +<10 MB |
| D1 reads | 5M/day | <50k/day |
| D1 writes | 100k/day | <100/day |
| R2 storage | 10 GB | <100 MB/year |
| R2 Class A ops | 1M/month | <1k/month |
| Cron triggers | unlimited | already 1, no new |

All within free tier indefinitely under expected usage. No paid features required.

## Testing

- `auth-tokens.test.ts` — create/hash/lookup/revoke; bearer auth path; expired tokens rejected.
- `bugs.test.ts` — create + breadcrumbs + related_log_ids snapshot; PUT screenshot to mocked R2; list with filters; PATCH state; size cap on screenshot.
- `trace.test.ts` — joins `logs` + `behaviour_events` by trace_id sorted by created_at.
- `triage.test.ts` — every field populated; regressed detection; `summary_for_humans` deterministic.
- `mcp.test.ts` — `tools/list` shape; `tools/call` for `search_logs` proxies correctly; auth required.

## Rollout

1. Apply migrations 0008 + 0009 to remote D1.
2. `wrangler r2 bucket create private-logger-bug-screenshots`.
3. Deploy backend.
4. Mint first API token via authenticated dashboard.
5. Add MCP entry to local `.mcp.json` and smoke-test from Claude Code.
6. Deploy frontend.
7. Open mobile worktree branch; ship in next mobile build (separate cycle).

Rollback: every change is additive. Redeploy previous Worker version; tables stay (harmless).

## Open questions deferred to v2

- Federation with rebeca-backend trace endpoint
- Slack/Discord push of triage summary on cron
- AI-narrated triage summary (replace deterministic template with Claude call)
- Screenshot annotation tool in Bugs modal
