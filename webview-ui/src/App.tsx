import React, { useReducer, useEffect } from 'react';
import { postMessage } from './vscode';
import type {
  McpServerConfig, McpTool, McpResource, McpPrompt,
  MessageToWebview, ConnectionStatus, RequestEntry, RequestInfo, HistoryEntry, CapabilityKind, CapabilityLoadState,
} from './types';
import Sidebar from './components/Sidebar';
import ToolsPanel from './components/ToolsPanel';
import ResourcesPanel from './components/ResourcesPanel';
import PromptsPanel from './components/PromptsPanel';
import HistoryPanel from './components/HistoryPanel';
import ConnectionLogPanel from './components/ConnectionLogPanel';
import AddServerModal from './components/AddServerModal';
import CopyButton from './components/CopyButton';

// ── State & Reducer ──────────────────────────────────────────────────────────

export interface LogSection {
  kind: 'request' | 'response' | 'request-headers' | 'response-headers' | 'error' | 'text';
  content: string;
}

export interface ConnectionLogEntry {
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  detail?: string | LogSection[];
}

type CapabilityLoadStateByKind = Record<CapabilityKind, Record<string, CapabilityLoadState>>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeRequestPayload(payload: unknown): { data: unknown; isError: boolean } {
  if (isRecord(payload)) {
    if (typeof payload.isError === 'boolean') {
      return { data: payload, isError: payload.isError };
    }
    if (isRecord(payload.result) && typeof payload.result.isError === 'boolean') {
      return { data: payload.result, isError: payload.result.isError };
    }
  }

  return { data: payload, isError: false };
}

interface AppState {
  servers: McpServerConfig[];
  serversLoading: boolean;
  serverStatus: Record<string, ConnectionStatus>;
  serverErrors: Record<string, string>;
  capabilityLoadState: CapabilityLoadStateByKind;
  selectedServerId: string | null;
  activeTab: 'tools' | 'resources' | 'prompts' | 'history' | 'log';
  tools: Record<string, McpTool[]>;
  resources: Record<string, McpResource[]>;
  prompts: Record<string, McpPrompt[]>;
  requests: Record<string, RequestEntry>;
  history: HistoryEntry[];
  connectionLogs: Record<string, ConnectionLogEntry[]>;
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
  | { type: 'CAPABILITY_LOAD_FAILED'; serverId: string; capability: CapabilityKind }
  | { type: 'TOOLS_LISTED'; serverId: string; tools: McpTool[] }
  | { type: 'RESOURCES_LISTED'; serverId: string; resources: McpResource[] }
  | { type: 'PROMPTS_LISTED'; serverId: string; prompts: McpPrompt[] }
  | { type: 'REQUEST_DONE'; requestId: string; data: unknown; isError: boolean }
  | { type: 'REQUEST_STARTED'; requestId: string }
  | { type: 'SELECT_SERVER'; serverId: string }
  | { type: 'SELECT_TAB'; tab: 'tools' | 'resources' | 'prompts' | 'history' | 'log' }
  | { type: 'SHOW_ADD_SERVER'; show: boolean }
  | { type: 'EXT_ERROR'; message: string; requestId?: string }
  | { type: 'CONNECTION_LOG'; serverId: string; log: ConnectionLogEntry }
  | { type: 'CONNECTION_LOG_CLEAR'; serverId: string }
  | { type: 'HISTORY_ADD'; entry: HistoryEntry }
  | { type: 'HISTORY_UPDATE'; id: string; status: 'done' | 'error'; result?: unknown; isError?: boolean }
  | { type: 'HISTORY_CLEAR'; serverId: string };

const initialState: AppState = {
  servers: [],
  serversLoading: true,
  serverStatus: {},
  serverErrors: {},
  capabilityLoadState: {
    tools: {},
    resources: {},
    prompts: {},
  },
  selectedServerId: null,
  activeTab: 'tools',
  tools: {},
  resources: {},
  prompts: {},
  requests: {},
  history: [],
  connectionLogs: {},
  showAddServer: false,
};

function setCapabilityState(
  capabilityLoadState: CapabilityLoadStateByKind,
  capability: CapabilityKind,
  serverId: string,
  loadState: CapabilityLoadState,
): CapabilityLoadStateByKind {
  return {
    ...capabilityLoadState,
    [capability]: {
      ...capabilityLoadState[capability],
      [serverId]: loadState,
    },
  };
}

function setAllCapabilityStates(
  capabilityLoadState: CapabilityLoadStateByKind,
  serverId: string,
  loadState: CapabilityLoadState,
): CapabilityLoadStateByKind {
  return {
    tools: { ...capabilityLoadState.tools, [serverId]: loadState },
    resources: { ...capabilityLoadState.resources, [serverId]: loadState },
    prompts: { ...capabilityLoadState.prompts, [serverId]: loadState },
  };
}

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
        capabilityLoadState: {
          tools: Object.fromEntries(action.servers.map(s => [s.id, state.capabilityLoadState.tools[s.id] ?? 'idle'])),
          resources: Object.fromEntries(action.servers.map(s => [s.id, state.capabilityLoadState.resources[s.id] ?? 'idle'])),
          prompts: Object.fromEntries(action.servers.map(s => [s.id, state.capabilityLoadState.prompts[s.id] ?? 'idle'])),
        },
      };

    case 'SERVER_ADDED':
      return {
        ...state,
        servers: [...state.servers, action.server],
        serverStatus: { ...state.serverStatus, [action.server.id]: 'disconnected' },
        capabilityLoadState: setAllCapabilityStates(state.capabilityLoadState, action.server.id, 'idle'),
      };

    case 'SERVER_REMOVED': {
      const servers = state.servers.filter(s => s.id !== action.serverId);
      const { [action.serverId]: _ss, ...serverStatus } = state.serverStatus;
      const { [action.serverId]: _se, ...serverErrors } = state.serverErrors;
      const { [action.serverId]: _toolState, ...toolLoadState } = state.capabilityLoadState.tools;
      const { [action.serverId]: _resourceState, ...resourceLoadState } = state.capabilityLoadState.resources;
      const { [action.serverId]: _promptState, ...promptLoadState } = state.capabilityLoadState.prompts;
      const { [action.serverId]: _t, ...tools } = state.tools;
      const { [action.serverId]: _r, ...resources } = state.resources;
      const { [action.serverId]: _p, ...prompts } = state.prompts;
      return {
        ...state,
        servers,
        serverStatus,
        serverErrors,
        capabilityLoadState: {
          tools: toolLoadState,
          resources: resourceLoadState,
          prompts: promptLoadState,
        },
        tools,
        resources,
        prompts,
        selectedServerId: state.selectedServerId === action.serverId ? null : state.selectedServerId,
      };
    }

    case 'CONNECTING':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'connecting' },
        serverErrors: { ...state.serverErrors, [action.serverId]: '' },
        capabilityLoadState: setAllCapabilityStates(state.capabilityLoadState, action.serverId, 'loading'),
        tools: { ...state.tools, [action.serverId]: [] },
        resources: { ...state.resources, [action.serverId]: [] },
        prompts: { ...state.prompts, [action.serverId]: [] },
      };

    case 'CONNECTED':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'connected' },
        serverErrors: { ...state.serverErrors, [action.serverId]: '' },
      };

    case 'DISCONNECTED':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'disconnected' },
        capabilityLoadState: setAllCapabilityStates(state.capabilityLoadState, action.serverId, 'idle'),
        tools: { ...state.tools, [action.serverId]: [] },
        resources: { ...state.resources, [action.serverId]: [] },
        prompts: { ...state.prompts, [action.serverId]: [] },
      };

    case 'CONNECTION_ERROR':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'error' },
        serverErrors: { ...state.serverErrors, [action.serverId]: action.error },
        capabilityLoadState: setAllCapabilityStates(state.capabilityLoadState, action.serverId, 'error'),
      };

    case 'CAPABILITY_LOAD_FAILED':
      return {
        ...state,
        capabilityLoadState: setCapabilityState(state.capabilityLoadState, action.capability, action.serverId, 'error'),
      };

    case 'TOOLS_LISTED':
      return {
        ...state,
        tools: { ...state.tools, [action.serverId]: action.tools },
        capabilityLoadState: setCapabilityState(state.capabilityLoadState, 'tools', action.serverId, 'loaded'),
      };

    case 'RESOURCES_LISTED':
      return {
        ...state,
        resources: { ...state.resources, [action.serverId]: action.resources },
        capabilityLoadState: setCapabilityState(state.capabilityLoadState, 'resources', action.serverId, 'loaded'),
      };

    case 'PROMPTS_LISTED':
      return {
        ...state,
        prompts: { ...state.prompts, [action.serverId]: action.prompts },
        capabilityLoadState: setCapabilityState(state.capabilityLoadState, 'prompts', action.serverId, 'loaded'),
      };

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
            [action.requestId]: { status: 'error', data: action.message, errorMsg: action.message, isError: true },
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

    case 'CONNECTION_LOG': {
      const existing = state.connectionLogs[action.serverId] ?? [];
      return {
        ...state,
        connectionLogs: {
          ...state.connectionLogs,
          [action.serverId]: [...existing, action.log].slice(-500),
        },
      };
    }

    case 'CONNECTION_LOG_CLEAR':
      return {
        ...state,
        connectionLogs: { ...state.connectionLogs, [action.serverId]: [] },
      };

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
        case 'connectionError': dispatch({ type: 'CONNECTION_ERROR',  serverId: msg.serverId, error: msg.error }); dispatch({ type: 'SELECT_TAB', tab: 'log' }); break;
        case 'capabilityLoadFailed': dispatch({ type: 'CAPABILITY_LOAD_FAILED', serverId: msg.serverId, capability: msg.capability }); break;
        case 'toolsListed':     dispatch({ type: 'TOOLS_LISTED',      serverId: msg.serverId, tools: msg.tools }); break;
        case 'resourcesListed': dispatch({ type: 'RESOURCES_LISTED',  serverId: msg.serverId, resources: msg.resources }); break;
        case 'promptsListed':   dispatch({ type: 'PROMPTS_LISTED',    serverId: msg.serverId, prompts: msg.prompts }); break;
        case 'connectionLog':   dispatch({ type: 'CONNECTION_LOG',    serverId: msg.serverId, log: msg.log }); break;
        case 'toolResult':
        case 'resourceContent':
        case 'promptContent': {
          const payload = msg.type === 'toolResult' ? msg.result : msg.content;
          const normalized = msg.type === 'toolResult'
            ? { data: msg.result, isError: msg.isError }
            : normalizeRequestPayload(payload);
          const { data, isError } = normalized;
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
    // Start each connection attempt with a fresh log so transport diagnostics are
    // scoped to the current session instead of accumulating across reconnects.
    dispatch({ type: 'CONNECTION_LOG_CLEAR', serverId });
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
      // Insert a pending history row immediately so users can see in-flight work
      // before the extension posts the final response back to the webview.
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
    // History can rehydrate a previous tool invocation by redirecting back into
    // ToolsPanel with the original args preloaded into JSON mode.
    dispatch({ type: 'SELECT_TAB', tab: 'tools' });
    setPendingRerun({ serverId: state.selectedServerId, toolName, args });
  };

  const [pendingRerun, setPendingRerun] = React.useState<{ serverId: string | null; toolName: string; args: unknown } | null>(null);

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
              <div className="server-header-main">
                <span className="server-header-name">{selectedServer.name}</span>
                <span className={`status-badge status-badge-${selectedStatus}`}>
                  {selectedStatus === 'connecting' && <span className="spinner" />}
                  {selectedStatus}
                </span>
                {selectedStatus === 'disconnected' || selectedStatus === 'error' ? (
                  <button className="btn btn-primary server-header-action" onClick={() => handleConnect(selectedServer.id)}>
                    Connect
                  </button>
                ) : selectedStatus === 'connected' ? (
                  <button className="btn btn-secondary server-header-action" onClick={() => handleDisconnect(selectedServer.id)}>
                    Disconnect
                  </button>
                ) : null}
              </div>
              {state.serverErrors[selectedServer.id] && (
                <div className="server-error-banner json-viewer-wrap">
                  <div className="server-error-banner-header">
                    <span className="server-error-banner-title">Connection Error</span>
                  </div>
                  <CopyButton text={state.serverErrors[selectedServer.id]} />
                  <pre className="server-error-banner-body">{state.serverErrors[selectedServer.id]}</pre>
                </div>
              )}
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
              {(() => {
                const logCount = (state.connectionLogs[selectedServer.id] ?? []).length;
                return (
                  <div
                    className={`tab${state.activeTab === 'log' ? ' active' : ''}`}
                    onClick={() => dispatch({ type: 'SELECT_TAB', tab: 'log' })}
                  >
                    Log{logCount > 0 ? ` (${logCount})` : ''}
                  </div>
                );
              })()}
            </div>

            {/* Tab content */}
            {state.activeTab === 'tools' && (
              <ToolsPanel
                key={`tools-${selectedServer.id}`}
                serverId={selectedServer.id}
                tools={state.tools[selectedServer.id] ?? []}
                loadState={state.capabilityLoadState.tools[selectedServer.id] ?? 'idle'}
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
                key={`resources-${selectedServer.id}`}
                serverId={selectedServer.id}
                resources={state.resources[selectedServer.id] ?? []}
                loadState={state.capabilityLoadState.resources[selectedServer.id] ?? 'idle'}
                requests={state.requests}
                isConnected={isConnected}
                onStartRequest={handleStartRequest}
              />
            )}
            {state.activeTab === 'prompts' && (
              <PromptsPanel
                key={`prompts-${selectedServer.id}`}
                serverId={selectedServer.id}
                prompts={state.prompts[selectedServer.id] ?? []}
                loadState={state.capabilityLoadState.prompts[selectedServer.id] ?? 'idle'}
                requests={state.requests}
                isConnected={isConnected}
                onStartRequest={handleStartRequest}
              />
            )}
            {state.activeTab === 'history' && (
              <HistoryPanel
                key={`history-${selectedServer.id}`}
                history={state.history.filter(e => e.serverId === selectedServer.id)}
                onClear={() => dispatch({ type: 'HISTORY_CLEAR', serverId: selectedServer.id })}
                onRerun={(toolName, args) => handleRerun(toolName, args)}
              />
            )}
            {state.activeTab === 'log' && (
              <ConnectionLogPanel
                logs={state.connectionLogs[selectedServer.id] ?? []}
                onClear={() => dispatch({ type: 'CONNECTION_LOG_CLEAR', serverId: selectedServer.id })}
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
                <p className="empty-state-secondary">
                  Add one manually or create a <code>.vscode/mcp.json</code> file.
                </p>
                <button className="btn btn-primary empty-state-action" onClick={() => dispatch({ type: 'SHOW_ADD_SERVER', show: true })}>
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
