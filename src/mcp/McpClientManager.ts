import { URL } from 'url';
import * as vscode from 'vscode';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  LoggingMessageNotificationSchema,
  PromptListChangedNotificationSchema,
  ResourceUpdatedNotificationSchema,
  ResourceListChangedNotificationSchema,
  ToolListChangedNotificationSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { AuthAccountSelection, AuthAccountSelectionOverrides, McpEventEntry, McpServerConfig, McpServerDetails, McpTool, McpResource, McpPrompt } from '../types';
import { createOAuthHandler, type OAuthState } from './McpOAuth';
import { createLoggingFetch, type FetchLogEntry } from './LoggingFetch';
import { clampLogText } from './logText';
import { SENSITIVE_HEADER_NAMES } from './sensitiveHeaders';

export interface LogSection {
  kind: 'request' | 'response' | 'raw-response' | 'request-headers' | 'response-headers' | 'error' | 'text';
  content: string;
}

export interface ConnectionLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string | LogSection[];
}

interface ActiveConnection {
  client: Client;
  config: McpServerConfig;
}

interface RecentEventGroup {
  key: string;
  timestamp: number;
}

// Connection error diagnostics

/** Walk the Error cause chain to find the root cause (max 5 levels). */
function getRootCause(e: unknown, depth = 0): Error | undefined {
  if (depth > 5 || !(e instanceof Error)) return undefined;
  const cause = (e as { cause?: unknown }).cause;
  if (cause instanceof Error) return getRootCause(cause, depth + 1) ?? cause;
  return e;
}

/**
 * When a server returns an HTML error page (e.g. IIS, nginx), the SDK embeds
 * the full HTML in the error message. Extract just the <title> to keep things readable.
 */
function cleanErrorMessage(msg: string): string {
  const htmlIdx = msg.search(/<(!DOCTYPE|html)/i);
  if (htmlIdx === -1) return msg;
  const prefix = msg.slice(0, htmlIdx).trimEnd();
  const html = msg.slice(htmlIdx);
  const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  if (titleMatch) {
    const title = titleMatch[1].trim();
    return prefix ? `${prefix} [${title}]` : title;
  }
  // Fallback: strip tags
  const stripped = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
  return prefix ? `${prefix} ${stripped}` : stripped;
}

/** Map Node.js error codes / messages to actionable hints for the user. */
function getConnectionHint(e: unknown): string | undefined {
  const root = getRootCause(e);
  if (!root) return undefined;

  const rawCode = (root as NodeJS.ErrnoException).code;
  const code = typeof rawCode === 'string' ? rawCode : '';
  const msg  = root.message.toLowerCase();

  if (code === 'ECONNREFUSED')
    return 'Connection refused — the server is not running or the port/URL is wrong.';
  if (code === 'ENOTFOUND')
    return 'Host not found — check the URL or hostname.';
  if (code === 'ETIMEDOUT' || code === 'EHOSTUNREACH')
    return 'Connection timed out — the server is not responding or is behind a firewall.';
  if (code === 'ECONNRESET')
    return 'Connection reset — the server closed the connection unexpectedly (may be overloaded or restarting).';
  if (code === 'ENETUNREACH')
    return 'Network unreachable — check your network connection.';
  if (code === 'EACCES' || code === 'EPERM')
    return 'Permission denied — check firewall or proxy settings.';
  if (code === 'ENOENT')
    return 'Command not found — check the server command path.';
  if (code.startsWith('CERT_') || code === 'ERR_TLS_CERT_ALTNAME_INVALID' || msg.includes('certificate') || msg.includes('ssl'))
    return 'SSL/TLS certificate error — the server\'s certificate may be self-signed, expired, or the hostname doesn\'t match.';

  // StreamableHTTPError / SSEClientTransport: HTTP error posting to endpoint
  if (msg.includes('error posting to endpoint')) {
    const httpStatus = typeof (root as { code?: unknown }).code === 'number'
      ? (root as { code: number }).code
      : null;
    if (httpStatus === 404) return 'Endpoint not found (HTTP 404) — check the URL path (e.g. add /mcp or verify the route).';
    if (httpStatus === 401 || httpStatus === 403) return 'Authentication error (HTTP ' + httpStatus + ') — check credentials or authorization headers.';
    if (httpStatus === 405) return 'Method not allowed (HTTP 405) — this URL may not be an MCP endpoint.';
    if (httpStatus === 406) return 'Not acceptable (HTTP 406) — the server does not support the MCP content type. Check the URL path.';
    if (httpStatus !== null && httpStatus >= 500) return `Server error (HTTP ${httpStatus}) — the server returned an internal error.`;
    if (httpStatus !== null) return `HTTP ${httpStatus} error — check the URL and verify it points to an MCP endpoint.`;
    return 'HTTP error posting to endpoint — check the URL and verify it points to an MCP server.';
  }

  if (msg.includes('unknown scheme') || msg.includes('unsupported protocol') || msg.includes('invalid url') || msg.includes('only absolute urls'))
    return 'Invalid URL — check the protocol prefix (must be http:// or https://).';

  if (msg === 'fetch failed' || msg.includes('failed to fetch'))
    return 'Network error — the server is unreachable. Check the URL and make sure the server is running.';

  return undefined;
}

export class McpClientManager {
  private readonly _connections = new Map<string, ActiveConnection>();
  private readonly _pendingConnects = new Map<string, AbortController>();
  private readonly _version: string;
  /** Log listeners are tracked per server so concurrent connections stay isolated. */
  private readonly _logListeners = new Map<string, (entry: ConnectionLogEntry) => void>();
  private readonly _recentMcpResponses = new Map<string, FetchLogEntry>();
  private _onEvent: ((serverId: string, event: McpEventEntry) => void) | undefined;
  private _eventCounter = 0;
  private readonly _recentEventGroups = new Map<string, RecentEventGroup>();

  constructor(version: string) {
    this._version = version;
  }

  /** Set a listener for connection log entries (called before connect). */
  setLogListener(serverId: string, listener: (entry: ConnectionLogEntry) => void): void {
    this._logListeners.set(serverId, listener);
  }

  setEventListener(listener: (serverId: string, event: McpEventEntry) => void): void {
    this._onEvent = listener;
  }

  private _log(serverId: string, level: ConnectionLogEntry['level'], message: string, detail?: string | LogSection[]): void {
    this._logListeners.get(serverId)?.({ timestamp: Date.now(), level, message, detail });
  }

  private _emitEvent(serverId: string, event: Omit<McpEventEntry, 'id' | 'timestamp'>): void {
    const now = Date.now();
    this._onEvent?.(serverId, {
      id: `evt-${now}-${++this._eventCounter}`,
      timestamp: now,
      ...event,
    });
  }

  private _asRecord(value: unknown): Record<string, unknown> | undefined {
    return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
  }

  private _rememberEventGroup(serverId: string, key: string): string {
    this._recentEventGroups.set(serverId, { key, timestamp: Date.now() });
    return key;
  }

  private _getRecentEventGroup(serverId: string, maxAgeMs = 2000): string | undefined {
    const recent = this._recentEventGroups.get(serverId);
    if (!recent) {
      return undefined;
    }

    if (Date.now() - recent.timestamp > maxAgeMs) {
      this._recentEventGroups.delete(serverId);
      return undefined;
    }

    return recent.key;
  }

  private _buildLoggingGroupKey(serverId: string, logger: string | undefined, data: unknown): string | undefined {
    const dataRecord = this._asRecord(data);
    const eventName = typeof dataRecord?.event === 'string' ? dataRecord.event : undefined;

    if (eventName) {
      return this._rememberEventGroup(serverId, `event:${eventName}:${logger ?? 'default'}`);
    }

    if (logger) {
      return this._rememberEventGroup(serverId, `logger:${logger}`);
    }

    return undefined;
  }

  private _buildResourceGroupKey(serverId: string, uri: string): string {
    return this._getRecentEventGroup(serverId) ?? this._rememberEventGroup(serverId, `resource:${uri}`);
  }

  private _registerNotificationHandlers(client: Client, serverId: string): void {
    client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
      const logger = notification.params.logger;
      const prefix = logger ? `${logger}: ` : '';
      this._emitEvent(serverId, {
        method: notification.method,
        title: `${prefix}${notification.params.level}`,
        level: notification.params.level,
        groupKey: this._buildLoggingGroupKey(serverId, logger, notification.params.data),
        logger,
        data: notification.params.data,
      });
    });

    client.setNotificationHandler(ToolListChangedNotificationSchema, notification => {
      this._emitEvent(serverId, {
        method: notification.method,
        title: 'Tools list changed',
        level: 'notice',
        data: notification.params,
      });
    });

    client.setNotificationHandler(ResourceListChangedNotificationSchema, notification => {
      this._emitEvent(serverId, {
        method: notification.method,
        title: 'Resources list changed',
        level: 'notice',
        data: notification.params,
      });
    });

    client.setNotificationHandler(PromptListChangedNotificationSchema, notification => {
      this._emitEvent(serverId, {
        method: notification.method,
        title: 'Prompts list changed',
        level: 'notice',
        data: notification.params,
      });
    });

    client.setNotificationHandler(ResourceUpdatedNotificationSchema, notification => {
      this._emitEvent(serverId, {
        method: notification.method,
        title: `Resource updated: ${notification.params.uri}`,
        level: 'notice',
        groupKey: this._buildResourceGroupKey(serverId, notification.params.uri),
        data: notification.params,
      });
    });
  }

  private _buildProgressOptions(serverId: string, operationLabel: string) {
    return {
      resetTimeoutOnProgress: true,
      onprogress: (progress: {
        progress: number;
        total?: number;
        message?: string;
      }) => {
        const progressText = progress.total !== undefined
          ? `${progress.progress}/${progress.total}`
          : `${progress.progress}`;

        this._emitEvent(serverId, {
          method: 'notifications/progress',
          title: progress.message ? `${progress.message} (${progressText})` : `${operationLabel} progress ${progressText}`,
          level: 'info',
          data: progress,
        });
      },
    };
  }

  private async _measure<T>(serverId: string, label: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    this._log(serverId, 'info', `${label} started`);

    try {
      const result = await operation();
      this._log(serverId, 'info', `${label} finished in ${Date.now() - startedAt}ms`);
      return result;
    } catch (error: unknown) {
      this._log(serverId, 'error', `${label} failed after ${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private _serializeLogValue(value: unknown): string {
    if (typeof value === 'string') {
      return clampLogText(value);
    }

    try {
      const serialized = JSON.stringify(value, null, 2);
      return clampLogText(serialized ?? String(value));
    } catch {
      return clampLogText(String(value));
    }
  }

  private _summarizeLogValue(label: string, value: unknown): string {
    const serialized = this._serializeLogValue(value);

    if (typeof value === 'string') {
      return `${label}: string (${value.length} chars)`;
    }

    if (Array.isArray(value)) {
      return `${label}: array (${value.length} items, ${serialized.length} chars)`;
    }

    if (value && typeof value === 'object') {
      return `${label}: object (${Object.keys(value).length} keys, ${serialized.length} chars)`;
    }

    return `${label}: ${typeof value} (${serialized.length} chars)`;
  }

  private _redactHeaders(headers: Record<string, string> | undefined): Record<string, string> | undefined {
    if (!headers) {
      return undefined;
    }

    return Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [
        name,
        SENSITIVE_HEADER_NAMES.has(name.toLowerCase()) ? '*** redacted ***' : value,
      ]),
    );
  }

  private _recentResponseKey(serverId: string, rpcMethod: string): string {
    return `${serverId}\u0000${rpcMethod}`;
  }

  private _getRpcMethodFromRequest(request: unknown): string | undefined {
    const record = this._asRecord(request);
    const method = record?.method;
    return typeof method === 'string' ? method : undefined;
  }

  private async _getResponseBodyForDiagnostics(response: FetchLogEntry): Promise<string> {
    if (response.responseBody && response.responseBody !== '[streaming SSE response]') {
      return response.responseBody;
    }

    if (!response.responseBodyPromise) {
      return '';
    }

    return await Promise.race([
      response.responseBodyPromise,
      new Promise<string>(resolve => setTimeout(() => resolve(''), 1000)),
    ]);
  }

  private _formatParsedJson(value: string): string | undefined {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return undefined;
    }
  }

  private _extractSseDataValues(rawResponseBody: string): string[] {
    const values: string[] = [];
    let currentDataLines: string[] = [];

    const flush = () => {
      if (currentDataLines.length > 0) {
        values.push(currentDataLines.join('\n'));
        currentDataLines = [];
      }
    };

    for (const line of rawResponseBody.split(/\r?\n/)) {
      if (line === '') {
        flush();
        continue;
      }

      if (line.startsWith('data:')) {
        currentDataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }

    flush();
    return values;
  }

  private _getParsedResponseDiagnostics(rawResponseBody: string): { parsedJson?: string; jsonStatus: string } {
    const sseDataValues = this._extractSseDataValues(rawResponseBody);
    if (sseDataValues.length > 0) {
      const parsedSseDataJson = this._formatParsedJson(sseDataValues[sseDataValues.length - 1]);
      if (parsedSseDataJson) {
        return {
          parsedJson: parsedSseDataJson,
          jsonStatus: 'Raw response is a Server-Sent Events (SSE) stream, not JSON. The SSE data value is valid JSON; the failure happened during MCP/schema validation.',
        };
      }

      return { jsonStatus: 'Raw response is a Server-Sent Events (SSE) stream, not JSON. The SSE data value is not valid JSON.' };
    }

    const parsedRawJson = this._formatParsedJson(rawResponseBody);
    if (parsedRawJson) {
      return {
        parsedJson: parsedRawJson,
        jsonStatus: 'Raw response is valid JSON; the failure happened during MCP/schema validation.',
      };
    }

    return { jsonStatus: 'Raw response is not valid JSON.' };
  }

  private async _logInvalidMcpResponse(
    serverId: string,
    label: string,
    request: unknown,
    requestContent: string,
    errorDetail: string,
    startedAt: number,
  ): Promise<void> {
    const rpcMethod = this._getRpcMethodFromRequest(request);
    if (!rpcMethod) {
      return;
    }

    const response = this._recentMcpResponses.get(this._recentResponseKey(serverId, rpcMethod));
    if (!response || response.timestamp < startedAt || response.status === null || response.status >= 400 || !response.responseBody) {
      return;
    }

    const rawResponseBody = await this._getResponseBodyForDiagnostics(response);
    if (!rawResponseBody) {
      return;
    }

    const responseDiagnostics = this._getParsedResponseDiagnostics(rawResponseBody);
    const sections: LogSection[] = [
      {
        kind: 'text',
        content: [
          `${label} failed after the server returned HTTP ${response.status} ${response.statusText}.`,
          responseDiagnostics.jsonStatus,
          'The MCP SDK rejected the response. The raw server response is included below for copy/paste debugging.',
        ].join('\n'),
      },
      { kind: 'request', content: requestContent },
      { kind: 'raw-response', content: rawResponseBody },
    ];

    if (responseDiagnostics.parsedJson) {
      sections.push({ kind: 'response', content: responseDiagnostics.parsedJson });
    }

    sections.push({ kind: 'error', content: errorDetail });

    this._log(serverId, 'error', `Raw MCP response rejected by SDK: ${rpcMethod}`, sections);
  }

  private _getAuthAccountSelection(config: McpServerConfig): AuthAccountSelection {
    const overrides = vscode.workspace
      .getConfiguration('mcpToolExplorer')
      .get<AuthAccountSelectionOverrides>('auth.accountSelection') ?? {};
    const value = overrides[config.id] ?? overrides[config.name] ?? 'auto';
    return value === 'prompt' || value === 'disabled' ? value : 'auto';
  }

  private async _measureRequest<T>(
    serverId: string,
    label: string,
    request: unknown,
    operation: () => Promise<T>,
    serializeResult: (result: T) => string,
    summarizeResult: (result: T) => string,
  ): Promise<T> {
    const startedAt = Date.now();
    const requestContent = this._serializeLogValue(request);
    this._log(serverId, 'info', `${label} started`, [{ kind: 'request', content: requestContent }]);

    try {
      const result = await operation();
      const responseContent = serializeResult(result);
      this._log(serverId, 'info', `${label} finished in ${Date.now() - startedAt}ms`, [
        { kind: 'response', content: responseContent },
        { kind: 'text', content: summarizeResult(result) },
      ]);
      return result;
    } catch (error: unknown) {
      const errorDetail = error instanceof Error
        ? clampLogText(error.message)
        : clampLogText(String(error));

      await this._logInvalidMcpResponse(serverId, label, request, requestContent, errorDetail, startedAt);

      this._log(serverId, 'error', `${label} failed after ${Date.now() - startedAt}ms`, [
        { kind: 'request', content: requestContent },
        { kind: 'error', content: errorDetail },
      ]);
      throw error;
    }
  }

  private _logFetchEntry(serverId: string, entry: FetchLogEntry): void {
    if (entry.rpcMethod && entry.responseBody) {
      this._recentMcpResponses.set(this._recentResponseKey(serverId, entry.rpcMethod), entry);
    }

    const statusStr = entry.status !== null ? `${entry.status} ${entry.statusText}` : 'NETWORK ERROR';
    const level: ConnectionLogEntry['level'] = entry.error ? 'error' : (entry.status && entry.status >= 400) ? 'warn' : 'info';

    const sections: LogSection[] = [];

    if (entry.requestBody) {
      sections.push({ kind: 'request', content: entry.requestBody });
    }
    if (Object.keys(entry.requestHeaders).length > 0) {
      sections.push({
        kind: 'request-headers',
        content: Object.entries(entry.requestHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n'),
      });
    }
    if (entry.responseBody) {
      sections.push({ kind: 'response', content: entry.responseBody });
    }
    if (entry.status !== null && Object.keys(entry.responseHeaders).length > 0) {
      sections.push({
        kind: 'response-headers',
        content: Object.entries(entry.responseHeaders).map(([k, v]) => `  ${k}: ${v}`).join('\n'),
      });
    }
    if (entry.error) {
      sections.push({ kind: 'error', content: entry.error });
    }

    const rpcLabel = entry.rpcMethod ? ` (${entry.rpcMethod})` : '';
    let pathname: string;
    try { pathname = new URL(entry.url).pathname; } catch { pathname = entry.url; }
    this._log(serverId, level, `HTTP ${entry.method} ${pathname}${rpcLabel}  →  ${statusStr}`, sections.length > 0 ? sections : undefined);
  }

  isConnected(serverId: string): boolean {
    return this._connections.has(serverId);
  }

  cancelConnect(serverId: string): void {
    this._pendingConnects.get(serverId)?.abort();
    this._pendingConnects.delete(serverId);
  }

  async connect(config: McpServerConfig): Promise<void> {
    // Cancel any in-progress connect attempt for this server
    this.cancelConnect(config.id);

    // Disconnect first if already connected
    if (this._connections.has(config.id)) {
      await this.disconnect(config.id);
    }

    this._log(config.id, 'info', `Connecting to "${config.name}"`, [
      `Type: ${config.type}`,
      config.url ? `URL: ${config.url}` : `Command: ${config.command} ${(config.args ?? []).join(' ')}`,
      config.headers ? `Headers: ${JSON.stringify(this._redactHeaders(config.headers))}` : '',
      config.cwd ? `CWD: ${config.cwd}` : '',
    ].filter(Boolean).join('\n'));

    const client = new Client(
      { name: 'mcp-tool-explorer', version: this._version },
      {
        capabilities: {
          logging: {},
          extensions: {
            'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
          },
        } as Record<string, unknown>,
      },
    );

    this._registerNotificationHandlers(client, config.id);

    const oauthState: OAuthState = {};
    const transport = this._createTransport(config, oauthState);

    // Set up AbortController so the user can cancel a hanging connect
    const controller = new AbortController();
    this._pendingConnects.set(config.id, controller);
    const abortPromise = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Connection cancelled')), { once: true });
    });

    // Collect stderr so "Connection closed" errors include the real reason
    let stderrOutput = '';
    if (config.type === 'stdio') {
      const stdioTransport = transport as StdioClientTransport;
      stdioTransport.stderr?.on('data', (chunk: { toString(): string }) => {
        const line = chunk.toString();
        stderrOutput += line;
        this._log(config.id, 'warn', 'Server stderr', line.trim());
      });
    }

    try {
      this._log(config.id, 'info', `Attempting ${config.type.toUpperCase()} transport`);
      await Promise.race([
        this._measure(config.id, `Connect ${config.type.toUpperCase()} transport`, () => client.connect(transport)),
        abortPromise,
      ]);
      this._log(config.id, 'info', `Connected successfully via ${config.type.toUpperCase()}`);
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        try { await client.close(); } catch { /* ignore */ }
        this._pendingConnects.delete(config.id);
        throw new Error('Connection cancelled');
      }
      const baseMsg = cleanErrorMessage(e instanceof Error ? e.message : String(e));
      const hint = getConnectionHint(e);
      const sections: LogSection[] = [{ kind: 'error', content: baseMsg }];
      if (hint) sections.push({ kind: 'text', content: `Diagnosis: ${hint}` });
      this._log(config.id, 'error', `${config.type.toUpperCase()} transport failed`, sections);

      // Fall back from Streamable HTTP to SSE (per MCP spec recommendation)
      if (config.type === 'http' && config.url) {
        try { await client.close(); } catch { /* ignore cleanup errors */ }

        this._log(config.id, 'info', 'Falling back to SSE transport');
        const sseClient = new Client(
          { name: 'mcp-tool-explorer', version: this._version },
          {
            capabilities: {
              logging: {},
              extensions: {
                'io.modelcontextprotocol/ui': { mimeTypes: ['text/html;profile=mcp-app'] },
              },
            } as Record<string, unknown>,
          },
        );
        this._registerNotificationHandlers(sseClient, config.id);
        const sseTransport = this._createTransport({ ...config, type: 'sse' }, oauthState);
        try {
          await Promise.race([
            this._measure(config.id, 'Connect SSE transport fallback', () => sseClient.connect(sseTransport)),
            abortPromise,
          ]);
          this._log(config.id, 'info', 'Connected successfully via SSE');
          this._pendingConnects.delete(config.id);
          this._connections.set(config.id, { client: sseClient, config });
          await this._setLoggingLevelIfSupported(config.id, sseClient);
          return;
        } catch (e2: unknown) {
          if (controller.signal.aborted) {
            try { await sseClient.close(); } catch { /* ignore */ }
            this._pendingConnects.delete(config.id);
            throw new Error('Connection cancelled');
          }
          try { await sseClient.close(); } catch { /* ensure EventSource is stopped */ }
          const sseMsg = e2 instanceof Error ? e2.message : String(e2);
          const sseHint = getConnectionHint(e2);
          const sseSections: LogSection[] = [{ kind: 'error', content: sseMsg }];
          if (sseHint) sseSections.push({ kind: 'text', content: `Diagnosis: ${sseHint}` });
          this._log(config.id, 'error', 'SSE transport also failed', sseSections);
          // SSE also failed — fall through to throw the original error
        }
      }

      const stderrDetail = stderrOutput.trim();
      const rootHint = hint ?? getConnectionHint(e);
      const parts = [baseMsg];
      if (rootHint) parts.push(`\nDiagnosis: ${rootHint}`);
      if (stderrDetail) parts.push(`\n\nServer stderr:\n${stderrDetail}`);
      const fullError = parts.join('');
      this._log(config.id, 'error', 'Connection failed', fullError);
      throw new Error(fullError);
    }

    this._pendingConnects.delete(config.id);
    this._connections.set(config.id, { client, config });
    await this._setLoggingLevelIfSupported(config.id, client);
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this._connections.get(serverId);
    if (conn) {
      try { await conn.client.close(); } catch { /* ignore */ }
      this._connections.delete(serverId);
    }
    this._recentEventGroups.delete(serverId);
    this._logListeners.delete(serverId);
  }

  async listTools(serverId: string): Promise<McpTool[]> {
    if (!this._supportsCapability(serverId, 'tools')) {
      this._log(serverId, 'info', 'Tools not supported by this server');
      return [];
    }
    return this._measureRequest(
      serverId,
      'List tools',
      { method: 'tools/list' },
      async () => {
        const { tools } = await this._client(serverId).listTools();
        return tools as McpTool[];
      },
      result => this._serializeLogValue(result),
      result => this._summarizeLogValue('Tools', result),
    );
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>): ReturnType<Client['callTool']> {
    return this._measureRequest(
      serverId,
      `Call tool ${name}`,
      { name, arguments: args },
      () => this._client(serverId).callTool(
        { name, arguments: args },
        undefined,
        this._buildProgressOptions(serverId, name),
      ),
      result => this._serializeLogValue(result),
      result => [
        this._summarizeLogValue('Result content', result.content),
        `Tool reported error: ${result.isError === true ? 'yes' : 'no'}`,
      ].join('\n'),
    );
  }

  async listResources(serverId: string): Promise<McpResource[]> {
    if (!this._supportsCapability(serverId, 'resources')) {
      this._log(serverId, 'info', 'Resources not supported by this server');
      return [];
    }
    return this._measureRequest(
      serverId,
      'List resources',
      { method: 'resources/list' },
      async () => {
        const { resources } = await this._client(serverId).listResources();
        return resources as McpResource[];
      },
      result => this._serializeLogValue(result),
      result => this._summarizeLogValue('Resources', result),
    );
  }

  async readResource(serverId: string, uri: string): ReturnType<Client['readResource']> {
    return this._measureRequest(
      serverId,
      `Read resource ${uri}`,
      { uri },
      () => this._client(serverId).readResource(
        { uri },
        this._buildProgressOptions(serverId, 'readResource'),
      ),
      result => this._serializeLogValue(result),
      result => this._summarizeLogValue('Resource result', result),
    );
  }

  async listPrompts(serverId: string): Promise<McpPrompt[]> {
    if (!this._supportsCapability(serverId, 'prompts')) {
      this._log(serverId, 'info', 'Prompts not supported by this server');
      return [];
    }
    return this._measureRequest(
      serverId,
      'List prompts',
      { method: 'prompts/list' },
      async () => {
        const { prompts } = await this._client(serverId).listPrompts();
        return prompts as McpPrompt[];
      },
      result => this._serializeLogValue(result),
      result => this._summarizeLogValue('Prompts', result),
    );
  }

  private async _setLoggingLevelIfSupported(serverId: string, client: Client): Promise<void> {
    const capabilities = client.getServerCapabilities();
    if (capabilities?.logging !== undefined) {
      try {
        await this._measure(serverId, 'Set logging level', () => client.setLoggingLevel('info'));
        this._log(serverId, 'info', 'Server logging level set to info');
      } catch (error: unknown) {
        this._log(serverId, 'warn', 'Failed to set server logging level', error instanceof Error ? error.message : String(error));
      }
    }
  }

  async completePromptArgument(
    serverId: string,
    promptName: string,
    argumentName: string,
    value: string,
    contextArgs: Record<string, string>,
  ): Promise<string[]> {
    const context = Object.keys(contextArgs).length > 0 ? { arguments: contextArgs } : undefined;

    if (!this._supportsCapability(serverId, 'completions')) {
      this._log(serverId, 'info', `Prompt argument completion not supported for ${promptName}.${argumentName}`, [{
        kind: 'request',
        content: this._serializeLogValue({
          ref: { type: 'ref/prompt', name: promptName },
          argument: { name: argumentName, value },
          context,
        }),
      }]);
      return [];
    }

    return this._measureRequest(
      serverId,
      `Complete prompt argument ${promptName}.${argumentName}`,
      {
        ref: { type: 'ref/prompt', name: promptName },
        argument: { name: argumentName, value },
        context,
      },
      async () => {
        const result = await this._client(serverId).complete({
          ref: { type: 'ref/prompt', name: promptName },
          argument: { name: argumentName, value },
          context,
        });

        return result.completion.values;
      },
      result => this._serializeLogValue(result),
      result => this._summarizeLogValue('Completion values', result),
    );
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string>): ReturnType<Client['getPrompt']> {
    return this._measureRequest(
      serverId,
      `Get prompt ${name}`,
      { name, arguments: args },
      () => this._client(serverId).getPrompt(
        { name, arguments: args },
        this._buildProgressOptions(serverId, name),
      ),
      result => this._serializeLogValue(result),
      result => this._summarizeLogValue('Prompt result', result),
    );
  }

  getServerDetails(serverId: string): McpServerDetails {
    const client = this._client(serverId);
    const serverInfo = client.getServerVersion();

    return {
      serverInfo: serverInfo
        ? {
          name: serverInfo.name,
          version: serverInfo.version,
          title: serverInfo.title,
          description: serverInfo.description,
          websiteUrl: serverInfo.websiteUrl,
        }
        : undefined,
      instructions: client.getInstructions(),
      capabilities: client.getServerCapabilities() as Record<string, unknown> | undefined,
    };
  }

  disposeAll(): void {
    // disconnect() captures the conn reference synchronously before clear() runs,
    // so fire-and-forget here is safe — clear() only removes the map entries.
    for (const [id] of this._connections) {
      this.disconnect(id).catch(() => undefined);
    }
    this._connections.clear();
  }

  // Private helpers

  private _client(serverId: string): Client {
    const conn = this._connections.get(serverId);
    if (!conn) throw new Error(`Not connected to server "${serverId}". Connect first.`);
    return conn.client;
  }

  private _supportsCapability(serverId: string, capability: 'tools' | 'resources' | 'prompts' | 'completions'): boolean {
    const capabilities = this._client(serverId).getServerCapabilities();
    if (!capabilities) return false;
    return capabilities[capability] !== undefined;
  }

  private _createTransport(config: McpServerConfig, oauthState?: OAuthState) {
    if (config.type === 'stdio') {
      if (!config.command) throw new Error(`Stdio server "${config.name}" is missing a command.`);

      return new StdioClientTransport({
        command: config.command,
        args: config.args ?? [],
        // Only pass env if the user defined extra vars; the SDK already merges
        // getDefaultEnvironment() (which includes the full PATH) automatically.
        env: Object.keys(config.env ?? {}).length > 0 ? config.env : undefined,
        cwd: config.cwd,
        stderr: 'pipe', // capture stderr for better error messages
      });
    }

    if (!config.url) throw new Error(`Server "${config.name}" is missing a URL.`);
    const url = new URL(config.url);
    const requestInit = config.headers
      ? { headers: config.headers }
      : undefined;

    // Wrap fetch: logging records every request, OAuth handles 401 token acquisition
    const loggingFetch = createLoggingFetch((entry) => this._logFetchEntry(config.id, entry));
    const authenticatedFetch = createOAuthHandler(loggingFetch, {
      accountSelection: this._getAuthAccountSelection(config),
      serverName: config.name,
      state: oauthState,
    });

    if (config.type === 'sse') {
      return new SSEClientTransport(url, {
        ...(requestInit ? { requestInit } : {}),
        fetch: authenticatedFetch,
      });
    }

    // http (streamable)
    // Note: reconnectionOptions are intentionally omitted. Background auto-reconnect
    // attempts from the transport can fire after client.close() and become unhandled
    // promise rejections that crash the extension host. The user reconnects manually.
    return new StreamableHTTPClientTransport(url, {
      ...(requestInit ? { requestInit } : {}),
      fetch: authenticatedFetch,
    });
  }
}
