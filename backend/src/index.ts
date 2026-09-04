import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { validateReplayUrl } from './replay/ssrf';
import { generateTokenPlaintext, hashToken, tokenPrefix } from './tokens';
import { sanitizeHeadersForStorage } from './replay/sanitize';
import { executeReplay } from './replay/handler';
import { redactPii, redactValue } from './redact';
import { computeFingerprint } from './fingerprint';
import { snapshotRelatedLogIds, fetchLogsByIds } from './bugs';
import { createMcpRouter } from './mcp';
import { buildHumanSummary } from './triage';
import { OPENAPI_SPEC } from './openapi';

type Bindings = {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
  SCREENSHOTS: R2Bucket;
};

type User = {
  id: number;
  username: string;
  password_hash: string;
  created_at: string;
};

type Session = {
  id: string;
  user_id: number;
  expires_at: string;
  created_at: string;
};

// Auth helper functions
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passwordBuffer = encoder.encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hashArray = new Uint8Array(derivedBits);
  const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');
  const hashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

  return `${saltHex}:${hashHex}`;
}

async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [saltHex, hashHex] = storedHash.split(':');
  if (!saltHex || !hashHex) return false;

  const salt = new Uint8Array(saltHex.match(/.{2}/g)!.map(byte => parseInt(byte, 16)));
  const encoder = new TextEncoder();
  const passwordBuffer = encoder.encode(password);

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    passwordBuffer,
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );

  const hashArray = new Uint8Array(derivedBits);
  const computedHashHex = Array.from(hashArray).map(b => b.toString(16).padStart(2, '0')).join('');

  return computedHashHex === hashHex;
}

function generateSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function validateSession(db: D1Database, sessionId: string): Promise<User | null> {
  const session = await db.prepare(
    `SELECT s.*, u.id as user_id, u.username, u.password_hash, u.created_at as user_created_at
     FROM sessions s
     JOIN users u ON s.user_id = u.id
     WHERE s.id = ? AND s.expires_at > datetime('now')`
  )
    .bind(sessionId)
    .first<{ user_id: number; username: string; password_hash: string; user_created_at: string }>();

  if (!session) return null;

  return {
    id: session.user_id,
    username: session.username,
    password_hash: session.password_hash,
    created_at: session.user_created_at,
  };
}

async function cleanExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= datetime('now')").run();
}

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH' | 'OPTIONS' | 'HEAD';

type LogSource = 'ios' | 'android' | 'web' | 'desktop' | 'backend' | 'simulator' | 'cli' | 'api' | 'watch' | 'tv' | 'extension' | 'iot' | 'rebeca-web-desktop' | 'rebeca-web-mobile';

type Log = {
  id: number;
  user_id: string;
  device_id: string | null;
  message: string;
  metadata: string | null;
  environment: 'dev' | 'test' | 'prod';
  source: LogSource | null;
  created_at: string;
  level: LogLevel;
  category: string;
  http_method: HttpMethod | null;
  endpoint: string | null;
  request_data: string | null;
  response_data: string | null;
  status_code: number | null;
  duration_ms: number | null;
  session_id: string | null;
  trace_id: string | null;
  app_version: string | null;
  os_version: string | null;
  device_model: string | null;
  network_type: string | null;
  fingerprint: string | null;
  breadcrumbs: string | null;
};

type Archive = {
  id: number;
  archive_date: string;
  log_count: number;
  data: string;
  created_at: string;
};

type CreateLogInput = {
  user_id: string;
  device_id?: string;
  message: string;
  metadata?: Record<string, unknown>;
  environment?: 'dev' | 'test' | 'prod';
  source?: LogSource;
  /**
   * Top-level app identifier sent by clients (e.g. 'travel-mobile-ios',
   * 'travel-mobile-android', 'travel-mobile-web', 'travel-web'). Used as
   * fallback for resolving `source` when it is not set and metadata does
   * not carry platform/os info. Optional passthrough — no schema migration.
   */
  app?: string;
  level?: LogLevel;
  category?: string;
  http_method?: HttpMethod;
  endpoint?: string;
  request_data?: Record<string, unknown> | string;
  response_data?: Record<string, unknown> | string;
  status_code?: number;
  duration_ms?: number;
  /** Per-app-launch session identifier (UUID/ULID). Groups every log from one session. */
  session_id?: string;
  /** Optional cross-system correlation ID (e.g. mobile → backend). */
  trace_id?: string;
  /** Client app semver, e.g. "2.4.1". */
  app_version?: string;
  /** OS string, e.g. "iOS 17.5". */
  os_version?: string;
  /** Device marketing name, e.g. "iPhone 15 Pro". */
  device_model?: string;
  /** Network type: "wifi" | "cellular" | "none" | "unknown". */
  network_type?: string;
  /**
   * Optional pre-computed fingerprint. Server falls back to deriving one
   * from (level, category, endpoint, status_code, normalized message)
   * when omitted, so error grouping works for legacy clients too.
   */
  fingerprint?: string;
  /**
   * Last N user-visible actions before this event (newest last).
   * Each item: { ts: ISO string, type: string, label: string, data?: any }.
   * Cap recommended at 50 client-side; server stores as-is.
   */
  breadcrumbs?: Array<Record<string, unknown>>;
};

// Free tier limits
const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const STORAGE_WARNING_THRESHOLD = 0.8; // Warn at 80%
const STORAGE_ARCHIVE_THRESHOLD = 0.7; // Archive when reaching 70%
const DAYS_TO_KEEP_IN_LOGS = 7; // Keep 7 days in main logs table

const BEHAVIOUR_CATEGORIES = new Set(['USER_ACTION']);

// El dashboard operativo esconde los logs de comportamiento (otro producto) y el
// ruido de [HTTP] en debug. Estaba copiado literal en once consultas; una sola
// definición evita que se desincronicen.
const DASHBOARD_ROW_SQL =
  `(endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;

function isDashboardRow(level: string, endpoint: string | null, message: string): boolean {
  if (endpoint && endpoint.includes('/behaviour/')) return false;
  if (level === 'debug' && message.startsWith('[HTTP]')) return false;
  return true;
}

// Alimenta `log_dimensions` (migración 0011), de donde salen los desplegables del
// dashboard. `INSERT OR IGNORE` no escribe nada cuando el valor ya está, así que en
// régimen esto no consume presupuesto de escritura. Su fallo lo traga quien la llama:
// un desplegable incompleto hasta el rebuild nocturno es aceptable, tumbar la ingesta
// de logs —el camino crítico del cliente móvil— no lo es.
async function recordDimensions(
  db: D1Database,
  row: { user_id: string; device_id: string | null; source: string | null; category: string | null }
): Promise<void> {
  const dims: Array<[string, string]> = [['user_id', row.user_id]];
  if (row.device_id) dims.push(['device_id', row.device_id]);
  if (row.source) dims.push(['source', row.source]);
  if (row.category) dims.push(['category', row.category]);
  const stmt = db.prepare('INSERT OR IGNORE INTO log_dimensions (kind, value) VALUES (?, ?)');
  await db.batch(dims.map(([kind, value]) => stmt.bind(kind, value)));
}

async function readDimension(db: D1Database, kind: string): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT value FROM log_dimensions WHERE kind = ? ORDER BY value')
    .bind(kind)
    .all<{ value: string }>();
  return (results || []).map((r) => r.value);
}

function resolveSource(
  body: Partial<CreateLogInput> | null | undefined,
  parsed: Record<string, unknown>
): string | null {
  if (body && typeof body.source === 'string' && body.source) return body.source;
  if (body && typeof body.app === 'string' && body.app) return body.app;
  const os = parsed.os as string | undefined;
  const platform = parsed.platform as string | undefined;
  return platform ?? os ?? null;
}

async function processBehaviourLog(
  analyticsDb: D1Database,
  log: { user_id: string; device_id: string | null; message: string;
         metadata: string | null; environment: string; source: string | null;
         created_at: string;
         session_id?: string | null; app_version?: string | null;
         os_version?: string | null; device_model?: string | null;
         network_type?: string | null }
): Promise<void> {
  const parts = log.message.split(':');
  const action = parts[0] ?? 'unknown';
  const subject = parts.slice(1).join(':') || 'unknown';
  const date = log.created_at.slice(0, 10);
  const parsed: Record<string, unknown> = log.metadata ? JSON.parse(log.metadata) : {};
  const screen = (parsed.screen as string) ?? null;
  // When processing a stored log row (retry / reprocess paths), we no longer
  // have the original top-level `app` field — only log.source. resolveSource
  // still falls back to metadata.platform / metadata.os for legacy rows.
  const source = log.source ?? resolveSource(null, parsed);
  const session_id = log.session_id ?? null;
  const app_version = log.app_version ?? (parsed.app_version as string | undefined) ?? null;
  const os_version = log.os_version ?? (parsed.os_version as string | undefined) ?? null;
  const device_model = log.device_model ?? (parsed.device_model as string | undefined) ?? null;
  const network_type = log.network_type ?? (parsed.network_type as string | undefined) ?? null;

  // Las cinco escrituras van en UN batch() porque D1 lo ejecuta como una sola
  // transaccion: o entran todas o no entra ninguna.
  //
  // Antes eran cinco round-trips sueltos y, si fallaba cualquiera menos el
  // primero, el evento quedaba ya insertado en behaviour_events mientras la
  // fila de `logs` se retenia para reintento (ver el catch del POST /logs y el
  // cron). El reintento volvia a ejecutar TODO -> evento duplicado y agregados
  // contados dos veces. Verificado en prod (2026-08-13): la sesion
  // 0msqsuyc6-ovs-39lov5v0q5v0 tenia sus 8 eventos ya en behaviour_events y sus
  // 8 filas todavia en `logs`, esperando un reintento que las habria duplicado.
  //
  // De paso baja de 5 round-trips a 1 sobre la misma D1, que es justo donde se
  // concentra la contencion en las rafagas donde se producen estos fallos.
  //
  // unique_users pasa a calcularse con un subselect dentro del UPDATE: el
  // SELECT COUNT(*) previo no cabe en un batch y ademas era una lectura fuera
  // de transaccion, asi que dos peticiones simultaneas escribian el mismo
  // valor obsoleto.
  await analyticsDb.batch([
    analyticsDb.prepare(
      `INSERT INTO behaviour_events
         (user_id, device_id, action, subject, screen, metadata, environment, source, created_at,
          session_id, app_version, os_version, device_model, network_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(log.user_id, log.device_id, action, subject, screen,
           log.metadata, log.environment, source, log.created_at,
           session_id, app_version, os_version, device_model, network_type),

    analyticsDb.prepare(
      `INSERT INTO daily_aggregates (date, action, subject, environment, source, count, unique_users)
       VALUES (?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(date, action, subject, environment, source)
       DO UPDATE SET count = count + 1`
    ).bind(date, action, subject, log.environment, source),

    analyticsDb.prepare(
      `INSERT OR IGNORE INTO daily_users (date, action, subject, user_id, environment, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(date, action, subject, log.user_id, log.environment, source),

    analyticsDb.prepare(
      `UPDATE daily_aggregates
       SET unique_users = (
         SELECT COUNT(*) FROM daily_users
         WHERE date = ? AND action = ? AND subject = ? AND environment = ?
           AND (source IS ? OR (source IS NULL AND ? IS NULL))
       )
       WHERE date = ? AND action = ? AND subject = ? AND environment = ?
         AND (source IS ? OR (source IS NULL AND ? IS NULL))`
    ).bind(date, action, subject, log.environment, source, source,
           date, action, subject, log.environment, source, source),

    // Per-version slice. Lets non-technical team members compare how a given
    // (action, subject) performs across app builds — funnel regressions show
    // up as a sudden drop on a specific app_version.
    analyticsDb.prepare(
      `INSERT INTO daily_aggregates_by_version
         (date, action, subject, environment, source, app_version, count, unique_users)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0)
       ON CONFLICT(date, action, subject, environment, source, app_version)
       DO UPDATE SET count = count + 1`
    ).bind(date, action, subject, log.environment, source, app_version),
  ]);
}

const app = new Hono<{ Bindings: Bindings }>();

// Enable CORS for frontend
app.use('/*', cors({
  origin: (origin) => {
    if (!origin) return null;
    if (origin === 'https://chrisyaranga.dev') return origin;
    if (origin === 'https://logger.chrisyaranga.dev') return origin;
    if (origin === 'https://rebeca.app') return origin;
    if (origin === 'https://rebeca.travel') return origin;
    if (origin.startsWith('http://localhost:')) return origin;
    return null;
  },
  allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
}));

// Health check
app.get('/', (c) => {
  return c.json({ status: 'ok', service: 'private-logger-api', version: '2.0.0' });
});

app.get('/openapi.json', (c) => c.json(OPENAPI_SPEC));

// Auth endpoints (no authentication required)
app.post('/auth/login', async (c) => {
  try {
    const body = await c.req.json<{ username: string; password: string }>();

    if (!body.username || !body.password) {
      return c.json({ error: 'Username and password are required' }, 400);
    }

    const user = await c.env.DB.prepare('SELECT * FROM users WHERE username = ?')
      .bind(body.username)
      .first<User>();

    if (!user) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    const isValid = await verifyPassword(body.password, user.password_hash);
    if (!isValid) {
      return c.json({ error: 'Invalid credentials' }, 401);
    }

    // Clean up expired sessions
    await cleanExpiredSessions(c.env.DB);

    // Create new session (24 hours expiry)
    const sessionToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

    await c.env.DB.prepare(
      'INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)'
    )
      .bind(sessionToken, user.id, expiresAt)
      .run();

    // Set HTTP-only cookie
    setCookie(c, 'session', sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'None',
      maxAge: 24 * 60 * 60,
      path: '/',
    });

    return c.json({
      success: true,
      user: { id: user.id, username: user.username },
      token: sessionToken,
      expiresAt,
    });
  } catch (error) {
    console.error('Login error:', error);
    return c.json({ error: 'Login failed' }, 500);
  }
});

app.post('/auth/logout', async (c) => {
  try {
    const sessionToken = getCookie(c, 'session') || c.req.header('Authorization')?.replace('Bearer ', '');

    if (sessionToken) {
      await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?')
        .bind(sessionToken)
        .run();

      deleteCookie(c, 'session', { path: '/' });
    }

    return c.json({ success: true, message: 'Logged out' });
  } catch (error) {
    console.error('Logout error:', error);
    return c.json({ error: 'Logout failed' }, 500);
  }
});

app.get('/auth/verify', async (c) => {
  try {
    const sessionToken = getCookie(c, 'session') || c.req.header('Authorization')?.replace('Bearer ', '');

    if (!sessionToken) {
      return c.json({ authenticated: false }, 401);
    }

    const user = await validateSession(c.env.DB, sessionToken);

    if (!user) {
      return c.json({ authenticated: false }, 401);
    }

    return c.json({
      authenticated: true,
      user: { id: user.id, username: user.username },
    });
  } catch (error) {
    console.error('Verify error:', error);
    return c.json({ authenticated: false }, 401);
  }
});

// Auth middleware for protected routes
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

// Auth middleware is available but not applied to API routes.
// Authentication is handled on the frontend side only.

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

// Create a new log entry
app.post('/logs', async (c) => {
  try {
    const body = await c.req.json<CreateLogInput>();

    if (!body.user_id || !body.message) {
      return c.json({ error: 'user_id and message are required' }, 400);
    }

    // PII scrub on the way in. user_id stays as-is (caller-controlled
    // identifier, not a credential). message + metadata + payloads are
    // redacted in place so the stored row carries no live secrets.
    body.message = redactPii(body.message);
    if (body.metadata) body.metadata = redactValue(body.metadata) as Record<string, unknown>;
    if (typeof body.request_data === 'string') body.request_data = redactPii(body.request_data);
    else if (body.request_data) body.request_data = redactValue(body.request_data) as Record<string, unknown>;
    if (typeof body.response_data === 'string') body.response_data = redactPii(body.response_data);
    else if (body.response_data) body.response_data = redactValue(body.response_data) as Record<string, unknown>;
    if (body.breadcrumbs) body.breadcrumbs = redactValue(body.breadcrumbs) as Array<Record<string, unknown>>;

    const metadata = body.metadata ? JSON.stringify(body.metadata) : null;
    const environment = body.environment || 'dev';
    // Resolve source from body.source → body.app → metadata.platform → metadata.os → null.
    // Clients (e.g. mobile app) send the app identifier at the top level as `app`;
    // metadata typically does not carry os/platform, so we accept both.
    const parsedMetadataForSource: Record<string, unknown> = body.metadata ?? {};
    const source = resolveSource(body, parsedMetadataForSource);
    const level = body.level || 'info';
    const category = body.category || 'GENERAL';
    const device_id = body.device_id || null;
    const http_method = body.http_method || null;
    const endpoint = body.endpoint || null;
    const request_data = body.request_data
      ? (typeof body.request_data === 'string' ? body.request_data : JSON.stringify(body.request_data))
      : null;
    const response_data = body.response_data
      ? (typeof body.response_data === 'string' ? body.response_data : JSON.stringify(body.response_data))
      : null;
    const status_code = body.status_code ?? null;
    const duration_ms = body.duration_ms ?? null;
    const session_id = body.session_id ?? null;
    const trace_id = body.trace_id ?? null;
    const app_version = body.app_version ?? null;
    const os_version = body.os_version ?? null;
    const device_model = body.device_model ?? null;
    const network_type = body.network_type ?? null;
    const breadcrumbs = body.breadcrumbs ? JSON.stringify(body.breadcrumbs) : null;
    const fingerprint = body.fingerprint
      ?? await computeFingerprint({ level, category, endpoint, status_code, message: body.message });

    const result = await c.env.DB.prepare(
      `INSERT INTO logs (
         user_id, device_id, message, metadata, environment, source, level, category,
         http_method, endpoint, request_data, response_data, status_code, duration_ms,
         session_id, trace_id, app_version, os_version, device_model, network_type,
         fingerprint, breadcrumbs
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
      .bind(
        body.user_id, device_id, body.message, metadata, environment, source, level, category,
        http_method, endpoint, request_data, response_data, status_code, duration_ms,
        session_id, trace_id, app_version, os_version, device_model, network_type,
        fingerprint, breadcrumbs,
      )
      .first<Log>();

    // Process behaviour logs into analytics D1
    if (result && BEHAVIOUR_CATEGORIES.has(category)) {
      try {
        await processBehaviourLog(c.env.ANALYTICS_DB, {
          user_id: body.user_id,
          device_id: device_id,
          message: body.message,
          metadata: metadata,
          environment: environment,
          source: source,
          created_at: result.created_at,
          session_id,
          app_version,
          os_version,
          device_model,
          network_type,
        });
        // Delete from raw logs to free space
        await c.env.DB.prepare('DELETE FROM logs WHERE id = ?')
          .bind(result.id).run();
      } catch (e) {
        console.error('Behaviour processing failed, log retained in raw DB:', e);
      }
    }

    // Los logs de comportamiento se acaban de borrar de `logs`, así que sus valores
    // no deben entrar en los desplegables: el rebuild nocturno los quitaría igual.
    if (result && !BEHAVIOUR_CATEGORIES.has(category)) {
      try {
        await recordDimensions(c.env.DB, {
          user_id: body.user_id,
          device_id,
          source,
          category: isDashboardRow(level, endpoint, body.message) ? category : null,
        });
      } catch (e) {
        // Un desplegable incompleto hasta el rebuild de las 03:00 es aceptable;
        // rechazar el log del cliente móvil por esto, no. El log ya está guardado.
        console.error('recordDimensions failed:', e);
      }
    }

    return c.json({ success: true, log: result }, 201);
  } catch (error) {
    console.error('Error creating log:', error);
    return c.json({ error: 'Failed to create log' }, 500);
  }
});

// Helper function to parse JSON fields safely
function parseLogFields(log: Log): Record<string, unknown> {
  return {
    ...log,
    metadata: log.metadata ? JSON.parse(log.metadata) : null,
    request_data: log.request_data ? tryParseJSON(log.request_data) : null,
    response_data: log.response_data ? tryParseJSON(log.response_data) : null,
    breadcrumbs: log.breadcrumbs ? tryParseJSON(log.breadcrumbs) : null,
  };
}

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

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

// Get all logs with optional filtering
// Techo del COUNT de paginación. Un COUNT(*) exacto sobre `logs` barre la tabla
// entera. Medido el 2026-09-04: con techo 10.000 el COUNT leía 13.337 filas por
// refresco del dashboard —más que ninguna otra consulta ya optimizada—; con 1.000
// son ~1.300. El paginador no pierde fondo: cuando el total viene tapado, "siguiente"
// se habilita por página llena en vez de por el total (ver App.tsx).
const COUNT_CAP = 1000;

app.get('/logs', async (c) => {
  try {
    const userId = c.req.query('user_id');
    const deviceId = c.req.query('device_id');
    const environment = c.req.query('environment');
    const source = c.req.query('source');
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');
    const search = c.req.query('search');
    const level = c.req.query('level');
    const category = c.req.query('category');
    const http_method = c.req.query('http_method');
    const session_id = c.req.query('session_id');
    const fingerprint = c.req.query('fingerprint');
    const app_version = c.req.query('app_version');
    const start_date = c.req.query('start_date');
    const end_date = c.req.query('end_date');

    let query = 'SELECT * FROM logs WHERE 1=1';
    const params: (string | number)[] = [];

    if (userId) {
      query += ' AND user_id = ?';
      params.push(userId);
    }

    if (deviceId) {
      query += ' AND device_id = ?';
      params.push(deviceId);
    }

    if (environment) {
      query += ' AND environment = ?';
      params.push(environment);
    }

    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }

    if (level) {
      query += ' AND level = ?';
      params.push(level);
    }

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    } else {
      // Behaviour logs (USER_ACTION) belong to the analytics project; hide
      // them from the dashboard unless the caller asks for them explicitly.
      query += ` AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;
    }

    if (http_method) {
      query += ' AND http_method = ?';
      params.push(http_method);
    }

    if (session_id) {
      query += ' AND session_id = ?';
      params.push(session_id);
    }

    if (fingerprint) {
      query += ' AND fingerprint = ?';
      params.push(fingerprint);
    }

    if (app_version) {
      query += ' AND app_version = ?';
      params.push(app_version);
    }

    if (start_date) {
      query += ' AND created_at >= ?';
      params.push(start_date);
    }

    if (end_date) {
      query += ' AND created_at <= ?';
      params.push(end_date);
    }

    if (search) {
      query += ' AND (message LIKE ? OR metadata LIKE ? OR endpoint LIKE ? OR request_data LIKE ? OR response_data LIKE ? OR device_id LIKE ? OR source LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const { results } = await c.env.DB.prepare(query)
      .bind(...params)
      .all<Log>();

    // Get total count for pagination
    let countQuery = 'SELECT 1 FROM logs WHERE 1=1';
    const countParams: string[] = [];

    if (userId) {
      countQuery += ' AND user_id = ?';
      countParams.push(userId);
    }

    if (deviceId) {
      countQuery += ' AND device_id = ?';
      countParams.push(deviceId);
    }

    if (environment) {
      countQuery += ' AND environment = ?';
      countParams.push(environment);
    }

    if (source) {
      countQuery += ' AND source = ?';
      countParams.push(source);
    }

    if (level) {
      countQuery += ' AND level = ?';
      countParams.push(level);
    }

    if (category) {
      countQuery += ' AND category = ?';
      countParams.push(category);
    } else {
      countQuery += ` AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;
    }

    if (http_method) {
      countQuery += ' AND http_method = ?';
      countParams.push(http_method);
    }

    if (session_id) {
      countQuery += ' AND session_id = ?';
      countParams.push(session_id);
    }

    if (fingerprint) {
      countQuery += ' AND fingerprint = ?';
      countParams.push(fingerprint);
    }

    if (app_version) {
      countQuery += ' AND app_version = ?';
      countParams.push(app_version);
    }

    if (start_date) {
      countQuery += ' AND created_at >= ?';
      countParams.push(start_date);
    }

    if (end_date) {
      countQuery += ' AND created_at <= ?';
      countParams.push(end_date);
    }

    if (search) {
      countQuery += ' AND (message LIKE ? OR metadata LIKE ? OR endpoint LIKE ? OR request_data LIKE ? OR response_data LIKE ? OR device_id LIKE ? OR source LIKE ?)';
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const logs = results?.map(parseLogFields) || [];

    // `count=0`: quien pagina en bucle (la exportación CSV del dashboard) no usa el
    // total y corta por página corta. Ejecutar el COUNT en cada una de sus 200 vueltas
    // costaba hasta 2,1M filas leídas de un solo click — el 42% de la cuota diaria
    // que este cambio existe para proteger.
    if (c.req.query('count') === '0') {
      return c.json({ logs, limit, offset });
    }

    // COUNT(*) ACOTADO: sin el LIMIT interior esto barría la tabla entera en cada
    // página (359 MB) y, sumado al ORDER BY, reventó el límite diario de lecturas de
    // D1 → 500 "Failed to fetch logs". El techo se devuelve como `total` y se marca
    // con `total_is_capped` para que la UI pueda pintar "1.000+" en vez de mentir.
    const countResult = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM (${countQuery} LIMIT ${COUNT_CAP + 1})`
    )
      .bind(...countParams)
      .first<{ count: number }>();
    const total = countResult?.count || 0;

    return c.json({
      logs,
      total: Math.min(total, COUNT_CAP),
      total_is_capped: total > COUNT_CAP,
      limit,
      offset,
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return c.json({ error: 'Failed to fetch logs' }, 500);
  }
});

// Get a single log by ID
app.get('/logs/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const log = await c.env.DB.prepare('SELECT * FROM logs WHERE id = ?')
      .bind(id)
      .first<Log>();

    if (!log) {
      return c.json({ error: 'Log not found' }, 404);
    }

    return c.json(parseLogFields(log));
  } catch (error) {
    console.error('Error fetching log:', error);
    return c.json({ error: 'Failed to fetch log' }, 500);
  }
});

// Delete a log by ID
app.delete('/logs/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const result = await c.env.DB.prepare('DELETE FROM logs WHERE id = ?')
      .bind(id)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ error: 'Log not found' }, 404);
    }

    return c.json({ success: true, message: 'Log deleted' });
  } catch (error) {
    console.error('Error deleting log:', error);
    return c.json({ error: 'Failed to delete log' }, 500);
  }
});

// Bulk delete logs with filters
app.post('/logs/bulk-delete', async (c) => {
  try {
    const body = await c.req.json<{
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
    }>();

    const { user_id, device_id, category, level, environment, source, http_method, search, start_date, end_date } = body;

    // Build the WHERE clause
    let query = 'DELETE FROM logs WHERE 1=1';
    const params: string[] = [];

    if (user_id) {
      query += ' AND user_id = ?';
      params.push(user_id);
    }

    if (device_id) {
      query += ' AND device_id = ?';
      params.push(device_id);
    }

    if (category) {
      query += ' AND category = ?';
      params.push(category);
    }

    if (level) {
      query += ' AND level = ?';
      params.push(level);
    }

    if (environment) {
      query += ' AND environment = ?';
      params.push(environment);
    }

    if (source) {
      query += ' AND source = ?';
      params.push(source);
    }

    if (http_method) {
      query += ' AND http_method = ?';
      params.push(http_method);
    }

    if (search) {
      query += ' AND (message LIKE ? OR endpoint LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (start_date) {
      query += ' AND DATE(created_at) >= ?';
      params.push(start_date);
    }

    if (end_date) {
      query += ' AND DATE(created_at) <= ?';
      params.push(end_date);
    }

    // First count how many will be deleted
    const countQuery = query.replace('DELETE FROM logs', 'SELECT COUNT(*) as count FROM logs');
    const countResult = await c.env.DB.prepare(countQuery)
      .bind(...params)
      .first<{ count: number }>();

    const countToDelete = countResult?.count || 0;

    if (countToDelete === 0) {
      return c.json({ success: true, deleted: 0, message: 'No logs matched the criteria' });
    }

    // Perform the delete
    const result = await c.env.DB.prepare(query)
      .bind(...params)
      .run();

    return c.json({
      success: true,
      deleted: result.meta.changes,
      message: `Successfully deleted ${result.meta.changes} logs`,
    });
  } catch (error) {
    console.error('Error bulk deleting logs:', error);
    return c.json({ error: 'Failed to bulk delete logs' }, 500);
  }
});

// Get recent logs by device_id and user_id for the last N hours
app.get('/logs/recent', async (c) => {
  try {
    const deviceId = c.req.query('device_id');
    const userId = c.req.query('user_id');
    const hours = parseInt(c.req.query('hours') || '24');

    if (!deviceId && !userId) {
      return c.json({ error: 'At least one of device_id or user_id is required' }, 400);
    }

    if (hours < 1 || hours > 720) {
      return c.json({ error: 'hours must be between 1 and 720 (30 days)' }, 400);
    }

    let query = `SELECT * FROM logs WHERE created_at >= datetime('now', '-${hours} hours') AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;
    const params: string[] = [];

    if (deviceId) {
      query += ' AND device_id = ?';
      params.push(deviceId);
    }

    if (userId) {
      query += ' AND user_id = ?';
      params.push(userId);
    }

    query += ' ORDER BY created_at DESC';

    const { results } = await c.env.DB.prepare(query)
      .bind(...params)
      .all<Log>();

    return c.json({
      logs: results?.map(parseLogFields) || [],
      count: results?.length || 0,
      hours,
      device_id: deviceId || null,
      user_id: userId || null,
    });
  } catch (error) {
    console.error('Error fetching recent logs:', error);
    return c.json({ error: 'Failed to fetch recent logs' }, 500);
  }
});

// Get unique user IDs for filtering
// Los cuatro desplegables (/users, /categories, /devices, /sources) salían de un
// `SELECT DISTINCT` sobre `logs` cada uno: cuatro barridos completos por refresco del
// dashboard, dos tercios de las lecturas que reventaron la cuota diaria de D1. Ahora
// leen `log_dimensions` (unos cientos de filas). Lo mantiene `recordDimensions` al
// insertar, y el cron de las 03:00 lo reconstruye para purgar valores ya archivados.
app.get('/users', async (c) => {
  try {
    return c.json({ users: await readDimension(c.env.DB, 'user_id') });
  } catch (error) {
    console.error('Error fetching users:', error);
    return c.json({ error: 'Failed to fetch users' }, 500);
  }
});

// Get unique categories for filtering
app.get('/categories', async (c) => {
  try {
    return c.json({ categories: await readDimension(c.env.DB, 'category') });
  } catch (error) {
    console.error('Error fetching categories:', error);
    return c.json({ error: 'Failed to fetch categories' }, 500);
  }
});

// Get unique device IDs for filtering
app.get('/devices', async (c) => {
  try {
    return c.json({ devices: await readDimension(c.env.DB, 'device_id') });
  } catch (error) {
    console.error('Error fetching devices:', error);
    return c.json({ error: 'Failed to fetch devices' }, 500);
  }
});

// Get unique sources for filtering
app.get('/sources', async (c) => {
  try {
    return c.json({ sources: await readDimension(c.env.DB, 'source') });
  } catch (error) {
    console.error('Error fetching sources:', error);
    return c.json({ error: 'Failed to fetch sources' }, 500);
  }
});

// User profile aggregator. Returns a human-readable summary so non-technical
// team members can answer "who is this user, what device, when last active,
// how often do they hit errors" in one request.
app.get('/users/:id/profile', async (c) => {
  try {
    const userId = c.req.param('id');

    const summary = await c.env.DB.prepare(
      `SELECT
         COUNT(*) AS total_logs,
         SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
         SUM(CASE WHEN level = 'warn' THEN 1 ELSE 0 END) AS warn_count,
         MIN(created_at) AS first_seen,
         MAX(created_at) AS last_seen,
         COUNT(DISTINCT session_id) AS session_count,
         COUNT(DISTINCT device_id) AS device_count
       FROM logs WHERE user_id = ?`
    ).bind(userId).first<{
      total_logs: number; error_count: number; warn_count: number;
      first_seen: string | null; last_seen: string | null;
      session_count: number; device_count: number;
    }>();

    if (!summary || summary.total_logs === 0) {
      return c.json({ error: 'User not found' }, 404);
    }

    const { results: devices } = await c.env.DB.prepare(
      `SELECT device_id, device_model, os_version, MAX(created_at) AS last_seen, COUNT(*) AS log_count
       FROM logs WHERE user_id = ? AND device_id IS NOT NULL
       GROUP BY device_id ORDER BY last_seen DESC LIMIT 10`
    ).bind(userId).all();

    const { results: sources } = await c.env.DB.prepare(
      `SELECT source, COUNT(*) AS count FROM logs
       WHERE user_id = ? AND source IS NOT NULL
       GROUP BY source ORDER BY count DESC`
    ).bind(userId).all();

    const { results: appVersions } = await c.env.DB.prepare(
      `SELECT app_version, MAX(created_at) AS last_seen, COUNT(*) AS count
       FROM logs WHERE user_id = ? AND app_version IS NOT NULL
       GROUP BY app_version ORDER BY last_seen DESC LIMIT 10`
    ).bind(userId).all();

    const { results: topErrors } = await c.env.DB.prepare(
      `SELECT fingerprint, MAX(message) AS sample_message, MAX(category) AS category,
              MAX(endpoint) AS endpoint, MAX(status_code) AS status_code,
              COUNT(*) AS count, MAX(created_at) AS last_seen
       FROM logs WHERE user_id = ? AND level = 'error' AND fingerprint IS NOT NULL
       GROUP BY fingerprint ORDER BY count DESC LIMIT 10`
    ).bind(userId).all();

    const { results: recentSessions } = await c.env.DB.prepare(
      `SELECT session_id, MIN(created_at) AS started_at, MAX(created_at) AS ended_at,
              COUNT(*) AS log_count,
              SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count
       FROM logs WHERE user_id = ? AND session_id IS NOT NULL
       GROUP BY session_id ORDER BY started_at DESC LIMIT 20`
    ).bind(userId).all();

    return c.json({
      user_id: userId,
      summary,
      devices,
      sources,
      app_versions: appVersions,
      top_errors: topErrors,
      recent_sessions: recentSessions,
    });
  } catch (error) {
    console.error('Error fetching user profile:', error);
    return c.json({ error: 'Failed to fetch user profile' }, 500);
  }
});

// Session timeline. Ordered list of every log in one app session, with
// breadcrumbs and context unwrapped, so PMs/QA can replay what happened.
app.get('/sessions/:id/timeline', async (c) => {
  try {
    const sessionId = c.req.param('id');
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM logs WHERE session_id = ? ORDER BY created_at ASC`
    ).bind(sessionId).all<Log>();

    if (!results || results.length === 0) {
      return c.json({ error: 'Session not found' }, 404);
    }

    const first = results[0];
    const last = results[results.length - 1];
    const errorCount = results.filter(r => r.level === 'error').length;
    const warnCount = results.filter(r => r.level === 'warn').length;

    return c.json({
      session_id: sessionId,
      user_id: first.user_id,
      device_id: first.device_id,
      device_model: first.device_model,
      os_version: first.os_version,
      app_version: first.app_version,
      source: first.source,
      started_at: first.created_at,
      ended_at: last.created_at,
      log_count: results.length,
      error_count: errorCount,
      warn_count: warnCount,
      logs: results.map(parseLogFields),
    });
  } catch (error) {
    console.error('Error fetching session timeline:', error);
    return c.json({ error: 'Failed to fetch session timeline' }, 500);
  }
});

// Error groups. Buckets logs by fingerprint so identical errors collapse
// into one row with count, affected user count, first/last seen.
app.get('/errors/groups', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const offset = parseInt(c.req.query('offset') || '0');
    const environment = c.req.query('environment');
    const source = c.req.query('source');
    const status = c.req.query('status'); // 'open' | 'ignored' | 'resolved' | 'monitoring' | 'all'
    const sinceParam = c.req.query('since'); // ISO timestamp; default last 7d

    const since = sinceParam || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let where = `WHERE level IN ('error', 'warn') AND fingerprint IS NOT NULL AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%') AND created_at >= ?`;
    const params: (string | number)[] = [since];
    if (environment) { where += ' AND environment = ?'; params.push(environment); }
    if (source) { where += ' AND source = ?'; params.push(source); }

    const { results } = await c.env.DB.prepare(
      `SELECT
         l.fingerprint,
         MAX(l.level) AS level,
         MAX(l.category) AS category,
         MAX(l.endpoint) AS endpoint,
         MAX(l.status_code) AS status_code,
         MAX(l.message) AS sample_message,
         MAX(l.source) AS sample_source,
         COUNT(*) AS occurrences,
         COUNT(DISTINCT l.user_id) AS affected_users,
         MIN(l.created_at) AS first_seen,
         MAX(l.created_at) AS last_seen,
         COALESCE(s.status, 'open') AS state_status,
         s.assigned_to AS state_assigned_to,
         s.note AS state_note,
         s.updated_at AS state_updated_at
       FROM logs l
       LEFT JOIN error_group_states s ON s.fingerprint = l.fingerprint
       ${where}
       GROUP BY l.fingerprint
       HAVING ${status === 'all' ? '1=1' : `state_status = ?`}
       ORDER BY occurrences DESC
       LIMIT ? OFFSET ?`
    ).bind(
      ...params,
      ...(status === 'all' ? [] : [status || 'open']),
      limit,
      offset,
    ).all();

    return c.json({ groups: results || [], since, limit, offset });
  } catch (error) {
    console.error('Error fetching error groups:', error);
    return c.json({ error: 'Failed to fetch error groups' }, 500);
  }
});

// Update state of an error group (status / assignment / note).
// Authenticated — only dashboard operators should be able to triage.
app.patch('/errors/groups/:fingerprint/state', authMiddleware, async (c) => {
  try {
    const fingerprint = c.req.param('fingerprint');
    const body = await c.req.json<{
      status?: 'open' | 'ignored' | 'resolved' | 'monitoring';
      assigned_to?: string | null;
      note?: string | null;
    }>();
    const user = c.get('user' as never) as User | undefined;
    const updatedBy = user?.username ?? 'unknown';

    await c.env.DB.prepare(
      `INSERT INTO error_group_states (fingerprint, status, assigned_to, note, updated_at, updated_by)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         status = COALESCE(?, error_group_states.status),
         assigned_to = COALESCE(?, error_group_states.assigned_to),
         note = COALESCE(?, error_group_states.note),
         updated_at = CURRENT_TIMESTAMP,
         updated_by = ?`
    ).bind(
      fingerprint,
      body.status ?? 'open',
      body.assigned_to ?? null,
      body.note ?? null,
      updatedBy,
      body.status ?? null,
      body.assigned_to ?? null,
      body.note ?? null,
      updatedBy,
    ).run();

    return c.json({ success: true });
  } catch (error) {
    console.error('Error updating error group state:', error);
    return c.json({ error: 'Failed to update state' }, 500);
  }
});

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

// Rich user list. Returns one row per user_id with last activity, device,
// app version, and error count — designed for the "Users" tab in the UI.
app.get('/users/rich', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');
    const search = c.req.query('search');
    const sinceParam = c.req.query('since'); // optional ISO; default 7d

    const since = sinceParam || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

    let where = `WHERE created_at >= ? AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;
    const params: (string | number)[] = [since];
    if (search) { where += ' AND user_id LIKE ?'; params.push(`%${search}%`); }

    const { results } = await c.env.DB.prepare(
      `SELECT
         user_id,
         COUNT(*) AS log_count,
         SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
         MAX(created_at) AS last_seen,
         MIN(created_at) AS first_seen,
         COUNT(DISTINCT session_id) AS session_count,
         (SELECT device_model FROM logs l2 WHERE l2.user_id = logs.user_id AND device_model IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_device_model,
         (SELECT os_version FROM logs l3 WHERE l3.user_id = logs.user_id AND os_version IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_os_version,
         (SELECT app_version FROM logs l4 WHERE l4.user_id = logs.user_id AND app_version IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_app_version,
         (SELECT source FROM logs l5 WHERE l5.user_id = logs.user_id AND source IS NOT NULL ORDER BY created_at DESC LIMIT 1) AS last_source
       FROM logs ${where}
       GROUP BY user_id
       ORDER BY last_seen DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return c.json({ users: results || [], since, limit, offset });
  } catch (error) {
    console.error('Error fetching rich users:', error);
    return c.json({ error: 'Failed to fetch users' }, 500);
  }
});

// Live tail. Server-Sent Events stream that emits new logs as they arrive.
// Implementation: hold the connection open, poll D1 every 2s for rows with
// id > last seen, push them as `data:` events. Workers cap connections at
// roughly 30s under default plan, so the EventSource on the client will
// auto-reconnect using Last-Event-ID — the server uses that header (or
// `?after=` query param fallback) to resume from where the prior stream left.
app.get('/logs/stream', async (c) => {
  const lastEventId = c.req.header('Last-Event-ID');
  const afterParam = c.req.query('after');
  let lastId = parseInt(lastEventId || afterParam || '0', 10);
  if (Number.isNaN(lastId) || lastId < 0) lastId = 0;

  // If no starting point given, anchor at the current MAX(id) so the
  // first stream only delivers genuinely-new entries (not 100k history).
  if (lastId === 0) {
    const head = await c.env.DB.prepare('SELECT IFNULL(MAX(id), 0) AS m FROM logs')
      .first<{ m: number }>();
    lastId = head?.m ?? 0;
  }

  const env = c.env;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      // Initial comment so the client knows the connection is live.
      controller.enqueue(encoder.encode(`: connected at ${new Date().toISOString()}\n\n`));
      const startTs = Date.now();

      const poll = async () => {
        try {
          const { results } = await env.DB.prepare(
            `SELECT * FROM logs
             WHERE id > ? AND category != 'USER_ACTION'
               AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%')
             ORDER BY id ASC LIMIT 100`
          ).bind(lastId).all<Log>();

          if (results && results.length > 0) {
            for (const row of results) {
              lastId = row.id;
              const data = JSON.stringify(parseLogFields(row));
              controller.enqueue(encoder.encode(`id: ${row.id}\ndata: ${data}\n\n`));
            }
          } else {
            controller.enqueue(encoder.encode(`: heartbeat ${Date.now()}\n\n`));
          }
        } catch (err) {
          controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({ error: String(err) })}\n\n`));
        }
      };

      // Poll every 2s, terminate cleanly after ~25s so EventSource
      // reconnects before the Worker hard-cap kicks in.
      const interval = setInterval(() => {
        if (Date.now() - startTs > 25_000) {
          clearInterval(interval);
          controller.close();
          return;
        }
        poll();
      }, 2000);

      // First poll right away.
      poll();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
});

// Behaviour analytics endpoints — read from ANALYTICS_DB.
// Surfaces user-action funnels for non-technical teammates: which actions
// users do most, and how those actions compare across app versions.
app.get('/behaviour/top-actions', async (c) => {
  try {
    const limit = parseInt(c.req.query('limit') || '50');
    const sinceParam = c.req.query('since'); // optional date YYYY-MM-DD; default 7d
    const environment = c.req.query('environment');
    const source = c.req.query('source');

    const since = sinceParam || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    let where = 'WHERE date >= ?';
    const params: (string | number)[] = [since];
    if (environment) { where += ' AND environment = ?'; params.push(environment); }
    if (source) { where += ' AND source = ?'; params.push(source); }

    const { results } = await c.env.ANALYTICS_DB.prepare(
      `SELECT action, subject,
              SUM(count) AS total_count,
              SUM(unique_users) AS total_users,
              MAX(date) AS last_day,
              MIN(date) AS first_day
       FROM daily_aggregates
       ${where}
       GROUP BY action, subject
       ORDER BY total_count DESC
       LIMIT ?`
    ).bind(...params, limit).all();

    return c.json({ actions: results || [], since });
  } catch (error) {
    console.error('Error fetching top actions:', error);
    return c.json({ error: 'Failed to fetch top actions' }, 500);
  }
});

app.get('/behaviour/by-version', async (c) => {
  try {
    const action = c.req.query('action');
    const subject = c.req.query('subject');
    const sinceParam = c.req.query('since');
    const since = sinceParam || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    let where = 'WHERE date >= ?';
    const params: (string | number)[] = [since];
    if (action) { where += ' AND action = ?'; params.push(action); }
    if (subject) { where += ' AND subject = ?'; params.push(subject); }

    const { results } = await c.env.ANALYTICS_DB.prepare(
      `SELECT app_version, action, subject,
              SUM(count) AS total_count,
              SUM(unique_users) AS total_users,
              MAX(date) AS last_day
       FROM daily_aggregates_by_version
       ${where}
       GROUP BY app_version, action, subject
       ORDER BY app_version DESC, total_count DESC`
    ).bind(...params).all();

    return c.json({ rows: results || [], since });
  } catch (error) {
    console.error('Error fetching behaviour by version:', error);
    return c.json({ error: 'Failed to fetch behaviour by version' }, 500);
  }
});

// Eventos de comportamiento EN CRUDO. Los dos endpoints de arriba devuelven
// agregados: contestan "que se usa mas", no "que hizo este usuario". Y los
// USER_ACTION no estan en la tabla `logs` (POST /logs los mueve a
// behaviour_events y borra la fila), asi que GET /logs tampoco los encuentra
// nunca. Sin esto no hay forma de reconstruir los pasos de alguien que reporta
// un fallo.
//
// Va con authMiddleware, a diferencia de /behaviour/top-actions y
// /behaviour/by-version: aqui salen filas por usuario (user_id, session_id,
// device_model, metadata), del mismo nivel de sensibilidad que /logs, /trace
// y /bugs, que si estan protegidos.
app.get('/behaviour/events', authMiddleware, async (c) => {
  try {
    const action = c.req.query('action');
    const subject = c.req.query('subject');
    const source = c.req.query('source');
    const environment = c.req.query('environment');
    const user_id = c.req.query('user_id');
    const session_id = c.req.query('session_id');
    const app_version = c.req.query('app_version');
    const screen = c.req.query('screen');
    const search = c.req.query('search');
    const start_date = c.req.query('start_date');
    const end_date = c.req.query('end_date');
    // Tope duro: un agente puede pedir limit=100000 y reventar la respuesta.
    const limit = Math.min(Math.max(parseInt(c.req.query('limit') || '100') || 100, 1), 1000);

    let query = 'SELECT * FROM behaviour_events WHERE 1=1';
    const params: (string | number)[] = [];

    if (action) { query += ' AND action = ?'; params.push(action); }
    if (subject) { query += ' AND subject = ?'; params.push(subject); }
    if (source) { query += ' AND source = ?'; params.push(source); }
    if (environment) { query += ' AND environment = ?'; params.push(environment); }
    if (user_id) { query += ' AND user_id = ?'; params.push(user_id); }
    if (session_id) { query += ' AND session_id = ?'; params.push(session_id); }
    if (app_version) { query += ' AND app_version = ?'; params.push(app_version); }
    if (screen) { query += ' AND screen = ?'; params.push(screen); }
    if (start_date) { query += ' AND created_at >= ?'; params.push(start_date); }
    if (end_date) { query += ' AND created_at <= ?'; params.push(end_date); }
    if (search) {
      query += ' AND (action LIKE ? OR subject LIKE ? OR screen LIKE ? OR metadata LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    // Se ordena DESC para que el LIMIT recorte por la cola vieja y devuelva
    // siempre la ventana mas reciente; created_at tiene resolucion de segundo
    // y una rafaga mete varios eventos en el mismo, asi que desempata id
    // (AUTOINCREMENT = orden real de insercion). Luego se invierte, porque
    // para reconstruir lo que hizo alguien el orden util es el cronologico.
    query += ' ORDER BY created_at DESC, id DESC LIMIT ?';
    params.push(limit);

    const { results } = await c.env.ANALYTICS_DB.prepare(query)
      .bind(...params)
      .all<Record<string, unknown>>();

    const events = (results || []).reverse().map((e) => ({
      ...e,
      metadata: e.metadata ? tryParseJSON(e.metadata as string) : null,
    }));

    return c.json({ events, count: events.length });
  } catch (error) {
    console.error('Error searching behaviour events:', error);
    return c.json({ error: 'Failed to search behaviour events' }, 500);
  }
});

// Get log statistics including storage info
// Antes: NUEVE consultas independientes sobre `logs`, cada una un barrido completo
// (~1,28M filas por refresco del dashboard, que se auto-refresca solo). Ahora UNA
// sola pasada agrupada por las cuatro dimensiones que pintan los paneles; los ocho
// agregados salen de ella sumando en JS. `uniqueUsers` viene de `log_dimensions`,
// que es justo la lista de user_id distintos.
// Respuesta cacheada CACHE_TTL_STATS s: sin eso, el auto-refresco del dashboard
// repite el barrido cada minuto y agota la cuota diaria en una hora abierta.
const CACHE_TTL_STATS = 900;

interface StatsRollupRow {
  environment: string | null;
  level: string | null;
  category: string | null;
  source: string | null;
  n: number;
  n_dash: number;
  n_24h: number;
  n_api: number;
}

function sumBy<K extends keyof StatsRollupRow>(
  rows: StatsRollupRow[],
  key: K,
  weight: (r: StatsRollupRow) => number
): Array<{ value: string | null; count: number }> {
  const acc = new Map<string | null, number>();
  for (const r of rows) {
    const w = weight(r);
    if (!w) continue;
    const k = r[key] as string | null;
    acc.set(k, (acc.get(k) || 0) + w);
  }
  return [...acc].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count);
}

app.get('/stats', async (c) => {
  try {
    const cache = caches.default;
    const cached = await cache.match(c.req.raw);
    // Copia mutable: lo que devuelve la Cache API trae cabeceras inmutables y el
    // middleware CORS escribe sobre la respuesta al salir.
    if (cached) return new Response(cached.body, cached);

    // Stats panels exclude behaviour (USER_ACTION) — those belong to the
    // user-behaviour analytics surface, not the operational dashboard.
    const { results } = await c.env.DB.prepare(
      `SELECT environment, level, category, source,
              COUNT(*) AS n,
              SUM(CASE WHEN ${DASHBOARD_ROW_SQL} THEN 1 ELSE 0 END) AS n_dash,
              SUM(CASE WHEN ${DASHBOARD_ROW_SQL} AND created_at >= datetime('now', '-24 hours') THEN 1 ELSE 0 END) AS n_24h,
              SUM(CASE WHEN ${DASHBOARD_ROW_SQL} AND http_method IS NOT NULL THEN 1 ELSE 0 END) AS n_api
         FROM logs
        WHERE category != 'USER_ACTION'
        GROUP BY environment, level, category, source`
    ).all<StatsRollupRow>();
    const rows = results || [];

    const uniqueUsers = await c.env.DB.prepare(
      `SELECT COUNT(*) as count FROM log_dimensions WHERE kind = 'user_id'`
    ).first<{ count: number }>();

    const archiveStats = await c.env.DB.prepare(
      'SELECT COUNT(*) as count, SUM(log_count) as total_logs FROM archives'
    ).first<{ count: number; total_logs: number }>();

    const all = (r: StatsRollupRow) => r.n;
    const dash = (r: StatsRollupRow) => r.n_dash;

    const payload = {
      total: rows.reduce((a, r) => a + r.n, 0),
      uniqueUsers: uniqueUsers?.count || 0,
      last24Hours: rows.reduce((a, r) => a + r.n_24h, 0),
      byEnvironment: sumBy(rows, 'environment', all).map((e) => ({ environment: e.value, count: e.count })),
      byLevel: sumBy(rows, 'level', all).map((e) => ({ level: e.value, count: e.count })),
      byCategory: sumBy(rows, 'category', all).slice(0, 10).map((e) => ({ category: e.value, count: e.count })),
      bySource: sumBy(rows, 'source', dash)
        .filter((e) => e.value !== null)
        .map((e) => ({ source: e.value, count: e.count })),
      apiCalls: rows.reduce((a, r) => a + r.n_api, 0),
      errorCount: rows.reduce((a, r) => a + (r.level === 'error' ? r.n_dash : 0), 0),
      archives: {
        count: archiveStats?.count || 0,
        totalLogs: archiveStats?.total_logs || 0,
      },
    };

    const response = c.json(payload);
    response.headers.set('cache-control', `public, max-age=${CACHE_TTL_STATS}`);
    await cache.put(c.req.raw, response.clone());
    return response;
  } catch (error) {
    console.error('Error fetching stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// Get time-series analytics for the dashboard
app.get('/stats/timeseries', async (c) => {
  try {
    const range = c.req.query('range') || '24h';

    let strftimeFmt: string;
    let cutoff: string;

    switch (range) {
      case '1h':
        strftimeFmt = '%Y-%m-%dT%H:%M:00Z';
        cutoff = '-1 hours';
        break;
      case '6h':
        strftimeFmt = '%Y-%m-%dT%H:00:00Z';
        cutoff = '-6 hours';
        break;
      case '7d':
        strftimeFmt = '%Y-%m-%dT00:00:00Z';
        cutoff = '-7 days';
        break;
      case '24h':
      default:
        strftimeFmt = '%Y-%m-%dT%H:00:00Z';
        cutoff = '-24 hours';
        break;
    }

    // Main bucket query: counts by level, avg duration
    const { results: bucketRows } = await c.env.DB.prepare(`
      SELECT
        strftime('${strftimeFmt}', created_at) AS bucket,
        COUNT(*) AS total,
        SUM(CASE WHEN level = 'debug' THEN 1 ELSE 0 END) AS debug_count,
        SUM(CASE WHEN level = 'info'  THEN 1 ELSE 0 END) AS info_count,
        SUM(CASE WHEN level = 'warn'  THEN 1 ELSE 0 END) AS warn_count,
        SUM(CASE WHEN level = 'error' THEN 1 ELSE 0 END) AS error_count,
        AVG(duration_ms) AS avg_duration_ms
      FROM logs
      WHERE created_at >= datetime('now', '${cutoff}')
        AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')
      GROUP BY bucket
      ORDER BY bucket ASC
    `).all<{
      bucket: string;
      total: number;
      debug_count: number;
      info_count: number;
      warn_count: number;
      error_count: number;
      avg_duration_ms: number | null;
    }>();

    const rows = bucketRows || [];

    // Check if any bucket has duration data
    const hasDurations = rows.some(r => r.avg_duration_ms !== null);

    // Compute per-bucket percentiles only if there is duration data
    const percentileMap: Record<string, { p50: number | null; p95: number | null; p99: number | null }> = {};

    if (hasDurations) {
      // Fetch all durations in the range, grouped by bucket, sorted ascending
      const { results: durationRows } = await c.env.DB.prepare(`
        SELECT
          strftime('${strftimeFmt}', created_at) AS bucket,
          duration_ms
        FROM logs
        WHERE created_at >= datetime('now', '${cutoff}')
          AND duration_ms IS NOT NULL
          AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')
        ORDER BY bucket ASC, duration_ms ASC
      `).all<{ bucket: string; duration_ms: number }>();

      // Group durations by bucket
      const grouped: Record<string, number[]> = {};
      for (const row of durationRows || []) {
        if (!grouped[row.bucket]) grouped[row.bucket] = [];
        grouped[row.bucket].push(row.duration_ms);
      }

      // Calculate percentiles from sorted arrays
      for (const [bucket, durations] of Object.entries(grouped)) {
        const n = durations.length;
        const p50Idx = Math.min(Math.floor(n * 0.5), n - 1);
        const p95Idx = Math.min(Math.floor(n * 0.95), n - 1);
        const p99Idx = Math.min(Math.floor(n * 0.99), n - 1);
        percentileMap[bucket] = {
          p50: durations[p50Idx],
          p95: durations[p95Idx],
          p99: durations[p99Idx],
        };
      }
    }

    // Build the final buckets array
    const buckets = rows.map(r => {
      const pctls = percentileMap[r.bucket] || { p50: null, p95: null, p99: null };
      return {
        timestamp: r.bucket,
        total: r.total,
        by_level: {
          debug: r.debug_count,
          info: r.info_count,
          warn: r.warn_count,
          error: r.error_count,
        },
        error_rate: r.total > 0 ? r.error_count / r.total : 0,
        avg_duration_ms: r.avg_duration_ms !== null ? Math.round(r.avg_duration_ms * 100) / 100 : null,
        p50_duration_ms: pctls.p50,
        p95_duration_ms: pctls.p95,
        p99_duration_ms: pctls.p99,
      };
    });

    // Top error categories (top 10)
    const { results: errorCategories } = await c.env.DB.prepare(`
      SELECT category, COUNT(*) AS count
      FROM logs
      WHERE created_at >= datetime('now', '${cutoff}')
        AND level = 'error'
        AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')
      GROUP BY category
      ORDER BY count DESC
      LIMIT 10
    `).all<{ category: string; count: number }>();

    // Status code distribution grouped into 2xx, 3xx, 4xx, 5xx, other
    const { results: statusRows } = await c.env.DB.prepare(`
      SELECT
        CASE
          WHEN status_code >= 200 AND status_code < 300 THEN '2xx'
          WHEN status_code >= 300 AND status_code < 400 THEN '3xx'
          WHEN status_code >= 400 AND status_code < 500 THEN '4xx'
          WHEN status_code >= 500 AND status_code < 600 THEN '5xx'
          ELSE 'other'
        END AS status_group,
        COUNT(*) AS count
      FROM logs
      WHERE created_at >= datetime('now', '${cutoff}')
        AND status_code IS NOT NULL
        AND category != 'USER_ACTION' AND (endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')
      GROUP BY status_group
      ORDER BY status_group ASC
    `).all<{ status_group: string; count: number }>();

    return c.json({
      buckets,
      top_error_categories: (errorCategories || []).map(r => ({ category: r.category, count: r.count })),
      status_code_distribution: (statusRows || []).map(r => ({ group: r.status_group, count: r.count })),
      range,
    });
  } catch (error) {
    console.error('Error fetching timeseries stats:', error);
    return c.json({ error: 'Failed to fetch timeseries stats' }, 500);
  }
});

// Get storage usage and limits - FIXED: uses size_after from query meta
app.get('/storage', async (c) => {
  try {
    // Run a simple query to get size_after from meta
    const queryResult = await c.env.DB.prepare('SELECT 1').run();
    const estimatedSize = queryResult.meta.size_after;

    const logsCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM logs')
      .first<{ count: number }>();

    const archivesCount = await c.env.DB.prepare('SELECT COUNT(*) as count FROM archives')
      .first<{ count: number }>();

    const archivesTotalLogs = await c.env.DB.prepare('SELECT SUM(log_count) as total FROM archives')
      .first<{ total: number }>();

    const usagePercent = (estimatedSize / STORAGE_LIMIT_BYTES) * 100;

    return c.json({
      used_bytes: estimatedSize,
      limit_bytes: STORAGE_LIMIT_BYTES,
      usage_percent: Math.round(usagePercent * 100) / 100,
      logs_count: logsCount?.count || 0,
      archives_count: archivesCount?.count || 0,
      archived_logs_total: archivesTotalLogs?.total || 0,
      warning: usagePercent >= STORAGE_WARNING_THRESHOLD * 100,
      should_archive: usagePercent >= STORAGE_ARCHIVE_THRESHOLD * 100,
    });
  } catch (error) {
    console.error('Error fetching storage info:', error);
    return c.json({ error: 'Failed to fetch storage info' }, 500);
  }
});

// List all archives
app.get('/archives', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT id, archive_date, log_count, created_at FROM archives ORDER BY archive_date DESC'
    ).all<Omit<Archive, 'data'>>();

    return c.json({ archives: results || [] });
  } catch (error) {
    console.error('Error fetching archives:', error);
    return c.json({ error: 'Failed to fetch archives' }, 500);
  }
});

// Download a specific archive as JSON
app.get('/archives/:date/download', async (c) => {
  try {
    const date = c.req.param('date');

    const archive = await c.env.DB.prepare(
      'SELECT * FROM archives WHERE archive_date = ?'
    )
      .bind(date)
      .first<Archive>();

    if (!archive) {
      return c.json({ error: 'Archive not found' }, 404);
    }

    const logs = JSON.parse(archive.data);

    return new Response(JSON.stringify(logs, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="logs-${date}.json"`,
      },
    });
  } catch (error) {
    console.error('Error downloading archive:', error);
    return c.json({ error: 'Failed to download archive' }, 500);
  }
});

// Export all archives as a single JSON file
app.get('/archives/export-all', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT * FROM archives ORDER BY archive_date ASC'
    ).all<Archive>();

    const allLogs: Log[] = [];
    for (const archive of results || []) {
      const logs = JSON.parse(archive.data);
      allLogs.push(...logs);
    }

    return new Response(JSON.stringify(allLogs, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="all-logs-export-${new Date().toISOString().split('T')[0]}.json"`,
      },
    });
  } catch (error) {
    console.error('Error exporting archives:', error);
    return c.json({ error: 'Failed to export archives' }, 500);
  }
});

// Manually trigger archiving of old logs
app.post('/archives/run', async (c) => {
  try {
    const result = await archiveOldLogs(c.env.DB);
    return c.json(result);
  } catch (error) {
    console.error('Error running archive:', error);
    return c.json({ error: 'Failed to run archive' }, 500);
  }
});

// Delete an archive (frees up space)
app.delete('/archives/:date', async (c) => {
  try {
    const date = c.req.param('date');

    const result = await c.env.DB.prepare('DELETE FROM archives WHERE archive_date = ?')
      .bind(date)
      .run();

    if (result.meta.changes === 0) {
      return c.json({ error: 'Archive not found' }, 404);
    }

    return c.json({ success: true, message: 'Archive deleted' });
  } catch (error) {
    console.error('Error deleting archive:', error);
    return c.json({ error: 'Failed to delete archive' }, 500);
  }
});

// Archive old logs function
async function archiveOldLogs(db: D1Database): Promise<{
  archived: number;
  dates: string[];
}> {
  const dates: string[] = [];
  let totalArchived = 0;

  // Get distinct dates older than DAYS_TO_KEEP_IN_LOGS
  const { results: oldDates } = await db.prepare(`
    SELECT DISTINCT DATE(created_at) as log_date
    FROM logs
    WHERE created_at < datetime('now', '-${DAYS_TO_KEEP_IN_LOGS} days')
    ORDER BY log_date ASC
  `).all<{ log_date: string }>();

  for (const { log_date } of oldDates || []) {
    // Get all logs for this date
    const { results: logsForDate } = await db.prepare(`
      SELECT * FROM logs
      WHERE DATE(created_at) = ?
      ORDER BY created_at ASC
    `)
      .bind(log_date)
      .all<Log>();

    if (!logsForDate || logsForDate.length === 0) continue;

    // Check if archive already exists for this date
    const existing = await db.prepare(
      'SELECT id FROM archives WHERE archive_date = ?'
    )
      .bind(log_date)
      .first();

    if (existing) {
      // Append to existing archive
      const existingArchive = await db.prepare(
        'SELECT data, log_count FROM archives WHERE archive_date = ?'
      )
        .bind(log_date)
        .first<{ data: string; log_count: number }>();

      if (existingArchive) {
        const existingLogs = JSON.parse(existingArchive.data);
        const mergedLogs = [...existingLogs, ...logsForDate];

        await db.prepare(
          'UPDATE archives SET data = ?, log_count = ? WHERE archive_date = ?'
        )
          .bind(JSON.stringify(mergedLogs), mergedLogs.length, log_date)
          .run();
      }
    } else {
      // Create new archive
      await db.prepare(
        'INSERT INTO archives (archive_date, log_count, data) VALUES (?, ?, ?)'
      )
        .bind(log_date, logsForDate.length, JSON.stringify(logsForDate))
        .run();
    }

    // Delete archived logs from main table
    await db.prepare('DELETE FROM logs WHERE DATE(created_at) = ?')
      .bind(log_date)
      .run();

    dates.push(log_date);
    totalArchived += logsForDate.length;
  }

  return { archived: totalArchived, dates };
}

// Scheduled handler for automatic archiving, behaviour retry, and purge
async function scheduled(
  _event: ScheduledEvent,
  env: Bindings,
  _ctx: ExecutionContext
): Promise<void> {
  console.log('Running scheduled jobs...');

  // 1. Archive old logs (existing)
  try {
    const result = await archiveOldLogs(env.DB);
    console.log(`Archived ${result.archived} logs from dates: ${result.dates.join(', ')}`);
  } catch (error) {
    console.error('Scheduled archive failed:', error);
  }

  // 2. Reconciliar `log_dimensions` con lo que queda vivo en `logs`. `recordDimensions`
  //    solo añade; sin esto, un device_id de hace meses se quedaría para siempre en el
  //    desplegable aunque su log ya esté archivado. UNA pasada por la tabla al día.
  //    El `WHERE category != 'USER_ACTION'` es el MISMO filtro que aplica
  //    `recordDimensions`: una fila de comportamiento atascada (falló su
  //    processBehaviourLog) tiene user_id y device_id que no deben salir en los
  //    desplegables ni inflar `uniqueUsers` en /stats, que la excluye explícitamente.
  try {
    const { results } = await env.DB.prepare(
      `SELECT DISTINCT user_id, device_id, source,
              CASE WHEN ${DASHBOARD_ROW_SQL} THEN category END AS category
         FROM logs
        WHERE category != 'USER_ACTION'`
    ).all<{ user_id: string | null; device_id: string | null; source: string | null; category: string | null }>();

    const live = new Set<string>();
    for (const r of results || []) {
      if (r.user_id) live.add(`user_id\u0000${r.user_id}`);
      if (r.device_id) live.add(`device_id\u0000${r.device_id}`);
      if (r.source) live.add(`source\u0000${r.source}`);
      if (r.category) live.add(`category\u0000${r.category}`);
    }

    const { results: stored } = await env.DB.prepare(
      'SELECT kind, value FROM log_dimensions'
    ).all<{ kind: string; value: string }>();
    const known = new Set((stored || []).map((r) => `${r.kind}\u0000${r.value}`));

    const del = env.DB.prepare('DELETE FROM log_dimensions WHERE kind = ? AND value = ?');
    const ins = env.DB.prepare('INSERT OR IGNORE INTO log_dimensions (kind, value) VALUES (?, ?)');
    const writes = [
      ...[...known].filter((k) => !live.has(k)).map((k) => del.bind(...k.split('\u0000'))),
      ...[...live].filter((k) => !known.has(k)).map((k) => ins.bind(...k.split('\u0000'))),
    ];
    if (writes.length > 0) {
      await env.DB.batch(writes);
      console.log(`Reconciled log_dimensions: ${writes.length} changes`);
    }
  } catch (error) {
    console.error('log_dimensions reconcile failed:', error);
  }

  // 3. Retry stale behaviour logs (failed inline processing)
  try {
    const stale = await env.DB.prepare(
      `SELECT * FROM logs WHERE category = 'USER_ACTION'
       AND created_at < datetime('now', '-1 hour')`
    ).all<Log>();

    let retried = 0;
    for (const log of stale.results ?? []) {
      try {
        await processBehaviourLog(env.ANALYTICS_DB, {
          user_id: log.user_id,
          device_id: log.device_id,
          message: log.message,
          metadata: log.metadata,
          environment: log.environment,
          source: log.source,
          created_at: log.created_at,
          session_id: log.session_id,
          app_version: log.app_version,
          os_version: log.os_version,
          device_model: log.device_model,
          network_type: log.network_type,
        });
        await env.DB.prepare('DELETE FROM logs WHERE id = ?').bind(log.id).run();
        retried++;
      } catch (e) {
        console.error(`Retry failed for log ${log.id}:`, e);
      }
    }
    if (retried > 0) console.log(`Retried ${retried} stale behaviour logs`);
  } catch (error) {
    console.error('Behaviour retry failed:', error);
  }

}

// Cross-system trace correlation. Joins logs + behaviour_events: first
// finds all logs sharing this trace_id, then pulls behaviour events whose
// session_id intersects (behaviour_events doesn't carry trace_id directly
// in the current schema).
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

app.post('/admin/reprocess', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM logs WHERE category = 'USER_ACTION' ORDER BY created_at ASC`
    ).all<Log>();

    let processed = 0;
    let failed = 0;
    for (const log of results ?? []) {
      try {
        await processBehaviourLog(c.env.ANALYTICS_DB, {
          user_id: log.user_id,
          device_id: log.device_id,
          message: log.message,
          metadata: log.metadata,
          environment: log.environment,
          source: log.source,
          created_at: log.created_at,
          session_id: log.session_id,
          app_version: log.app_version,
          os_version: log.os_version,
          device_model: log.device_model,
          network_type: log.network_type,
        });
        await c.env.DB.prepare('DELETE FROM logs WHERE id = ?').bind(log.id).run();
        processed++;
      } catch (e) {
        failed++;
        console.error(`Reprocess failed for log ${log.id}:`, e);
      }
    }

    return c.json({ processed, failed, total: (results ?? []).length });
  } catch (error) {
    console.error('Reprocess error:', error);
    return c.json({ error: 'Reprocess failed' }, 500);
  }
});

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

// Mount MCP HTTP sub-router. Auth: pl_live_ bearer only — agents call directly,
// session cookies are intentionally rejected on this surface. The mcp module
// is intentionally generic over Bindings; cast to keep it decoupled.
app.route('/mcp', createMcpRouter(app as unknown as Parameters<typeof createMcpRouter>[0]));

export default {
  fetch: app.fetch,
  scheduled,
};
