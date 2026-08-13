import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import { hashToken } from './tokens';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    ANALYTICS_DB: D1Database;
  }
}

// Token de agente. authMiddleware solo compara el hash SHA-256 contra
// api_tokens, asi que basta con sembrar la fila para autenticar.
const TOKEN = `pl_live_${'a'.repeat(32)}`;
const AUTH = { Authorization: `Bearer ${TOKEN}` };

// OJO: este fichero NO crea daily_aggregates a proposito. El ultimo test
// necesita que una escritura POSTERIOR al INSERT de behaviour_events falle
// para comprobar que processBehaviourLog es atomico; la forma mas honesta de
// provocarlo es que le falte la tabla del segundo statement.
async function setupSchema() {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT, environment TEXT DEFAULT 'dev', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT DEFAULT 'info', category TEXT DEFAULT 'GENERAL', http_method TEXT, endpoint TEXT, request_data TEXT, response_data TEXT, status_code INTEGER, duration_ms REAL, device_id TEXT, source TEXT DEFAULT NULL, session_id TEXT DEFAULT NULL, trace_id TEXT DEFAULT NULL, app_version TEXT DEFAULT NULL, os_version TEXT DEFAULT NULL, device_model TEXT DEFAULT NULL, network_type TEXT DEFAULT NULL, fingerprint TEXT DEFAULT NULL, breadcrumbs TEXT DEFAULT NULL)`);
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS api_tokens (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL UNIQUE, prefix TEXT NOT NULL, name TEXT NOT NULL, user_id INTEGER NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME, last_used DATETIME)`);

  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS behaviour_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT, action TEXT NOT NULL, subject TEXT NOT NULL, screen TEXT, metadata TEXT, environment TEXT DEFAULT 'dev', source TEXT, created_at TEXT DEFAULT (datetime('now')), session_id TEXT DEFAULT NULL, app_version TEXT DEFAULT NULL, os_version TEXT DEFAULT NULL, device_model TEXT DEFAULT NULL, network_type TEXT DEFAULT NULL)`);
  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS daily_users (date TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, environment TEXT DEFAULT 'dev', source TEXT, UNIQUE(date, action, subject, user_id, environment, source))`);
  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS daily_aggregates_by_version (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, environment TEXT DEFAULT 'dev', source TEXT, app_version TEXT, count INTEGER DEFAULT 0, unique_users INTEGER DEFAULT 0, UNIQUE(date, action, subject, environment, source, app_version))`);
}

async function seed() {
  await env.DB.prepare('INSERT INTO users (id, username, password_hash) VALUES (1, ?, ?)')
    .bind('agent', 'unused').run();
  await env.DB.prepare('INSERT INTO api_tokens (hash, prefix, name, user_id) VALUES (?, ?, ?, 1)')
    .bind(await hashToken(TOKEN), TOKEN.slice(0, 12), 'test').run();

  // Una sesion completa de un usuario que reporta un fallo, mas ruido de otro
  // usuario/plataforma para que los filtros tengan algo que descartar.
  const rows: Array<[string, string, string, string, string | null, string, string, string, string]> = [
    ['70', 'navigation', 'screen_view', 'sess-a', '/calendar', 'web', 'dev', '2.0.145', '2026-08-12 13:08:20'],
    ['70', 'calendar', 'view_mode_changed', 'sess-a', '/calendar', 'web', 'dev', '2.0.145', '2026-08-12 13:08:22'],
    ['70', 'calendar', 'map_toggled', 'sess-a', '/calendar', 'web', 'dev', '2.0.145', '2026-08-12 13:08:24'],
    ['70', 'chat', 'message_sent', 'sess-a', '/chat', 'web', 'dev', '2.0.145', '2026-08-12 13:08:26'],
    ['99', 'navigation', 'screen_view', 'sess-b', '/home', 'travel-mobile-ios', 'prod', '2.0.144', '2026-08-12 13:09:00'],
  ];
  for (const [user_id, action, subject, session_id, screen, source, environment, app_version, created_at] of rows) {
    await env.ANALYTICS_DB.prepare(
      `INSERT INTO behaviour_events (user_id, action, subject, session_id, screen, metadata, source, environment, app_version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(user_id, action, subject, session_id, screen, JSON.stringify({ screen }), source, environment, app_version, created_at).run();
  }
}

type EventsResponse = {
  events: Array<{ action: string; subject: string; session_id: string | null; user_id: string; source: string | null; metadata: unknown }>;
  count: number;
};

// beforeAll a nivel de FICHERO, no dentro de cada describe: vitest-pool-workers
// aisla el storage y deshace lo que escribe el beforeAll de un describe en
// cuanto ese describe termina, asi que la semilla no llegaria al siguiente.
beforeAll(async () => {
  await setupSchema();
  await seed();
});

describe('GET /behaviour/events', () => {
  it('rechaza sin token: expone datos por usuario, no agregados', async () => {
    const res = await SELF.fetch('https://example.com/behaviour/events');
    expect(res.status).toBe(401);
  });

  it('reconstruye una sesion en orden cronologico', async () => {
    const res = await SELF.fetch('https://example.com/behaviour/events?session_id=sess-a', { headers: AUTH });
    expect(res.status).toBe(200);
    const body = await res.json() as EventsResponse;
    expect(body.count).toBe(4);
    expect(body.events.map((e) => `${e.action}:${e.subject}`)).toEqual([
      'navigation:screen_view',
      'calendar:view_mode_changed',
      'calendar:map_toggled',
      'chat:message_sent',
    ]);
  });

  it('con limit devuelve los mas RECIENTES, no los mas viejos', async () => {
    const res = await SELF.fetch('https://example.com/behaviour/events?session_id=sess-a&limit=2', { headers: AUTH });
    const body = await res.json() as EventsResponse;
    expect(body.events.map((e) => `${e.action}:${e.subject}`)).toEqual([
      'calendar:map_toggled',
      'chat:message_sent',
    ]);
  });

  it('filtra por user_id, action, source y app_version', async () => {
    const byUser = await (await SELF.fetch('https://example.com/behaviour/events?user_id=99', { headers: AUTH })).json() as EventsResponse;
    expect(byUser.count).toBe(1);
    expect(byUser.events[0].source).toBe('travel-mobile-ios');

    const byAction = await (await SELF.fetch('https://example.com/behaviour/events?action=calendar', { headers: AUTH })).json() as EventsResponse;
    expect(byAction.count).toBe(2);

    const bySubject = await (await SELF.fetch('https://example.com/behaviour/events?action=calendar&subject=map_toggled', { headers: AUTH })).json() as EventsResponse;
    expect(bySubject.count).toBe(1);

    const byVersion = await (await SELF.fetch('https://example.com/behaviour/events?app_version=2.0.144', { headers: AUTH })).json() as EventsResponse;
    expect(byVersion.count).toBe(1);
  });

  it('filtra por rango de fechas y por texto libre', async () => {
    const byDate = await (await SELF.fetch('https://example.com/behaviour/events?start_date=2026-08-12 13:08:24', { headers: AUTH })).json() as EventsResponse;
    expect(byDate.count).toBe(3);

    const bySearch = await (await SELF.fetch('https://example.com/behaviour/events?search=chat', { headers: AUTH })).json() as EventsResponse;
    expect(bySearch.count).toBe(1);
  });

  it('devuelve metadata ya parseada para que el agente no tenga que hacerlo', async () => {
    const body = await (await SELF.fetch('https://example.com/behaviour/events?session_id=sess-a&limit=1', { headers: AUTH })).json() as EventsResponse;
    expect(body.events[0].metadata).toEqual({ screen: '/chat' });
  });
});

describe('MCP tool search_behaviour', () => {
  // El registro del tool ya se cubre en mcp.test.ts; esto comprueba el cableado
  // completo: JSON-RPC -> innerFetch -> authMiddleware con el mismo bearer ->
  // /behaviour/events. Si el tool apuntara a una ruta que no existe o el token
  // no se propagara, aqui saldria 404/401 y no filas.
  it('devuelve la sesion a traves de JSON-RPC', async () => {
    const res = await SELF.fetch('https://example.com/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...AUTH },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'search_behaviour', arguments: { session_id: 'sess-a' } },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { result?: { content: Array<{ text: string }> } };
    const payload = JSON.parse(body.result!.content[0].text) as EventsResponse;
    expect(payload.count).toBe(4);
    expect(payload.events[0].subject).toBe('screen_view');
  });
});

describe('processBehaviourLog es atomico', () => {
  // Regresion de las ~47 filas USER_ACTION atascadas en `logs`: cuando fallaba
  // una escritura posterior a la del evento, el evento YA estaba insertado pero
  // la fila de `logs` se retenia para reintento -> el cron lo reinsertaba y
  // duplicaba el evento y los agregados. Con las 5 escrituras en un batch()
  // (una sola transaccion en D1) el fallo no deja nada a medias.
  it('no deja el evento suelto si falla una escritura posterior', async () => {
    const userId = `atomic-${Date.now()}`;
    const res = await SELF.fetch('https://example.com/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        user_id: userId,
        message: 'calendar:map_toggled',
        category: 'USER_ACTION',
        source: 'web',
        environment: 'dev',
        metadata: {},
      }),
    });
    expect(res.status).toBe(201);

    const event = await env.ANALYTICS_DB.prepare(
      'SELECT COUNT(*) AS n FROM behaviour_events WHERE user_id = ?'
    ).bind(userId).first<{ n: number }>();
    expect(event?.n).toBe(0);

    // Y la fila cruda sigue en `logs` para que el cron la reintente entera.
    const retained = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM logs WHERE user_id = ?'
    ).bind(userId).first<{ n: number }>();
    expect(retained?.n).toBe(1);
  });
});
