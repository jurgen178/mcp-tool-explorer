import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import type { McpServerConfig } from '../types';

/** Stable ID for a discovered server so the frontend can track connections. */
function stableId(source: string, name: string): string {
  return `${source}:${name}`;
}

const GLOBAL_STATE_KEY = 'manualServers';
const SECRETS_PREFIX = 'env:';

/** Stored shape — env is kept separately in secrets, so we omit it here. */
type StoredServer = Omit<McpServerConfig, 'env'>;

export class McpConfigDiscovery {
  private readonly _context: vscode.ExtensionContext;
  private readonly _manualServers: McpServerConfig[] = [];

  constructor(context: vscode.ExtensionContext) {
    this._context = context;
    // Restore persisted servers (without env — loaded lazily in discoverServers)
    const stored = context.globalState.get<StoredServer[]>(GLOBAL_STATE_KEY, []);
    for (const s of stored) {
      this._manualServers.push({ ...s, env: {} });
    }
  }

  async discoverServers(): Promise<McpServerConfig[]> {
    const servers: McpServerConfig[] = [];

    // 1. .vscode/mcp.json in every open workspace folder
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const mcpJsonPath = path.join(folder.uri.fsPath, '.vscode', 'mcp.json');
      if (fs.existsSync(mcpJsonPath)) {
        try {
          const raw = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf-8')) as Record<string, unknown>;
          const mcpServers =
            (raw['servers'] as Record<string, unknown>) ??
            (raw['mcpServers'] as Record<string, unknown>) ??
            {};
          for (const [name, cfg] of Object.entries(mcpServers)) {
            servers.push(this._parse(name, cfg as Record<string, unknown>, 'vscode-mcp.json', folder.uri.fsPath));
          }
        } catch {
          // malformed JSON — skip silently
        }
      }
    }

    // 2. VS Code workspace / user setting: mcp.servers
    // NOTE: VS Code automatically syncs .vscode/mcp.json into the mcp.servers
    // workspace setting, so we skip any name already discovered from mcp.json.
    const settingsServers =
      vscode.workspace.getConfiguration('mcp').get<Record<string, unknown>>('servers') ?? {};
    const firstFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    for (const [name, cfg] of Object.entries(settingsServers)) {
      // Deduplicate by name — skip if already discovered from any source
      if (!servers.some(s => s.name === name)) {
        servers.push(this._parse(name, cfg as Record<string, unknown>, 'settings', firstFolder));
      }
    }

    // 3. Manually added servers — load env from secrets
    for (const server of this._manualServers) {
      const envRaw = await this._context.secrets.get(`${SECRETS_PREFIX}${server.id}`);
      server.env = envRaw ? (JSON.parse(envRaw) as Record<string, string>) : {};
    }
    servers.push(...this._manualServers);

    return servers;
  }

  async addManualServer(config: Omit<McpServerConfig, 'id' | 'source'>): Promise<McpServerConfig> {
    const { env, ...rest } = config;
    const server: McpServerConfig = {
      ...rest,
      env: env ?? {},
      id: `manual:${Date.now()}`,
      source: 'manual',
    };
    this._manualServers.push(server);
    await this._persist(server);
    return server;
  }

  async updateManualServer(serverId: string, config: Omit<McpServerConfig, 'id' | 'source'>): Promise<McpServerConfig | undefined> {
    const idx = this._manualServers.findIndex(s => s.id === serverId);
    if (idx === -1) return undefined;
    const { env, ...rest } = config;
    const updated: McpServerConfig = { ...rest, env: env ?? {}, id: serverId, source: 'manual' };
    this._manualServers[idx] = updated;
    await this._persist(updated);
    return updated;
  }

  async removeManualServer(serverId: string): Promise<void> {
    const idx = this._manualServers.findIndex(s => s.id === serverId);
    if (idx !== -1) {
      this._manualServers.splice(idx, 1);
      await this._context.secrets.delete(`${SECRETS_PREFIX}${serverId}`);
      await this._saveGlobalState();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private async _persist(server: McpServerConfig): Promise<void> {
    if (server.env && Object.keys(server.env).length > 0) {
      await this._context.secrets.store(`${SECRETS_PREFIX}${server.id}`, JSON.stringify(server.env));
    }
    await this._saveGlobalState();
  }

  private async _saveGlobalState(): Promise<void> {
    // Persist server metadata without env (stored separately in secrets)
    const toStore: StoredServer[] = this._manualServers.map(({ env: _env, ...rest }) => rest);
    await this._context.globalState.update(GLOBAL_STATE_KEY, toStore);
  }

  private _parse(
    name: string,
    cfg: Record<string, unknown>,
    source: McpServerConfig['source'],
    workspaceRoot?: string,
  ): McpServerConfig {
    const explicitType = cfg['type'] as string | undefined;
    const url = cfg['url'] as string | undefined;

    let type: McpServerConfig['type'];
    if (explicitType === 'stdio' || explicitType === 'sse' || explicitType === 'http') {
      type = explicitType;
    } else if (url) {
      type = 'http'; // default for URL-based servers (Streamable HTTP)
    } else {
      type = 'stdio';
    }

    return {
      id: stableId(source, name),
      name,
      type,
      command: cfg['command'] as string | undefined,
      args: (cfg['args'] as string[] | undefined) ?? [],
      env: (cfg['env'] as Record<string, string> | undefined) ?? {},
      cwd: (cfg['cwd'] as string | undefined) ?? workspaceRoot,
      url,
      headers: cfg['headers'] as Record<string, string> | undefined,
      source,
    };
  }
}
