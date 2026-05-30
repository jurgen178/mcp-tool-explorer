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

export type AuthAccountSelection = 'auto' | 'prompt' | 'disabled';
export type AuthAccountSelectionOverrides = Record<string, AuthAccountSelection>;

export interface McpTool {
  name: string;
  description?: string;
  inputSchema: InputSchema;
  _meta?: {
    ui?: {
      resourceUri?: string;
      visibility?: Array<'model' | 'app'>;
    };
  };
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

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type CapabilityKind = 'tools' | 'resources' | 'prompts';
export type CapabilityLoadState = 'idle' | 'loading' | 'loaded' | 'error';

// Test Cases

export type TestAssertionType = 'no-error' | 'contains' | 'equals' | 'json-path';

export interface TestAssertion {
  type: TestAssertionType;
  expected?: string;
  path?: string;
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
  /** Preferred input mode for the editor UI. */
  viewMode?: 'json' | 'form';
  assertion: TestAssertion;
}

export interface TestRunResult {
  testId: string;
  status: 'pass' | 'fail' | 'error';
  durationMs: number;
  actual?: unknown;
  message?: string;
}

export interface RequestEntry {
  status: 'pending' | 'done' | 'error';
  data?: unknown;
  isError?: boolean;
  errorMsg?: string;
  structuredContent?: unknown;
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

// Messages: Webview → Extension

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
  | { type: 'setAuthOverride'; serverId: string; serverName: string; accountSelection: AuthAccountSelection }
  | { type: 'cancelConnect'; serverId: string }
  | { type: 'loadTests' }
  | { type: 'saveTests'; tests: TestCase[]; variables: Record<string, string> }
  | { type: 'runTest'; test: TestCase; requestId: string; variables: Record<string, string> }
  | { type: 'openExternal'; url: string }
  | { type: 'fetchUiResource'; serverId: string; uri: string; requestId: string };

// Messages: Extension → Webview

export type MessageToWebview =
  | { type: 'serversLoaded'; servers: McpServerConfig[] }
  | { type: 'serverAdded'; server: McpServerConfig }
  | { type: 'serverUpdated'; server: McpServerConfig }
  | { type: 'serverRemoved'; serverId: string }
  | { type: 'authOverridesLoaded'; overrides: AuthAccountSelectionOverrides }
  | { type: 'connected'; serverId: string }
  | { type: 'serverDetailsLoaded'; serverId: string; details: McpServerDetails }
  | { type: 'serverEvent'; serverId: string; event: McpEventEntry }
  | { type: 'disconnected'; serverId: string }
  | { type: 'connectionError'; serverId: string; error: string }
  | { type: 'capabilityLoadFailed'; serverId: string; capability: CapabilityKind; error: string }
  | { type: 'toolsListed'; serverId: string; tools: McpTool[] }
  | { type: 'toolResult'; requestId: string; result: unknown; isError: boolean; structuredContent?: unknown }
  | { type: 'resourcesListed'; serverId: string; resources: McpResource[] }
  | { type: 'resourceContent'; requestId: string; content: unknown }
  | { type: 'promptsListed'; serverId: string; prompts: McpPrompt[] }
  | { type: 'promptArgumentCompletion'; requestId: string; argumentName: string; values: string[] }
  | { type: 'promptContent'; requestId: string; content: unknown }
  | { type: 'connectionLog'; serverId: string; log: { timestamp: number; level: 'info' | 'warn' | 'error'; message: string; detail?: string | { kind: 'request' | 'response' | 'request-headers' | 'response-headers' | 'error' | 'text'; content: string }[] } }
  | { type: 'testsLoaded'; tests: TestCase[]; variables: Record<string, string> }
  | { type: 'testRunResult'; requestId: string; result: TestRunResult }
  | { type: 'uiResourceContent'; requestId: string; html: string; csp?: { connectDomains?: string[]; resourceDomains?: string[]; frameDomains?: string[] } }
  | { type: 'error'; message: string; requestId?: string };
