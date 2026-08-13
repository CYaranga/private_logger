import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    ANALYTICS_DB: D1Database;
  }
}

// Fichero aparte de behaviour.test.ts: el aislamiento de storage de
// vitest-pool-workers es POR FICHERO, y alli hace falta que daily_aggregates
// NO exista. Aqui si existe, para ejercer el camino feliz completo.
async function setupSchema() {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT, environment TEXT DEFAULT 'dev', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT DEFAULT 'info', category TEXT DEFAULT 'GENERAL', http_method TEXT, endpoint TEXT, request_data TEXT, response_data TEXT, status_code INTEGER, duration_ms REAL, device_id TEXT, source TEXT DEFAULT NULL, session_id TEXT DEFAULT NULL, trace_id TEXT DEFAULT NULL, app_version TEXT DEFAULT NULL, os_version TEXT DEFAULT NULL, device_model TEXT DEFAULT NULL, network_type TEXT DEFAULT NULL, fingerprint TEXT DEFAULT NULL, breadcrumbs TEXT DEFAULT NULL)`);

  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS behaviour_events (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT, action TEXT NOT NULL, subject TEXT NOT NULL, screen TEXT, metadata TEXT, environment TEXT DEFAULT 'dev', source TEXT, created_at TEXT DEFAULT (datetime('now')), session_id TEXT DEFAULT NULL, app_version TEXT DEFAULT NULL, os_version TEXT DEFAULT NULL, device_model TEXT DEFAULT NULL, network_type TEXT DEFAULT NULL)`);
  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS daily_aggregates (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, environment TEXT DEFAULT 'dev', source TEXT, count INTEGER DEFAULT 0, unique_users INTEGER DEFAULT 0, UNIQUE(date, action, subject, environment, source))`);
  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS daily_users (date TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL, environment TEXT DEFAULT 'dev', source TEXT, UNIQUE(date, action, subject, user_id, environment, source))`);
  await env.ANALYTICS_DB.exec(`CREATE TABLE IF NOT EXISTS daily_aggregates_by_version (id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, action TEXT NOT NULL, subject TEXT NOT NULL, environment TEXT DEFAULT 'dev', source TEXT, app_version TEXT, count INTEGER DEFAULT 0, unique_users INTEGER DEFAULT 0, UNIQUE(date, action, subject, environment, source, app_version))`);
}

async function postAction(user_id: string) {
  const res = await SELF.fetch('https://example.com/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      user_id,
      message: 'calendar:map_toggled',
      category: 'USER_ACTION',
      source: 'web',
      environment: 'dev',
      app_version: '2.0.145',
      metadata: { screen: '/calendar' },
    }),
  });
  expect(res.status).toBe(201);
}

describe('POST /logs USER_ACTION — agregados', () => {
  beforeAll(async () => {
    await setupSchema();
  });

  // El batch cambio unique_users de "SELECT COUNT(*) y luego UPDATE con el
  // valor" a un subselect dentro del propio UPDATE. Si el subselect estuviera
  // mal, los agregados se romperian en silencio: nadie lanza, solo salen mal.
  it('cuenta eventos y usuarios unicos, y vacia la fila cruda de logs', async () => {
    await postAction('u1');
    await postAction('u1');
    await postAction('u2');

    const agg = await env.ANALYTICS_DB.prepare(
      `SELECT count, unique_users FROM daily_aggregates
       WHERE action = 'calendar' AND subject = 'map_toggled'`
    ).first<{ count: number; unique_users: number }>();
    expect(agg?.count).toBe(3);
    expect(agg?.unique_users).toBe(2);

    const events = await env.ANALYTICS_DB.prepare(
      `SELECT COUNT(*) AS n FROM behaviour_events WHERE action = 'calendar'`
    ).first<{ n: number }>();
    expect(events?.n).toBe(3);

    const byVersion = await env.ANALYTICS_DB.prepare(
      `SELECT app_version, count FROM daily_aggregates_by_version WHERE action = 'calendar'`
    ).first<{ app_version: string; count: number }>();
    expect(byVersion?.app_version).toBe('2.0.145');
    expect(byVersion?.count).toBe(3);

    // Las USER_ACTION no se quedan en `logs`: se procesan y se borran.
    const retained = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM logs WHERE category = 'USER_ACTION'`
    ).first<{ n: number }>();
    expect(retained?.n).toBe(0);
  });
});
