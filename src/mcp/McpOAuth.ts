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
  authFailed?: boolean;
}

interface TokenAcquisitionResult {
  token?: string;
  prompted: boolean;
}

interface OAuthResourceMetadata {
  authorization_servers?: string[];
  scopes_supported?: string[];
  resource?: string;
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
      let result: TokenAcquisitionResult;
      try {
        result = await discoverAndAcquireToken(response, url, accountSelection, options.serverName, baseFetch);
      } catch (error) {
        if (options.state) {
          options.state.authFailed = true;
          options.state.promptCancelled = true;
        }
        throw error;
      }
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

  const metadataFallback = getResourceMetadataFallback(resourceMetadataUrl);
  let meta: OAuthResourceMetadata | undefined;

  try {
    const rmResp = await metadataFetch(resourceMetadataUrl, { signal: AbortSignal.timeout(5000) });
    if (rmResp.ok) {
      meta = await rmResp.json() as OAuthResourceMetadata;
    }
  } catch {
    // Fall back below when possible.
  }

  meta ??= metadataFallback;
  if (!meta) return { prompted };

  return acquireTokenFromMetadata(meta, accountSelection, serverName);
}

async function acquireTokenFromMetadata(
  meta: OAuthResourceMetadata,
  accountSelection: AuthAccountSelection,
  serverName: string | undefined,
): Promise<TokenAcquisitionResult> {
  let prompted = false;
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
      forceNewSession: {
        detail: serverName
          ? `Choose the account to use for MCP server "${serverName}".`
          : 'Choose the account to use for this MCP server.',
      },
      clearSessionPreference: true,
    });
  } else {
    session = await vscode.authentication.getSession(providerId, tokenScopes, { silent: true });
    if (!session) {
      session = await vscode.authentication.getSession(providerId, tokenScopes, {
        createIfNone: {
          detail: serverName
            ? `Authorize MCP server "${serverName}" with your current account.`
            : 'Authorize this MCP server with your current account.',
        },
      });
    }
  }

  return { token: session?.accessToken, prompted };
}

function getResourceMetadataFallback(resourceMetadataUrl: string): OAuthResourceMetadata | undefined {
  let metadataUrl: URL;
  try {
    metadataUrl = new URL(resourceMetadataUrl);
  } catch {
    return undefined;
  }

  const resource = getResourceFromMetadataUrl(metadataUrl);
  if (!resource) {
    return undefined;
  }

  const authorizationServer = getMicrosoftAuthorizationServer(resource);
  if (!authorizationServer) {
    return undefined;
  }

  return {
    authorization_servers: [authorizationServer],
    resource,
  };
}

function getResourceFromMetadataUrl(metadataUrl: URL): string | undefined {
  const marker = '/.well-known/oauth-protected-resource';
  const markerIndex = metadataUrl.pathname.indexOf(marker);
  if (markerIndex < 0) {
    return undefined;
  }

  const resourcePath = metadataUrl.pathname.slice(0, markerIndex)
    + metadataUrl.pathname.slice(markerIndex + marker.length);
  const resourceUrl = new URL(metadataUrl.toString());
  resourceUrl.pathname = resourcePath || '/';
  resourceUrl.search = '';
  resourceUrl.hash = '';
  return resourceUrl.toString().replace(/\/$/, '');
}

function getMicrosoftAuthorizationServer(resource: string): string | undefined {
  let resourceUrl: URL;
  try {
    resourceUrl = new URL(resource);
  } catch {
    return undefined;
  }

  const tenantMatch = resourceUrl.pathname.match(/\/tenants\/([0-9a-f-]{36})(?:\/|$)/i);
  if (!tenantMatch) {
    return undefined;
  }

  return `https://login.microsoftonline.com/${tenantMatch[1]}/v2.0`;
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
