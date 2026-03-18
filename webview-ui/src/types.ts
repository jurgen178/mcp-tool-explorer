// Re-export shared types for the webview bundle.
// Keep in sync with ../../src/types.ts

export interface McpServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for stdio servers. */
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  source: 'vscode-mcp.json' | 'settings' | 'manual';
}

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: InputSchema;
}

export interface InputSchema {
  type?: string;
  properties?: Record<string, SchemaProperty>;
  required?: string[];
  [key: string]: unknown;
}

export interface SchemaProperty {
  type?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: SchemaProperty;
  [key: string]: unknown;
}

export interface McpResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface McpPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface RequestEntry {
  status: 'pending' | 'done' | 'error';
  data?: unknown;
  isError?: boolean;
  errorMsg?: string;
}

export interface RequestInfo {
  type: 'tool' | 'resource' | 'prompt';
  name: string;
  args?: unknown;
}

export interface HistoryEntry extends RequestInfo {
  id: string;        // same as requestId
  serverId: string;
  timestamp: number;
  durationMs?: number;
  status: 'pending' | 'done' | 'error';
  result?: unknown;
  isError?: boolean;
}

// ── Messages: Webview → Extension ──────────────────────────────────────────

export type MessageToExtension =
  | { type: 'getServers' }
  | { type: 'connect'; serverId: string }
  | { type: 'disconnect'; serverId: string }
  | { type: 'listTools'; serverId: string }
  | { type: 'callTool'; serverId: string; toolName: string; args: Record<string, unknown>; requestId: string }
  | { type: 'listResources'; serverId: string }
  | { type: 'readResource'; serverId: string; uri: string; requestId: string }
  | { type: 'listPrompts'; serverId: string }
  | { type: 'getPrompt'; serverId: string; promptName: string; args: Record<string, string>; requestId: string }
  | { type: 'addServer'; config: Omit<McpServerConfig, 'id' | 'source'> }
  | { type: 'removeServer'; serverId: string };

// ── Messages: Extension → Webview ──────────────────────────────────────────

export type MessageToWebview =
  | { type: 'serversLoaded'; servers: McpServerConfig[] }
  | { type: 'serverAdded'; server: McpServerConfig }
  | { type: 'serverRemoved'; serverId: string }
  | { type: 'connected'; serverId: string }
  | { type: 'disconnected'; serverId: string }
  | { type: 'connectionError'; serverId: string; error: string }
  | { type: 'toolsListed'; serverId: string; tools: McpTool[] }
  | { type: 'toolResult'; requestId: string; result: unknown; isError: boolean }
  | { type: 'resourcesListed'; serverId: string; resources: McpResource[] }
  | { type: 'resourceContent'; requestId: string; content: unknown }
  | { type: 'promptsListed'; serverId: string; prompts: McpPrompt[] }
  | { type: 'promptContent'; requestId: string; content: unknown }
  | { type: 'error'; message: string; requestId?: string };
