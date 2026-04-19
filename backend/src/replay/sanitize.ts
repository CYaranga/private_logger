const SENSITIVE = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
]);

export function sanitizeHeadersForStorage(
  headers: Record<string, string> | null | undefined
): Record<string, string> {
  if (!headers) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== '' && SENSITIVE.has(k.toLowerCase())) {
      out[k] = '***';
    } else {
      out[k] = v;
    }
  }
  return out;
}
