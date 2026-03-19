import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpTool, McpResource, McpPrompt } from '../types';
import { createOAuthHandler } from './McpOAuth';
import { createLoggingFetch, type FetchLogEntry } from './LoggingFetch';

export interface ConnectionLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string;
}

interface ActiveConnection {
  client: Client;
  config: McpServerConfig;
}

export class McpClientManager {
  private readonly _connections = new Map<string, ActiveConnection>();
  private readonly _version: string;
  /** Callback to emit log entries to the panel during connect. */
  private _onLog: ((entry: ConnectionLogEntry) => void) | undefined;

  constructor(version: string) {
    this._version = version;
  }

  /** Set a listener for connection log entries (called before connect). */
  setLogListener(listener: (entry: ConnectionLogEntry) => void): void {
    this._onLog = listener;
  }

  private _log(level: ConnectionLogEntry['level'], message: string, detail?: string): void {
    this._onLog?.({ timestamp: Date.now(), level, message, detail });
  }

  private _logFetchEntry(entry: FetchLogEntry): void {
    const statusStr = entry.status !== null ? `${entry.status} ${entry.statusText}` : 'NETWORK ERROR';
    const level: ConnectionLogEntry['level'] = entry.error ? 'error' : (entry.status && entry.status >= 400) ? 'warn' : 'info';

    const lines = [
      `${entry.method} ${entry.url}  →  ${statusStr}  (${entry.durationMs}ms)`,
    ];
    if (entry.rpcMethod) {
      lines.push(`JSON-RPC method: ${entry.rpcMethod}`);
    }
    if (Object.keys(entry.requestHeaders).length > 0) {
      lines.push('Request headers:');
      for (const [k, v] of Object.entries(entry.requestHeaders)) lines.push(`  ${k}: ${v}`);
    }
    if (entry.status !== null) {
      lines.push('Response headers:');
      for (const [k, v] of Object.entries(entry.responseHeaders)) lines.push(`  ${k}: ${v}`);
    }
    if (entry.bodyExcerpt) {
      lines.push('Response body (excerpt):');
      lines.push(`  ${entry.bodyExcerpt}`);
    }
    if (entry.error) {
      lines.push(`Error: ${entry.error}`);
    }

    const rpcLabel = entry.rpcMethod ? ` (${entry.rpcMethod})` : '';
    this._log(level, `HTTP ${entry.method} ${new URL(entry.url).pathname}${rpcLabel}  →  ${statusStr}`, lines.join('\n'));
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
      { capabilities: { tools: {}, resources: {}, prompts: {} } },
    );

    const transport = this._createTransport(config);

    // Collect stderr so "Connection closed" errors include the real reason
    let stderrOutput = '';
    if (config.type === 'stdio') {
      const stdioTransport = transport as StdioClientTransport;
      stdioTransport.stderr?.on('data', (chunk: Buffer) => {
        const line = chunk.toString();
        stderrOutput += line;
        this._log('warn', 'Server stderr', line.trim());
      });
    }

    try {
      this._log('info', `Attempting ${config.type.toUpperCase()} transport…`);
      await client.connect(transport);
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
          { capabilities: { tools: {}, resources: {}, prompts: {} } },
        );
        const sseTransport = this._createTransport({ ...config, type: 'sse' });
        try {
          await sseClient.connect(sseTransport);
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
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this._connections.get(serverId);
    if (conn) {
      try { await conn.client.close(); } catch { /* ignore */ }
      this._connections.delete(serverId);
    }
  }

  async listTools(serverId: string): Promise<McpTool[]> {
    const { tools } = await this._client(serverId).listTools();
    return tools as McpTool[];
  }

  async callTool(serverId: string, name: string, args: Record<string, unknown>) {
    return this._client(serverId).callTool({ name, arguments: args });
  }

  async listResources(serverId: string): Promise<McpResource[]> {
    const { resources } = await this._client(serverId).listResources();
    return resources as McpResource[];
  }

  async readResource(serverId: string, uri: string) {
    return this._client(serverId).readResource({ uri });
  }

  async listPrompts(serverId: string): Promise<McpPrompt[]> {
    const { prompts } = await this._client(serverId).listPrompts();
    return prompts as McpPrompt[];
  }

  async getPrompt(serverId: string, name: string, args: Record<string, string>) {
    return this._client(serverId).getPrompt({ name, arguments: args });
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
    const url = new URL(config.url);
    const requestInit: RequestInit | undefined = config.headers
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
    return new StreamableHTTPClientTransport(url, {
      ...(requestInit ? { requestInit } : {}),
      fetch: authenticatedFetch,
      reconnectionOptions: { maxRetries: 2, initialReconnectionDelay: 1000, maxReconnectionDelay: 5000, reconnectionDelayGrowFactor: 1.5 },
    });
  }
}
