import * as vscode from 'vscode';
import { McpExplorerPanel } from './panels/McpExplorerPanel';

export function activate(context: vscode.ExtensionContext): void {
  const openCommand = vscode.commands.registerCommand('mcpExplorer.open', () => {
    McpExplorerPanel.createOrShow(context);
  });

  context.subscriptions.push(openCommand);

  // Auto-open if the workspace contains a .vscode/mcp.json
  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/mcp.json');
  watcher.onDidCreate(() => McpExplorerPanel.refresh());
  watcher.onDidChange(() => McpExplorerPanel.refresh());
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  McpExplorerPanel.currentPanel?.dispose();
}
