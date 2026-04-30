/**
 * API token helpers. Token plaintext shape: `pl_live_<32 base62 chars>`.
 * Only the SHA-256 hash is stored; plaintext is shown to the operator
 * exactly once at creation. `prefix` is the first 12 plaintext chars,
 * kept for human recognition (similar to GitHub's `ghp_xxxxxxxxxxxx`).
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const BODY_LEN = 32;

export function generateTokenPlaintext(): string {
  const buf = new Uint8Array(BODY_LEN);
  crypto.getRandomValues(buf);
  let body = '';
  for (let i = 0; i < BODY_LEN; i++) body += ALPHABET[buf[i] % ALPHABET.length];
  return `pl_live_${body}`;
}

export async function hashToken(plaintext: string): Promise<string> {
  const buf = new TextEncoder().encode(plaintext);
  const hash = await crypto.subtle.digest('SHA-256', buf);
  const bytes = new Uint8Array(hash);
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex;
}

export function tokenPrefix(plaintext: string): string {
  return plaintext.slice(0, 12);
}
