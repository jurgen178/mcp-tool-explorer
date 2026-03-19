import * as vscode from 'vscode';
import { McpToolExplorerPanel } from './panels/McpToolExplorerPanel';

export function activate(context: vscode.ExtensionContext): void {
  const openCommand = vscode.commands.registerCommand('mcpToolExplorer.open', () => {
    McpToolExplorerPanel.createOrShow(context);
  });

  context.subscriptions.push(openCommand);

  // Auto-open if the workspace contains a .vscode/mcp.json
  const watcher = vscode.workspace.createFileSystemWatcher('**/.vscode/mcp.json');
  watcher.onDidCreate(() => McpToolExplorerPanel.refresh());
  watcher.onDidChange(() => McpToolExplorerPanel.refresh());
  context.subscriptions.push(watcher);
}

export function deactivate(): void {
  McpToolExplorerPanel.currentPanel?.dispose();
}
