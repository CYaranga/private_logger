# Agent-Friendly Logger Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship MCP server + API tokens + bug-report ingestion + trace correlation + triage summary + OpenAPI manifest on the existing private-logger Worker, free tier only.

**Architecture:** Single Cloudflare Worker (`private-logger-api`) gains new Hono routes, an MCP HTTP sub-router, an R2 binding for screenshots, and two new D1 tables (`api_tokens`, `bug_reports`). Frontend gets a Bugs tab, an API tokens settings modal, and a triage banner. Mobile worktree adds `logger.reportBug()` plus a UI sheet.

**Tech Stack:** Hono on Cloudflare Workers, D1 SQLite, R2 storage, `@modelcontextprotocol/sdk` (with hand-rolled JSON-RPC fallback if Workers bundling fails), React 18 + Vite + lucide-react, vitest with `@cloudflare/vitest-pool-workers`. Mobile: React Native + Expo + `@rebeca/api`.

**Spec:** `docs/superpowers/specs/2026-04-29-agent-friendly-logger-design.md`

---

## Task 1: Migration 0008 — api_tokens table

**Files:**
- Create: `backend/migrations/0008_api_tokens.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- API tokens for service accounts and agent (MCP) access. Token plaintext
-- has shape `pl_live_<32 base62 chars>`; only its SHA-256 hash is stored.
-- The first 12 plaintext chars are kept in `prefix` for display so users
-- can recognise which token is which without revealing it.

CREATE TABLE IF NOT EXISTS api_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  hash        TEXT NOT NULL UNIQUE,
  prefix      TEXT NOT NULL,
  name        TEXT NOT NULL,
  user_id     INTEGER NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at  DATETIME,
  last_used   DATETIME,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_tokens_hash ON api_tokens(hash);
CREATE INDEX IF NOT EXISTS idx_tokens_user ON api_tokens(user_id);
```

- [ ] **Step 2: Apply locally**

```bash
cd backend
bunx wrangler d1 execute private_logs_db --local --file=./migrations/0008_api_tokens.sql
```

Expected: `success`, 0 rows read, table created.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/0008_api_tokens.sql
git commit -m "feat(backend): add api_tokens migration (0008)"
```

---

## Task 2: Migration 0009 — bug_reports table

**Files:**
- Create: `backend/migrations/0009_bug_reports.sql`

- [ ] **Step 1: Write migration SQL**

```sql
-- Mobile bug reports. Single user installation so no rate limit / auth
-- on POST. Screenshot lives in R2 (binding SCREENSHOTS), not in this row.
-- related_log_ids is a JSON array of log ids around the report time so
-- agents can fetch context with one query.

CREATE TABLE IF NOT EXISTS bug_reports (
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

CREATE INDEX IF NOT EXISTS idx_bugs_status ON bug_reports(status);
CREATE INDEX IF NOT EXISTS idx_bugs_user ON bug_reports(user_id);
CREATE INDEX IF NOT EXISTS idx_bugs_session ON bug_reports(session_id);
CREATE INDEX IF NOT EXISTS idx_bugs_created ON bug_reports(created_at DESC);
```

- [ ] **Step 2: Apply locally**

```bash
cd backend
bunx wrangler d1 execute private_logs_db --local --file=./migrations/0009_bug_reports.sql
```

Expected: `success`, table created.

- [ ] **Step 3: Commit**

```bash
git add backend/migrations/0009_bug_reports.sql
git commit -m "feat(backend): add bug_reports migration (0009)"
```

---

## Task 3: Add R2 binding to wrangler.toml

**Files:**
- Modify: `backend/wrangler.toml`

- [ ] **Step 1: Add R2 binding**

Append to `backend/wrangler.toml`:

```toml

[[r2_buckets]]
binding = "SCREENSHOTS"
bucket_name = "private-logger-bug-screenshots"
```

- [ ] **Step 2: Update Bindings type**

Modify `backend/src/index.ts`, find `type Bindings = {` and add the R2 binding:

```ts
type Bindings = {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  SCREENSHOTS: R2Bucket;
};
```

- [ ] **Step 3: Typecheck**

```bash
cd backend
bunx tsc --noEmit
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add backend/wrangler.toml backend/src/index.ts
git commit -m "feat(backend): bind R2 SCREENSHOTS bucket"
```

---

## Task 4: Token helpers module

**Files:**
- Create: `backend/src/tokens.ts`
- Test: `backend/src/tokens.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { generateTokenPlaintext, hashToken, tokenPrefix } from './tokens';

describe('tokens', () => {
  it('generates pl_live_ prefixed plaintext of expected length', () => {
    const t = generateTokenPlaintext();
    expect(t.startsWith('pl_live_')).toBe(true);
    expect(t.length).toBe('pl_live_'.length + 32);
  });

  it('two generated tokens differ', () => {
    expect(generateTokenPlaintext()).not.toBe(generateTokenPlaintext());
  });

  it('hashes deterministically with SHA-256 hex', async () => {
    const t = 'pl_live_abcdefghij1234567890ABCDEFGHIJ12';
    const h1 = await hashToken(t);
    const h2 = await hashToken(t);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefix returns first 12 chars including pl_live_', () => {
    expect(tokenPrefix('pl_live_abcdefghij1234567890ABCDEFGHIJ12'))
      .toBe('pl_live_abcd');
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
cd backend
bunx vitest run src/tokens.test.ts
```

Expected: FAIL — `Cannot find module './tokens'`.

- [ ] **Step 3: Write minimal implementation**

Create `backend/src/tokens.ts`:

```ts
/**
 * API token helpers. Token plaintext shape: `pl_live_<32 base62 chars>`.
 * Only the SHA-256 hash is stored; plaintext is shown to the operator
 * exactly once at creation. `prefix` is the first 12 plaintext chars,
 * kept for human recognition (similar to GitHub's `ghp_xxxxxxxxxxxx`).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BODY_LEN = 32;

export function generateTokenPlaintext(): string {
  const buf = new Uint8Array(BODY_LEN);
  crypto.getRandomValues(buf);
  let body = '';
  for (let i = 0; i < BODY_LEN; i++) body += ALPHABET[buf[i] % ALPHABET.length];
  return `pl_live_${body}`;
}

export async function hashToken(plaintext: string): Promise<string> {
  const buf = new TextEncoder().encode(plaintext);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export function tokenPrefix(plaintext: string): string {
  return plaintext.slice(0, 12);
}
```

- [ ] **Step 4: Run test, verify it passes**

```bash
bunx vitest run src/tokens.test.ts
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/tokens.ts backend/src/tokens.test.ts
git commit -m "feat(backend): add api token helpers (generate/hash/prefix)"
```

---

## Task 5: Extend authMiddleware to accept Bearer tokens

**Files:**
- Modify: `backend/src/index.ts` (around `authMiddleware`, line ~505)

- [ ] **Step 1: Locate authMiddleware**

```bash
grep -n "const authMiddleware" backend/src/index.ts
```

Note the line. Read 25 lines around it.

- [ ] **Step 2: Replace authMiddleware body**

Replace the existing authMiddleware block with:

```ts
const authMiddleware = async (c: Context<{ Bindings: Bindings }>, next: Next) => {
  // 1) API token via Authorization: Bearer pl_live_<32>
  const authHeader = c.req.header('Authorization');
  if (authHeader?.startsWith('Bearer pl_live_')) {
    const plaintext = authHeader.slice('Bearer '.length).trim();
    const hash = await hashToken(plaintext);
    const tokenRow = await c.env.DB.prepare(
      `SELECT t.id AS token_id, t.expires_at, u.id, u.username, u.password_hash, u.created_at
       FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.hash = ? LIMIT 1`
    ).bind(hash).first<{
      token_id: number; expires_at: string | null;
      id: number; username: string; password_hash: string; created_at: string;
    }>();
    if (tokenRow) {
      if (tokenRow.expires_at && new Date(tokenRow.expires_at).getTime() < Date.now()) {
        return c.json({ error: 'Token expired' }, 401);
      }
      // Fire-and-forget last_used update
      c.env.DB.prepare('UPDATE api_tokens SET last_used = CURRENT_TIMESTAMP WHERE id = ?')
        .bind(tokenRow.token_id).run().catch(() => {});
      c.set('user' as never, {
        id: tokenRow.id,
        username: tokenRow.username,
        password_hash: tokenRow.password_hash,
        created_at: tokenRow.created_at,
      } as never);
      await next();
      return;
    }
    return c.json({ error: 'Invalid token' }, 401);
  }

  // 2) Session cookie or legacy Authorization: Bearer <session-id>
  const sessionToken = getCookie(c, 'session') || authHeader?.replace('Bearer ', '');
  if (!sessionToken) return c.json({ error: 'Authentication required' }, 401);
  const user = await validateSession(c.env.DB, sessionToken);
  if (!user) return c.json({ error: 'Invalid or expired session' }, 401);
  c.set('user' as never, user as never);
  await next();
};
```

Add the import at top of file alongside existing imports:

```ts
import { hashToken } from './tokens';
```

- [ ] **Step 3: Typecheck**

```bash
cd backend
bunx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): authMiddleware accepts pl_live_ bearer tokens"
```

---

## Task 6: API token REST endpoints

**Files:**
- Modify: `backend/src/index.ts` (insert after existing auth routes block)

- [ ] **Step 1: Insert endpoints**

After the `app.get('/auth/verify', ...)` handler, add:

```ts
// API token management. Plaintext is returned exactly once; only hash is stored.
app.post('/auth/tokens', authMiddleware, async (c) => {
  try {
    const body = await c.req.json<{ name: string; expires_in_days?: number }>();
    if (!body.name?.trim()) return c.json({ error: 'name is required' }, 400);
    const user = c.get('user' as never) as User;
    const plaintext = generateTokenPlaintext();
    const hash = await hashToken(plaintext);
    const prefix = tokenPrefix(plaintext);
    const expiresAt = body.expires_in_days
      ? new Date(Date.now() + body.expires_in_days * 86400_000).toISOString()
      : null;
    const result = await c.env.DB.prepare(
      `INSERT INTO api_tokens (hash, prefix, name, user_id, expires_at)
       VALUES (?, ?, ?, ?, ?) RETURNING id`
    ).bind(hash, prefix, body.name.trim(), user.id, expiresAt).first<{ id: number }>();
    return c.json({ id: result?.id, plaintext, prefix });
  } catch (error) {
    console.error('Error creating token:', error);
    return c.json({ error: 'Failed to create token' }, 500);
  }
});

app.get('/auth/tokens', authMiddleware, async (c) => {
  try {
    const user = c.get('user' as never) as User;
    const { results } = await c.env.DB.prepare(
      `SELECT id, prefix, name, created_at, expires_at, last_used
       FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC`
    ).bind(user.id).all();
    return c.json({ tokens: results || [] });
  } catch (error) {
    console.error('Error listing tokens:', error);
    return c.json({ error: 'Failed to list tokens' }, 500);
  }
});

app.delete('/auth/tokens/:id', authMiddleware, async (c) => {
  try {
    const user = c.get('user' as never) as User;
    const id = parseInt(c.req.param('id'), 10);
    const result = await c.env.DB.prepare(
      'DELETE FROM api_tokens WHERE id = ? AND user_id = ?'
    ).bind(id, user.id).run();
    return c.json({ success: true, deleted: result.meta.changes });
  } catch (error) {
    console.error('Error revoking token:', error);
    return c.json({ error: 'Failed to revoke token' }, 500);
  }
});
```

Add imports at top alongside existing `hashToken` import:

```ts
import { generateTokenPlaintext, hashToken, tokenPrefix } from './tokens';
```

(Replace the single-import line if it already exists.)

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Manual smoke test (after migration applied locally)**

```bash
cd backend
bunx wrangler dev &
DEV_PID=$!
sleep 4
# Login first to get session cookie (admin/<password>) — skip in CI
# Or insert a fake admin token directly via wrangler d1 execute --local
kill $DEV_PID
```

Skip if no local creds available. End-to-end test happens after deploy.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): POST/GET/DELETE /auth/tokens endpoints"
```

---

## Task 7: Bug report module + insert helper

**Files:**
- Create: `backend/src/bugs.ts`
- Test: `backend/src/bugs.test.ts`

- [ ] **Step 1: Write failing test**

Create `backend/src/bugs.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { snapshotRelatedLogIds } from './bugs';
import { env } from 'cloudflare:test';

describe('snapshotRelatedLogIds', () => {
  it('returns up to 10 most recent log ids for a (user_id, session_id) pair', async () => {
    // Seed 12 logs for a user/session pair
    const stmt = env.DB.prepare(
      `INSERT INTO logs (user_id, session_id, message, environment, level, category)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 12; i++) {
      await stmt.bind('u1', 's1', `m${i}`, 'dev', 'info', 'GENERAL').run();
    }
    const ids = await snapshotRelatedLogIds(env.DB, 'u1', 's1');
    expect(ids).toHaveLength(10);
    // newest-first ordering
    expect(ids[0]).toBeGreaterThan(ids[9]);
  });

  it('falls back to user-only when session_id is null', async () => {
    await env.DB.prepare(
      `INSERT INTO logs (user_id, session_id, message, environment, level, category)
       VALUES ('u2', NULL, 'mu', 'dev', 'info', 'GENERAL')`
    ).run();
    const ids = await snapshotRelatedLogIds(env.DB, 'u2', null);
    expect(ids.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

```bash
bunx vitest run src/bugs.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement bugs.ts**

Create `backend/src/bugs.ts`:

```ts
/**
 * Bug-report support helpers. The /bugs route handler in index.ts uses
 * these to (a) snapshot the last N log ids around the report so agents
 * can fetch context in one query, and (b) build the joined view that
 * GET /bugs/:id returns.
 */

const RELATED_LOGS_LIMIT = 10;

export async function snapshotRelatedLogIds(
  db: D1Database,
  userId: string,
  sessionId: string | null,
): Promise<number[]> {
  const sql = sessionId
    ? `SELECT id FROM logs WHERE user_id = ? AND session_id = ?
       ORDER BY created_at DESC LIMIT ?`
    : `SELECT id FROM logs WHERE user_id = ?
       ORDER BY created_at DESC LIMIT ?`;
  const stmt = sessionId
    ? db.prepare(sql).bind(userId, sessionId, RELATED_LOGS_LIMIT)
    : db.prepare(sql).bind(userId, RELATED_LOGS_LIMIT);
  const { results } = await stmt.all<{ id: number }>();
  return (results ?? []).map((r) => r.id);
}

export async function fetchLogsByIds(
  db: D1Database,
  ids: number[],
): Promise<Record<string, unknown>[]> {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const { results } = await db.prepare(
    `SELECT * FROM logs WHERE id IN (${placeholders}) ORDER BY created_at ASC`
  ).bind(...ids).all();
  return results ?? [];
}
```

- [ ] **Step 4: Run test, verify pass**

```bash
bunx vitest run src/bugs.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/bugs.ts backend/src/bugs.test.ts
git commit -m "feat(backend): bug snapshot helper"
```

---

## Task 8: Bug REST endpoints (POST + screenshot upload)

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add POST /bugs**

After the `/admin/reprocess` block, add:

```ts
// Bug reports — public POST (single-user installation), authenticated read.
// Description and breadcrumbs run through redactPii on insert.
app.post('/bugs', async (c) => {
  try {
    const body = await c.req.json<{
      user_id: string;
      session_id?: string;
      description: string;
      severity?: 'low' | 'medium' | 'high' | 'critical';
      device_model?: string;
      os_version?: string;
      app_version?: string;
      network_type?: string;
      breadcrumbs?: Array<Record<string, unknown>>;
    }>();
    if (!body.user_id || !body.description) {
      return c.json({ error: 'user_id and description are required' }, 400);
    }
    const cleanDescription = redactPii(body.description);
    const cleanBreadcrumbs = body.breadcrumbs
      ? JSON.stringify(redactValue(body.breadcrumbs))
      : null;
    const sessionId = body.session_id ?? null;
    const relatedIds = await snapshotRelatedLogIds(c.env.DB, body.user_id, sessionId);
    const result = await c.env.DB.prepare(
      `INSERT INTO bug_reports
         (user_id, session_id, severity, description, device_model, os_version,
          app_version, network_type, breadcrumbs, related_log_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    ).bind(
      body.user_id, sessionId, body.severity ?? 'medium', cleanDescription,
      body.device_model ?? null, body.os_version ?? null, body.app_version ?? null,
      body.network_type ?? null, cleanBreadcrumbs, JSON.stringify(relatedIds),
    ).first<{ id: number }>();
    const id = result?.id;
    return c.json({
      id,
      screenshot_upload_url: `/bugs/${id}/screenshot`,
    }, 201);
  } catch (error) {
    console.error('Error creating bug:', error);
    return c.json({ error: 'Failed to create bug' }, 500);
  }
});
```

Add the import for `snapshotRelatedLogIds` and `fetchLogsByIds`:

```ts
import { snapshotRelatedLogIds, fetchLogsByIds } from './bugs';
```

- [ ] **Step 2: Add PUT /bugs/:id/screenshot**

```ts
app.put('/bugs/:id/screenshot', async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    if (Number.isNaN(id)) return c.json({ error: 'invalid id' }, 400);
    const contentType = c.req.header('content-type') ?? 'image/png';
    const data = await c.req.arrayBuffer();
    if (data.byteLength === 0) return c.json({ error: 'empty body' }, 400);
    if (data.byteLength > 2 * 1024 * 1024) return c.json({ error: 'too large (max 2MB)' }, 413);
    const key = `bugs/${id}/screenshot.png`;
    await c.env.SCREENSHOTS.put(key, data, { httpMetadata: { contentType } });
    await c.env.DB.prepare('UPDATE bug_reports SET screenshot_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(key, id).run();
    return c.json({ success: true, key });
  } catch (error) {
    console.error('Error uploading screenshot:', error);
    return c.json({ error: 'Failed to upload screenshot' }, 500);
  }
});
```

- [ ] **Step 3: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): POST /bugs and PUT /bugs/:id/screenshot"
```

---

## Task 9: Bug REST endpoints (GET list, GET detail, PATCH, screenshot fetch)

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add screenshot read route + auth-protected listing**

```ts
// Authenticated read of stored screenshot. Worker-proxied so we don't
// expose the R2 bucket publicly.
app.get('/bugs/:id/screenshot', authMiddleware, async (c) => {
  const id = parseInt(c.req.param('id'), 10);
  const row = await c.env.DB.prepare('SELECT screenshot_url FROM bug_reports WHERE id = ?')
    .bind(id).first<{ screenshot_url: string | null }>();
  if (!row?.screenshot_url) return c.json({ error: 'no screenshot' }, 404);
  const obj = await c.env.SCREENSHOTS.get(row.screenshot_url);
  if (!obj) return c.json({ error: 'object missing' }, 404);
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set('cache-control', 'private, max-age=300');
  return new Response(obj.body, { headers });
});

app.get('/bugs', authMiddleware, async (c) => {
  try {
    const status = c.req.query('status');
    const userId = c.req.query('user_id');
    const limit = parseInt(c.req.query('limit') || '100', 10);
    const offset = parseInt(c.req.query('offset') || '0', 10);

    let where = 'WHERE 1=1';
    const params: (string | number)[] = [];
    if (status) { where += ' AND status = ?'; params.push(status); }
    if (userId) { where += ' AND user_id = ?'; params.push(userId); }
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM bug_reports ${where}
       ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    const bugs = (results ?? []).map((r) => ({
      ...r,
      breadcrumbs: r.breadcrumbs ? JSON.parse(r.breadcrumbs as string) : null,
      related_log_ids: r.related_log_ids ? JSON.parse(r.related_log_ids as string) : [],
      screenshot_url: r.screenshot_url ? `/bugs/${r.id}/screenshot` : null,
    }));
    return c.json({ bugs, limit, offset });
  } catch (error) {
    console.error('Error listing bugs:', error);
    return c.json({ error: 'Failed to list bugs' }, 500);
  }
});

app.get('/bugs/:id', authMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const row = await c.env.DB.prepare('SELECT * FROM bug_reports WHERE id = ?')
      .bind(id).first<Record<string, unknown>>();
    if (!row) return c.json({ error: 'not found' }, 404);
    const ids = row.related_log_ids ? JSON.parse(row.related_log_ids as string) : [];
    const relatedLogs = await fetchLogsByIds(c.env.DB, ids as number[]);
    return c.json({
      ...row,
      breadcrumbs: row.breadcrumbs ? JSON.parse(row.breadcrumbs as string) : null,
      related_log_ids: ids,
      related_logs: relatedLogs,
      screenshot_url: row.screenshot_url ? `/bugs/${id}/screenshot` : null,
    });
  } catch (error) {
    console.error('Error fetching bug:', error);
    return c.json({ error: 'Failed to fetch bug' }, 500);
  }
});

app.patch('/bugs/:id', authMiddleware, async (c) => {
  try {
    const id = parseInt(c.req.param('id'), 10);
    const body = await c.req.json<{
      status?: 'new' | 'triaged' | 'in_progress' | 'resolved' | 'wontfix';
      assigned_to?: string | null;
      note?: string | null;
    }>();
    await c.env.DB.prepare(
      `UPDATE bug_reports SET
         status = COALESCE(?, status),
         assigned_to = COALESCE(?, assigned_to),
         note = COALESCE(?, note),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).bind(body.status ?? null, body.assigned_to ?? null, body.note ?? null, id).run();
    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating bug:', error);
    return c.json({ error: 'Failed to update bug' }, 500);
  }
});
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```

Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): GET/PATCH /bugs endpoints + screenshot fetch"
```

---

## Task 10: Trace correlation endpoint

**Files:**
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Add /trace/:trace_id**

Insert near other agent-facing endpoints:

```ts
// Cross-system trace correlation. Joins logs + behaviour_events by trace_id.
app.get('/trace/:trace_id', authMiddleware, async (c) => {
  try {
    const traceId = c.req.param('trace_id');
    const [logsRes, eventsRes] = await Promise.all([
      c.env.DB.prepare('SELECT * FROM logs WHERE trace_id = ? ORDER BY created_at ASC')
        .bind(traceId).all(),
      c.env.ANALYTICS_DB.prepare(
        // behaviour_events has session_id but not trace_id (yet). For v1 we
        // fall back to joining via session_id present in the logs result.
        'SELECT * FROM behaviour_events WHERE session_id IN (SELECT DISTINCT session_id FROM (SELECT ? AS session_id))'
      ).bind('').all(),
    ]);
    return c.json({
      trace_id: traceId,
      logs: (logsRes.results ?? []).map(parseLogFields),
      behaviour_events: eventsRes.results ?? [],
    });
  } catch (error) {
    console.error('Error fetching trace:', error);
    return c.json({ error: 'Failed to fetch trace' }, 500);
  }
});
```

Note: behaviour_events doesn't store trace_id in the current schema. We resolve trace → logs → unique session_ids → behaviour events. Update query:

```ts
app.get('/trace/:trace_id', authMiddleware, async (c) => {
  try {
    const traceId = c.req.param('trace_id');
    const logsRes = await c.env.DB.prepare(
      'SELECT * FROM logs WHERE trace_id = ? ORDER BY created_at ASC'
    ).bind(traceId).all<Log>();
    const sessionIds = Array.from(new Set(
      (logsRes.results ?? []).map((l) => l.session_id).filter((s): s is string => !!s)
    ));
    let behaviourEvents: Record<string, unknown>[] = [];
    if (sessionIds.length > 0) {
      const placeholders = sessionIds.map(() => '?').join(',');
      const eventsRes = await c.env.ANALYTICS_DB.prepare(
        `SELECT * FROM behaviour_events WHERE session_id IN (${placeholders})
         ORDER BY created_at ASC`
      ).bind(...sessionIds).all();
      behaviourEvents = eventsRes.results ?? [];
    }
    return c.json({
      trace_id: traceId,
      logs: (logsRes.results ?? []).map(parseLogFields),
      behaviour_events: behaviourEvents,
    });
  } catch (error) {
    console.error('Error fetching trace:', error);
    return c.json({ error: 'Failed to fetch trace' }, 500);
  }
});
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add backend/src/index.ts
git commit -m "feat(backend): GET /trace/:trace_id correlates logs + behaviour_events"
```

---

## Task 11: Triage summary endpoint

**Files:**
- Create: `backend/src/triage.ts`
- Modify: `backend/src/index.ts`
- Test: `backend/src/triage.test.ts`

- [ ] **Step 1: Write failing test**

Create `backend/src/triage.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildHumanSummary } from './triage';

describe('buildHumanSummary', () => {
  it('mentions error groups, app versions, and bug count', () => {
    const summary = buildHumanSummary({
      open_groups: 3,
      affected_users: 12,
      regressed: 1,
      untriaged_bugs: 4,
      top_endpoint: '/trips/get',
      top_app_version: '2.0.23',
    });
    expect(summary).toContain('3');
    expect(summary).toContain('12');
    expect(summary).toContain('/trips/get');
    expect(summary).toContain('2.0.23');
    expect(summary).toContain('4');
  });

  it('handles zero state gracefully', () => {
    const summary = buildHumanSummary({
      open_groups: 0, affected_users: 0, regressed: 0,
      untriaged_bugs: 0, top_endpoint: null, top_app_version: null,
    });
    expect(summary.toLowerCase()).toContain('no');
  });
});
```

- [ ] **Step 2: Verify failure**

```bash
bunx vitest run src/triage.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement triage.ts**

Create `backend/src/triage.ts`:

```ts
/**
 * Triage summary helpers. Pure templating — no LLM calls — so the daily
 * digest stays free, deterministic, and testable.
 */

export interface SummaryInput {
  open_groups: number;
  affected_users: number;
  regressed: number;
  untriaged_bugs: number;
  top_endpoint: string | null;
  top_app_version: string | null;
}

export function buildHumanSummary(s: SummaryInput): string {
  if (s.open_groups === 0 && s.untriaged_bugs === 0 && s.regressed === 0) {
    return 'No open issues — everything looks calm right now.';
  }
  const parts: string[] = [];
  if (s.regressed > 0) {
    parts.push(`${s.regressed} new error group${s.regressed === 1 ? '' : 's'} since yesterday`);
  }
  if (s.open_groups > 0) {
    parts.push(`${s.open_groups} open error group${s.open_groups === 1 ? '' : 's'}`);
  }
  if (s.affected_users > 0) {
    parts.push(`${s.affected_users} user${s.affected_users === 1 ? '' : 's'} affected`);
  }
  if (s.top_endpoint) {
    parts.push(`top endpoint: ${s.top_endpoint}`);
  }
  if (s.top_app_version) {
    parts.push(`active build: ${s.top_app_version}`);
  }
  if (s.untriaged_bugs > 0) {
    parts.push(`${s.untriaged_bugs} bug report${s.untriaged_bugs === 1 ? '' : 's'} untriaged`);
  }
  return parts.join(' · ') + '.';
}
```

- [ ] **Step 4: Verify pass**

```bash
bunx vitest run src/triage.test.ts
```

Expected: PASS.

- [ ] **Step 5: Add /agent/triage-summary endpoint**

In `backend/src/index.ts`, after the `/errors/groups` block:

```ts
app.get('/agent/triage-summary', authMiddleware, async (c) => {
  try {
    const sinceParam = c.req.query('since');
    const since = sinceParam || new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    const exclude = `category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;

    const openGroups = await c.env.DB.prepare(
      `SELECT l.fingerprint, COUNT(*) AS occurrences,
              COUNT(DISTINCT l.user_id) AS affected_users,
              MAX(l.endpoint) AS endpoint, MAX(l.level) AS level,
              MAX(l.message) AS sample_message, MIN(l.created_at) AS first_seen,
              MAX(l.created_at) AS last_seen
       FROM logs l
       LEFT JOIN error_group_states s ON s.fingerprint = l.fingerprint
       WHERE l.level IN ('error','warn') AND l.fingerprint IS NOT NULL
         AND ${exclude} AND l.created_at >= ?
       GROUP BY l.fingerprint
       HAVING COALESCE(s.status, 'open') = 'open'
       ORDER BY occurrences DESC LIMIT 10`
    ).bind(since).all();

    const regressed = ((openGroups.results ?? []) as Array<{ first_seen: string }>)
      .filter((g) => g.first_seen >= since);

    const affectedUsersRow = await c.env.DB.prepare(
      `SELECT COUNT(DISTINCT user_id) AS n FROM logs
       WHERE level = 'error' AND ${exclude} AND created_at >= ?`
    ).bind(since).first<{ n: number }>();

    const topEndpointRow = await c.env.DB.prepare(
      `SELECT endpoint, COUNT(*) AS n FROM logs
       WHERE level = 'error' AND endpoint IS NOT NULL AND ${exclude} AND created_at >= ?
       GROUP BY endpoint ORDER BY n DESC LIMIT 1`
    ).bind(since).first<{ endpoint: string; n: number }>();

    const activeAppVersions = await c.env.DB.prepare(
      `SELECT app_version, COUNT(DISTINCT user_id) AS users,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS errors
       FROM logs WHERE app_version IS NOT NULL AND ${exclude} AND created_at >= ?
       GROUP BY app_version ORDER BY users DESC LIMIT 5`
    ).bind(since).all<{ app_version: string; users: number; errors: number }>();

    const topAppVersion = activeAppVersions.results?.[0]?.app_version ?? null;

    const untriagedRow = await c.env.DB.prepare(
      `SELECT COUNT(*) AS n FROM bug_reports WHERE status = 'new'`
    ).first<{ n: number }>();

    const summary = buildHumanSummary({
      open_groups: openGroups.results?.length ?? 0,
      affected_users: affectedUsersRow?.n ?? 0,
      regressed: regressed.length,
      untriaged_bugs: untriagedRow?.n ?? 0,
      top_endpoint: topEndpointRow?.endpoint ?? null,
      top_app_version: topAppVersion,
    });

    return c.json({
      since,
      open_error_groups: openGroups.results ?? [],
      regressed_errors: regressed,
      affected_users_24h: affectedUsersRow?.n ?? 0,
      top_endpoints_by_error_rate: topEndpointRow ? [{ endpoint: topEndpointRow.endpoint, count: topEndpointRow.n }] : [],
      active_app_versions: activeAppVersions.results ?? [],
      untriaged_bug_reports: untriagedRow?.n ?? 0,
      summary_for_humans: summary,
    });
  } catch (error) {
    console.error('Error building triage summary:', error);
    return c.json({ error: 'Failed to build summary' }, 500);
  }
});
```

Add import at top:

```ts
import { buildHumanSummary } from './triage';
```

- [ ] **Step 6: Typecheck**

```bash
bunx tsc --noEmit
```

- [ ] **Step 7: Commit**

```bash
git add backend/src/triage.ts backend/src/triage.test.ts backend/src/index.ts
git commit -m "feat(backend): GET /agent/triage-summary"
```

---

## Task 12: OpenAPI manifest endpoint

**Files:**
- Create: `backend/src/openapi.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Write openapi.ts**

```ts
/**
 * Handcrafted OpenAPI 3.1 spec. No code-gen dep. Documents the surface
 * agents can call. Update when a new endpoint ships.
 */

export const OPENAPI_SPEC = {
  openapi: '3.1.0',
  info: {
    title: 'private-logger API',
    version: '2.1.0',
    description: 'Logging + agent-facing triage and bug-report ingest. See /mcp for MCP-over-HTTP.',
  },
  servers: [
    { url: 'https://private-logger-api.christian-yaranga-05.workers.dev' },
  ],
  components: {
    securitySchemes: {
      bearerToken: { type: 'http', scheme: 'bearer', bearerFormat: 'pl_live_*' },
      sessionCookie: { type: 'apiKey', in: 'cookie', name: 'session' },
    },
  },
  paths: {
    '/logs': {
      get: { summary: 'Search logs', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
      post: { summary: 'Ingest log entry', security: [] },
    },
    '/logs/{id}': { get: { summary: 'Get log by id' } },
    '/logs/stream': { get: { summary: 'SSE live tail' } },
    '/users/{id}/profile': { get: { summary: 'Rich user profile' } },
    '/users/rich': { get: { summary: 'List rich user summaries' } },
    '/sessions/{id}/timeline': { get: { summary: 'Ordered events for a session' } },
    '/errors/groups': { get: { summary: 'Triage-ready error groups' } },
    '/errors/groups/{fingerprint}/state': {
      patch: { summary: 'Update error group state', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
    },
    '/bugs': {
      post: { summary: 'Create bug report (public)' },
      get: { summary: 'List bug reports', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
    },
    '/bugs/{id}': {
      get: { summary: 'Get bug report with related logs', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
      patch: { summary: 'Triage update', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
    },
    '/bugs/{id}/screenshot': {
      put: { summary: 'Upload screenshot (image/*, ≤2MB)' },
      get: { summary: 'Fetch screenshot bytes', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
    },
    '/trace/{trace_id}': { get: { summary: 'Cross-system trace', security: [{ bearerToken: [] }, { sessionCookie: [] }] } },
    '/agent/triage-summary': { get: { summary: 'One-call digest for agents', security: [{ bearerToken: [] }, { sessionCookie: [] }] } },
    '/auth/tokens': {
      post: { summary: 'Mint API token', security: [{ sessionCookie: [] }] },
      get: { summary: 'List tokens', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
    },
    '/auth/tokens/{id}': {
      delete: { summary: 'Revoke token', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
    },
    '/mcp': { post: { summary: 'MCP HTTP endpoint (JSON-RPC)', security: [{ bearerToken: [] }] } },
  },
} as const;
```

- [ ] **Step 2: Mount /openapi.json**

In `backend/src/index.ts` (after health check):

```ts
import { OPENAPI_SPEC } from './openapi';

app.get('/openapi.json', (c) => c.json(OPENAPI_SPEC));
```

- [ ] **Step 3: Typecheck**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/openapi.ts backend/src/index.ts
git commit -m "feat(backend): GET /openapi.json manifest"
```

---

## Task 13: MCP server module — tool surface

**Files:**
- Create: `backend/src/mcp.ts`
- Modify: `backend/src/index.ts`

- [ ] **Step 1: Implement MCP module (hand-rolled JSON-RPC)**

The MCP SDK doesn't currently bundle cleanly for Cloudflare Workers. We implement the minimal JSON-RPC surface ourselves (initialize, tools/list, tools/call, resources/list, resources/read). All tool handlers internally fetch the existing REST endpoints with the bearer token, so logic stays single-source.

Create `backend/src/mcp.ts`:

```ts
/**
 * Minimal MCP-over-HTTP transport (JSON-RPC 2.0). Tools internally call
 * existing REST handlers via app.fetch so we have one source of truth.
 *
 * Mounted as a Hono sub-router at /mcp. Auth: Bearer pl_live_<32> only —
 * cookies are intentionally rejected on this surface (cross-origin agent
 * calls should never carry user session cookies).
 */

import { Hono, type Context } from 'hono';

type RpcRequest = { jsonrpc: '2.0'; id: number | string | null; method: string; params?: Record<string, unknown> };
type RpcResponse = { jsonrpc: '2.0'; id: number | string | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  call(args: Record<string, unknown>, ctx: { fetch: (path: string, init?: RequestInit) => Promise<Response>; bearer: string }): Promise<unknown>;
}

const TOOLS: ToolDef[] = [
  {
    name: 'search_logs',
    description: 'Search logs with filters. Returns paginated entries.',
    inputSchema: { type: 'object', properties: { level: { type: 'string' }, environment: { type: 'string' }, source: { type: 'string' }, user_id: { type: 'string' }, session_id: { type: 'string' }, fingerprint: { type: 'string' }, search: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'integer' } } },
    async call(args, { fetch }) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) {
        if (v !== undefined && v !== null && v !== '') params.append(k, String(v));
      }
      const res = await fetch(`/logs?${params.toString()}`);
      return res.json();
    },
  },
  {
    name: 'get_log',
    description: 'Fetch a single log entry by id.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    async call(args, { fetch }) { return (await fetch(`/logs/${args.id}`)).json(); },
  },
  {
    name: 'get_user_profile',
    description: 'User profile aggregate (devices, sessions, top errors).',
    inputSchema: { type: 'object', required: ['user_id'], properties: { user_id: { type: 'string' } } },
    async call(args, { fetch }) { return (await fetch(`/users/${encodeURIComponent(String(args.user_id))}/profile`)).json(); },
  },
  {
    name: 'get_session_timeline',
    description: 'Ordered logs + breadcrumbs for one app session.',
    inputSchema: { type: 'object', required: ['session_id'], properties: { session_id: { type: 'string' } } },
    async call(args, { fetch }) { return (await fetch(`/sessions/${encodeURIComponent(String(args.session_id))}/timeline`)).json(); },
  },
  {
    name: 'get_error_groups',
    description: 'Grouped errors by fingerprint with triage state.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, since: { type: 'string' }, environment: { type: 'string' }, limit: { type: 'integer' } } },
    async call(args, { fetch }) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== '') params.append(k, String(v));
      return (await fetch(`/errors/groups?${params.toString()}`)).json();
    },
  },
  {
    name: 'update_error_group',
    description: 'Set status / assignment / note on an error group.',
    inputSchema: { type: 'object', required: ['fingerprint'], properties: { fingerprint: { type: 'string' }, status: { type: 'string' }, assigned_to: { type: 'string' }, note: { type: 'string' } } },
    async call(args, { fetch }) {
      const fp = String(args.fingerprint);
      const body: Record<string, unknown> = {};
      for (const k of ['status', 'assigned_to', 'note']) if (args[k] !== undefined) body[k] = args[k];
      return (await fetch(`/errors/groups/${encodeURIComponent(fp)}/state`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
    },
  },
  {
    name: 'find_by_trace',
    description: 'Logs + behaviour events sharing a trace_id.',
    inputSchema: { type: 'object', required: ['trace_id'], properties: { trace_id: { type: 'string' } } },
    async call(args, { fetch }) { return (await fetch(`/trace/${encodeURIComponent(String(args.trace_id))}`)).json(); },
  },
  {
    name: 'list_bugs',
    description: 'List bug reports.',
    inputSchema: { type: 'object', properties: { status: { type: 'string' }, user_id: { type: 'string' }, limit: { type: 'integer' } } },
    async call(args, { fetch }) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(args)) if (v !== undefined && v !== '') params.append(k, String(v));
      return (await fetch(`/bugs?${params.toString()}`)).json();
    },
  },
  {
    name: 'get_bug',
    description: 'Full bug report with related logs.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' } } },
    async call(args, { fetch }) { return (await fetch(`/bugs/${args.id}`)).json(); },
  },
  {
    name: 'triage_bug',
    description: 'Update bug status / assignment / note.',
    inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'integer' }, status: { type: 'string' }, assigned_to: { type: 'string' }, note: { type: 'string' } } },
    async call(args, { fetch }) {
      const id = args.id;
      const body: Record<string, unknown> = {};
      for (const k of ['status', 'assigned_to', 'note']) if (args[k] !== undefined) body[k] = args[k];
      return (await fetch(`/bugs/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })).json();
    },
  },
  {
    name: 'get_triage_summary',
    description: 'One-call digest of open issues, regressions, untriaged bugs.',
    inputSchema: { type: 'object', properties: { since: { type: 'string' } } },
    async call(args, { fetch }) {
      const params = new URLSearchParams();
      if (args.since) params.append('since', String(args.since));
      return (await fetch(`/agent/triage-summary?${params.toString()}`)).json();
    },
  },
  {
    name: 'tail_logs',
    description: 'Poll D1 for new logs every 2s for `seconds` (max 25). Returns accumulated rows.',
    inputSchema: { type: 'object', required: ['seconds'], properties: { seconds: { type: 'integer', maximum: 25, minimum: 2 } } },
    async call(args, { fetch }) {
      const seconds = Math.min(Math.max(Number(args.seconds), 2), 25);
      // Snapshot current MAX(id) via a cheap query, then poll.
      const head = await (await fetch('/logs?limit=1')).json() as { logs?: Array<{ id: number }> };
      let lastId = head.logs?.[0]?.id ?? 0;
      const collected: unknown[] = [];
      const start = Date.now();
      while (Date.now() - start < seconds * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        const res = await (await fetch(`/logs?limit=100`)).json() as { logs?: Array<{ id: number }> };
        const fresh = (res.logs ?? []).filter((l) => l.id > lastId);
        for (const r of fresh) lastId = Math.max(lastId, r.id);
        collected.push(...fresh.reverse());
      }
      return { logs: collected };
    },
  },
];

interface ResourceDef {
  uriPattern: RegExp;
  template: string;
  fetch(uri: string, ctx: { fetch: (path: string) => Promise<Response> }): Promise<unknown>;
}

const RESOURCES: ResourceDef[] = [
  {
    uriPattern: /^logger:\/\/users\/(.+)$/,
    template: 'logger://users/{user_id}',
    async fetch(uri, { fetch }) {
      const m = uri.match(/^logger:\/\/users\/(.+)$/);
      return (await fetch(`/users/${encodeURIComponent(m![1])}/profile`)).json();
    },
  },
  {
    uriPattern: /^logger:\/\/sessions\/(.+)$/,
    template: 'logger://sessions/{session_id}',
    async fetch(uri, { fetch }) {
      const m = uri.match(/^logger:\/\/sessions\/(.+)$/);
      return (await fetch(`/sessions/${encodeURIComponent(m![1])}/timeline`)).json();
    },
  },
  {
    uriPattern: /^logger:\/\/bugs\/(\d+)$/,
    template: 'logger://bugs/{id}',
    async fetch(uri, { fetch }) {
      const m = uri.match(/^logger:\/\/bugs\/(\d+)$/);
      return (await fetch(`/bugs/${m![1]}`)).json();
    },
  },
];

export function createMcpRouter(parent: Hono): Hono {
  const mcp = new Hono();

  mcp.post('/', async (c: Context) => {
    const auth = c.req.header('Authorization');
    if (!auth?.startsWith('Bearer pl_live_')) {
      return c.json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Unauthorized' } }, 401);
    }
    const bearer = auth.slice('Bearer '.length).trim();

    const body = await c.req.json<RpcRequest | RpcRequest[]>();
    const requests = Array.isArray(body) ? body : [body];

    const innerFetch = async (path: string, init?: RequestInit): Promise<Response> => {
      const url = new URL(path, 'http://internal');
      const req = new Request(url, {
        ...init,
        headers: { ...(init?.headers as Record<string, string> | undefined), Authorization: `Bearer ${bearer}` },
      });
      return parent.fetch(req, c.env, c.executionCtx);
    };

    const responses: RpcResponse[] = [];
    for (const rpc of requests) {
      responses.push(await dispatch(rpc, innerFetch, bearer));
    }
    return c.json(Array.isArray(body) ? responses : responses[0]);
  });

  return mcp;
}

async function dispatch(
  rpc: RpcRequest,
  innerFetch: (path: string, init?: RequestInit) => Promise<Response>,
  bearer: string,
): Promise<RpcResponse> {
  const id = rpc.id ?? null;
  try {
    switch (rpc.method) {
      case 'initialize':
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {}, resources: {} },
            serverInfo: { name: 'private-logger', version: '1.0.0' },
          },
        };
      case 'tools/list':
        return {
          jsonrpc: '2.0', id,
          result: { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) },
        };
      case 'tools/call': {
        const params = rpc.params as { name: string; arguments?: Record<string, unknown> } | undefined;
        const tool = TOOLS.find((t) => t.name === params?.name);
        if (!tool) throw new Error(`Unknown tool: ${params?.name}`);
        const out = await tool.call(params?.arguments ?? {}, { fetch: innerFetch, bearer });
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text: JSON.stringify(out) }] },
        };
      }
      case 'resources/list':
        return {
          jsonrpc: '2.0', id,
          result: { resources: RESOURCES.map((r) => ({ uri: r.template, name: r.template, mimeType: 'application/json' })) },
        };
      case 'resources/read': {
        const params = rpc.params as { uri: string } | undefined;
        const uri = params?.uri ?? '';
        const handler = RESOURCES.find((r) => r.uriPattern.test(uri));
        if (!handler) throw new Error(`Unknown resource: ${uri}`);
        const out = await handler.fetch(uri, { fetch: innerFetch });
        return {
          jsonrpc: '2.0', id,
          result: { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(out) }] },
        };
      }
      default:
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${rpc.method}` } };
    }
  } catch (err) {
    return {
      jsonrpc: '2.0', id,
      error: { code: -32603, message: err instanceof Error ? err.message : 'Internal error' },
    };
  }
}
```

- [ ] **Step 2: Mount /mcp on main app**

In `backend/src/index.ts`, after the main `app` is created and existing CORS middleware is attached, add:

```ts
import { createMcpRouter } from './mcp';

app.route('/mcp', createMcpRouter(app));
```

- [ ] **Step 3: Typecheck**

```bash
bunx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/mcp.ts backend/src/index.ts
git commit -m "feat(backend): MCP HTTP server with 12 tools + 3 resources"
```

---

## Task 14: MCP minimal smoke test

**Files:**
- Create: `backend/src/mcp.test.ts`

- [ ] **Step 1: Write tools/list test**

```ts
import { describe, it, expect } from 'vitest';
import { createMcpRouter } from './mcp';
import { Hono } from 'hono';

describe('mcp', () => {
  it('rejects requests without bearer pl_live_', async () => {
    const parent = new Hono();
    parent.route('/mcp', createMcpRouter(parent));
    const res = await parent.request('/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(401);
  });

  it('returns tool list with bearer', async () => {
    const parent = new Hono();
    parent.route('/mcp', createMcpRouter(parent));
    const res = await parent.request('/mcp', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer pl_live_unused_for_unit',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { tools: Array<{ name: string }> } };
    expect(body.result?.tools).toBeTruthy();
    expect(body.result?.tools.find((t) => t.name === 'search_logs')).toBeTruthy();
    expect(body.result?.tools).toHaveLength(12);
  });
});
```

- [ ] **Step 2: Run**

```bash
bunx vitest run src/mcp.test.ts
```

Expected: PASS, 2 tests.

- [ ] **Step 3: Commit**

```bash
git add backend/src/mcp.test.ts
git commit -m "test(backend): mcp tools/list + auth"
```

---

## Task 15: Frontend types + api client additions

**Files:**
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api.ts`

- [ ] **Step 1: Add types**

Append to `frontend/src/types.ts`:

```ts
export type BugStatus = 'new' | 'triaged' | 'in_progress' | 'resolved' | 'wontfix';
export type BugSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface BugReport {
  id: number;
  user_id: string;
  session_id: string | null;
  severity: BugSeverity;
  description: string;
  device_model: string | null;
  os_version: string | null;
  app_version: string | null;
  network_type: string | null;
  breadcrumbs: Breadcrumb[] | null;
  related_log_ids: number[];
  related_logs?: Log[];
  screenshot_url: string | null;
  status: BugStatus;
  assigned_to: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface ApiToken {
  id: number;
  prefix: string;
  name: string;
  created_at: string;
  expires_at: string | null;
  last_used: string | null;
}

export interface ApiTokenCreated extends ApiToken {
  plaintext: string;
}

export interface TriageSummary {
  since: string;
  open_error_groups: ErrorGroup[];
  regressed_errors: ErrorGroup[];
  affected_users_24h: number;
  top_endpoints_by_error_rate: Array<{ endpoint: string; count: number }>;
  active_app_versions: Array<{ app_version: string; users: number; errors: number }>;
  untriaged_bug_reports: number;
  summary_for_humans: string;
}

export interface TraceResult {
  trace_id: string;
  logs: Log[];
  behaviour_events: Array<Record<string, unknown>>;
}
```

- [ ] **Step 2: Add api functions**

Append to `frontend/src/api.ts`:

```ts
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
```

- [ ] **Step 3: Typecheck**

```bash
cd frontend
bunx tsc -b --noEmit
```

Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types.ts frontend/src/api.ts
git commit -m "feat(frontend): types + api client for bugs/tokens/triage/trace"
```

---

## Task 16: Frontend Bugs tab component

**Files:**
- Create: `frontend/src/BugsTab.tsx`

- [ ] **Step 1: Implement BugsTab**

```tsx
import { useEffect, useState, useCallback } from 'react';
import type { BugReport, BugStatus } from './types';
import { fetchBugs } from './api';
import { Bug, Inbox } from 'lucide-react';

const STATUSES: Array<BugStatus | 'all'> = ['new', 'triaged', 'in_progress', 'resolved', 'wontfix', 'all'];

function relativeTime(iso: string): string {
  const d = Date.now() - new Date(iso).getTime();
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function BugsTab({ onSelectBug }: { onSelectBug: (id: number) => void }) {
  const [bugs, setBugs] = useState<BugReport[]>([]);
  const [statusFilter, setStatusFilter] = useState<BugStatus | 'all'>('new');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchBugs({ status: statusFilter === 'all' ? undefined : statusFilter, limit: 100 });
      setBugs(res.bugs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch bugs');
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="bugs-tab">
      <div className="filters" style={{ marginBottom: 12 }}>
        <div className="filter-group">
          <label>Status</label>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as BugStatus | 'all')}>
            {STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
          </select>
        </div>
        <div className="filter-group" style={{ alignSelf: 'flex-end' }}>
          <button className="btn btn-secondary" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="logs-table logs-table-wide">
        <table className="resizable-table">
          <thead>
            <tr>
              <th style={{ width: 90 }}>Severity</th>
              <th>Description</th>
              <th>User</th>
              <th>Device</th>
              <th>App</th>
              <th>Reported</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {loading && bugs.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 24, textAlign: 'center' }}>Loading…</td></tr>
            ) : bugs.length === 0 ? (
              <tr><td colSpan={8} style={{ padding: 32, textAlign: 'center', color: 'var(--text-secondary)' }}>
                <Inbox size={28} strokeWidth={1.4} style={{ display: 'block', margin: '0 auto 8px', opacity: 0.6 }} />
                No bug reports in this view.
              </td></tr>
            ) : bugs.map((b) => (
              <tr key={b.id} className="log-row" onClick={() => onSelectBug(b.id)} style={{ cursor: 'pointer' }}>
                <td>
                  <span className={`level-badge level-${b.severity === 'critical' || b.severity === 'high' ? 'error' : b.severity === 'medium' ? 'warn' : 'info'}`}>
                    {b.severity}
                  </span>
                </td>
                <td style={{ maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={b.description}>
                  <Bug size={11} strokeWidth={1.8} style={{ marginRight: 6, color: 'var(--text-tertiary)' }} />
                  {b.description}
                </td>
                <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{b.user_id}</td>
                <td>{b.device_model ?? '—'}</td>
                <td>{b.app_version ?? '—'}</td>
                <td title={b.created_at}>{relativeTime(b.created_at)}</td>
                <td>
                  <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)' }}>{b.status}</span>
                </td>
                <td><button className="btn btn-secondary" style={{ padding: '4px 10px', fontSize: 11 }}>Open</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/BugsTab.tsx
git commit -m "feat(frontend): BugsTab component"
```

---

## Task 17: Frontend BugDetailModal

**Files:**
- Create: `frontend/src/BugDetailModal.tsx`

- [ ] **Step 1: Implement modal**

```tsx
import { useEffect, useState } from 'react';
import type { BugReport, BugStatus } from './types';
import { fetchBug, triageBug, getBugScreenshotUrl } from './api';
import { Bug, ImageIcon } from 'lucide-react';

const STATUSES: BugStatus[] = ['new', 'triaged', 'in_progress', 'resolved', 'wontfix'];

interface Props {
  bugId: number;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
}

function fmt(iso: string | null): string { return iso ? new Date(iso).toLocaleString() : '—'; }

export function BugDetailModal({ bugId, onClose, onOpenSession }: Props) {
  const [bug, setBug] = useState<BugReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showImage, setShowImage] = useState(false);

  useEffect(() => {
    setLoading(true);
    fetchBug(bugId).then(setBug).catch((e) => setError(e instanceof Error ? e.message : 'Failed')).finally(() => setLoading(false));
  }, [bugId]);

  const update = async (patch: { status?: BugStatus; assigned_to?: string | null; note?: string | null }) => {
    if (!bug) return;
    try {
      await triageBug(bug.id, patch);
      setBug({ ...bug, ...patch, updated_at: new Date().toISOString() } as BugReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 920, width: '92%', maxHeight: '88vh', overflowY: 'auto' }}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Bug size={18} strokeWidth={1.8} style={{ color: 'var(--accent)' }} />
            Bug #{bugId}
          </h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        {loading ? (
          <p style={{ padding: 24 }}>Loading…</p>
        ) : error ? (
          <div className="error-banner">{error}</div>
        ) : bug ? (
          <div style={{ padding: 16, display: 'grid', gap: 18 }}>
            <section>
              <div className="kicker">Description</div>
              <p style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>{bug.description}</p>
            </section>

            <section>
              <div className="summary-grid">
                <div className="summary-cell"><div className="summary-label">User</div><div style={{ fontFamily: 'var(--font-mono)' }}>{bug.user_id}</div></div>
                <div className="summary-cell"><div className="summary-label">Severity</div><div>{bug.severity}</div></div>
                <div className="summary-cell"><div className="summary-label">Reported</div><div>{fmt(bug.created_at)}</div></div>
                <div className="summary-cell"><div className="summary-label">Updated</div><div>{fmt(bug.updated_at)}</div></div>
                <div className="summary-cell"><div className="summary-label">Device</div><div>{bug.device_model ?? '—'}</div></div>
                <div className="summary-cell"><div className="summary-label">OS</div><div>{bug.os_version ?? '—'}</div></div>
                <div className="summary-cell"><div className="summary-label">App</div><div>{bug.app_version ?? '—'}</div></div>
                <div className="summary-cell"><div className="summary-label">Network</div><div>{bug.network_type ?? '—'}</div></div>
              </div>
            </section>

            {bug.screenshot_url && (
              <section>
                <div className="kicker" style={{ marginBottom: 6 }}>
                  <ImageIcon size={11} strokeWidth={1.6} style={{ marginRight: 4 }} /> Screenshot
                </div>
                {showImage ? (
                  <img src={getBugScreenshotUrl(bug.id)} alt="screenshot" style={{ maxWidth: '100%', borderRadius: 6 }} />
                ) : (
                  <button className="btn btn-secondary" onClick={() => setShowImage(true)}>Load screenshot</button>
                )}
              </section>
            )}

            <section>
              <div className="kicker" style={{ marginBottom: 6 }}>Triage</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                <select value={bug.status} onChange={(e) => update({ status: e.target.value as BugStatus })}>
                  {STATUSES.map((s) => (<option key={s} value={s}>{s}</option>))}
                </select>
                <input
                  placeholder="assigned_to"
                  defaultValue={bug.assigned_to ?? ''}
                  onBlur={(e) => update({ assigned_to: e.target.value || null })}
                  style={{ padding: '6px 10px' }}
                />
                <input
                  placeholder="note"
                  defaultValue={bug.note ?? ''}
                  onBlur={(e) => update({ note: e.target.value || null })}
                  style={{ flex: 1, padding: '6px 10px' }}
                />
              </div>
            </section>

            {bug.session_id && (
              <section>
                <button className="btn btn-secondary" onClick={() => onOpenSession(bug.session_id!)}>
                  Open session timeline
                </button>
              </section>
            )}

            {bug.related_logs && bug.related_logs.length > 0 && (
              <section>
                <div className="kicker" style={{ marginBottom: 6 }}>Related logs ({bug.related_logs.length})</div>
                <ul style={{ listStyle: 'none', padding: 0, margin: 0, fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                  {bug.related_logs.map((l) => (
                    <li key={l.id} style={{ padding: '4px 0', borderBottom: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text-tertiary)' }}>#{l.id}</span> · <span className={`level-badge level-${l.level}`}>{l.level}</span> · {l.message}
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/BugDetailModal.tsx
git commit -m "feat(frontend): BugDetailModal"
```

---

## Task 18: Frontend ApiTokensModal

**Files:**
- Create: `frontend/src/ApiTokensModal.tsx`

- [ ] **Step 1: Implement modal**

```tsx
import { useEffect, useState } from 'react';
import type { ApiToken, ApiTokenCreated } from './types';
import { listApiTokens, createApiToken, revokeApiToken } from './api';
import { Key, Copy, Check, Trash2 } from 'lucide-react';

export function ApiTokensModal({ onClose }: { onClose: () => void }) {
  const [tokens, setTokens] = useState<ApiToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [expiresDays, setExpiresDays] = useState<string>('');
  const [created, setCreated] = useState<ApiTokenCreated | null>(null);
  const [copied, setCopied] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await listApiTokens();
      setTokens(res.tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    try {
      const t = await createApiToken(name.trim(), expiresDays ? Number(expiresDays) : undefined);
      setCreated(t);
      setName('');
      setExpiresDays('');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed');
    }
  };

  const handleRevoke = async (id: number) => {
    if (!confirm('Revoke this token?')) return;
    await revokeApiToken(id);
    load();
  };

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.plaintext);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720, width: '92%' }}>
        <div className="modal-header">
          <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Key size={18} strokeWidth={1.8} /> API tokens
          </h2>
          <button className="modal-close" onClick={onClose}>×</button>
        </div>

        <div style={{ padding: 16, display: 'grid', gap: 16 }}>
          {error && <div className="error-banner">{error}</div>}

          {created && (
            <div style={{ padding: 12, background: 'var(--success-muted)', border: '1px solid rgba(134,215,161,0.3)', borderRadius: 6 }}>
              <div className="kicker" style={{ marginBottom: 6 }}>Token created — copy now, never shown again</div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code style={{ flex: 1, padding: '8px 10px', background: 'var(--bg-2)', borderRadius: 4, fontFamily: 'var(--font-mono)', fontSize: 12, overflowX: 'auto' }}>
                  {created.plaintext}
                </code>
                <button className="btn btn-secondary" onClick={copy}>
                  {copied ? <Check size={12} /> : <Copy size={12} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </div>
          )}

          <section style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <div className="filter-group" style={{ flex: 1 }}>
              <label>Name</label>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Claude Code MCP" />
            </div>
            <div className="filter-group">
              <label>Expires (days)</label>
              <input type="number" value={expiresDays} onChange={(e) => setExpiresDays(e.target.value)} placeholder="∞" style={{ width: 100 }} />
            </div>
            <button className="btn btn-primary" onClick={handleCreate} disabled={!name.trim()}>Create</button>
          </section>

          <table className="resizable-table" style={{ width: '100%' }}>
            <thead><tr><th>Name</th><th>Prefix</th><th>Created</th><th>Last used</th><th>Expires</th><th /></tr></thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center' }}>Loading…</td></tr>
              ) : tokens.length === 0 ? (
                <tr><td colSpan={6} style={{ padding: 16, textAlign: 'center', color: 'var(--text-secondary)' }}>No tokens yet.</td></tr>
              ) : tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.prefix}…</td>
                  <td>{new Date(t.created_at).toLocaleDateString()}</td>
                  <td>{t.last_used ? new Date(t.last_used).toLocaleString() : '—'}</td>
                  <td>{t.expires_at ? new Date(t.expires_at).toLocaleDateString() : 'never'}</td>
                  <td>
                    <button className="btn btn-danger" style={{ padding: '4px 8px', fontSize: 11 }} onClick={() => handleRevoke(t.id)}>
                      <Trash2 size={11} strokeWidth={1.8} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

```bash
bunx tsc -b --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/ApiTokensModal.tsx
git commit -m "feat(frontend): ApiTokensModal"
```

---

## Task 19: Frontend wiring (tabs, modals, banner, deep link)

**Files:**
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: Add Bugs tab to tab type**

Find:
```ts
const [activeTab, setActiveTab] = useState<'logs' | 'users' | 'errors' | 'behaviour' | 'archives' | 'analytics'>('logs');
```

Replace with:
```ts
const [activeTab, setActiveTab] = useState<'logs' | 'users' | 'errors' | 'behaviour' | 'bugs' | 'archives' | 'analytics'>('logs');
const [openBugId, setOpenBugId] = useState<number | null>(null);
const [showTokens, setShowTokens] = useState(false);
const [triage, setTriage] = useState<TriageSummary | null>(null);
```

- [ ] **Step 2: Add imports**

Add to existing lucide-react import: `Bug, Key`. Add new lines:

```ts
import { BugsTab } from './BugsTab';
import { BugDetailModal } from './BugDetailModal';
import { ApiTokensModal } from './ApiTokensModal';
import type { TriageSummary } from './types';
import { fetchTriageSummary } from './api';
```

- [ ] **Step 3: Fetch triage summary on mount**

Add useEffect after existing data-loading effects:

```ts
useEffect(() => {
  fetchTriageSummary().then(setTriage).catch(() => {});
}, []);
```

- [ ] **Step 4: Deep link**

Add useEffect right after the activeTab state declaration:

```ts
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const bugId = params.get('bug_id');
  if (bugId) {
    setOpenBugId(parseInt(bugId, 10));
    setActiveTab('bugs');
  }
}, []);
```

- [ ] **Step 5: Insert tab buttons (desktop + mobile)**

Find both tab strips. After the `errors` tab button, add:

Desktop (size 14):
```tsx
<button className={`tab ${activeTab === 'bugs' ? 'active' : ''}`} onClick={() => setActiveTab('bugs')}>
  <Bug size={14} strokeWidth={1.6} /> bugs
</button>
```

Mobile (size 13): same with `size={13}`.

- [ ] **Step 6: Insert render branches**

Both desktop and mobile render-branch chains: after `activeTab === 'behaviour' ? <BehaviourTab />`, add:

```tsx
) : activeTab === 'bugs' ? (
  <BugsTab onSelectBug={setOpenBugId} />
```

- [ ] **Step 7: Insert modals**

Near the existing `{openUserId && (...)}` block, add:

```tsx
{openBugId && (
  <BugDetailModal
    bugId={openBugId}
    onClose={() => setOpenBugId(null)}
    onOpenSession={(sid) => { setOpenBugId(null); setOpenSessionId(sid); }}
  />
)}
{showTokens && <ApiTokensModal onClose={() => setShowTokens(false)} />}
```

- [ ] **Step 8: Add Tokens menu item to user-menu**

Find the user-menu block in desktop layout (`<div className="user-menu">`). Add a button before logout:

```tsx
<button className="btn btn-secondary" style={{ padding: '5px 10px', fontSize: '12px', display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={() => setShowTokens(true)}>
  <Key size={12} strokeWidth={1.8} /> tokens
</button>
```

- [ ] **Step 9: Add triage banner**

Above the logs tab content (right before `<div className="filters-container">`), add:

```tsx
{triage && (triage.untriaged_bug_reports > 0 || triage.regressed_errors.length > 0) && (
  <div
    onClick={() => setActiveTab('errors')}
    style={{
      padding: '8px 12px', marginBottom: 12, borderRadius: 6,
      background: 'var(--accent-muted)', border: '1px solid rgba(122,215,232,0.3)',
      fontFamily: 'var(--font-mono)', fontSize: 12, cursor: 'pointer',
    }}
    title="Click to open Errors tab"
  >
    <span className="dot-led" /> {triage.summary_for_humans}
  </div>
)}
```

- [ ] **Step 10: Typecheck**

```bash
bunx tsc -b --noEmit
```

- [ ] **Step 11: Commit**

```bash
git add frontend/src/App.tsx
git commit -m "feat(frontend): wire Bugs tab, tokens modal, triage banner, deep link"
```

---

## Task 20: Mobile worktree — logger.reportBug

**Files:**
- Create worktree first
- Modify: `rebeca-mobile-app/.worktrees/bug-reporting/packages/api/src/services/logger.ts`
- Modify: `rebeca-mobile-app/.worktrees/bug-reporting/packages/api/src/index.ts`

- [ ] **Step 1: Create worktree**

```bash
cd /Users/chrisyaranga/Documents/EulerInnovations/rebeca-mobile-app
git worktree add .worktrees/bug-reporting -b feat/bug-reporting origin/develop
```

- [ ] **Step 2: Add reportBug method**

In `packages/api/src/services/logger.ts`, add inside `LoggerService` class near `reportBug` location (e.g. after `userAction`):

```ts
async reportBug(input: {
  description: string;
  severity?: 'low' | 'medium' | 'high' | 'critical';
  screenshotBase64?: string;
}): Promise<{ id: number }> {
  const body = {
    user_id: this.userId,
    session_id: this.sessionId,
    description: input.description,
    severity: input.severity ?? 'medium',
    device_model: this.deviceContext.device_model,
    os_version: this.deviceContext.os_version,
    app_version: APP_VERSION,
    network_type: this.deviceContext.network_type,
    breadcrumbs: this.getBreadcrumbs(),
  };
  const res = await fetch(`${API_BASE}/bugs`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Bug report failed: ${res.status}`);
  const json = await res.json() as { id: number };

  if (input.screenshotBase64) {
    const bytes = decodeBase64(input.screenshotBase64);
    await fetch(`${API_BASE}/bugs/${json.id}/screenshot`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: bytes,
    });
  }

  return json;
}
```

Add helper at module bottom (above singleton export):

```ts
function decodeBase64(b64: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
```

- [ ] **Step 3: Re-export not needed (logger singleton already exported)**

- [ ] **Step 4: Commit**

```bash
cd /Users/chrisyaranga/Documents/EulerInnovations/rebeca-mobile-app/.worktrees/bug-reporting
git add packages/api/src/services/logger.ts
git commit -m "feat(api/logger): reportBug method"
```

---

## Task 21: Apply migrations + create R2 bucket + deploy

**Files:** none

- [ ] **Step 1: Apply migrations to remote**

```bash
cd backend
bunx wrangler d1 execute private_logs_db --remote --yes --file=./migrations/0008_api_tokens.sql
bunx wrangler d1 execute private_logs_db --remote --yes --file=./migrations/0009_bug_reports.sql
```

Both should report `success`.

- [ ] **Step 2: Create R2 bucket**

```bash
bunx wrangler r2 bucket create private-logger-bug-screenshots
```

Expected: `Created bucket private-logger-bug-screenshots`.

- [ ] **Step 3: Deploy backend**

```bash
bun run deploy
```

Expected: `Deployed private-logger-api`. Note new Version ID.

- [ ] **Step 4: Deploy frontend**

```bash
cd ../frontend
bun run deploy
```

Expected: `Deployed private-logger-frontend`.

- [ ] **Step 5: Smoke test endpoints**

```bash
# OpenAPI
curl -s https://private-logger-api.christian-yaranga-05.workers.dev/openapi.json | head -20

# Triage summary requires auth — login first via the dashboard, then mint a token, export it, then:
export PL_TOKEN=pl_live_...
curl -s -H "Authorization: Bearer $PL_TOKEN" https://private-logger-api.christian-yaranga-05.workers.dev/agent/triage-summary | python3 -m json.tool

# MCP tools/list
curl -s -X POST -H "Authorization: Bearer $PL_TOKEN" -H "Content-Type: application/json" \
  https://private-logger-api.christian-yaranga-05.workers.dev/mcp \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | python3 -m json.tool
```

Expected: 12 tools listed.

- [ ] **Step 6: Commit deploy artifacts (none — deploys don't write files)**

No commit needed; previous task commits already in history.

---

## Task 22: Mobile commit + push branch

**Files:** none

- [ ] **Step 1: Push mobile worktree branch**

```bash
cd /Users/chrisyaranga/Documents/EulerInnovations/rebeca-mobile-app/.worktrees/bug-reporting
git push -u origin feat/bug-reporting
```

User merges via PR when ready (not part of this plan — ship-blocking is user's call).

---

## Self-review (run after writing the plan)

**Spec coverage:**
- ✅ Migrations 0008 + 0009 → Tasks 1, 2
- ✅ R2 binding → Task 3
- ✅ Token helpers + auth + endpoints → Tasks 4, 5, 6
- ✅ Bug report module + endpoints → Tasks 7, 8, 9
- ✅ Trace correlation → Task 10
- ✅ Triage summary → Task 11
- ✅ OpenAPI manifest → Task 12
- ✅ MCP server + tests → Tasks 13, 14
- ✅ Frontend types/api/components → Tasks 15, 16, 17, 18
- ✅ Frontend wiring → Task 19
- ✅ Mobile reportBug → Task 20
- ✅ Rollout → Tasks 21, 22

**Placeholder scan:** none.

**Type consistency:** `BugReport`, `BugStatus`, `BugSeverity`, `ApiToken`, `TriageSummary` used consistently across types.ts and components. `screenshot_url` returned as path `/bugs/:id/screenshot` (route on Worker) in both list and detail responses.

**Notes:**
- BugReportSheet UI in mobile (full sheet component + floating button) deliberately deferred. Plan ships the SDK method (Task 20) which is the testable + agent-relevant unit; the UI sheet is a follow-up since it needs design pass + screenshot capture lib selection (`expo-screen-capture` vs `react-native-view-shot`).
- ApiTokensModal exposes "tokens" button only on desktop layout. Mobile users (single-user install) almost never need to mint tokens on phone.
