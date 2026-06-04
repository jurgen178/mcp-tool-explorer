/**
 * Handles OAuth 401 challenges automatically using VS Code's built-in
 * authentication API and RFC 9728 resource metadata discovery.
 *
 * On a 401 with `www-authenticate: Bearer resource_metadata="..."`, it extracts
 * the metadata path, fetches it from the request's own origin, discovers the
 * required scopes or resource, and acquires a token via `vscode.authentication`.
 */
import * as vscode from 'vscode';
import type { AuthAccountSelection } from '../types';

interface OAuthOptions {
  accountSelection?: AuthAccountSelection;
  serverName?: string;
  state?: OAuthState;
}

export interface OAuthState {
  promptCancelled?: boolean;
}

interface TokenAcquisitionResult {
  token?: string;
  prompted: boolean;
}

export function createOAuthHandler(
  baseFetch: typeof globalThis.fetch = globalThis.fetch,
  options: OAuthOptions = {},
): typeof globalThis.fetch {
  /** Cached access token — reused across requests until a fresh 401 arrives. */
  let cachedToken: string | undefined;
  const accountSelection = options.accountSelection ?? 'auto';

  if (accountSelection === 'disabled') {
    return baseFetch;
  }

  const oauthFetch: typeof globalThis.fetch = async (input, init?) => {
    // Inject cached token if available
    if (cachedToken) {
      const headers = new Headers(init?.headers);
      headers.set('Authorization', `Bearer ${cachedToken}`);
      init = { ...init, headers };
    }

    const response = await baseFetch(input, init);

    if (response.status === 401 && !options.state?.promptCancelled) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as Request).url;
      const result = await discoverAndAcquireToken(response, url, accountSelection, options.serverName, baseFetch);
      const token = result.token;
      if (token) {
        cachedToken = token;
        const retryHeaders = new Headers(init?.headers);
        retryHeaders.set('Authorization', `Bearer ${token}`);
        return baseFetch(input, { ...init, headers: retryHeaders });
      }
      if (result.prompted && options.state) {
        options.state.promptCancelled = true;
      }
    }

    return response;
  };

  return oauthFetch as typeof globalThis.fetch;
}

/**
 * Maps an authorization server URL to a VS Code authentication provider ID.
 * Returns undefined for unknown or absent providers — callers skip auth silently
 * and the original 401 response is returned to the caller.
 */
function resolveProviderId(authServer: string): string | undefined {
  if (authServer.includes('microsoftonline.com') || authServer.includes('microsoft')) {
    return 'microsoft';
  }
  if (authServer.includes('github.com')) {
    return 'github';
  }
  return undefined;
}

/**
 * Parse the `www-authenticate` header, fetch OAuth resource metadata from the
 * advertised URL, and acquire a token via VS Code.
 */
async function discoverAndAcquireToken(
  response: Response,
  requestUrl: string,
  accountSelection: AuthAccountSelection,
  serverName: string | undefined,
  metadataFetch: typeof globalThis.fetch,
): Promise<TokenAcquisitionResult> {
  let prompted = false;
  const wwwAuth = response.headers.get('www-authenticate') ?? '';
  const rmMatch = wwwAuth.match(/resource_metadata="([^"]+)"/i);
  if (!rmMatch) return { prompted };

  // Absolute resource_metadata URLs may live on a different host than the MCP
  // endpoint. Relative values are resolved against the original request URL.
  let resourceMetadataUrl: string;
  try {
    resourceMetadataUrl = new URL(rmMatch[1]!, requestUrl).toString();
  } catch {
    return { prompted };
  }

  try {
    const rmResp = await metadataFetch(resourceMetadataUrl, { signal: AbortSignal.timeout(5000) });
    if (!rmResp.ok) return { prompted };

    const meta = await rmResp.json() as {
      authorization_servers?: string[];
      scopes_supported?: string[];
      resource?: string;
    };

    const scopes = meta.scopes_supported ?? [];
    const resourceDefaultScope = typeof meta.resource === 'string'
      ? toDefaultScope(meta.resource)
      : undefined;
    // Keep only app-specific scopes (e.g. "GUID/.default"), skip generic OIDC scopes
    const appScopes = scopes.filter(
      (s: string) => s.includes('/') && !['openid', 'profile', 'offline_access', 'email'].includes(s),
    );
    let tokenScopes = scopes;
    if (appScopes.length > 0) {
      tokenScopes = appScopes;
    } else if (scopes.length === 0 && resourceDefaultScope) {
      tokenScopes = [resourceDefaultScope];
    }
    if (tokenScopes.length === 0) return { prompted };

    // Derive the VS Code auth provider from the authorization_servers metadata.
    // If no known provider is advertised, skip auth and return the original 401.
    const authServer = meta.authorization_servers?.[0] ?? '';
    const providerId = resolveProviderId(authServer);
    if (!providerId) return { prompted }; // unknown provider — cannot acquire token

    let session: vscode.AuthenticationSession | undefined;
    if (accountSelection === 'prompt') {
      prompted = true;
      session = await vscode.authentication.getSession(providerId, tokenScopes, {
        createIfNone: {
          detail: serverName
            ? `Choose the account to use for MCP server "${serverName}".`
            : 'Choose the account to use for this MCP server.',
        },
        clearSessionPreference: true,
      });
    } else {
      session = await vscode.authentication.getSession(providerId, tokenScopes, { silent: true });
    }

    if (!session && accountSelection === 'auto') {
      session = await vscode.authentication.getSession(providerId, tokenScopes, { createIfNone: true });
    }
    return { token: session?.accessToken, prompted };
  } catch {
    return { prompted };
  }
}

function toDefaultScope(resource: string): string | undefined {
  const trimmedResource = resource.trim();
  if (!trimmedResource) {
    return undefined;
  }

  if (trimmedResource.endsWith('/.default')) {
    return trimmedResource;
  }

  return `${trimmedResource.replace(/\/+$/, '')}/.default`;
}
