import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServerConfig, McpTool, McpResource, McpPrompt } from '../types';

interface ActiveConnection {
  client: Client;
  config: McpServerConfig;
}

export class McpClientManager {
  private readonly _connections = new Map<string, ActiveConnection>();
  private readonly _version: string;

  constructor(version: string) {
    this._version = version;
  }

  isConnected(serverId: string): boolean {
    return this._connections.has(serverId);
  }

  async connect(config: McpServerConfig): Promise<void> {
    // Disconnect first if already connected
    if (this._connections.has(config.id)) {
      await this.disconnect(config.id);
    }

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
        stderrOutput += chunk.toString();
      });
    }

    try {
      await client.connect(transport);
    } catch (e: unknown) {
      // Per the MCP spec, clients SHOULD try Streamable HTTP first and
      // fall back to SSE when the server doesn't support it.
      if (config.type === 'http' && config.url) {
        try { await client.close(); } catch { /* ignore cleanup errors */ }

        const sseClient = new Client(
          { name: 'mcp-tool-explorer', version: this._version },
          { capabilities: { tools: {}, resources: {}, prompts: {} } },
        );
        const sseTransport = this._createTransport({ ...config, type: 'sse' });
        try {
          await sseClient.connect(sseTransport);
          this._connections.set(config.id, { client: sseClient, config });
          return;
        } catch {
          // SSE also failed — fall through to throw the original error
        }
      }

      const base = e instanceof Error ? e.message : String(e);
      const detail = stderrOutput.trim();
      throw new Error(detail ? `${base}\n\nServer stderr:\n${detail}` : base);
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

    if (config.type === 'sse') {
      return new SSEClientTransport(url, requestInit ? { requestInit } : undefined);
    }

    // http (streamable)
    return new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  }
}
