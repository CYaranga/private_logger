export interface ExecuteReplayArgs {
  method: string;
  endpoint: string;
  queryParams: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  fetchImpl: typeof fetch;
  timeoutMs: number;
}

export interface ExecuteReplayResult {
  statusCode: number;
  durationMs: number;
  responseData: unknown;
  error: string | null;
  finalUrl: string;
  sentHeaders: Record<string, string>;
  sentBody: string | null;
}

const MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

function hasHeader(headers: Record<string, string>, name: string): boolean {
  const lower = name.toLowerCase();
  return Object.keys(headers).some(k => k.toLowerCase() === lower);
}

function buildUrl(endpoint: string, queryParams: Record<string, string>): string {
  const entries = Object.entries(queryParams);
  if (entries.length === 0) return endpoint;
  const url = new URL(endpoint);
  for (const [k, v] of entries) url.searchParams.append(k, v);
  return url.toString();
}

export async function executeReplay(args: ExecuteReplayArgs): Promise<ExecuteReplayResult> {
  const { method, endpoint, queryParams, headers, body, fetchImpl, timeoutMs } = args;

  const finalUrl = buildUrl(endpoint, queryParams);
  const sentHeaders: Record<string, string> = { ...headers };
  let sentBody: string | null = null;

  if (body !== undefined && body !== null) {
    if (typeof body === 'string') {
      sentBody = body;
    } else {
      sentBody = JSON.stringify(body);
      if (!hasHeader(sentHeaders, 'Content-Type')) {
        sentHeaders['Content-Type'] = 'application/json';
      }
    }
  }

  const signal = AbortSignal.timeout(timeoutMs);
  const start = Date.now();

  try {
    const response = await fetchImpl(finalUrl, {
      method,
      headers: sentHeaders,
      body: sentBody ?? undefined,
      signal,
    });
    const text = await response.text();
    const durationMs = Date.now() - start;

    let responseData: unknown;
    let error: string | null = null;
    if (text.length > MAX_RESPONSE_BYTES) {
      responseData = text.slice(0, MAX_RESPONSE_BYTES);
      error = `response truncated: original length ${text.length} bytes`;
    } else {
      try {
        responseData = JSON.parse(text);
      } catch {
        responseData = text;
      }
    }

    return {
      statusCode: response.status,
      durationMs,
      responseData,
      error,
      finalUrl,
      sentHeaders,
      sentBody,
    };
  } catch (e) {
    const durationMs = Date.now() - start;
    const message = e instanceof Error ? e.message : String(e);
    return {
      statusCode: 0,
      durationMs,
      responseData: null,
      error: message,
      finalUrl,
      sentHeaders,
      sentBody,
    };
  }
}
