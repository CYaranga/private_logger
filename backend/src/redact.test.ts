import { describe, it, expect } from 'vitest';
import { redactPii, redactValue } from './redact';

describe('redactPii', () => {
  it('redacts JWTs', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c';
    const out = redactPii(`token=${jwt}`);
    expect(out).toContain('<jwt-redacted>');
    expect(out).not.toContain(jwt);
  });

  it('redacts Authorization Bearer headers (case-insensitive, json or text)', () => {
    expect(redactPii('Authorization: Bearer abc.DEF-123')).toContain('<bearer-redacted>');
    expect(redactPii('"authorization":"Bearer xyz_456"')).toContain('<bearer-redacted>');
  });

  it('redacts api-key style headers with long values', () => {
    expect(redactPii('"api_key":"abcdefghij1234567890_AAA"')).toContain('<key-redacted>');
    expect(redactPii('apiKey=abcdef1234567890ABCDEF')).toContain('<key-redacted>');
  });

  it('redacts emails', () => {
    expect(redactPii('contact alice@example.com please')).toContain('<email-redacted>');
  });

  it('redacts credit-card-shaped digit runs', () => {
    expect(redactPii('card 4111 1111 1111 1111 charged')).toContain('<card-redacted>');
    expect(redactPii('cc=4111-1111-1111-1111')).toContain('<card-redacted>');
  });

  it('redacts long hex runs that smell like hashes', () => {
    const hash = 'a'.repeat(40);
    expect(redactPii(`sha=${hash}`)).toContain('<hash-redacted>');
  });

  it('leaves benign text alone', () => {
    const benign = 'User clicked save on /trips/42 in 230ms';
    expect(redactPii(benign)).toBe(benign);
  });

  it('order: jwt before generic hash', () => {
    const jwt = 'eyJfoo.eyJbar-baz.signaturepart';
    const out = redactPii(jwt);
    expect(out).toBe('<jwt-redacted>');
  });
});

describe('redactValue', () => {
  it('walks nested objects and arrays', () => {
    const input = {
      user: { email: 'bob@x.com', token: 'eyJx.eyJy.zzz' },
      cards: ['4111 1111 1111 1111'],
      ok: 1,
    };
    const out = redactValue(input) as typeof input;
    expect(out.user.email).toBe('<email-redacted>');
    expect(out.user.token).toBe('<jwt-redacted>');
    expect(out.cards[0]).toBe('<card-redacted>');
    expect(out.ok).toBe(1);
  });

  it('returns null/undefined unchanged', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(undefined)).toBeUndefined();
  });

  it('returns non-string primitives unchanged', () => {
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
  });
});
