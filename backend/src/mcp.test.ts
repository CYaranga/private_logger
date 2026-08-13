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
    // Los USER_ACTION no viven en `logs`, asi que search_logs jamas los ve:
    // hace falta un tool propio contra behaviour_events.
    expect(body.result?.tools.find((t) => t.name === 'search_behaviour')).toBeTruthy();
    expect(body.result?.tools).toHaveLength(13);
  });
});
