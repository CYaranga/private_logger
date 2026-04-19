export type SsrfResult =
  | { ok: true }
  | { ok: false; reason: 'malformed' | 'scheme' | 'private' };

function parseIPv4(host: string): number[] | null {
  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (n < 0 || n > 255) return null;
    octets.push(n);
  }
  return octets;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 127) return true;                           // loopback
  if (a === 10) return true;                            // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true;     // 172.16.0.0/12
  if (a === 192 && b === 168) return true;              // 192.168.0.0/16
  if (a === 169 && b === 254) return true;              // link-local
  if (a === 0) return true;                             // 0.0.0.0/8
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const h = host.toLowerCase();
  if (h === '::1') return true;                         // loopback
  if (h.startsWith('fe80:') || h.startsWith('fe80::')) return true; // link-local
  if (h.startsWith('fc') || h.startsWith('fd')) return true;        // unique local fc00::/7
  return false;
}

export function validateReplayUrl(raw: string): SsrfResult {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'scheme' };
  }

  let host = url.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);

  if (host === 'localhost') return { ok: false, reason: 'private' };
  if (host.endsWith('.internal')) return { ok: false, reason: 'private' };

  const ipv4 = parseIPv4(host);
  if (ipv4 && isPrivateIPv4(ipv4)) return { ok: false, reason: 'private' };

  if (host.includes(':') && isPrivateIPv6(host)) return { ok: false, reason: 'private' };

  return { ok: true };
}
