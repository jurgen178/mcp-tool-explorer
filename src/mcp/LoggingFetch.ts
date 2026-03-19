/**
 * Creates a fetch wrapper that logs every HTTP request and response detail
 * and handles OAuth 401 challenges automatically using VS Code's auth API.
 *
 * On a 401 with a `www-authenticate: Bearer resource_metadata="..."` header,
 * it discovers the OAuth resource metadata from the **same origin** (localhost),
 * acquires a token via `vscode.authentication`, and retries the request.
 */
import * as vscode from 'vscode';

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
  /** Cached access token — reused until a new 401 is received. */
  let cachedToken: string | undefined;

  const emitLog = (
    start: number, method: string, url: string,
    reqHeaders: Record<string, string>, response: Response | null,
    bodyExcerpt: string, error: string | null,
  ) => {
    const resHeaders: Record<string, string> = {};
    response?.headers.forEach((v, k) => { resHeaders[k] = v; });
    onLog({
      timestamp: start, method, url, requestHeaders: reqHeaders,
      status: response?.status ?? null,
      statusText: response?.statusText ?? '',
      responseHeaders: resHeaders, bodyExcerpt, error,
      durationMs: Date.now() - start,
    });
  };

  const captureHeaders = (headers: Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    headers.forEach((v, k) => { out[k] = v; });
    return out;
  };

  const loggingFetch: typeof globalThis.fetch = async (input, init?) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');

    // Inject cached token if available
    if (cachedToken) {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${cachedToken}`);
      init = { ...init, headers };
    }

    const reqHeaders = captureHeaders(new Headers(init?.headers));
    const start = Date.now();

    try {
      const response = await globalThis.fetch(input, init);

      // Handle 401 → discover OAuth metadata → acquire token → retry
      if (response.status === 401) {
        let bodyExcerpt = '';
        try { const c = response.clone(); const t = await c.text(); bodyExcerpt = t.substring(0, 500); } catch { /* */ }
        emitLog(start, method, url, reqHeaders, response, bodyExcerpt, null);

        const token = await discoverAndAcquireToken(response, url);
        if (token) {
          cachedToken = token;
          const retryHeaders = new Headers(init?.headers);
          retryHeaders.set('Authorization', `Bearer ${token}`);
          const retryInit = { ...init, headers: retryHeaders };
          const retryReqHeaders = captureHeaders(retryHeaders);
          const retryStart = Date.now();

          const retryResponse = await globalThis.fetch(input, retryInit);
          let retryBody = '';
          if (!retryResponse.ok) {
            try { const c = retryResponse.clone(); const t = await c.text(); retryBody = t.substring(0, 500); } catch { /* */ }
          }
          emitLog(retryStart, method, url, retryReqHeaders, retryResponse, retryBody, null);
          return retryResponse;
        }
        return response;
      }

      // Normal path
      let bodyExcerpt = '';
      if (!response.ok) {
        try { const c = response.clone(); const t = await c.text(); bodyExcerpt = t.length > 500 ? t.substring(0, 500) + '…' : t; } catch { /* */ }
      }
      emitLog(start, method, url, reqHeaders, response, bodyExcerpt, null);
      return response;
    } catch (err: unknown) {
      emitLog(start, method, url, reqHeaders, null, '', err instanceof Error ? err.message : String(err));
      throw err;
    }
  };

  return loggingFetch as typeof globalThis.fetch;
}

/**
 * On 401, read the `www-authenticate` header to find the resource_metadata path,
 * then fetch it from the **same origin** (the localhost dev server) to get the
 * real scopes and auth server info. Finally acquire a token via VS Code.
 */
async function discoverAndAcquireToken(
  response: Response,
  requestUrl: string,
): Promise<string | undefined> {
  const wwwAuth = response.headers.get('www-authenticate') ?? '';
  const rmMatch = wwwAuth.match(/resource_metadata="([^"]+)"/i);
  if (!rmMatch) return undefined;

  // The resource_metadata URL in the header may point to an external hostname that
  // doesn't resolve on the dev machine.  Extract just the **path** and resolve it
  // against the request's own origin (localhost) where the server is actually running.
  let rmPath: string;
  try {
    rmPath = new URL(rmMatch[1]!).pathname;
  } catch {
    return undefined;
  }
  const localRmUrl = new URL(rmPath, new URL(requestUrl).origin).toString();

  try {
    const rmResp = await globalThis.fetch(localRmUrl);
    if (!rmResp.ok) return undefined;

    const meta = await rmResp.json() as {
      authorization_servers?: string[];
      scopes_supported?: string[];
      resource?: string;
    };

    const scopes = meta.scopes_supported ?? [];
    // Filter to the app-specific scope (e.g. "GUID/.default"), skip generic OIDC scopes
    const appScopes = scopes.filter(s => s.includes('/') && !['openid', 'profile', 'offline_access', 'email'].includes(s));
    const tokenScopes = appScopes.length > 0 ? appScopes : scopes;

    if (tokenScopes.length === 0) return undefined;

    // Use VS Code's built-in Microsoft auth provider
    let session = await vscode.authentication.getSession('microsoft', tokenScopes, { silent: true });
    if (!session) {
      session = await vscode.authentication.getSession('microsoft', tokenScopes, { createIfNone: true });
    }
    return session?.accessToken;
  } catch {
    return undefined;
  }
}
