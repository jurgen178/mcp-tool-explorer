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
  requestBody: string;
  status: number | null;
  statusText: string;
  responseHeaders: Record<string, string>;
  responseBody: string;
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
    let requestBody = '';
    try {
      if (init?.body && typeof init.body === 'string') {
        const parsed = JSON.parse(init.body);
        if (parsed.method) rpcMethod = parsed.method;
        requestBody = JSON.stringify(parsed, null, 2);
      }
    } catch { /* not JSON or no method */ }

    const start = Date.now();
    try {
      const response = await globalThis.fetch(input, init);

      const resHeaders: Record<string, string> = {};
      response.headers.forEach((v, k) => { resHeaders[k] = v; });

      let bodyExcerpt = '';
      let responseBody = '';
      const contentType = response.headers.get('content-type') ?? '';
      try {
        const c = response.clone();
        const t = await c.text();
        if (!response.ok) {
          bodyExcerpt = t.length > 500 ? t.substring(0, 500) + '…' : t;
        }
        if (contentType.includes('text/event-stream')) {
          // Extract all data: lines from SSE, parse each as JSON and collect
          const dataLines = t.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).trim())
            .filter(Boolean);
          if (dataLines.length === 1) {
            try { responseBody = JSON.stringify(JSON.parse(dataLines[0]), null, 2); } catch { responseBody = dataLines[0]; }
          } else if (dataLines.length > 1) {
            const parsed = dataLines.map(d => { try { return JSON.parse(d); } catch { return d; } });
            responseBody = JSON.stringify(parsed, null, 2);
          }
        } else {
          try {
            responseBody = JSON.stringify(JSON.parse(t), null, 2);
          } catch {
            responseBody = t.length > 2000 ? t.substring(0, 2000) + '…' : t;
          }
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
        responseBody: '', bodyExcerpt: '', error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
      throw err;
    }
  };

  return loggingFetch as typeof globalThis.fetch;
}
