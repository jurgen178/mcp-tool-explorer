/**
 * Creates a fetch wrapper that logs every HTTP request and response detail,
 * useful for diagnosing connection issues with MCP servers.
 *
 * Each call to `onLog(entry)` emits a structured log entry containing
 * the URL, method, request headers, response status, response headers,
 * and a truncated body excerpt.
 */
export interface FetchLogEntry {
  timestamp: number;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  bodyExcerpt: string;
  error: string | null;
  durationMs: number;
}

export function createLoggingFetch(
  onLog: (entry: FetchLogEntry) => void,
): typeof globalThis.fetch {
  const loggingFetch: typeof globalThis.fetch = async (input, init?) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    // Capture request headers
    const reqHeaders: Record<string, string> = {};
    const h = new Headers(init?.headers);
    h.forEach((v, k) => { reqHeaders[k] = k.toLowerCase() === 'authorization' ? `${v.substring(0, 15)}…` : v; });

    const start = Date.now();
    try {
      const response = await globalThis.fetch(input, init);
      const durationMs = Date.now() - start;

      // Capture response headers
      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { resHeaders[k] = v; });

      // Clone + peek at the body (up to 500 chars) for non-streaming responses
      let bodyExcerpt = '';
      if (!response.ok) {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          bodyExcerpt = text.length > 500 ? text.substring(0, 500) + '…' : text;
        } catch { /* body may be locked or unavailable */ }
      }

      onLog({
        timestamp: start,
        method,
        url,
        requestHeaders: reqHeaders,
        status: response.status,
        statusText: response.statusText,
        responseHeaders: resHeaders,
        bodyExcerpt,
        error: null,
        durationMs,
      });

      return response;
    } catch (err: unknown) {
      const durationMs = Date.now() - start;
      onLog({
        timestamp: start,
        method,
        url,
        requestHeaders: reqHeaders,
        status: null,
        statusText: '',
        responseHeaders: {},
        bodyExcerpt: '',
        error: err instanceof Error ? err.message : String(err),
        durationMs,
      });
      throw err;
    }
  };

  return loggingFetch as typeof globalThis.fetch;
}

