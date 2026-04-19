import { describe, it, expect } from 'vitest';
import { validateReplayUrl } from './ssrf';

describe('validateReplayUrl', () => {
  it('accepts public https URL', () => {
    expect(validateReplayUrl('https://api.rebeca.app/foo')).toEqual({ ok: true });
  });

  it('accepts public http URL', () => {
    expect(validateReplayUrl('http://example.com/bar')).toEqual({ ok: true });
  });

  it('rejects non-http(s) schemes', () => {
    expect(validateReplayUrl('ftp://example.com')).toEqual({ ok: false, reason: 'scheme' });
    expect(validateReplayUrl('file:///etc/passwd')).toEqual({ ok: false, reason: 'scheme' });
  });

  it('rejects localhost', () => {
    expect(validateReplayUrl('http://localhost/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://LOCALHOST:8787/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects loopback IPv4', () => {
    expect(validateReplayUrl('http://127.0.0.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://127.255.255.254/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects private IPv4 ranges', () => {
    expect(validateReplayUrl('http://10.0.0.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://172.16.0.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://172.31.255.255/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://192.168.1.1/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://169.254.169.254/')).toEqual({ ok: false, reason: 'private' });
  });

  it('accepts IPv4 just outside private ranges', () => {
    expect(validateReplayUrl('http://172.32.0.1/')).toEqual({ ok: true });
    expect(validateReplayUrl('http://172.15.255.255/')).toEqual({ ok: true });
    expect(validateReplayUrl('http://11.0.0.1/')).toEqual({ ok: true });
  });

  it('rejects IPv6 loopback and link-local', () => {
    expect(validateReplayUrl('http://[::1]/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://[fe80::1]/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://[fc00::1]/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects .internal hostnames', () => {
    expect(validateReplayUrl('http://service.internal/')).toEqual({ ok: false, reason: 'private' });
    expect(validateReplayUrl('http://FOO.INTERNAL/')).toEqual({ ok: false, reason: 'private' });
  });

  it('rejects malformed URLs', () => {
    expect(validateReplayUrl('not a url')).toEqual({ ok: false, reason: 'malformed' });
    expect(validateReplayUrl('')).toEqual({ ok: false, reason: 'malformed' });
  });
});
