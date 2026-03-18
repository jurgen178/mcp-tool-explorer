import type { McpServerConfig, ConnectionStatus } from '../types';

interface Props {
  servers: McpServerConfig[];
  serversLoading: boolean;
  serverStatus: Record<string, ConnectionStatus>;
  selectedServerId: string | null;
  onSelect: (id: string) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: () => void;
}

export default function Sidebar({
  servers, serversLoading, serverStatus, selectedServerId,
  onSelect, onConnect, onDisconnect, onRemove, onAdd,
}: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Servers</span>
        <button className="icon-btn" title="Add server" onClick={onAdd}>＋</button>
      </div>

      <div className="server-list scroll-list">
        {serversLoading ? (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
            <span className="spinner" />Discovering…
          </div>
        ) : servers.length === 0 ? (
          <div style={{ padding: '12px 10px', fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
            No servers found.
          </div>
        ) : servers.map(server => {
          const status: ConnectionStatus = serverStatus[server.id] ?? 'disconnected';
          const isSelected = server.id === selectedServerId;
          return (
            <div
              key={server.id}
              className={`server-item${isSelected ? ' active' : ''}`}
              onClick={() => onSelect(server.id)}
              title={server.type === 'stdio' ? server.command : server.url}
            >
              <span className={`dot dot-${status}`} />
              <span className="server-name">{server.name}</span>
              <span className="server-type-badge">{server.type}</span>

              {/* Action buttons — only visible on hover via CSS parent context */}
              {status === 'disconnected' || status === 'error' ? (
                <button
                  className="icon-btn"
                  style={{ fontSize: 11, marginLeft: 2 }}
                  title="Connect"
                  onClick={e => { e.stopPropagation(); onSelect(server.id); onConnect(server.id); }}
                >▶</button>
              ) : status === 'connected' ? (
                <button
                  className="icon-btn"
                  style={{ fontSize: 11, marginLeft: 2 }}
                  title="Disconnect"
                  onClick={e => { e.stopPropagation(); onDisconnect(server.id); }}
                >■</button>
              ) : null}

              {server.source === 'manual' && (
                <button
                  className="icon-btn"
                  style={{ fontSize: 11 }}
                  title="Remove server"
                  onClick={e => { e.stopPropagation(); onRemove(server.id); }}
                >✕</button>
              )}
            </div>
          );
        })}
      </div>

      <button className="sidebar-add-btn" onClick={onAdd}>
        + Add Server
      </button>
    </div>
  );
}
