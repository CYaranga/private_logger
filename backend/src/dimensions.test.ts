import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF, createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import worker from './index';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
    ANALYTICS_DB: D1Database;
  }
}

// Cobertura del cambio que sacó los desplegables y /stats de barrer `logs` en cada
// refresco del dashboard (cuota diaria de lecturas de D1 reventada, 2026-09-03).
const LOGS_DDL = `CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, message TEXT NOT NULL, metadata TEXT, environment TEXT DEFAULT 'dev', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT DEFAULT 'info', category TEXT DEFAULT 'GENERAL', http_method TEXT, endpoint TEXT, request_data TEXT, response_data TEXT, status_code INTEGER, duration_ms REAL, device_id TEXT, source TEXT DEFAULT NULL, session_id TEXT DEFAULT NULL, trace_id TEXT DEFAULT NULL, app_version TEXT DEFAULT NULL, os_version TEXT DEFAULT NULL, device_model TEXT DEFAULT NULL, network_type TEXT DEFAULT NULL, fingerprint TEXT DEFAULT NULL, breadcrumbs TEXT DEFAULT NULL)`;

beforeAll(async () => {
  await env.DB.exec(LOGS_DDL);
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS log_dimensions (kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (kind, value))`);
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS archives (id INTEGER PRIMARY KEY AUTOINCREMENT, archive_date TEXT NOT NULL UNIQUE, log_count INTEGER NOT NULL, data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
});

async function post(body: Record<string, unknown>) {
  return SELF.fetch('https://example.com/logs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function get<T>(path: string): Promise<T> {
  const res = await SELF.fetch(`https://example.com${path}`);
  expect(res.status).toBe(200);
  return res.json() as Promise<T>;
}

describe('log_dimensions alimenta los desplegables', () => {
  it('un log nuevo aparece en /users, /devices, /sources y /categories', async () => {
    expect((await post({
      user_id: 'u-dim-1', device_id: 'dev-dim-1', source: 'ios', category: 'API',
      message: 'hola',
    })).status).toBe(201);

    expect((await get<{ users: string[] }>('/users')).users).toContain('u-dim-1');
    expect((await get<{ devices: string[] }>('/devices')).devices).toContain('dev-dim-1');
    expect((await get<{ sources: string[] }>('/sources')).sources).toContain('ios');
    expect((await get<{ categories: string[] }>('/categories')).categories).toContain('API');
  });

  // El dashboard esconde el ruido de [HTTP] en debug; su categoría no debe llenar el
  // desplegable, pero el usuario y el dispositivo sí siguen siendo reales.
  it('no registra la categoria de una fila que el dashboard esconde', async () => {
    await post({
      user_id: 'u-dim-2', device_id: 'dev-dim-2', source: 'web',
      level: 'debug', category: 'RUIDO_HTTP', message: '[HTTP] GET /x',
    });
    expect((await get<{ categories: string[] }>('/categories')).categories).not.toContain('RUIDO_HTTP');
    expect((await get<{ users: string[] }>('/users')).users).toContain('u-dim-2');
  });

  // Los logs de comportamiento se borran de `logs` nada más procesarlos: sus valores
  // no deben salir en ningún desplegable ni inflar `uniqueUsers`.
  it('no registra dimensiones de un log de comportamiento', async () => {
    await post({
      user_id: 'u-behaviour', device_id: 'dev-behaviour', source: 'android',
      category: 'USER_ACTION', message: 'calendar:map_toggled',
    });
    expect((await get<{ users: string[] }>('/users')).users).not.toContain('u-behaviour');
    expect((await get<{ devices: string[] }>('/devices')).devices).not.toContain('dev-behaviour');
  });
});

describe('reconciliacion nocturna de log_dimensions', () => {
  it('borra los valores cuyo log ya no existe y NO adopta los de un USER_ACTION atascado', async () => {
    await env.DB.prepare(
      `INSERT INTO log_dimensions (kind, value) VALUES ('user_id', 'u-fantasma'), ('device_id', 'dev-fantasma')`
    ).run();
    // Fila de comportamiento que se quedó sin procesar: el reintento vive en el paso
    // siguiente del mismo cron, así que el reconcile la ve viva.
    await env.DB.prepare(
      `INSERT INTO logs (user_id, device_id, source, category, message) VALUES ('u-atascado', 'dev-atascado', 'ios', 'USER_ACTION', 'x')`
    ).run();
    // Log normal vivo: el aislamiento de storage de vitest-pool-workers es POR TEST,
    // asi que este bloque no ve lo que insertaron los anteriores.
    await env.DB.prepare(
      `INSERT INTO logs (user_id, device_id, source, category, message) VALUES ('u-vivo', 'dev-vivo', 'ios', 'API', 'ok')`
    ).run();

    const ctx = createExecutionContext();
    // `env` de cloudflare:test no declara los bindings que no usa este fichero
    // (SCREENSHOTS); el handler solo toca DB y ANALYTICS_DB.
    await worker.scheduled(
      { cron: '0 3 * * *', scheduledTime: Date.now(), noRetry: () => {} } as never,
      env as unknown as Parameters<typeof worker.scheduled>[1],
      ctx
    );
    await waitOnExecutionContext(ctx);

    const users = (await get<{ users: string[] }>('/users')).users;
    const devices = (await get<{ devices: string[] }>('/devices')).devices;
    expect(users).not.toContain('u-fantasma');
    expect(devices).not.toContain('dev-fantasma');
    expect(users).not.toContain('u-atascado');
    expect(devices).not.toContain('dev-atascado');
    // El log normal sigue vivo, así que su valor se conserva (y se adopta, porque
    // se insertó por SQL directo sin pasar por recordDimensions).
    expect(users).toContain('u-vivo');
    expect(devices).toContain('dev-vivo');
  });
});

describe('/logs?count=0', () => {
  it('omite el total en vez de ejecutar el COUNT', async () => {
    const con = await get<{ total?: number; total_is_capped?: boolean }>('/logs?limit=1');
    expect(typeof con.total).toBe('number');

    const sin = await get<{ total?: number; total_is_capped?: boolean; logs: unknown[] }>('/logs?limit=1&count=0');
    expect(sin.total).toBeUndefined();
    expect(sin.total_is_capped).toBeUndefined();
    expect(Array.isArray(sin.logs)).toBe(true);
  });
});

// Oraculo: las NUEVE consultas que hacia /stats antes de fusionarse en una sola
// pasada agrupada. Si el rollup deriva mal cualquiera de los ocho agregados, esto
// lo caza. El filtro extendido va literal, tal como estaba en cada consulta.
const DASH = `(endpoint IS NULL OR endpoint NOT LIKE '%/behaviour/%') AND NOT (level = 'debug' AND message LIKE '[HTTP]%')`;

describe('/stats: la agregacion fusionada da lo mismo que las nueve consultas', () => {
  it('coincide en total, last24Hours, apiCalls, errorCount, byLevel, byEnvironment, byCategory y bySource', async () => {
    const rows: Array<[string, string | null, string | null, string, string, string | null, string | null, string]> = [
      // user_id, device_id, source, environment, level, category, endpoint, message
      ['u1', 'd1', 'ios', 'prod', 'info', 'API', '/a', 'ok'],
      ['u1', 'd1', 'ios', 'prod', 'error', 'API', '/a', 'boom'],
      ['u2', 'd2', 'web', 'dev', 'error', 'UI', null, 'boom2'],
      ['u2', 'd2', 'web', 'dev', 'debug', 'UI', null, '[HTTP] GET /x'],   // escondida
      ['u3', 'd3', 'ios', 'prod', 'info', 'API', '/clients/behaviour/log', 'b'], // escondida
      ['u3', 'd3', 'ios', 'prod', 'info', 'USER_ACTION', null, 'tap'],    // fuera de /stats
      ['u4', null, null, 'prod', 'warn', null, null, 'sin categoria'],
    ];
    for (const [user_id, device_id, source, environment, level, category, endpoint, message] of rows) {
      await env.DB.prepare(
        `INSERT INTO logs (user_id, device_id, source, environment, level, category, endpoint, message, http_method)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(user_id, device_id, source, environment, level, category, endpoint, message, endpoint ? 'GET' : null).run();
    }

    const scalar = async (sql: string) =>
      (await env.DB.prepare(sql).first<{ count: number }>())?.count ?? 0;

    const esperado = {
      total: await scalar(`SELECT COUNT(*) as count FROM logs WHERE category != 'USER_ACTION'`),
      last24Hours: await scalar(`SELECT COUNT(*) as count FROM logs WHERE created_at >= datetime('now', '-24 hours') AND category != 'USER_ACTION' AND ${DASH}`),
      apiCalls: await scalar(`SELECT COUNT(*) as count FROM logs WHERE http_method IS NOT NULL AND category != 'USER_ACTION' AND ${DASH}`),
      errorCount: await scalar(`SELECT COUNT(*) as count FROM logs WHERE level = 'error' AND category != 'USER_ACTION' AND ${DASH}`),
    };
    const { results: byLevelViejo } = await env.DB.prepare(
      `SELECT level, COUNT(*) as count FROM logs WHERE category != 'USER_ACTION' GROUP BY level`
    ).all<{ level: string; count: number }>();
    const { results: byEnvViejo } = await env.DB.prepare(
      `SELECT environment, COUNT(*) as count FROM logs WHERE category != 'USER_ACTION' GROUP BY environment`
    ).all<{ environment: string; count: number }>();
    const { results: byCatViejo } = await env.DB.prepare(
      `SELECT category, COUNT(*) as count FROM logs WHERE category != 'USER_ACTION' GROUP BY category ORDER BY count DESC LIMIT 10`
    ).all<{ category: string; count: number }>();
    const { results: bySrcViejo } = await env.DB.prepare(
      `SELECT source, COUNT(*) as count FROM logs WHERE source IS NOT NULL AND category != 'USER_ACTION' AND ${DASH} GROUP BY source ORDER BY count DESC`
    ).all<{ source: string; count: number }>();

    const stats = await get<{
      total: number; last24Hours: number; apiCalls: number; errorCount: number;
      byLevel: { level: string; count: number }[];
      byEnvironment: { environment: string; count: number }[];
      byCategory: { category: string; count: number }[];
      bySource: { source: string; count: number }[];
    }>('/stats');

    expect(stats.total).toBe(esperado.total);
    expect(stats.last24Hours).toBe(esperado.last24Hours);
    expect(stats.apiCalls).toBe(esperado.apiCalls);
    expect(stats.errorCount).toBe(esperado.errorCount);

    const norm = <T extends Record<string, unknown>>(a: T[], k: keyof T) =>
      [...a].map((r) => `${r[k] ?? 'NULL'}=${r.count}`).sort();
    expect(norm(stats.byLevel, 'level')).toEqual(norm(byLevelViejo || [], 'level'));
    expect(norm(stats.byEnvironment, 'environment')).toEqual(norm(byEnvViejo || [], 'environment'));
    expect(norm(stats.byCategory, 'category')).toEqual(norm(byCatViejo || [], 'category'));
    expect(norm(stats.bySource, 'source')).toEqual(norm(bySrcViejo || [], 'source'));
  });
});
