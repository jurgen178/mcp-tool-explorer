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
  onEvent?: (message: string, detail?: string) => void;
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
        result = await discoverAndAcquireToken(response, url, accountSelection, options.serverName, baseFetch, options.onEvent);
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
  onEvent: OAuthOptions['onEvent'],
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

  return acquireTokenFromMetadata(meta, accountSelection, serverName, wwwAuth, onEvent);
}

async function acquireTokenFromMetadata(
  meta: OAuthResourceMetadata,
  accountSelection: AuthAccountSelection,
  serverName: string | undefined,
  wwwAuthenticate: string | undefined,
  onEvent: OAuthOptions['onEvent'],
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

  const detail = serverName
    ? `Authorize MCP server "${serverName}".`
    : 'Authorize this MCP server.';

  if (isClaimsChallenge(providerId, wwwAuthenticate)) {
    const authRequest = { wwwAuthenticate, fallbackScopes: tokenScopes };
    if (accountSelection === 'prompt') {
      prompted = true;
      const session = await vscode.authentication.getSession(providerId, authRequest, {
        forceNewSession: { detail },
        clearSessionPreference: true,
      });
      logOAuthSession(onEvent, session, 'OAuth token acquired after account selection');
      return { token: session.accessToken, prompted };
    }

    const silentSession = await vscode.authentication.getSession(providerId, authRequest, { silent: true });
    if (!silentSession) {
      onEvent?.('OAuth token not available silently', tokenScopeSummary(tokenScopes));
    } else {
      logOAuthSession(onEvent, silentSession, 'OAuth token acquired silently');
    }
    return { token: silentSession?.accessToken, prompted };
  }

  if (accountSelection === 'prompt') {
    prompted = true;
    const session = await vscode.authentication.getSession(providerId, tokenScopes, {
      forceNewSession: { detail },
      clearSessionPreference: true,
    });
    logOAuthSession(onEvent, session, 'OAuth token acquired after account selection');
    return { token: session.accessToken, prompted };
  }

  const silentSession = await vscode.authentication.getSession(providerId, tokenScopes, { silent: true });
  if (!silentSession) {
    onEvent?.('OAuth token not available silently', tokenScopeSummary(tokenScopes));
  } else {
    logOAuthSession(onEvent, silentSession, 'OAuth token acquired silently');
  }
  return { token: silentSession?.accessToken, prompted };
}

function logOAuthSession(
  onEvent: OAuthOptions['onEvent'],
  session: vscode.AuthenticationSession,
  message: string,
): void {
  const claims = decodeJwtPayload(session.accessToken);
  const lines = [
    `Account: ${session.account.label}`,
    `Account ID: ${session.account.id}`,
    `Scopes: ${session.scopes.join(' ')}`,
  ];
  if (claims) {
    if (typeof claims.tid === 'string') lines.push(`Tenant: ${claims.tid}`);
    if (typeof claims.aud === 'string') lines.push(`Audience: ${claims.aud}`);
    if (typeof claims.upn === 'string') lines.push(`UPN: ${claims.upn}`);
    if (typeof claims.preferred_username === 'string') lines.push(`Username: ${claims.preferred_username}`);
  }
  onEvent?.(message, lines.join('\n'));
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const payload = token.split('.')[1];
  if (!payload) {
    return undefined;
  }

  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function tokenScopeSummary(tokenScopes: string[]): string {
  return `Scopes: ${tokenScopes.join(' ')}`;
}

function isClaimsChallenge(
  providerId: string,
  wwwAuthenticate: string | undefined,
): wwwAuthenticate is string {
  return providerId === 'microsoft'
    && typeof wwwAuthenticate === 'string'
    && /(?:^|[\s,])claims=/i.test(wwwAuthenticate);
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
