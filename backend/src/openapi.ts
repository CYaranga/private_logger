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
    '/behaviour/events': {
      get: { summary: 'Search raw user-behaviour events', security: [{ bearerToken: [] }, { sessionCookie: [] }] },
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
