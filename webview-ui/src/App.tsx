import React, { useReducer, useEffect } from 'react';
import { postMessage } from './vscode';
import type {
  McpServerConfig, McpTool, McpResource, McpPrompt,
  MessageToWebview, ConnectionStatus, RequestEntry, RequestInfo, HistoryEntry,
} from './types';
import Sidebar from './components/Sidebar';
import ToolsPanel from './components/ToolsPanel';
import ResourcesPanel from './components/ResourcesPanel';
import PromptsPanel from './components/PromptsPanel';
import HistoryPanel from './components/HistoryPanel';
import AddServerModal from './components/AddServerModal';

// ── State & Reducer ──────────────────────────────────────────────────────────

interface AppState {
  servers: McpServerConfig[];
  serversLoading: boolean;
  serverStatus: Record<string, ConnectionStatus>;
  serverErrors: Record<string, string>;
  selectedServerId: string | null;
  activeTab: 'tools' | 'resources' | 'prompts' | 'history';
  tools: Record<string, McpTool[]>;
  resources: Record<string, McpResource[]>;
  prompts: Record<string, McpPrompt[]>;
  requests: Record<string, RequestEntry>;
  history: HistoryEntry[];
  showAddServer: boolean;
}

type Action =
  | { type: 'SERVERS_LOADED'; servers: McpServerConfig[] }
  | { type: 'SERVER_ADDED'; server: McpServerConfig }
  | { type: 'SERVER_REMOVED'; serverId: string }
  | { type: 'CONNECTING'; serverId: string }
  | { type: 'CONNECTED'; serverId: string }
  | { type: 'DISCONNECTED'; serverId: string }
  | { type: 'CONNECTION_ERROR'; serverId: string; error: string }
  | { type: 'TOOLS_LISTED'; serverId: string; tools: McpTool[] }
  | { type: 'RESOURCES_LISTED'; serverId: string; resources: McpResource[] }
  | { type: 'PROMPTS_LISTED'; serverId: string; prompts: McpPrompt[] }
  | { type: 'REQUEST_DONE'; requestId: string; data: unknown; isError: boolean }
  | { type: 'REQUEST_STARTED'; requestId: string }
  | { type: 'SELECT_SERVER'; serverId: string }
  | { type: 'SELECT_TAB'; tab: 'tools' | 'resources' | 'prompts' | 'history' }
  | { type: 'SHOW_ADD_SERVER'; show: boolean }
  | { type: 'EXT_ERROR'; message: string; requestId?: string }
  | { type: 'HISTORY_ADD'; entry: HistoryEntry }
  | { type: 'HISTORY_UPDATE'; id: string; status: 'done' | 'error'; result?: unknown; isError?: boolean }
  | { type: 'HISTORY_CLEAR'; serverId: string };

const initialState: AppState = {
  servers: [],
  serversLoading: true,
  serverStatus: {},
  serverErrors: {},
  selectedServerId: null,
  activeTab: 'tools',
  tools: {},
  resources: {},
  prompts: {},
  requests: {},
  history: [],
  showAddServer: false,
};

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SERVERS_LOADED':
      return {
        ...state,
        servers: action.servers,
        serversLoading: false,
        // Preserve status for servers that stayed
        serverStatus: Object.fromEntries(
          action.servers.map(s => [s.id, state.serverStatus[s.id] ?? 'disconnected']),
        ),
      };

    case 'SERVER_ADDED':
      return {
        ...state,
        servers: [...state.servers, action.server],
        serverStatus: { ...state.serverStatus, [action.server.id]: 'disconnected' },
      };

    case 'SERVER_REMOVED': {
      const servers = state.servers.filter(s => s.id !== action.serverId);
      const { [action.serverId]: _ss, ...serverStatus } = state.serverStatus;
      const { [action.serverId]: _se, ...serverErrors } = state.serverErrors;
      const { [action.serverId]: _t, ...tools } = state.tools;
      const { [action.serverId]: _r, ...resources } = state.resources;
      const { [action.serverId]: _p, ...prompts } = state.prompts;
      return {
        ...state, servers, serverStatus, serverErrors, tools, resources, prompts,
        selectedServerId: state.selectedServerId === action.serverId ? null : state.selectedServerId,
      };
    }

    case 'CONNECTING':
      return { ...state, serverStatus: { ...state.serverStatus, [action.serverId]: 'connecting' } };

    case 'CONNECTED':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'connected' },
        serverErrors: { ...state.serverErrors, [action.serverId]: '' },
      };

    case 'DISCONNECTED':
      return { ...state, serverStatus: { ...state.serverStatus, [action.serverId]: 'disconnected' } };

    case 'CONNECTION_ERROR':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'error' },
        serverErrors: { ...state.serverErrors, [action.serverId]: action.error },
      };

    case 'TOOLS_LISTED':
      return { ...state, tools: { ...state.tools, [action.serverId]: action.tools } };

    case 'RESOURCES_LISTED':
      return { ...state, resources: { ...state.resources, [action.serverId]: action.resources } };

    case 'PROMPTS_LISTED':
      return { ...state, prompts: { ...state.prompts, [action.serverId]: action.prompts } };

    case 'REQUEST_STARTED':
      return { ...state, requests: { ...state.requests, [action.requestId]: { status: 'pending' } } };

    case 'REQUEST_DONE':
      return {
        ...state,
        requests: {
          ...state.requests,
          [action.requestId]: { status: action.isError ? 'error' : 'done', data: action.data, isError: action.isError },
        },
      };

    case 'EXT_ERROR':
      if (action.requestId) {
        return {
          ...state,
          requests: {
            ...state.requests,
            [action.requestId]: { status: 'error', errorMsg: action.message },
          },
        };
      }
      return state;

    case 'HISTORY_ADD':
      return { ...state, history: [action.entry, ...state.history].slice(0, 300) };

    case 'HISTORY_UPDATE': {
      const history = state.history.map(e =>
        e.id === action.id
          ? { ...e, status: action.status, durationMs: Date.now() - e.timestamp, result: action.result, isError: action.isError ?? false }
          : e,
      );
      return { ...state, history };
    }

    case 'HISTORY_CLEAR':
      return { ...state, history: state.history.filter(e => e.serverId !== action.serverId) };

    case 'SELECT_SERVER':
      return { ...state, selectedServerId: action.serverId };

    case 'SELECT_TAB':
      return { ...state, activeTab: action.tab };

    case 'SHOW_ADD_SERVER':
      return { ...state, showAddServer: action.show };

    default:
      return state;
  }
}

// ── Component ────────────────────────────────────────────────────────────────

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // ── Message listener ────────────────────────────────────────────────────

  useEffect(() => {
    const handler = (event: MessageEvent<MessageToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'serversLoaded':   dispatch({ type: 'SERVERS_LOADED',    servers: msg.servers }); break;
        case 'serverAdded':     dispatch({ type: 'SERVER_ADDED',      server: msg.server }); break;
        case 'serverRemoved':   dispatch({ type: 'SERVER_REMOVED',    serverId: msg.serverId }); break;
        case 'connected':       dispatch({ type: 'CONNECTED',         serverId: msg.serverId }); break;
        case 'disconnected':    dispatch({ type: 'DISCONNECTED',      serverId: msg.serverId }); break;
        case 'connectionError': dispatch({ type: 'CONNECTION_ERROR',  serverId: msg.serverId, error: msg.error }); break;
        case 'toolsListed':     dispatch({ type: 'TOOLS_LISTED',      serverId: msg.serverId, tools: msg.tools }); break;
        case 'resourcesListed': dispatch({ type: 'RESOURCES_LISTED',  serverId: msg.serverId, resources: msg.resources }); break;
        case 'promptsListed':   dispatch({ type: 'PROMPTS_LISTED',    serverId: msg.serverId, prompts: msg.prompts }); break;
        case 'toolResult':
        case 'resourceContent':
        case 'promptContent': {
          const data = msg.type === 'toolResult' ? msg.result : msg.content;
          const isError = msg.type === 'toolResult' ? msg.isError : false;
          dispatch({ type: 'REQUEST_DONE', requestId: msg.requestId, data, isError });
          dispatch({ type: 'HISTORY_UPDATE', id: msg.requestId, status: isError ? 'error' : 'done', result: data, isError });
          break;
        }
        case 'error':
          dispatch({ type: 'EXT_ERROR', message: msg.message, requestId: msg.requestId });
          if (msg.requestId) {
            dispatch({ type: 'HISTORY_UPDATE', id: msg.requestId, status: 'error', result: msg.message, isError: true });
          }
          break;
      }
    };
    window.addEventListener('message', handler);
    // Ask the extension for configured servers on mount
    postMessage({ type: 'getServers' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // ── Actions ─────────────────────────────────────────────────────────────

  const handleConnect = (serverId: string) => {
    dispatch({ type: 'CONNECTING', serverId });
    postMessage({ type: 'connect', serverId });
  };

  const handleDisconnect = (serverId: string) => {
    postMessage({ type: 'disconnect', serverId });
  };

  const handleSelectServer = (serverId: string) => {
    dispatch({ type: 'SELECT_SERVER', serverId });
  };

  const handleRemoveServer = (serverId: string) => {
    postMessage({ type: 'removeServer', serverId });
  };

  const handleAddServer = (config: McpServerConfig) => {
    postMessage({ type: 'addServer', config });
    dispatch({ type: 'SHOW_ADD_SERVER', show: false });
  };

  const handleStartRequest = (requestId: string, info: RequestInfo) => {
    dispatch({ type: 'REQUEST_STARTED', requestId });
    dispatch({
      type: 'HISTORY_ADD',
      entry: {
        id: requestId,
        serverId: state.selectedServerId ?? '',
        ...info,
        timestamp: Date.now(),
        status: 'pending',
      },
    });
  };

  const handleRerun = (toolName: string, args: unknown) => {
    // Switch to tools tab — ToolsPanel picks up the jump via selectedTool state internally
    dispatch({ type: 'SELECT_TAB', tab: 'tools' });
    // Signal ToolsPanel to pre-load via a ref-based approach is done inside the panel;
    // here we just surface the data via a prop
    setPendingRerun({ toolName, args });
  };

  const [pendingRerun, setPendingRerun] = React.useState<{ toolName: string; args: unknown } | null>(null);

  // ── Selected server data ─────────────────────────────────────────────────

  const selectedServer = state.servers.find(s => s.id === state.selectedServerId) ?? null;
  const selectedStatus = state.selectedServerId ? (state.serverStatus[state.selectedServerId] ?? 'disconnected') : 'disconnected';
  const isConnected = selectedStatus === 'connected';

  return (
    <div className="app">
      <Sidebar
        servers={state.servers}
        serversLoading={state.serversLoading}
        serverStatus={state.serverStatus}
        selectedServerId={state.selectedServerId}
        onSelect={handleSelectServer}
        onConnect={handleConnect}
        onDisconnect={handleDisconnect}
        onRemove={handleRemoveServer}
        onAdd={() => dispatch({ type: 'SHOW_ADD_SERVER', show: true })}
      />

      <div className="main">
        {selectedServer ? (
          <>
            {/* Server header */}
            <div className="server-header">
              <span className="server-header-name">{selectedServer.name}</span>
              <span className={`status-badge status-badge-${selectedStatus}`}>
                {selectedStatus === 'connecting' && <span className="spinner" />}
                {selectedStatus}
              </span>
              {state.serverErrors[selectedServer.id] && (
                <span style={{ fontSize: 11, color: 'var(--vscode-charts-red, #f44747)', flex: 1 }}>
                  {state.serverErrors[selectedServer.id]}
                </span>
              )}
              {selectedStatus === 'disconnected' || selectedStatus === 'error' ? (
                <button className="btn btn-primary" style={{ fontSize: 12 }} onClick={() => handleConnect(selectedServer.id)}>
                  Connect
                </button>
              ) : selectedStatus === 'connected' ? (
                <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => handleDisconnect(selectedServer.id)}>
                  Disconnect
                </button>
              ) : null}
            </div>

            {/* Tab bar */}
            <div className="tab-bar">
              {(['tools', 'resources', 'prompts'] as const).map(tab => (
                <div
                  key={tab}
                  className={`tab${state.activeTab === tab ? ' active' : ''}`}
                  onClick={() => dispatch({ type: 'SELECT_TAB', tab })}
                >
                  {tab.charAt(0).toUpperCase() + tab.slice(1)}
                  {tab === 'tools'     && state.tools[selectedServer.id]     ? ` (${state.tools[selectedServer.id].length})` : ''}
                  {tab === 'resources' && state.resources[selectedServer.id] ? ` (${state.resources[selectedServer.id].length})` : ''}
                  {tab === 'prompts'   && state.prompts[selectedServer.id]   ? ` (${state.prompts[selectedServer.id].length})` : ''}
                </div>
              ))}
              {(() => {
                const count = state.history.filter(e => e.serverId === selectedServer.id).length;
                return (
                  <div
                    className={`tab${state.activeTab === 'history' ? ' active' : ''}`}
                    onClick={() => dispatch({ type: 'SELECT_TAB', tab: 'history' })}
                  >
                    History{count > 0 ? ` (${count})` : ''}
                  </div>
                );
              })()}
            </div>

            {/* Tab content */}
            {state.activeTab === 'tools' && (
              <ToolsPanel
                serverId={selectedServer.id}
                tools={state.tools[selectedServer.id] ?? []}
                history={state.history.filter(e => e.serverId === selectedServer.id && e.type === 'tool')}
                requests={state.requests}
                isConnected={isConnected}
                pendingRerun={pendingRerun}
                onPendingRerunConsumed={() => setPendingRerun(null)}
                onStartRequest={handleStartRequest}
              />
            )}
            {state.activeTab === 'resources' && (
              <ResourcesPanel
                serverId={selectedServer.id}
                resources={state.resources[selectedServer.id] ?? []}
                requests={state.requests}
                isConnected={isConnected}
                onStartRequest={handleStartRequest}
              />
            )}
            {state.activeTab === 'prompts' && (
              <PromptsPanel
                serverId={selectedServer.id}
                prompts={state.prompts[selectedServer.id] ?? []}
                requests={state.requests}
                isConnected={isConnected}
                onStartRequest={handleStartRequest}
              />
            )}
            {state.activeTab === 'history' && (
              <HistoryPanel
                history={state.history.filter(e => e.serverId === selectedServer.id)}
                onClear={() => dispatch({ type: 'HISTORY_CLEAR', serverId: selectedServer.id })}
                onRerun={(toolName, args) => handleRerun(toolName, args)}
              />
            )}
          </>
        ) : (
          <div className="empty-state">
            <h2>MCP Tool Explorer</h2>
            {state.serversLoading ? (
              <p><span className="spinner" />Discovering MCP servers…</p>
            ) : state.servers.length === 0 ? (
              <>
                <p>No MCP servers found in this workspace.</p>
                <p style={{ marginTop: 8 }}>
                  Add one manually or create a <code>.vscode/mcp.json</code> file.
                </p>
                <button className="btn btn-primary" style={{ marginTop: 12 }} onClick={() => dispatch({ type: 'SHOW_ADD_SERVER', show: true })}>
                  + Add Server
                </button>
              </>
            ) : (
              <p>Select a server from the sidebar to inspect its Tools, Resources, and Prompts.</p>
            )}
          </div>
        )}
      </div>

      {state.showAddServer && (
        <AddServerModal
          onAdd={handleAddServer}
          onClose={() => dispatch({ type: 'SHOW_ADD_SERVER', show: false })}
        />
      )}
    </div>
  );
}
