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
    description: 'Search logs with filters (app_version for a specific build, source for platform e.g. travel-mobile-ios/android, environment, level, dates). Returns paginated entries.',
    inputSchema: { type: 'object', properties: { level: { type: 'string' }, environment: { type: 'string' }, source: { type: 'string' }, user_id: { type: 'string' }, session_id: { type: 'string' }, fingerprint: { type: 'string' }, app_version: { type: 'string' }, search: { type: 'string' }, start_date: { type: 'string' }, end_date: { type: 'string' }, limit: { type: 'integer' } } },
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

// Hono is intentionally untyped here so this module is decoupled from the
// concrete Bindings shape in index.ts. Mount via:
//   app.route('/mcp', createMcpRouter(app as Hono));
// Internal handlers only need `c.env`, `c.executionCtx`, and `c.req` which
// are present on every Hono Context regardless of binding generics.
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
