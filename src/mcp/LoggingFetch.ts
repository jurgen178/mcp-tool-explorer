/**
 * Creates a fetch wrapper that logs every HTTP request and response detail,
 * useful for diagnosing connection issues with MCP servers.
 */

export interface FetchLogEntry {
  timestamp: number;
  method: string;
  url: string;
  rpcMethod: string;
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

    const reqHeaders: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { reqHeaders[k] = v; });

    // Try to extract the JSON-RPC method name from the request body
    let rpcMethod = '';
    try {
      if (init?.body && typeof init.body === 'string') {
        const parsed = JSON.parse(init.body);
        if (parsed.method) rpcMethod = parsed.method;
      }
    } catch { /* not JSON or no method */ }

    const start = Date.now();
    try {
      const response = await globalThis.fetch(input, init);

      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { resHeaders[k] = v; });

      let bodyExcerpt = '';
      if (!response.ok) {
        try { const c = response.clone(); const t = await c.text(); bodyExcerpt = t.length > 500 ? t.substring(0, 500) + '…' : t; } catch { /* */ }
      }

      onLog({
        timestamp: start, method, url, rpcMethod, requestHeaders: reqHeaders,
        status: response.status, statusText: response.statusText,
        responseHeaders: resHeaders, bodyExcerpt, error: null,
        durationMs: Date.now() - start,
      });
      return response;
    } catch (err: unknown) {
      onLog({
        timestamp: start, method, url, rpcMethod, requestHeaders: reqHeaders,
        status: null, statusText: '', responseHeaders: {},
        bodyExcerpt: '', error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
      throw err;
    }
  };

  return loggingFetch as typeof globalThis.fetch;
}
