import { describe, it, expect } from 'vitest';
import { sanitizeHeadersForStorage } from './sanitize';

describe('sanitizeHeadersForStorage', () => {
  it('returns empty object for null/undefined', () => {
    expect(sanitizeHeadersForStorage(null)).toEqual({});
    expect(sanitizeHeadersForStorage(undefined)).toEqual({});
  });

  it('preserves non-sensitive headers verbatim', () => {
    expect(sanitizeHeadersForStorage({
      'Content-Type': 'application/json',
      'X-Request-Id': 'abc-123',
    })).toEqual({
      'Content-Type': 'application/json',
      'X-Request-Id': 'abc-123',
    });
  });

  it('redacts sensitive headers case-insensitively', () => {
    const result = sanitizeHeadersForStorage({
      'Authorization': 'Bearer abc',
      'cookie': 'sid=xyz',
      'Set-Cookie': 'sid=xyz',
      'X-API-Key': 'secret',
      'x-auth-token': 't',
      'Content-Type': 'application/json',
    });
    expect(result).toEqual({
      'Authorization': '***',
      'cookie': '***',
      'Set-Cookie': '***',
      'X-API-Key': '***',
      'x-auth-token': '***',
      'Content-Type': 'application/json',
    });
  });

  it('only redacts non-empty values', () => {
    expect(sanitizeHeadersForStorage({ Authorization: '' })).toEqual({ Authorization: '' });
  });
});
