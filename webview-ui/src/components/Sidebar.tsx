import type { McpServerConfig, ConnectionStatus, McpServerDetails } from '../types';

interface CapabilitySupport {
  tools: boolean | null;
  resources: boolean | null;
  prompts: boolean | null;
}

interface Props {
  servers: McpServerConfig[];
  serversLoading: boolean;
  serverStatus: Record<string, ConnectionStatus>;
  serverDetails: Record<string, McpServerDetails | undefined>;
  selectedServerId: string | null;
  onSelect: (id: string) => void;
  onConnect: (id: string) => void;
  onDisconnect: (id: string) => void;
  onRemove: (id: string) => void;
  onEdit: (server: McpServerConfig) => void;
  onAdd: () => void;
}

function getCapabilitySupport(details?: McpServerDetails): CapabilitySupport {
  const capabilities = details?.capabilities;
  if (!capabilities) {
    return { tools: null, resources: null, prompts: null };
  }

  return {
    tools: capabilities.tools !== undefined,
    resources: capabilities.resources !== undefined,
    prompts: capabilities.prompts !== undefined,
  };
}

function describeCapability(label: string, supported: boolean | null): string {
  if (supported === null) return `${label}: unknown`;
  return `${label}: ${supported ? 'yes' : 'no'}`;
}

const STATUS_LABEL: Record<ConnectionStatus, string> = {
  disconnected: 'Not connected',
  connecting:   'Connecting…',
  connected:    'Connected',
  error:        'Error',
};

function buildTooltip(server: McpServerConfig, status: ConnectionStatus, details?: McpServerDetails): string {
  const target = server.type === 'stdio'
    ? [server.command, ...(server.args ?? [])].filter(Boolean).join(' ')
    : server.url ?? '';

  const lines = [
    server.name,
    `Status: ${STATUS_LABEL[status]}`,
    `Target: ${target || 'n/a'}`,
  ];

  if (status === 'connected') {
    const capabilitySupport = getCapabilitySupport(details);
    lines.push(
      describeCapability('(T)ools', capabilitySupport.tools),
      describeCapability('(R)esources', capabilitySupport.resources),
      describeCapability('(P)rompts', capabilitySupport.prompts),
    );
  }

  return lines.join('\n');
}

export default function Sidebar({
  servers, serversLoading, serverStatus, serverDetails, selectedServerId,
  onSelect, onConnect, onDisconnect, onRemove, onEdit, onAdd,
}: Props) {
  return (
    <div className="sidebar">
      <div className="sidebar-header">
        <span>Servers</span>
        <button className="icon-btn" title="Add server" onClick={onAdd}>＋</button>
      </div>

      <div className="server-list scroll-list">
        {serversLoading ? (
          <div className="sidebar-status-text">
            <span className="spinner" />Discovering…
          </div>
        ) : servers.length === 0 ? (
          <div className="sidebar-status-text">
            No servers found.
          </div>
        ) : servers.map(server => {
          const status: ConnectionStatus = serverStatus[server.id] ?? 'disconnected';
          const isSelected = server.id === selectedServerId;
          const capabilitySupport = getCapabilitySupport(serverDetails[server.id]);
          return (
            <div
              key={server.id}
              className={`server-item${isSelected ? ' active' : ''}`}
              onClick={() => onSelect(server.id)}
              title={buildTooltip(server, status, serverDetails[server.id])}
            >
              <span className={`dot dot-${status}`} />
              <div className="server-meta">
                <span className="server-name">{server.name}</span>
                {status === 'connected' && (
                  <div className="server-capabilities" aria-label="Supported capabilities">
                    <span className={`server-capability${capabilitySupport.tools === true ? ' is-supported' : capabilitySupport.tools === false ? ' is-unsupported' : ' is-unknown'}`}>T</span>
                    <span className={`server-capability${capabilitySupport.resources === true ? ' is-supported' : capabilitySupport.resources === false ? ' is-unsupported' : ' is-unknown'}`}>R</span>
                    <span className={`server-capability${capabilitySupport.prompts === true ? ' is-supported' : capabilitySupport.prompts === false ? ' is-unsupported' : ' is-unknown'}`}>P</span>
                  </div>
                )}
              </div>
              <span className="server-type-badge">{server.type}</span>

              {/* Action buttons — only visible on hover via CSS parent context */}
              {status === 'disconnected' || status === 'error' ? (
                <button
                  className="icon-btn server-action-btn"
                  title="Connect"
                  onClick={e => { e.stopPropagation(); onSelect(server.id); onConnect(server.id); }}
                >▶</button>
              ) : status === 'connected' ? (
                <button
                  className="icon-btn server-action-btn"
                  title="Disconnect"
                  onClick={e => { e.stopPropagation(); onDisconnect(server.id); }}
                >■</button>
              ) : null}

              {server.source === 'manual' && (
                <>
                  <button
                    className="icon-btn server-edit-btn"
                    title="Edit server"
                    onClick={e => { e.stopPropagation(); onEdit(server); }}
                  >✎</button>
                  <button
                    className="icon-btn server-remove-btn"
                    title="Remove server"
                    onClick={e => { e.stopPropagation(); onRemove(server.id); }}
                  >✕</button>
                </>
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
