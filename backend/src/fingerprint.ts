/**
 * Stable error fingerprint helpers. Normalize transient values out of the
 * message so re-occurrences of the same underlying issue collapse into a
 * single error group, regardless of varying IDs/timestamps/IPs/etc.
 */

export function normalizeMessage(message: string): string {
  return message
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/\b\d{10,}\b/g, '<num>')
    .replace(/\b\d+\.\d+\.\d+\.\d+\b/g, '<ip>')
    .replace(/\b\d+\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 200);
}

export async function computeFingerprint(parts: {
  level: string;
  category: string;
  endpoint: string | null;
  status_code: number | null;
  message: string;
}): Promise<string> {
  const key = [
    parts.level,
    parts.category,
    parts.endpoint ?? '',
    parts.status_code ?? '',
    normalizeMessage(parts.message),
  ].join('|');
  const buf = new TextEncoder().encode(key);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.slice(0, 16);
}
