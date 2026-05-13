// Shared types between extension host and webview.
// Keep this file free of Node/VS Code/browser imports so both sides can use it.

export interface McpServerConfig {
  id: string;
  name: string;
  type: 'stdio' | 'sse' | 'http';
  // stdio
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** Working directory for stdio servers — set to the workspace folder root. */
  cwd?: string;
  // sse / http
  url?: string;
  headers?: Record<string, string>;
  // where it was discovered
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

export interface McpImplementationInfo {
  name: string;
  version: string;
  title?: string;
  description?: string;
  websiteUrl?: string;
}

export interface McpServerDetails {
  serverInfo?: McpImplementationInfo;
  instructions?: string;
  capabilities?: Record<string, unknown>;
}

export interface McpEventEntry {
  id: string;
  timestamp: number;
  method: string;
  title: string;
  level: 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
  groupKey?: string;
  logger?: string;
  data?: unknown;
}

export type CapabilityKind = 'tools' | 'resources' | 'prompts';

// ── Test Cases ────────────────────────────────────────────────────────────────

export type TestAssertionType = 'no-error' | 'contains' | 'equals' | 'json-path';

export interface TestAssertion {
  type: TestAssertionType;
  /** Expected value (string or JSON text) for 'contains' and 'equals'. */
  expected?: string;
  /** Dot-notation path for 'json-path'. */
  path?: string;
  /** Expected value at path for 'json-path'. */
  pathExpected?: string;
}

export interface TestCase {
  id: string;
  name: string;
  /** Optional group/suite name for organising tests in the UI. */
  group?: string;
  serverId: string;
  /** Server endpoint for portability: URL for http/sse servers, or the command string for stdio.
   * Used as fallback when serverId is not found in the local MCP config. */
  serverEndpoint?: string;
  toolName: string;
  args: Record<string, unknown>;
  assertion: TestAssertion;
}

export interface TestRunResult {
  testId: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  actual?: unknown;
  message?: string;
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
  | { type: 'completePromptArgument'; serverId: string; promptName: string; argumentName: string; value: string; contextArgs: Record<string, string>; requestId: string }
  | { type: 'getPrompt'; serverId: string; promptName: string; args: Record<string, string>; requestId: string }
  | { type: 'addServer'; config: Omit<McpServerConfig, 'id' | 'source'> }
  | { type: 'updateServer'; serverId: string; config: Omit<McpServerConfig, 'id' | 'source'> }
  | { type: 'removeServer'; serverId: string }
  | { type: 'loadTests' }
  | { type: 'saveTests'; tests: TestCase[]; variables: Record<string, string> }
  | { type: 'runTest'; test: TestCase; requestId: string; variables: Record<string, string> };

// ── Messages: Extension → Webview ──────────────────────────────────────────

export type MessageToWebview =
  | { type: 'serversLoaded'; servers: McpServerConfig[] }
  | { type: 'serverAdded'; server: McpServerConfig }
  | { type: 'serverUpdated'; server: McpServerConfig }
  | { type: 'serverRemoved'; serverId: string }
  | { type: 'connected'; serverId: string }
  | { type: 'serverDetailsLoaded'; serverId: string; details: McpServerDetails }
  | { type: 'serverEvent'; serverId: string; event: McpEventEntry }
  | { type: 'disconnected'; serverId: string }
  | { type: 'connectionError'; serverId: string; error: string }
  | { type: 'capabilityLoadFailed'; serverId: string; capability: CapabilityKind; error: string }
  | { type: 'toolsListed'; serverId: string; tools: McpTool[] }
  | { type: 'toolResult'; requestId: string; result: unknown; isError: boolean }
  | { type: 'resourcesListed'; serverId: string; resources: McpResource[] }
  | { type: 'resourceContent'; requestId: string; content: unknown }
  | { type: 'promptsListed'; serverId: string; prompts: McpPrompt[] }
  | { type: 'promptArgumentCompletion'; requestId: string; argumentName: string; values: string[] }
  | { type: 'promptContent'; requestId: string; content: unknown }
  | { type: 'connectionLog'; serverId: string; log: { timestamp: number; level: 'info' | 'warn' | 'error'; message: string; detail?: string | { kind: string; content: string }[] } }
  | { type: 'testsLoaded'; tests: TestCase[]; variables: Record<string, string> }
  | { type: 'testRunResult'; requestId: string; result: TestRunResult }
  | { type: 'error'; message: string; requestId?: string };
