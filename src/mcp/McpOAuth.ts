/**
 * Handles OAuth 401 challenges automatically using VS Code's built-in
 * authentication API and RFC 9728 resource metadata discovery.
 *
 * On a 401 with `www-authenticate: Bearer resource_metadata="..."`, it extracts
 * the metadata path, fetches it from the request's own origin, discovers the
 * required scopes, and acquires a token via `vscode.authentication`.
 */
import * as vscode from 'vscode';

export function createOAuthHandler(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
): typeof globalThis.fetch {
  /** Cached access token — reused across requests until a fresh 401 arrives. */
  let cachedToken: string | undefined;

  const oauthFetch: typeof globalThis.fetch = async (input, init?) => {
    // Inject cached token if available
    if (cachedToken) {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${cachedToken}`);
      init = { ...init, headers };
    }

    const response = await baseFetch(input, init);

    if (response.status === 401) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const token = await discoverAndAcquireToken(response, url);
      if (token) {
        cachedToken = token;
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set('Authorization', `Bearer ${token}`);
        return baseFetch(input, { ...init, headers: retryHeaders });
      }
    }

    return response;
  };

  return oauthFetch as typeof globalThis.fetch;
}

/**
 * Parse the `www-authenticate` header, fetch OAuth resource metadata from the
 * same origin as the original request, and acquire a token via VS Code.
 */
async function discoverAndAcquireToken(
  response: Response,
  requestUrl: string,
): Promise<string | undefined> {
  const wwwAuth = response.headers.get('www-authenticate') ?? '';
  const rmMatch = wwwAuth.match(/resource_metadata="([^"]+)"/i);
  if (!rmMatch) return undefined;

  // Extract just the path and resolve against the request's own origin,
  // so it works both in dev (localhost) and production (real hostname).
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
    // Keep only app-specific scopes (e.g. "GUID/.default"), skip generic OIDC scopes
    const appScopes = scopes.filter(
      (s: string) => s.includes('/') && !['openid', 'profile', 'offline_access', 'email'].includes(s),
    );
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
