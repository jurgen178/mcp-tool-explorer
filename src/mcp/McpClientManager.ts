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
import type { McpEventEntry, McpServerConfig, McpServerDetails, McpTool, McpResource, McpPrompt } from '../types';
import { createOAuthHandler } from './McpOAuth';
import { createLoggingFetch, type FetchLogEntry } from './LoggingFetch';

export interface LogSection {
  kind: 'request' | 'response' | 'request-headers' | 'response-headers' | 'error' | 'text';
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

export class McpClientManager {
  private readonly _connections = new Map<string, ActiveConnection>();
  private readonly _version: string;
  /** Callback to emit log entries to the panel during connect. */
  private _onLog: ((entry: ConnectionLogEntry) => void) | undefined;
  private _onEvent: ((serverId: string, event: McpEventEntry) => void) | undefined;
  private _eventCounter = 0;
  private readonly _recentEventGroups = new Map<string, RecentEventGroup>();
  private readonly _urlCtor = (globalThis as unknown as { URL: new (input: string) => { pathname: string } & object }).URL;

  constructor(version: string) {
    this._version = version;
  }

  /** Set a listener for connection log entries (called before connect). */
  setLogListener(listener: (entry: ConnectionLogEntry) => void): void {
    this._onLog = listener;
  }

  setEventListener(listener: (serverId: string, event: McpEventEntry) => void): void {
    this._onEvent = listener;
  }

  private _log(level: ConnectionLogEntry['level'], message: string, detail?: string | LogSection[]): void {
    this._onLog?.({ timestamp: Date.now(), level, message, detail });
  }

  private _emitEvent(serverId: string, event: Omit<McpEventEntry, 'id' | 'timestamp'>): void {
    this._onEvent?.(serverId, {
      id: `evt-${Date.now()}-${++this._eventCounter}`,
      timestamp: Date.now(),
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

  private _getRecentEventGroup(serverId: string, maxAgeMs = 600): string | undefined {
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

  private async _measure<T>(label: string, operation: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    this._log('info', `${label} started`);

    try {
      const result = await operation();
      this._log('info', `${label} finished in ${Date.now() - startedAt}ms`);
      return result;
    } catch (error: unknown) {
      this._log('error', `${label} failed after ${Date.now() - startedAt}ms`, error instanceof Error ? error.message : String(error));
      throw error;
    }
  }

  private _logFetchEntry(entry: FetchLogEntry): void {
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
    this._log(level, `HTTP ${entry.method} ${new this._urlCtor(entry.url).pathname}${rpcLabel}  →  ${statusStr}`, sections.length > 0 ? sections : undefined);
  }

  isConnected(serverId: string): boolean {
    return this._connections.has(serverId);
  }

  async connect(config: McpServerConfig): Promise<void> {
    // Disconnect first if already connected
    if (this._connections.has(config.id)) {
      await this.disconnect(config.id);
    }

    this._log('info', `Connecting to "${config.name}"…`, [
      `Type: ${config.type}`,
      config.url ? `URL: ${config.url}` : `Command: ${config.command} ${(config.args ?? []).join(' ')}`,
      config.headers ? `Headers: ${JSON.stringify(config.headers)}` : '',
      config.cwd ? `CWD: ${config.cwd}` : '',
    ].filter(Boolean).join('\n'));

    const client = new Client(
      { name: 'mcp-tool-explorer', version: this._version },
      { capabilities: { logging: {} } as Record<string, unknown> },
    );

    this._registerNotificationHandlers(client, config.id);

    const transport = this._createTransport(config);

    // Collect stderr so "Connection closed" errors include the real reason
    let stderrOutput = '';
    if (config.type === 'stdio') {
      const stdioTransport = transport as StdioClientTransport;
      stdioTransport.stderr?.on('data', (chunk: { toString(): string }) => {
        const line = chunk.toString();
        stderrOutput += line;
        this._log('warn', 'Server stderr', line.trim());
      });
    }

    try {
      this._log('info', `Attempting ${config.type.toUpperCase()} transport…`);
      await this._measure(`Connect ${config.type.toUpperCase()} transport`, () => client.connect(transport));
      this._log('info', `Connected successfully via ${config.type.toUpperCase()}.`);
    } catch (e: unknown) {
      const baseMsg = e instanceof Error ? e.message : String(e);
      const stack = e instanceof Error ? e.stack : undefined;
      this._log('error', `${config.type.toUpperCase()} transport failed`, [baseMsg, stack ? `Stack: ${stack}` : ''].filter(Boolean).join('\n'));

      // Fall back from Streamable HTTP to SSE (per MCP spec recommendation)
      if (config.type === 'http' && config.url) {
        try { await client.close(); } catch { /* ignore cleanup errors */ }

        this._log('info', 'Falling back to SSE transport…');
        const sseClient = new Client(
          { name: 'mcp-tool-explorer', version: this._version },
          { capabilities: { logging: {} } as Record<string, unknown> },
        );
        const sseTransport = this._createTransport({ ...config, type: 'sse' });
        try {
          await this._measure('Connect SSE transport fallback', () => sseClient.connect(sseTransport));
          this._log('info', 'Connected successfully via SSE.');
          this._connections.set(config.id, { client: sseClient, config });
          return;
        } catch (e2: unknown) {
          try { await sseClient.close(); } catch { /* ensure EventSource is stopped */ }
          const sseMsg = e2 instanceof Error ? e2.message : String(e2);
          this._log('error', 'SSE transport also failed', sseMsg);
          // SSE also failed — fall through to throw the original error
        }
      }

      const detail = stderrOutput.trim();
      const fullError = detail ? `${baseMsg}\n\nServer stderr:\n${detail}` : baseMsg;
      this._log('error', 'Connection failed', fullError);
      throw new Error(fullError);
    }

    this._connections.set(config.id, { client, config });

    const capabilities = client.getServerCapabilities();
    if (capabilities?.logging !== undefined) {
      try {
        await this._measure('Set logging level', () => client.setLoggingLevel('info'));
        this._log('info', 'Server logging level set to info.');
      } catch (error: unknown) {
        this._log('warn', 'Failed to set server logging level', error instanceof Error ? error.message : String(error));
      }
    }
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this._connections.get(serverId);
    if (conn) {
      try { await conn.client.close(); } catch { /* ignore */ }
      this._connections.delete(serverId);
    }
  }

  async listTools(serverId: string): Promise<McpTool[]> {
    if (!this._supportsCapability(serverId, 'tools')) {
      this._log('info', 'Tools not supported by this server.');
      return [];
    }
    const { tools } = await this._measure('List tools', () => this._client(serverId).listTools());
    return tools as McpTool[];
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>) {
    return this._client(serverId).callTool(
      { name, arguments: args },
      undefined,
      this._buildProgressOptions(serverId, name),
    );
  }

  async listResources(serverId: string): Promise<McpResource[]> {
    if (!this._supportsCapability(serverId, 'resources')) {
      this._log('info', 'Resources not supported by this server.');
      return [];
    }
    const { resources } = await this._measure('List resources', () => this._client(serverId).listResources());
    return resources as McpResource[];
  }

  async readResource(serverId: string, uri: string) {
    return this._client(serverId).readResource(
      { uri },
      this._buildProgressOptions(serverId, 'readResource'),
    );
  }

  async listPrompts(serverId: string): Promise<McpPrompt[]> {
    if (!this._supportsCapability(serverId, 'prompts')) {
      this._log('info', 'Prompts not supported by this server.');
      return [];
    }
    const { prompts } = await this._measure('List prompts', () => this._client(serverId).listPrompts());
    return prompts as McpPrompt[];
  }

  async completePromptArgument(
    serverId: string,
    promptName: string,
    argumentName: string,
    value: string,
    contextArgs: Record<string, string>,
  ): Promise<string[]> {
    if (!this._supportsCapability(serverId, 'completions')) {
      return [];
    }

    const result = await this._client(serverId).complete({
      ref: { type: 'ref/prompt', name: promptName },
      argument: { name: argumentName, value },
      context: Object.keys(contextArgs).length > 0 ? { arguments: contextArgs } : undefined,
    });

    return result.completion.values;
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string>) {
    return this._client(serverId).getPrompt(
      { name, arguments: args },
      this._buildProgressOptions(serverId, name),
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
    for (const [id] of this._connections) {
      this.disconnect(id).catch(() => undefined);
    }
    this._connections.clear();
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private _client(serverId: string): Client {
    const conn = this._connections.get(serverId);
    if (!conn) throw new Error(`Not connected to server "${serverId}". Connect first.`);
    return conn.client;
  }

  private _supportsCapability(serverId: string, capability: 'tools' | 'resources' | 'prompts' | 'completions'): boolean {
    const capabilities = this._client(serverId).getServerCapabilities();
    if (!capabilities) return true;
    return capabilities[capability] !== undefined;
  }

  private _createTransport(config: McpServerConfig) {
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
    const url = new this._urlCtor(config.url);
    const requestInit = config.headers
      ? { headers: config.headers }
      : undefined;

    // Wrap fetch: logging records every request, OAuth handles 401 token acquisition
    const loggingFetch = createLoggingFetch((entry) => this._logFetchEntry(entry));
    const authenticatedFetch = createOAuthHandler(loggingFetch);

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
