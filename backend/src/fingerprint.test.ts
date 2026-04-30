import { describe, it, expect } from 'vitest';
import { normalizeMessage, computeFingerprint } from './fingerprint';

describe('normalizeMessage', () => {
  it('collapses UUIDs', () => {
    const msg = 'Failed to load trip 7c3b2a8e-4f5d-4a1b-9c2d-3e4f5a6b7c8d for user';
    expect(normalizeMessage(msg)).toContain('<uuid>');
  });

  it('collapses long numeric IDs', () => {
    expect(normalizeMessage('order 12345678901 not found'))
      .toContain('<num>');
  });

  it('collapses small integers', () => {
    expect(normalizeMessage('retry attempt 3 of 5'))
      .toBe('retry attempt <n> of <n>');
  });

  it('lower-cases and trims', () => {
    expect(normalizeMessage('  HELLO   World  ')).toBe('hello world');
  });

  it('truncates at 200 chars', () => {
    expect(normalizeMessage('x'.repeat(500)).length).toBe(200);
  });
});

describe('computeFingerprint', () => {
  it('is stable for the same logical error', async () => {
    const a = await computeFingerprint({
      level: 'error', category: 'API', endpoint: '/trips/3', status_code: 500,
      message: 'Failed to load trip 7c3b2a8e-4f5d-4a1b-9c2d-3e4f5a6b7c8d',
    });
    const b = await computeFingerprint({
      level: 'error', category: 'API', endpoint: '/trips/9', status_code: 500,
      message: 'Failed to load trip 11111111-2222-3333-4444-555555555555',
    });
    // endpoint differs in number, message UUID differs — both normalize away,
    // but endpoint is NOT normalized in the key. So these will differ.
    // The point: same endpoint + same normalized message => same fingerprint.
    const c = await computeFingerprint({
      level: 'error', category: 'API', endpoint: '/trips/3', status_code: 500,
      message: 'Failed to load trip aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    expect(a).toBe(c);
    expect(a).not.toBe(b);
  });

  it('returns 16 hex chars', async () => {
    const fp = await computeFingerprint({
      level: 'info', category: 'X', endpoint: null, status_code: null, message: 'hi',
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
  });

  it('different level -> different fingerprint', async () => {
    const a = await computeFingerprint({
      level: 'error', category: 'X', endpoint: null, status_code: null, message: 'same',
    });
    const b = await computeFingerprint({
      level: 'warn', category: 'X', endpoint: null, status_code: null, message: 'same',
    });
    expect(a).not.toBe(b);
  });
});
