import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpClientManager } from '../mcp/McpClientManager';
import { McpConfigDiscovery } from '../mcp/McpConfigDiscovery';
import type { CapabilityKind, McpServerConfig, MessageToExtension, MessageToWebview, TestAssertion, TestRunResult } from '../types';

export class McpToolExplorerPanel {
  public static currentPanel: McpToolExplorerPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _disposables: vscode.Disposable[] = [];

  private readonly _clientManager: McpClientManager;
  private readonly _configDiscovery: McpConfigDiscovery;
  /** Single source-of-truth for server configs while the panel is open. */
  private _servers = new Map<string, McpServerConfig>();
  /** Timestamp until which file-watcher events for the test file should be ignored (avoids echo after own writes). */
  private _ignoreWatcherUntil = 0;

  // ── Static factory ────────────────────────────────────────────────────────

  public static createOrShow(context: vscode.ExtensionContext): void {
    const column = vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.One;

    if (McpToolExplorerPanel.currentPanel) {
      McpToolExplorerPanel.currentPanel._panel.reveal(column);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      'mcpToolExplorer',
      'MCP Tool Explorer',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist', 'webview')],
      },
    );

    McpToolExplorerPanel.currentPanel = new McpToolExplorerPanel(panel, context);
  }

  public static refresh(): void {
    McpToolExplorerPanel.currentPanel?._sendServers();
  }

  // ── Constructor ───────────────────────────────────────────────────────────

  private constructor(panel: vscode.WebviewPanel, context: vscode.ExtensionContext) {
    this._panel = panel;
    this._extensionUri = context.extensionUri;
    const ext = vscode.extensions.getExtension('jurgen178.mcp-tool-explorer');
    const version: string = (ext?.packageJSON as { version?: string })?.version ?? '1.0.0';
    this._clientManager = new McpClientManager(version);
    this._configDiscovery = new McpConfigDiscovery(context);

    this._panel.webview.html = this._buildHtml();

    this._panel.webview.onDidReceiveMessage(
      (msg: MessageToExtension) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Watch for external changes to the test file
    const testWatcher = vscode.workspace.createFileSystemWatcher('**/.mcp-tests.json');
    const onTestFileChanged = () => { if (Date.now() > this._ignoreWatcherUntil) this._loadAndSendTests(); };
    testWatcher.onDidChange(onTestFileChanged, null, this._disposables);
    testWatcher.onDidCreate(onTestFileChanged, null, this._disposables);
    testWatcher.onDidDelete(() => { if (Date.now() > this._ignoreWatcherUntil) this._post({ type: 'testsLoaded', tests: [], variables: {} }); }, null, this._disposables);
    this._disposables.push(testWatcher);
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private async _handleMessage(message: MessageToExtension): Promise<void> {
    try {
      await this._processMessage(message);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this._post({
        type: 'error',
        message: msg,
        requestId: (message as Record<string, unknown>).requestId as string | undefined,
      });
    }
  }

  private async _processMessage(message: MessageToExtension): Promise<void> {
    switch (message.type) {
      case 'getServers': {
        await this._sendServers();
        await this._loadAndSendTests();
        break;
      }

      case 'connect': {
        const config = this._servers.get(message.serverId);
        if (!config) {
          this._post({ type: 'connectionError', serverId: message.serverId, error: 'Server config not found' });
          return;
        }
        // Wire up log listener so every log entry streams to the webview
        this._clientManager.setLogListener(message.serverId, (log) => {
          this._post({ type: 'connectionLog', serverId: message.serverId, log });
        });
        this._clientManager.setEventListener((serverId, event) => {
          this._post({ type: 'serverEvent', serverId, event });
          void this._handleServerEvent(serverId, event.method);
        });
        try {
          await this._clientManager.connect(config);
          this._post({ type: 'connected', serverId: message.serverId });
          this._post({
            type: 'serverDetailsLoaded',
            serverId: message.serverId,
            details: this._clientManager.getServerDetails(message.serverId),
          });
          await this._loadCapabilities(message.serverId);
        } catch (e: unknown) {
          const error = e instanceof Error ? e.message : String(e);
          this._post({ type: 'connectionError', serverId: message.serverId, error });
        }
        break;
      }

      case 'disconnect': {
        await this._clientManager.disconnect(message.serverId);
        this._post({ type: 'disconnected', serverId: message.serverId });
        break;
      }

      case 'listTools': {
        const tools = await this._clientManager.listTools(message.serverId);
        this._post({ type: 'toolsListed', serverId: message.serverId, tools });
        break;
      }

      case 'callTool': {
        const result = await this._clientManager.callTool(message.serverId, message.toolName, message.args);
        this._post({
          type: 'toolResult',
          requestId: message.requestId,
          // The webview works directly with MCP content items so it can apply its
          // own interpretation pipeline for raw, text, image, and JSON results.
          result: result.content,
          isError: result.isError === true,
        });
        break;
      }

      case 'listResources': {
        const resources = await this._clientManager.listResources(message.serverId);
        this._post({ type: 'resourcesListed', serverId: message.serverId, resources });
        break;
      }

      case 'readResource': {
        const content = await this._clientManager.readResource(message.serverId, message.uri);
        this._post({ type: 'resourceContent', requestId: message.requestId, content });
        break;
      }

      case 'listPrompts': {
        const prompts = await this._clientManager.listPrompts(message.serverId);
        this._post({ type: 'promptsListed', serverId: message.serverId, prompts });
        break;
      }

      case 'getPrompt': {
        const content = await this._clientManager.getPrompt(message.serverId, message.promptName, message.args);
        this._post({ type: 'promptContent', requestId: message.requestId, content });
        break;
      }

      case 'completePromptArgument': {
        try {
          const values = await this._clientManager.completePromptArgument(
            message.serverId,
            message.promptName,
            message.argumentName,
            message.value,
            message.contextArgs,
          );
          this._post({ type: 'promptArgumentCompletion', requestId: message.requestId, argumentName: message.argumentName, values });
        } catch {
          this._post({ type: 'promptArgumentCompletion', requestId: message.requestId, argumentName: message.argumentName, values: [] });
        }
        break;
      }

      case 'addServer': {
        const server = await this._configDiscovery.addManualServer(message.config);
        this._servers.set(server.id, server);
        this._post({ type: 'serverAdded', server });
        break;
      }

      case 'updateServer': {
        const updated = await this._configDiscovery.updateManualServer(message.serverId, message.config);
        if (updated) {
          this._servers.set(updated.id, updated);
          this._post({ type: 'serverUpdated', server: updated });
        }
        break;
      }

      case 'removeServer': {
        const wasConnected = this._clientManager.isConnected(message.serverId);
        if (wasConnected) await this._clientManager.disconnect(message.serverId);
        await this._configDiscovery.removeManualServer(message.serverId);
        this._servers.delete(message.serverId);
        this._post({ type: 'serverRemoved', serverId: message.serverId });
        break;
      }

      case 'loadTests': {
        await this._loadAndSendTests();
        break;
      }

      case 'saveTests': {
        const filePath = this._getTestFilePath();
        if (!filePath) { break; }
        // Serialize with explicit property order so the JSON is readable and consistent
        const ordered = message.tests.map(t => ({
          id: t.id,
          name: t.name,
          ...(t.group ? { group: t.group } : {}),
          serverId: t.serverId,
          serverEndpoint: t.serverEndpoint,
          toolName: t.toolName,
          args: t.args,
          assertion: t.assertion,
        }));
        const fileContent = { variables: message.variables, tests: ordered };
        this._ignoreWatcherUntil = Date.now() + 500;
        fs.writeFileSync(filePath, JSON.stringify(fileContent, null, 2), 'utf-8');
        break;
      }

      case 'runTest': {
        const { test, requestId, variables } = message;
        const start = Date.now();
        try {
          // Resolve the server: prefer exact serverId match, fall back to serverEndpoint match
          const resolvedServerId = this._resolveServerId(test.serverId, test.serverEndpoint);
          if (!resolvedServerId) {
            this._post({ type: 'testRunResult', requestId, result: { testId: test.id, status: 'error', durationMs: 0, message: `Server "${test.serverId}" not found locally${test.serverEndpoint ? ` (endpoint: ${test.serverEndpoint})` : ''}. Add and connect the server first.` } });
            break;
          }
          if (!this._clientManager.isConnected(resolvedServerId)) {
            this._post({ type: 'testRunResult', requestId, result: { testId: test.id, status: 'error', durationMs: 0, message: 'Server is not connected. Connect to the server first.' } });
            break;
          }
          const resolvedArgs = _substituteVars(test.args, variables ?? {});
          const mcpResult = await this._clientManager.callTool(resolvedServerId, test.toolName, resolvedArgs);
          const durationMs = Date.now() - start;
          const evalResult = _evaluateAssertion(test.assertion, mcpResult.content, mcpResult.isError === true);
          this._post({ type: 'testRunResult', requestId, result: { testId: test.id, status: evalResult.pass ? 'pass' : 'fail', durationMs, actual: mcpResult.content, message: evalResult.message } });
        } catch (e: unknown) {
          const durationMs = Date.now() - start;
          this._post({ type: 'testRunResult', requestId, result: { testId: test.id, status: 'error', durationMs, message: e instanceof Error ? e.message : String(e) } });
        }
        break;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  private _getTestFilePath(): string | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    return folder ? path.join(folder, '.mcp-tests.json') : undefined;
  }

  /**
   * Resolve a serverId from a test case.
   * 1. If serverId exists in the known server map → use it directly.
   * 2. Otherwise fall back to matching serverEndpoint against known server urls/commands.
   * Returns undefined if no server matches.
   */
  private _resolveServerId(serverId: string, serverEndpoint?: string): string | undefined {
    if (this._servers.has(serverId)) return serverId;
    if (!serverEndpoint) return undefined;
    const needle = serverEndpoint.trim();
    for (const [id, cfg] of this._servers) {
      if (cfg.url && cfg.url.trim() === needle) return id;
      if (cfg.command) {
        const cmdString = [cfg.command, ...(cfg.args ?? [])].join(' ').trim();
        if (cmdString === needle) return id;
      }
    }
    return undefined;
  }

  private async _loadAndSendTests(): Promise<void> {
    const filePath = this._getTestFilePath();
    if (!filePath || !fs.existsSync(filePath)) {
      this._post({ type: 'testsLoaded', tests: [], variables: {} });
      return;
    }
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(raw);
      // Support both legacy (plain array) and new ({variables, tests}) format
      const tests = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.tests) ? parsed.tests : []);
      const variables: Record<string, string> = (!Array.isArray(parsed) && parsed.variables && typeof parsed.variables === 'object') ? parsed.variables : {};
      this._post({ type: 'testsLoaded', tests, variables });
    } catch {
      this._post({ type: 'testsLoaded', tests: [], variables: {} });
    }
  }
  private async _sendServers(): Promise<void> {
    const servers = await this._configDiscovery.discoverServers();
    this._servers.clear();
    for (const s of servers) this._servers.set(s.id, s);
    this._post({ type: 'serversLoaded', servers });
  }

  /** Best-effort: load tools, resources, and prompts after a successful connect. */
  private async _loadCapabilities(serverId: string): Promise<void> {
    const loadResultMessage = (capability: CapabilityKind, reason: unknown): MessageToWebview => ({
      type: 'capabilityLoadFailed',
      serverId,
      capability,
      error: reason instanceof Error ? reason.message : String(reason),
    });

    const loadCapability = <T,>(
      capability: CapabilityKind,
      load: () => Promise<T>,
      onSuccess: (value: T) => void,
    ): Promise<void> => load()
      .then(onSuccess)
      .catch(reason => {
        this._post(loadResultMessage(capability, reason));
      });

    await Promise.all([
      loadCapability('tools', () => this._clientManager.listTools(serverId), tools => {
        this._post({ type: 'toolsListed', serverId, tools });
      }),
      loadCapability('resources', () => this._clientManager.listResources(serverId), resources => {
        this._post({ type: 'resourcesListed', serverId, resources });
      }),
      loadCapability('prompts', () => this._clientManager.listPrompts(serverId), prompts => {
        this._post({ type: 'promptsListed', serverId, prompts });
      }),
    ]);
  }

  private async _handleServerEvent(serverId: string, method: string): Promise<void> {
    switch (method) {
      case 'notifications/tools/list_changed': {
        try {
          const tools = await this._clientManager.listTools(serverId);
          this._post({ type: 'toolsListed', serverId, tools });
        } catch {
          // Best-effort refresh only.
        }
        break;
      }
      case 'notifications/resources/list_changed': {
        try {
          const resources = await this._clientManager.listResources(serverId);
          this._post({ type: 'resourcesListed', serverId, resources });
        } catch {
          // Best-effort refresh only.
        }
        break;
      }
      case 'notifications/prompts/list_changed': {
        try {
          const prompts = await this._clientManager.listPrompts(serverId);
          this._post({ type: 'promptsListed', serverId, prompts });
        } catch {
          // Best-effort refresh only.
        }
        break;
      }
    }
  }

  private _post(message: MessageToWebview): void {
    this._panel.webview.postMessage(message);
  }

  // ── HTML generation ───────────────────────────────────────────────────────

  private _buildHtml(): string {
    const webviewDist = vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview');
    const indexPath = path.join(webviewDist.fsPath, 'index.html');

    if (!fs.existsSync(indexPath)) {
      return this._buildPlaceholderHtml();
    }

    const baseUri = this._panel.webview.asWebviewUri(webviewDist).toString();
    const cspSource = this._panel.webview.cspSource;

    let html = fs.readFileSync(indexPath, 'utf-8');

    // Replace relative asset paths with absolute webview URIs
    html = html.replace(/(src|href)="\.\/(assets\/[^"]+)"/g, `$1="${baseUri}/$2"`);
    html = html.replace(/(src|href)="\/(assets\/[^"]+)"/g, `$1="${baseUri}/$2"`);

    // Inject CSP meta tag
    const csp = [
      `default-src 'none'`,
      `img-src ${cspSource} https: data:`,
      `script-src 'unsafe-inline' ${cspSource}`,
      `style-src 'unsafe-inline' ${cspSource}`,
      `font-src ${cspSource}`,
    ].join('; ');

    html = html.replace(
      '<head>',
      `<head>\n    <meta http-equiv="Content-Security-Policy" content="${csp}">`,
    );

    return html;
  }

  private _buildPlaceholderHtml(): string {
    return `<!DOCTYPE html><html><body style="color:var(--vscode-foreground);font-family:var(--vscode-font-family);padding:24px">
      <h2>MCP Tool Explorer</h2>
      <p>Webview assets not built yet. Run <code>npm run build:webview</code> and reload.</p>
    </body></html>`;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  public dispose(): void {
    McpToolExplorerPanel.currentPanel = undefined;
    this._clientManager.disposeAll();
    this._panel.dispose();
    while (this._disposables.length) {
      this._disposables.pop()?.dispose();
    }
  }
}

// ── Test assertion evaluation (module-level) ──────────────────────────────────

function _evaluateAssertion(
  assertion: TestAssertion,
  actual: unknown,
  isError: boolean,
): { pass: boolean; message?: string } {
  switch (assertion.type) {
    case 'no-error':
      return isError
        ? { pass: false, message: 'Tool returned an error' }
        : { pass: true };

    case 'contains': {
      const text = JSON.stringify(actual);
      const expected = assertion.expected ?? '';
      return text.includes(expected)
        ? { pass: true }
        : { pass: false, message: `Expected output to contain: ${expected}` };
    }

    case 'equals': {
      let expectedParsed: unknown;
      try { expectedParsed = JSON.parse(assertion.expected ?? 'null'); }
      catch { return { pass: false, message: 'Expected value is not valid JSON' }; }
      const actualStr = JSON.stringify(actual);
      const expectedStr = JSON.stringify(expectedParsed);
      return actualStr === expectedStr
        ? { pass: true }
        : { pass: false, message: `Expected:\n${expectedStr}\n\nGot:\n${actualStr}` };
    }

    case 'json-path': {
      const value = _getJsonPath(actual, assertion.path ?? '');
      const expectedStr = assertion.pathExpected ?? '';
      const actualStr = typeof value === 'string' ? value : JSON.stringify(value);
      return actualStr === expectedStr || JSON.stringify(value) === expectedStr
        ? { pass: true }
        : { pass: false, message: `At path "${assertion.path}": expected "${expectedStr}", got "${actualStr}"` };
    }

    default:
      return { pass: false, message: 'Unknown assertion type' };
  }
}

function _getJsonPath(obj: unknown, dotPath: string): unknown {
  if (!dotPath) return obj;
  const parts = dotPath.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Replace {{VAR_NAME}} placeholders in all string values of args. */
function _substituteVars(args: Record<string, unknown>, vars: Record<string, string>): Record<string, unknown> {
  const json = JSON.stringify(args);
  const substituted = json.replace(/\{\{(\w+)\}\}/g, (_, name: string) => name in vars ? vars[name] : `{{${name}}}`);
  try { return JSON.parse(substituted) as Record<string, unknown>; }
  catch { return args; }
}
