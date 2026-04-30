import { describe, it, expect, beforeAll } from 'vitest';
import { snapshotRelatedLogIds } from './bugs';
import { env } from 'cloudflare:test';

describe('snapshotRelatedLogIds', () => {
  beforeAll(async () => {
    await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, session_id TEXT, message TEXT NOT NULL, metadata TEXT, environment TEXT DEFAULT 'dev', source TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT DEFAULT 'info', category TEXT DEFAULT 'GENERAL', http_method TEXT, endpoint TEXT, request_data TEXT, response_data TEXT, status_code INTEGER, duration_ms REAL)`);
  });

  it('returns up to 10 most recent log ids for a (user_id, session_id) pair', async () => {
    const stmt = env.DB.prepare(
      `INSERT INTO logs (user_id, session_id, message, environment, level, category)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (let i = 0; i < 12; i++) {
      await stmt.bind('u1', 's1', `m${i}`, 'dev', 'info', 'GENERAL').run();
    }
    const ids = await snapshotRelatedLogIds(env.DB, 'u1', 's1');
    expect(ids).toHaveLength(10);
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
