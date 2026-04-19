import { describe, it, expect, vi } from 'vitest';
import { executeReplay } from './handler';

type FetchCall = [string, RequestInit?];

function makeFetch(responder: (url: string, init?: RequestInit) => Promise<Response>) {
  return vi.fn(async (url: string, init?: RequestInit) => responder(url, init));
}

describe('executeReplay', () => {
  it('builds URL with query params appended', async () => {
    const fetchImpl = makeFetch(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/items',
      queryParams: { a: '1', b: 'two' },
      headers: {},
      body: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    const [calledUrl] = fetchImpl.mock.calls[0] as FetchCall;
    expect(calledUrl).toContain('https://api.example.com/items?');
    expect(calledUrl).toContain('a=1');
    expect(calledUrl).toContain('b=two');
  });

  it('merges with existing query string on endpoint', async () => {
    const fetchImpl = makeFetch(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/items?x=1',
      queryParams: { y: '2' },
      headers: {},
      body: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    const [calledUrl] = fetchImpl.mock.calls[0] as FetchCall;
    expect(calledUrl).toContain('x=1');
    expect(calledUrl).toContain('y=2');
  });

  it('serializes object body as JSON and sets Content-Type', async () => {
    const fetchImpl = makeFetch(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'POST',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: { hello: 'world' },
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    const [, init] = fetchImpl.mock.calls[0] as FetchCall;
    expect(init?.body).toBe('{"hello":"world"}');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  });

  it('preserves string body and does not override Content-Type', async () => {
    const fetchImpl = makeFetch(async () => new Response('{}', { status: 200 }));
    await executeReplay({
      method: 'POST',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: { 'Content-Type': 'text/plain' },
      body: 'raw text',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    const [, init] = fetchImpl.mock.calls[0] as FetchCall;
    expect(init?.body).toBe('raw text');
    expect((init?.headers as Record<string, string>)['Content-Type']).toBe('text/plain');
  });

  it('returns parsed JSON response when response is JSON', async () => {
    const fetchImpl = makeFetch(async () => new Response('{"ok":true}', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }));
    const result = await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    expect(result.statusCode).toBe(200);
    expect(result.responseData).toEqual({ ok: true });
    expect(result.error).toBeNull();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('returns raw string when response is not JSON', async () => {
    const fetchImpl = makeFetch(async () => new Response('hello', { status: 200 }));
    const result = await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    expect(result.responseData).toBe('hello');
  });

  it('records status_code 0 and error on fetch failure', async () => {
    const fetchImpl = makeFetch(async () => { throw new Error('boom'); });
    const result = await executeReplay({
      method: 'GET',
      endpoint: 'https://api.example.com/x',
      queryParams: {},
      headers: {},
      body: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      timeoutMs: 1000,
    });
    expect(result.statusCode).toBe(0);
    expect(result.error).toBe('boom');
    expect(result.responseData).toBeNull();
  });
});
