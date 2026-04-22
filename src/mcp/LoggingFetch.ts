/**
 * Creates a fetch wrapper that logs every HTTP request and response detail,
 * useful for diagnosing connection issues with MCP servers.
 */
import { clampLogText } from './logText';
import { SENSITIVE_HEADER_NAMES } from './sensitiveHeaders';

export interface FetchLogEntry {
  timestamp: number;
  method: string;
  url: string;
  rpcMethod: string;
  requestHeaders: Record<string, string>;
  requestBody: string;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
  bodyExcerpt: string;
  error: string | null;
  durationMs: number;
}

function redactHeaders(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, name) => {
    result[name] = SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? '*** redacted ***' : value;
  });
  return result;
}

export function createLoggingFetch(
  onLog: (entry: FetchLogEntry) => void,
): typeof globalThis.fetch {
  const loggingFetch: typeof globalThis.fetch = async (input, init?) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    const reqHeaders = redactHeaders(new Headers(init?.headers));

    // Try to extract the JSON-RPC method name from the request body
    let rpcMethod = '';
    let requestBody = '';
    try {
      if (init?.body && typeof init.body === 'string') {
        const parsed = JSON.parse(init.body);
        if (parsed.method) rpcMethod = parsed.method;
        requestBody = clampLogText(JSON.stringify(parsed, null, 2));
      }
    } catch { /* not JSON or no method */ }

    const start = Date.now();
    try {
      const response = await globalThis.fetch(input, init);

      const resHeaders = redactHeaders(response.headers);

      let bodyExcerpt = '';
      let responseBody = '';
      const contentType = response.headers.get('content-type') ?? '';

      if (contentType.includes('text/event-stream')) {
        onLog({
          timestamp: start, method, url, rpcMethod, requestHeaders: reqHeaders,
          requestBody, status: response.status, statusText: response.statusText,
          responseHeaders: resHeaders,
          responseBody: '[streaming SSE response]',
          bodyExcerpt: '',
          error: null,
          durationMs: Date.now() - start,
        });
        return response;
      }

      try {
        const c = response.clone();
        const t = await c.text();
        if (!response.ok) {
          bodyExcerpt = clampLogText(t);
        }
        try {
          responseBody = clampLogText(JSON.stringify(JSON.parse(t), null, 2));
        } catch {
          responseBody = clampLogText(t);
        }
      } catch { /* */ }

      onLog({
        timestamp: start, method, url, rpcMethod, requestHeaders: reqHeaders,
        requestBody, status: response.status, statusText: response.statusText,
        responseHeaders: resHeaders, responseBody, bodyExcerpt, error: null,
        durationMs: Date.now() - start,
      });
      return response;
    } catch (err: unknown) {
      onLog({
        timestamp: start, method, url, rpcMethod, requestHeaders: reqHeaders,
        requestBody, status: null, statusText: '', responseHeaders: {},
        responseBody: '', bodyExcerpt: '', error: clampLogText(err instanceof Error ? err.message : String(err)),
        durationMs: Date.now() - start,
      });
      throw err;
    }
  };

  return loggingFetch as typeof globalThis.fetch;
}
