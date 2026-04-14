import { Hono, type Context, type Next } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';

type Bindings = {
  DB: D1Database;
  ANALYTICS_DB: D1Database;
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
  level?: LogLevel;
  category?: string;
  http_method?: HttpMethod;
  endpoint?: string;
  request_data?: Record<string, unknown> | string;
  response_data?: Record<string, unknown> | string;
  status_code?: number;
  duration_ms?: number;
};

// Free tier limits
const STORAGE_LIMIT_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const STORAGE_WARNING_THRESHOLD = 0.8; // Warn at 80%
const STORAGE_ARCHIVE_THRESHOLD = 0.7; // Archive when reaching 70%
const DAYS_TO_KEEP_IN_LOGS = 7; // Keep 7 days in main logs table

const BEHAVIOUR_CATEGORIES = new Set(['USER_ACTION']);

async function processBehaviourLog(
  analyticsDb: D1Database,
  log: { user_id: string; device_id: string | null; message: string;
         metadata: string | null; environment: string; source: string | null;
         created_at: string }
): Promise<void> {
  const parts = log.message.split(':');
  const action = parts[0] ?? 'unknown';
  const subject = parts.slice(1).join(':') || 'unknown';
  const date = log.created_at.slice(0, 10);
  const parsed: Record<string, unknown> = log.metadata ? JSON.parse(log.metadata) : {};
  const screen = (parsed.screen as string) ?? null;

  await analyticsDb.prepare(
    `INSERT INTO behaviour_events
       (user_id, device_id, action, subject, screen, metadata, environment, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(log.user_id, log.device_id, action, subject, screen,
         log.metadata, log.environment, log.source, log.created_at).run();

  await analyticsDb.prepare(
    `INSERT INTO daily_aggregates (date, action, subject, environment, source, count, unique_users)
     VALUES (?, ?, ?, ?, ?, 1, 0)
     ON CONFLICT(date, action, subject, environment, source)
     DO UPDATE SET count = count + 1`
  ).bind(date, action, subject, log.environment, log.source).run();

  await analyticsDb.prepare(
    `INSERT OR IGNORE INTO daily_users (date, action, subject, user_id, environment, source)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(date, action, subject, log.user_id, log.environment, log.source).run();

  const row = await analyticsDb.prepare(
    `SELECT COUNT(*) as cnt FROM daily_users
     WHERE date = ? AND action = ? AND subject = ? AND environment = ?
       AND (source IS ? OR (source IS NULL AND ? IS NULL))`
  ).bind(date, action, subject, log.environment, log.source, log.source)
   .first<{ cnt: number }>();

  await analyticsDb.prepare(
    `UPDATE daily_aggregates SET unique_users = ?
     WHERE date = ? AND action = ? AND subject = ? AND environment = ?
       AND (source IS ? OR (source IS NULL AND ? IS NULL))`
  ).bind(row?.cnt ?? 0, date, action, subject, log.environment, log.source, log.source).run();
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
  const sessionToken = getCookie(c, 'session') || c.req.header('Authorization')?.replace('Bearer ', '');

  if (!sessionToken) {
    return c.json({ error: 'Authentication required' }, 401);
  }

  const user = await validateSession(c.env.DB, sessionToken);

  if (!user) {
    return c.json({ error: 'Invalid or expired session' }, 401);
  }

  // Store user in context for later use
  c.set('user' as never, user as never);
  await next();
};

// Auth middleware is available but not applied to API routes.
// Authentication is handled on the frontend side only.

// Create a new log entry
app.post('/logs', async (c) => {
  try {
    const body = await c.req.json<CreateLogInput>();

    if (!body.user_id || !body.message) {
      return c.json({ error: 'user_id and message are required' }, 400);
    }

    const metadata = body.metadata ? JSON.stringify(body.metadata) : null;
    const environment = body.environment || 'dev';
    const source = body.source || null;
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

    const result = await c.env.DB.prepare(
      `INSERT INTO logs (user_id, device_id, message, metadata, environment, source, level, category, http_method, endpoint, request_data, response_data, status_code, duration_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
      .bind(body.user_id, device_id, body.message, metadata, environment, source, level, category, http_method, endpoint, request_data, response_data, status_code, duration_ms)
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
        });
        // Delete from raw logs to free space
        await c.env.DB.prepare('DELETE FROM logs WHERE id = ?')
          .bind(result.id).run();
      } catch (e) {
        console.error('Behaviour processing failed, log retained in raw DB:', e);
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
  };
}

function tryParseJSON(str: string): unknown {
  try {
    return JSON.parse(str);
  } catch {
    return str;
  }
}

// Get all logs with optional filtering
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
    }

    if (http_method) {
      query += ' AND http_method = ?';
      params.push(http_method);
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
    let countQuery = 'SELECT COUNT(*) as count FROM logs WHERE 1=1';
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
    }

    if (http_method) {
      countQuery += ' AND http_method = ?';
      countParams.push(http_method);
    }

    if (search) {
      countQuery += ' AND (message LIKE ? OR metadata LIKE ? OR endpoint LIKE ? OR request_data LIKE ? OR response_data LIKE ? OR device_id LIKE ? OR source LIKE ?)';
      countParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
    }

    const countResult = await c.env.DB.prepare(countQuery)
      .bind(...countParams)
      .first<{ count: number }>();

    return c.json({
      logs: results?.map(parseLogFields) || [],
      total: countResult?.count || 0,
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

    let query = `SELECT * FROM logs WHERE created_at >= datetime('now', '-${hours} hours')`;
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
app.get('/users', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT DISTINCT user_id FROM logs ORDER BY user_id'
    ).all<{ user_id: string }>();

    return c.json({ users: results?.map(r => r.user_id) || [] });
  } catch (error) {
    console.error('Error fetching users:', error);
    return c.json({ error: 'Failed to fetch users' }, 500);
  }
});

// Get unique categories for filtering
app.get('/categories', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT DISTINCT category FROM logs WHERE category IS NOT NULL ORDER BY category'
    ).all<{ category: string }>();

    return c.json({ categories: results?.map(r => r.category) || [] });
  } catch (error) {
    console.error('Error fetching categories:', error);
    return c.json({ error: 'Failed to fetch categories' }, 500);
  }
});

// Get unique device IDs for filtering
app.get('/devices', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT DISTINCT device_id FROM logs WHERE device_id IS NOT NULL ORDER BY device_id'
    ).all<{ device_id: string }>();

    return c.json({ devices: results?.map(r => r.device_id) || [] });
  } catch (error) {
    console.error('Error fetching devices:', error);
    return c.json({ error: 'Failed to fetch devices' }, 500);
  }
});

// Get unique sources for filtering
app.get('/sources', async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      'SELECT DISTINCT source FROM logs WHERE source IS NOT NULL ORDER BY source'
    ).all<{ source: string }>();

    return c.json({ sources: results?.map(r => r.source) || [] });
  } catch (error) {
    console.error('Error fetching sources:', error);
    return c.json({ error: 'Failed to fetch sources' }, 500);
  }
});

// Get log statistics including storage info
app.get('/stats', async (c) => {
  try {
    const totalLogs = await c.env.DB.prepare('SELECT COUNT(*) as count FROM logs')
      .first<{ count: number }>();

    const byEnvironment = await c.env.DB.prepare(
      'SELECT environment, COUNT(*) as count FROM logs GROUP BY environment'
    ).all<{ environment: string; count: number }>();

    const byLevel = await c.env.DB.prepare(
      'SELECT level, COUNT(*) as count FROM logs GROUP BY level'
    ).all<{ level: string; count: number }>();

    const byCategory = await c.env.DB.prepare(
      'SELECT category, COUNT(*) as count FROM logs GROUP BY category ORDER BY count DESC LIMIT 10'
    ).all<{ category: string; count: number }>();

    const bySource = await c.env.DB.prepare(
      'SELECT source, COUNT(*) as count FROM logs WHERE source IS NOT NULL GROUP BY source ORDER BY count DESC'
    ).all<{ source: string; count: number }>();

    const uniqueUsers = await c.env.DB.prepare(
      'SELECT COUNT(DISTINCT user_id) as count FROM logs'
    ).first<{ count: number }>();

    const recentLogs = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM logs WHERE created_at >= datetime('now', '-24 hours')"
    ).first<{ count: number }>();

    // Get archive stats
    const archiveStats = await c.env.DB.prepare(
      'SELECT COUNT(*) as count, SUM(log_count) as total_logs FROM archives'
    ).first<{ count: number; total_logs: number }>();

    // Get API call stats
    const apiCallStats = await c.env.DB.prepare(
      'SELECT COUNT(*) as count FROM logs WHERE http_method IS NOT NULL'
    ).first<{ count: number }>();

    const errorCount = await c.env.DB.prepare(
      "SELECT COUNT(*) as count FROM logs WHERE level = 'error'"
    ).first<{ count: number }>();

    return c.json({
      total: totalLogs?.count || 0,
      uniqueUsers: uniqueUsers?.count || 0,
      last24Hours: recentLogs?.count || 0,
      byEnvironment: byEnvironment.results || [],
      byLevel: byLevel.results || [],
      byCategory: byCategory.results || [],
      bySource: bySource.results || [],
      apiCalls: apiCallStats?.count || 0,
      errorCount: errorCount?.count || 0,
      archives: {
        count: archiveStats?.count || 0,
        totalLogs: archiveStats?.total_logs || 0,
      },
    });
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

  // 2. Retry stale behaviour logs (failed inline processing)
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

export default {
  fetch: app.fetch,
  scheduled,
};
