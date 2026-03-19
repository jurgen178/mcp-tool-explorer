import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { McpClientManager } from '../mcp/McpClientManager';
import { McpConfigDiscovery } from '../mcp/McpConfigDiscovery';
import type { McpServerConfig, MessageToExtension, MessageToWebview } from '../types';

export class McpToolExplorerPanel {
  public static currentPanel: McpToolExplorerPanel | undefined;

  private readonly _panel: vscode.WebviewPanel;
  private readonly _extensionUri: vscode.Uri;
  private readonly _disposables: vscode.Disposable[] = [];

  private readonly _clientManager: McpClientManager;
  private readonly _configDiscovery: McpConfigDiscovery;
  /** Single source-of-truth for server configs while the panel is open. */
  private _servers = new Map<string, McpServerConfig>();

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

    McpToolExplorerPanel.currentPanel = new McpToolExplorerPanel(panel, context.extensionUri);
  }

  public static refresh(): void {
    McpToolExplorerPanel.currentPanel?._sendServers();
  }

  // ── Constructor ───────────────────────────────────────────────────────────

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri) {
    this._panel = panel;
    this._extensionUri = extensionUri;
    const ext = vscode.extensions.getExtension('jurgen178.mcp-tool-explorer');
    const version: string = (ext?.packageJSON as { version?: string })?.version ?? '1.0.0';
    this._clientManager = new McpClientManager(version);
    this._configDiscovery = new McpConfigDiscovery();

    this._panel.webview.html = this._buildHtml();

    this._panel.webview.onDidReceiveMessage(
      (msg: MessageToExtension) => this._handleMessage(msg),
      null,
      this._disposables,
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
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
        break;
      }

      case 'connect': {
        const config = this._servers.get(message.serverId);
        if (!config) {
          this._post({ type: 'connectionError', serverId: message.serverId, error: 'Server config not found' });
          return;
        }
        // Wire up log listener so every log entry streams to the webview
        this._clientManager.setLogListener((log) => {
          this._post({ type: 'connectionLog', serverId: message.serverId, log });
        });
        try {
          await this._clientManager.connect(config);
          this._post({ type: 'connected', serverId: message.serverId });
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

      case 'addServer': {
        const server = this._configDiscovery.addManualServer(message.config);
        this._servers.set(server.id, server);
        this._post({ type: 'serverAdded', server });
        break;
      }

      case 'removeServer': {
        const wasConnected = this._clientManager.isConnected(message.serverId);
        if (wasConnected) await this._clientManager.disconnect(message.serverId);
        this._configDiscovery.removeManualServer(message.serverId);
        this._servers.delete(message.serverId);
        this._post({ type: 'serverRemoved', serverId: message.serverId });
        break;
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async _sendServers(): Promise<void> {
    const servers = await this._configDiscovery.discoverServers();
    this._servers.clear();
    for (const s of servers) this._servers.set(s.id, s);
    this._post({ type: 'serversLoaded', servers });
  }

  /** Best-effort: load tools, resources, and prompts after a successful connect. */
  private async _loadCapabilities(serverId: string): Promise<void> {
    const tryLoad = async <T>(fn: () => Promise<T>): Promise<T | null> => {
      try { return await fn(); } catch { return null; }
    };

    const [tools, resources, prompts] = await Promise.all([
      tryLoad(() => this._clientManager.listTools(serverId)),
      tryLoad(() => this._clientManager.listResources(serverId)),
      tryLoad(() => this._clientManager.listPrompts(serverId)),
    ]);

    if (tools)     this._post({ type: 'toolsListed',     serverId, tools });
    if (resources) this._post({ type: 'resourcesListed', serverId, resources });
    if (prompts)   this._post({ type: 'promptsListed',   serverId, prompts });
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
