import { describe, it, expect } from 'vitest';
import { generateTokenPlaintext, hashToken, tokenPrefix } from './tokens';

describe('tokens', () => {
  it('generates pl_live_ prefixed plaintext of expected length', () => {
    const t = generateTokenPlaintext();
    expect(t.startsWith('pl_live_')).toBe(true);
    expect(t.length).toBe('pl_live_'.length + 32);
  });

  it('two generated tokens differ', () => {
    expect(generateTokenPlaintext()).not.toBe(generateTokenPlaintext());
  });

  it('hashes deterministically with SHA-256 hex', async () => {
    const t = 'pl_live_abcdefghij1234567890ABCDEFGHIJ12';
    const h1 = await hashToken(t);
    const h2 = await hashToken(t);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefix returns first 12 chars including pl_live_', () => {
    expect(tokenPrefix('pl_live_abcdefghij1234567890ABCDEFGHIJ12'))
      .toBe('pl_live_abcd');
  });
});
