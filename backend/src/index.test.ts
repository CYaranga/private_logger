import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';

declare module 'cloudflare:test' {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

// Helper to setup database schema
async function setupDatabase() {
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT NOT NULL, device_id TEXT, message TEXT NOT NULL, metadata TEXT, environment TEXT DEFAULT 'dev', created_at DATETIME DEFAULT CURRENT_TIMESTAMP, level TEXT DEFAULT 'info', category TEXT DEFAULT 'GENERAL', http_method TEXT, endpoint TEXT, request_data TEXT, response_data TEXT, status_code INTEGER, duration_ms REAL)`);

  await env.DB.exec(`CREATE TABLE IF NOT EXISTS archives (id INTEGER PRIMARY KEY AUTOINCREMENT, archive_date TEXT NOT NULL UNIQUE, log_count INTEGER NOT NULL, data TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  await env.DB.exec(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);

  await env.DB.exec(`CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (user_id) REFERENCES users(id))`);
}

describe('Private Logger API', () => {
  beforeAll(async () => {
    await setupDatabase();
  });

  describe('Health Check', () => {
    it('GET / returns status ok', async () => {
      const response = await SELF.fetch('https://example.com/');
      expect(response.status).toBe(200);

      const data = await response.json() as { status: string; service: string };
      expect(data).toMatchObject({
        status: 'ok',
        service: 'private-logger-api',
      });
    });
  });

  describe('Authentication', () => {
    it('protected routes return 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/logs');
      expect(response.status).toBe(401);
    });

    it('POST /auth/login fails with missing credentials', async () => {
      const response = await SELF.fetch('https://example.com/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });

      expect(response.status).toBe(400);
    });

    it('POST /auth/login fails with invalid credentials', async () => {
      const response = await SELF.fetch('https://example.com/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'invalid', password: 'wrong' }),
      });

      expect(response.status).toBe(401);
    });

    it('GET /auth/verify returns false without session', async () => {
      const response = await SELF.fetch('https://example.com/auth/verify');
      expect(response.status).toBe(401);

      const data = await response.json() as { authenticated: boolean };
      expect(data.authenticated).toBe(false);
    });

    it('POST /auth/logout succeeds even without session', async () => {
      const response = await SELF.fetch('https://example.com/auth/logout', {
        method: 'POST',
      });
      expect(response.status).toBe(200);

      const data = await response.json() as { success: boolean };
      expect(data.success).toBe(true);
    });
  });

  describe('Stats Endpoint (unauthenticated should fail)', () => {
    it('GET /stats returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/stats');
      expect(response.status).toBe(401);
    });
  });

  describe('Storage Endpoint (unauthenticated should fail)', () => {
    it('GET /storage returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/storage');
      expect(response.status).toBe(401);
    });
  });

  describe('Users Endpoint (unauthenticated should fail)', () => {
    it('GET /users returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/users');
      expect(response.status).toBe(401);
    });
  });

  describe('Categories Endpoint (unauthenticated should fail)', () => {
    it('GET /categories returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/categories');
      expect(response.status).toBe(401);
    });
  });

  describe('Devices Endpoint (unauthenticated should fail)', () => {
    it('GET /devices returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/devices');
      expect(response.status).toBe(401);
    });
  });

  describe('Archives Endpoints (unauthenticated should fail)', () => {
    it('GET /archives returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/archives');
      expect(response.status).toBe(401);
    });

    it('POST /archives/run returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/archives/run', {
        method: 'POST',
      });
      expect(response.status).toBe(401);
    });
  });

  describe('Log Endpoints (unauthenticated should fail)', () => {
    it('POST /logs returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/logs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: 'test-user',
          message: 'Test log message',
        }),
      });
      expect(response.status).toBe(401);
    });

    it('GET /logs returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/logs');
      expect(response.status).toBe(401);
    });

    it('DELETE /logs/:id returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/logs/1', {
        method: 'DELETE',
      });
      expect(response.status).toBe(401);
    });

    it('POST /logs/bulk-delete returns 401 without auth', async () => {
      const response = await SELF.fetch('https://example.com/logs/bulk-delete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: 'test' }),
      });
      expect(response.status).toBe(401);
    });
  });
});
