/**
 * Server-side PII / secret scrub. Applied to message + serialized payloads
 * before insert so anyone with dashboard read can't pull live credentials.
 *
 * Order matters: catch the most specific patterns first (JWT, bearer header,
 * api key) before generic high-entropy strings.
 */

const PII_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, replace: '<jwt-redacted>' },
  { re: /(authorization"?\s*[:=]\s*"?)bearer\s+[A-Za-z0-9._\-]+/gi, replace: '$1<bearer-redacted>' },
  { re: /(api[-_]?key"?\s*[:=]\s*"?)[A-Za-z0-9_\-]{16,}/gi, replace: '$1<key-redacted>' },
  { re: /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, replace: '<email-redacted>' },
  { re: /\b(?:\d[ -]*?){13,19}\b/g, replace: '<card-redacted>' },
  { re: /\b[A-Fa-f0-9]{32,}\b/g, replace: '<hash-redacted>' },
];

export function redactPii(input: string): string {
  let out = input;
  for (const p of PII_PATTERNS) out = out.replace(p.re, p.replace);
  return out;
}

/** Apply redactPii to every string leaf of an object/value. */
export function redactValue(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactPii(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactValue(v);
    }
    return out;
  }
  return value;
}
