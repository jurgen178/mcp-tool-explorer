import React, { useReducer, useEffect, useRef } from 'react';
import { postMessage } from './vscode';
import type {
  McpEventEntry, McpServerConfig, McpServerDetails, McpTool, McpResource, McpPrompt,
  MessageToWebview, ConnectionStatus, RequestEntry, RequestInfo, HistoryEntry, CapabilityKind, CapabilityLoadState,
  TestCase, TestRunResult, AuthAccountSelection, AuthAccountSelectionOverrides,
} from './types';
import Sidebar from './components/Sidebar';
import ToolsPanel from './components/ToolsPanel';
import ResourcesPanel from './components/ResourcesPanel';
import PromptsPanel from './components/PromptsPanel';
import HistoryPanel from './components/HistoryPanel';
import ConnectionLogPanel from './components/ConnectionLogPanel';
import EventsPanel from './components/EventsPanel';
import TestsPanel from './components/TestsPanel';
import AddServerModal from './components/AddServerModal';
import AuthOverrideModal from './components/AuthOverrideModal.tsx';
import CopyButton from './components/CopyButton';
import { useKonamiCode, MatrixRainOverlay } from './components/MatrixProtocol';

// State & Reducer

export interface LogSection {
  sectionType: 'request' | 'response' | 'raw-response' | 'request-headers' | 'response-headers' | 'error' | 'text';
  content: string;
}

export interface ConnectionLogEntry {
  id: string;
  timestamp: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  requestId?: string;
  requestPhase?: 'started' | 'finished' | 'failed';
  diagnosticType?: 'raw-response';
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
  serverDetails: Record<string, McpServerDetails | undefined>;
  serverEvents: Record<string, McpEventEntry[]>;
  capabilityLoadState: CapabilityLoadStateByKind;
  selectedServerId: string | null;
  activeTab: 'tools' | 'resources' | 'prompts' | 'history' | 'events' | 'log' | 'tests';
  tools: Record<string, McpTool[]>;
  resources: Record<string, McpResource[]>;
  prompts: Record<string, McpPrompt[]>;
  requests: Record<string, RequestEntry>;
  history: HistoryEntry[];
  connectionLogs: Record<string, ConnectionLogEntry[]>;
  focusedLogEntryId?: string;
  authOverrides: AuthAccountSelectionOverrides;
  showAddServer: boolean;
  editingServer: McpServerConfig | null;
  authServer: McpServerConfig | null;
  tests: TestCase[];
  testVariables: Record<string, string>;
  testResults: Record<string, TestRunResult>;
  runningTestIds: string[];
}

type Action =
  | { type: 'SERVERS_LOADED'; servers: McpServerConfig[] }
  | { type: 'SERVER_ADDED'; server: McpServerConfig }
  | { type: 'SERVER_UPDATED'; server: McpServerConfig }
  | { type: 'SERVER_REMOVED'; serverId: string }
  | { type: 'AUTH_OVERRIDES_LOADED'; overrides: AuthAccountSelectionOverrides }
  | { type: 'SHOW_AUTH_SERVER'; server: McpServerConfig | null }
  | { type: 'AUTH_OVERRIDE_SET'; server: McpServerConfig; value: AuthAccountSelection }
  | { type: 'CONNECTING'; serverId: string }
  | { type: 'CONNECTED'; serverId: string }
  | { type: 'SERVER_DETAILS_LOADED'; serverId: string; details: McpServerDetails }
  | { type: 'SERVER_EVENT'; serverId: string; event: McpEventEntry }
  | { type: 'SERVER_EVENTS_CLEAR'; serverId: string }
  | { type: 'DISCONNECTED'; serverId: string }
  | { type: 'CONNECTION_ERROR'; serverId: string; error: string }
  | { type: 'CAPABILITY_LOAD_FAILED'; serverId: string; capability: CapabilityKind }
  | { type: 'TOOLS_LISTED'; serverId: string; tools: McpTool[] }
  | { type: 'RESOURCES_LISTED'; serverId: string; resources: McpResource[] }
  | { type: 'PROMPTS_LISTED'; serverId: string; prompts: McpPrompt[] }
  | { type: 'REQUEST_DONE'; requestId: string; data: unknown; isError: boolean; structuredContent?: unknown }
  | { type: 'REQUEST_STARTED'; requestId: string }
  | { type: 'SELECT_SERVER'; serverId: string }
  | { type: 'SELECT_TAB'; tab: 'tools' | 'resources' | 'prompts' | 'history' | 'events' | 'log' | 'tests' }
  | { type: 'SHOW_ADD_SERVER'; show: boolean }
  | { type: 'SHOW_EDIT_SERVER'; server: McpServerConfig | null }
  | { type: 'EXT_ERROR'; message: string; requestId?: string }
  | { type: 'CONNECTION_LOG'; serverId: string; log: ConnectionLogEntry }
  | { type: 'CONNECTION_LOG_CLEAR'; serverId: string }
  | { type: 'FOCUS_LOG_ENTRY'; logEntryId: string }
  | { type: 'HISTORY_ADD'; entry: HistoryEntry }
  | { type: 'HISTORY_UPDATE'; id: string; status: 'done' | 'error'; result?: unknown; isError?: boolean }
  | { type: 'HISTORY_CLEAR'; serverId: string }
  | { type: 'TESTS_LOADED'; tests: TestCase[]; variables: Record<string, string> }
  | { type: 'TEST_RESULT'; result: TestRunResult; requestId: string }
  | { type: 'TEST_RUN_START'; testId: string; requestId: string };

const initialState: AppState = {
  servers: [],
  serversLoading: true,
  serverStatus: {},
  serverErrors: {},
  serverDetails: {},
  serverEvents: {},
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
  focusedLogEntryId: undefined,
  authOverrides: {},
  showAddServer: false,
  editingServer: null,
  authServer: null,
  tests: [],
  testVariables: {},
  testResults: {},
  runningTestIds: [],
};

const SIDEBAR_KEY = 'sidebar-width';
const SIDEBAR_DEFAULT = 220;
const SIDEBAR_MIN = 150;
const SIDEBAR_MAX = 500;

function getInitialSidebarWidth() {
  const stored = localStorage.getItem(SIDEBAR_KEY);
  const parsed = stored ? parseInt(stored, 10) : NaN;
  return Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, !isNaN(parsed) ? parsed : SIDEBAR_DEFAULT));
}

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
        servers: state.servers.some(s => s.id === action.server.id)
          ? state.servers.map(s => s.id === action.server.id ? action.server : s)
          : [...state.servers, action.server],
        serverStatus: { ...state.serverStatus, [action.server.id]: state.serverStatus[action.server.id] ?? 'disconnected' },
        capabilityLoadState: state.capabilityLoadState.tools[action.server.id]
          ? state.capabilityLoadState
          : setAllCapabilityStates(state.capabilityLoadState, action.server.id, 'idle'),
      };

    case 'SERVER_UPDATED':
      return {
        ...state,
        servers: state.servers.map(s => s.id === action.server.id ? action.server : s),
      };

    case 'SERVER_REMOVED': {
      const servers = state.servers.filter(s => s.id !== action.serverId);
      const { [action.serverId]: _ss, ...serverStatus } = state.serverStatus;
      const { [action.serverId]: _se, ...serverErrors } = state.serverErrors;
      const { [action.serverId]: _toolState, ...toolLoadState } = state.capabilityLoadState.tools;
      const { [action.serverId]: _resourceState, ...resourceLoadState } = state.capabilityLoadState.resources;
      const { [action.serverId]: _promptState, ...promptLoadState } = state.capabilityLoadState.prompts;
      const { [action.serverId]: _details, ...serverDetails } = state.serverDetails;
      const { [action.serverId]: _events, ...serverEvents } = state.serverEvents;
      const { [action.serverId]: _t, ...tools } = state.tools;
      const { [action.serverId]: _r, ...resources } = state.resources;
      const { [action.serverId]: _p, ...prompts } = state.prompts;
      const { [action.serverId]: _cl, ...connectionLogs } = state.connectionLogs;
      // Drop all pending/completed request entries that belong to this server,
      // identified via the history (which tracks serverId per request).
      const removedRequestIds = new Set(
        state.history.filter(e => e.serverId === action.serverId).map(e => e.id),
      );
      const requests = Object.fromEntries(
        Object.entries(state.requests).filter(([id]) => !removedRequestIds.has(id)),
      );
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
        serverDetails,
        serverEvents,
        tools,
        resources,
        prompts,
        connectionLogs,
        requests,
        selectedServerId: state.selectedServerId === action.serverId ? null : state.selectedServerId,
      };
    }

    case 'AUTH_OVERRIDES_LOADED':
      return { ...state, authOverrides: action.overrides };

    case 'SHOW_AUTH_SERVER':
      return { ...state, authServer: action.server };

    case 'AUTH_OVERRIDE_SET': {
      const authOverrides = { ...state.authOverrides };
      delete authOverrides[action.server.id];
      delete authOverrides[action.server.name];
      if (action.value !== 'auto') {
        authOverrides[action.server.name] = action.value;
      }
      return { ...state, authOverrides, authServer: null };
    }

    case 'CONNECTING':
      return {
        ...state,
        serverStatus: { ...state.serverStatus, [action.serverId]: 'connecting' },
        serverErrors: { ...state.serverErrors, [action.serverId]: '' },
        serverDetails: { ...state.serverDetails, [action.serverId]: undefined },
        serverEvents: { ...state.serverEvents, [action.serverId]: [] },
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

    case 'SERVER_DETAILS_LOADED':
      return {
        ...state,
        serverDetails: { ...state.serverDetails, [action.serverId]: action.details },
      };

    case 'SERVER_EVENT': {
      const existing = state.serverEvents[action.serverId] ?? [];
      return {
        ...state,
        serverEvents: {
          ...state.serverEvents,
          [action.serverId]: [action.event, ...existing].slice(0, 300),
        },
      };
    }

    case 'SERVER_EVENTS_CLEAR':
      return {
        ...state,
        serverEvents: { ...state.serverEvents, [action.serverId]: [] },
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
          [action.requestId]: { status: action.isError ? 'error' : 'done', data: action.data, isError: action.isError, structuredContent: action.structuredContent },
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

    case 'TESTS_LOADED':
      return { ...state, tests: action.tests, testVariables: action.variables };

    case 'TEST_RUN_START':
      return { ...state, runningTestIds: [...state.runningTestIds.filter(id => id !== action.testId), action.testId] };

    case 'TEST_RESULT':
      return {
        ...state,
        testResults: { ...state.testResults, [action.result.testId]: action.result },
        runningTestIds: state.runningTestIds.filter(id => id !== action.result.testId),
      };

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

    case 'FOCUS_LOG_ENTRY':
      return { ...state, activeTab: 'log', focusedLogEntryId: action.logEntryId };

    case 'SHOW_ADD_SERVER':
      return { ...state, showAddServer: action.show };

    case 'SHOW_EDIT_SERVER':
      return { ...state, editingServer: action.server };

    default:
      return state;
  }
}

// Component

export default function App() {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Message listener

  useEffect(() => {
    const handler = (event: MessageEvent<MessageToWebview>) => {
      const msg = event.data;
      switch (msg.type) {
        case 'serversLoaded':   dispatch({ type: 'SERVERS_LOADED',    servers: msg.servers }); break;
        case 'serverAdded':     dispatch({ type: 'SERVER_ADDED',      server: msg.server }); break;
        case 'serverUpdated':   dispatch({ type: 'SERVER_UPDATED',    server: msg.server }); break;
        case 'serverRemoved':   dispatch({ type: 'SERVER_REMOVED',    serverId: msg.serverId }); break;
        case 'authOverridesLoaded': dispatch({ type: 'AUTH_OVERRIDES_LOADED', overrides: msg.overrides }); break;
        case 'connected':       dispatch({ type: 'CONNECTED',         serverId: msg.serverId }); break;
        case 'serverDetailsLoaded': dispatch({ type: 'SERVER_DETAILS_LOADED', serverId: msg.serverId, details: msg.details }); break;
        case 'serverEvent':     dispatch({ type: 'SERVER_EVENT',      serverId: msg.serverId, event: msg.event }); break;
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
          const structuredContent = msg.type === 'toolResult' ? msg.structuredContent : undefined;
          dispatch({ type: 'REQUEST_DONE', requestId: msg.requestId, data, isError, structuredContent });
          dispatch({ type: 'HISTORY_UPDATE', id: msg.requestId, status: isError ? 'error' : 'done', result: data, isError });
          break;
        }
        case 'error':
          dispatch({ type: 'EXT_ERROR', message: msg.message, requestId: msg.requestId });
          if (msg.requestId) {
            dispatch({ type: 'HISTORY_UPDATE', id: msg.requestId, status: 'error', result: msg.message, isError: true });
          }
          break;
        case 'testsLoaded':
          dispatch({ type: 'TESTS_LOADED', tests: msg.tests, variables: msg.variables });
          break;
        case 'testRunResult':
          dispatch({ type: 'TEST_RESULT', result: msg.result, requestId: msg.requestId });
          break;
      }
    };
    window.addEventListener('message', handler);
    // Ask the extension for configured servers on mount
    postMessage({ type: 'getServers' });
    return () => window.removeEventListener('message', handler);
  }, []);

  // Actions

  const handleConnect = (serverId: string) => {
    // Start each connection attempt with a fresh log so transport diagnostics are
    // scoped to the current session instead of accumulating across reconnects.
    dispatch({ type: 'CONNECTION_LOG_CLEAR', serverId });
    dispatch({ type: 'SERVER_EVENTS_CLEAR', serverId });
    dispatch({ type: 'CONNECTING', serverId });
    postMessage({ type: 'connect', serverId });
  };

  const handleDisconnect = (serverId: string) => {
    postMessage({ type: 'disconnect', serverId });
  };

  const handleCancelConnect = (serverId: string) => {
    postMessage({ type: 'cancelConnect', serverId });
  };

  const handleSelectServer = (serverId: string) => {
    dispatch({ type: 'SELECT_SERVER', serverId });
  };

  const handleRemoveServer = (serverId: string) => {
    postMessage({ type: 'removeServer', serverId });
  };

  const handleAddServer = (config: Omit<McpServerConfig, 'id' | 'source'>) => {
    postMessage({ type: 'addServer', config });
    dispatch({ type: 'SHOW_ADD_SERVER', show: false });
  };

  const handleEditServer = (server: McpServerConfig) => {
    dispatch({ type: 'SHOW_EDIT_SERVER', server });
  };

  const handleSaveAuthOverride = (server: McpServerConfig, value: AuthAccountSelection) => {
    dispatch({ type: 'AUTH_OVERRIDE_SET', server, value });
    postMessage({ type: 'setAuthOverride', serverId: server.id, serverName: server.name, accountSelection: value });
  };

  const handleUpdateServer = (config: Omit<McpServerConfig, 'id' | 'source'>) => {
    postMessage({ type: 'updateServer', serverId: state.editingServer!.id, config });
    dispatch({ type: 'SHOW_EDIT_SERVER', server: null });
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

  const handleOpenLogForRequest = (requestId: string) => {
    const serverId = state.selectedServerId;
    if (!serverId) return;

    const logs = state.connectionLogs[serverId] ?? [];
    const matchingLogs = logs.filter(log => log.requestId === requestId);
    const recentMatchingLogs = [...matchingLogs].reverse();
    const target = recentMatchingLogs.find(log => log.diagnosticType === 'raw-response')
      ?? recentMatchingLogs.find(log => log.requestPhase === 'failed')
      ?? recentMatchingLogs.find(log => log.requestPhase === 'finished')
      ?? recentMatchingLogs.find(log => log.requestPhase === 'started')
      ?? matchingLogs[matchingLogs.length - 1];

    if (target) {
      dispatch({ type: 'FOCUS_LOG_ENTRY', logEntryId: target.id });
    } else {
      dispatch({ type: 'SELECT_TAB', tab: 'log' });
    }
  };

  const [pendingRerun, setPendingRerun] = React.useState<{ serverId: string | null; toolName: string; args: unknown } | null>(null);

  const testReqCounterRef = React.useRef(0);
  const nextTestReqId = () => `testrun-${Date.now()}-${++testReqCounterRef.current}`;

  const handleSaveTests = (tests: typeof state.tests, variables = state.testVariables) => {
    dispatch({ type: 'TESTS_LOADED', tests, variables });
    postMessage({ type: 'saveTests', tests, variables });
  };

  const handleSaveAsTest = (toolName: string, args: unknown) => {
    const newTest: TestCase = {
      id: `test-${Date.now()}`,
      name: toolName,
      serverId: state.selectedServerId ?? '',
      toolName,
      args: (args ?? {}) as Record<string, unknown>,
      assertion: { type: 'no-error' },
    };
    handleSaveTests([...state.tests, newTest]);
  };

  const handleSaveVariables = (variables: Record<string, string>) => {
    handleSaveTests(state.tests, variables);
  };

  const handleRunTest = (test: (typeof state.tests)[0]) => {
    const requestId = nextTestReqId();
    dispatch({ type: 'TEST_RUN_START', testId: test.id, requestId });
    postMessage({ type: 'runTest', test, requestId, variables: state.testVariables });
  };

  const handleRunAllTests = () => {
    const testsToRun = state.tests.filter(t => !state.runningTestIds.includes(t.id));
    for (const test of testsToRun) {
      const requestId = nextTestReqId();
      dispatch({ type: 'TEST_RUN_START', testId: test.id, requestId });
      postMessage({ type: 'runTest', test, requestId, variables: state.testVariables });
    }
  };

  const handleRunGroup = (group: string) => {
    const testsToRun = state.tests.filter(t =>
      (group === '' ? !t.group : t.group === group) && !state.runningTestIds.includes(t.id)
    );
    for (const test of testsToRun) {
      const requestId = nextTestReqId();
      dispatch({ type: 'TEST_RUN_START', testId: test.id, requestId });
      postMessage({ type: 'runTest', test, requestId, variables: state.testVariables });
    }
  };



  const [matrixActive, setMatrixActive] = React.useState(false);
  useKonamiCode(React.useCallback(() => setMatrixActive(true), []));

  const sidebarWrapperRef = useRef<HTMLDivElement>(null);
  const sidebarHandleRef = useRef<HTMLDivElement>(null);
  const appRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const MIN_MAIN = 300;
    const handle = sidebarHandleRef.current;
    const wrapper = sidebarWrapperRef.current;
    const app = appRef.current;
    if (!handle || !wrapper) return;

    const getMaxSidebarWidth = () => app
      ? Math.max(0, Math.min(SIDEBAR_MAX, app.clientWidth - MIN_MAIN))
      : SIDEBAR_MAX;

    const clampSidebarWidth = (width: number, maxWidth = getMaxSidebarWidth()) => {
      const safeMax = Math.max(0, maxWidth);
      const safeMin = Math.min(SIDEBAR_MIN, safeMax);
      return Math.max(safeMin, Math.min(safeMax, width));
    };

    const applySidebarWidth = (width: number) => {
      wrapper.style.setProperty('--sidebar-width', `${width}px`);
    };

    const persistSidebarWidth = (width: number) => {
      localStorage.setItem(SIDEBAR_KEY, String(width));
    };

    const updateSidebarWidth = (width: number) => {
      applySidebarWidth(width);
      persistSidebarWidth(width);
    };

    // Restore persisted width without using container geometry, because VS Code
    // may temporarily hide the webview and report unusable layout sizes.
    applySidebarWidth(getInitialSidebarWidth());

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = wrapper.getBoundingClientRect().width;
      handle.setPointerCapture(e.pointerId);
      app?.classList.add('sidebar-resizing');

      let dragActive = true;
      let latestWidth = clampSidebarWidth(startWidth);

      const clamp = (x: number) => clampSidebarWidth(startWidth + x - startX);

      const updateWidth = (width: number) => {
        latestWidth = width;
        updateSidebarWidth(width);
      };

      const persistCurrentWidth = () => {
        updateWidth(latestWidth);
      };

      const onPointerMove = (ev: PointerEvent) => {
        updateWidth(clamp(ev.clientX));
      };

      const cleanupDrag = (pointerId?: number) => {
        if (!dragActive) return;
        dragActive = false;
        app?.classList.remove('sidebar-resizing');
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerCancel);
        handle.removeEventListener('lostpointercapture', onLostPointerCapture);
        if (pointerId !== undefined && handle.hasPointerCapture(pointerId)) {
          handle.releasePointerCapture(pointerId);
        }
      };

      const onPointerUp = (ev: PointerEvent) => {
        updateWidth(clamp(ev.clientX));
        persistCurrentWidth();
        cleanupDrag(ev.pointerId);
      };

      const onPointerCancel = () => {
        persistCurrentWidth();
        cleanupDrag();
      };

      const onLostPointerCapture = () => {
        persistCurrentWidth();
        cleanupDrag();
      };

      document.addEventListener('pointermove', onPointerMove);
      document.addEventListener('pointerup', onPointerUp);
      handle.addEventListener('pointercancel', onPointerCancel);
      handle.addEventListener('lostpointercapture', onLostPointerCapture);
    };

    handle.addEventListener('pointerdown', onPointerDown);

    // Clamp sidebar width when the window shrinks (e.g. un-maximized)
    const observer = new ResizeObserver(() => {
      if (!app || app.clientWidth === 0 || document.visibilityState !== 'visible') return;
      applySidebarWidth(clampSidebarWidth(getInitialSidebarWidth()));
    });
    if (app) observer.observe(app);

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        applySidebarWidth(getInitialSidebarWidth());
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      handle.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      observer.disconnect();
    };
  }, []);

  // Selected server data

  const selectedServer = state.servers.find(s => s.id === state.selectedServerId) ?? null;
  const selectedStatus = state.selectedServerId ? (state.serverStatus[state.selectedServerId] ?? 'disconnected') : 'disconnected';
  const isConnected = selectedStatus === 'connected';

  return (
    <div className="app" ref={appRef}>
      {matrixActive && <MatrixRainOverlay onDismiss={() => setMatrixActive(false)} />}
      <div className="sidebar-wrapper" ref={sidebarWrapperRef}>
        <Sidebar
          servers={state.servers}
          serversLoading={state.serversLoading}
          serverStatus={state.serverStatus}
          serverDetails={state.serverDetails}
          serverItems={Object.fromEntries(state.servers.map(s => [s.id, {
            tools: state.tools[s.id]?.length ?? 0,
            resources: state.resources[s.id]?.length ?? 0,
            prompts: state.prompts[s.id]?.length ?? 0,
          }]))}
          authOverrides={state.authOverrides}
          selectedServerId={state.selectedServerId}
          onSelect={handleSelectServer}
          onConnect={handleConnect}
          onDisconnect={handleDisconnect}
          onRemove={handleRemoveServer}
          onEdit={handleEditServer}
          onAuth={server => dispatch({ type: 'SHOW_AUTH_SERVER', server })}
          onAdd={() => dispatch({ type: 'SHOW_ADD_SERVER', show: true })}
        />
        <div className="resize-handle" ref={sidebarHandleRef} />
      </div>

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
                ) : selectedStatus === 'connecting' ? (
                  <button className="btn btn-secondary server-header-action" onClick={() => handleCancelConnect(selectedServer.id)}>
                    Cancel
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
                const count = (state.serverEvents[selectedServer.id] ?? []).length;
                return (
                  <div
                    className={`tab${state.activeTab === 'events' ? ' active' : ''}`}
                    onClick={() => dispatch({ type: 'SELECT_TAB', tab: 'events' })}
                  >
                    Events{count > 0 ? ` (${count})` : ''}
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
              <div className="tab-separator" />
              <div
                className={`tab tab-global${state.activeTab === 'tests' ? ' active' : ''}`}
                onClick={() => dispatch({ type: 'SELECT_TAB', tab: 'tests' })}
                title="Tests run against any server — not specific to the selected server"
              >
                Tests{state.tests.length > 0 ? ` (${state.tests.length})` : ''}
              </div>
            </div>

            {/* Tab content — tools/resources/prompts stay mounted to preserve selection */}
            <div style={state.activeTab !== 'tools' ? { display: 'none' } : { display: 'contents' }}>
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
                onSaveAsTest={handleSaveAsTest}
                onOpenLogForRequest={handleOpenLogForRequest}
              />
            </div>
            <div style={state.activeTab !== 'resources' ? { display: 'none' } : { display: 'contents' }}>
              <ResourcesPanel
                key={`resources-${selectedServer.id}`}
                serverId={selectedServer.id}
                resources={state.resources[selectedServer.id] ?? []}
                loadState={state.capabilityLoadState.resources[selectedServer.id] ?? 'idle'}
                requests={state.requests}
                isConnected={isConnected}
                onStartRequest={handleStartRequest}
              />
            </div>
            <div style={state.activeTab !== 'prompts' ? { display: 'none' } : { display: 'contents' }}>
              <PromptsPanel
                key={`prompts-${selectedServer.id}`}
                serverId={selectedServer.id}
                prompts={state.prompts[selectedServer.id] ?? []}
                loadState={state.capabilityLoadState.prompts[selectedServer.id] ?? 'idle'}
                requests={state.requests}
                isConnected={isConnected}
                onStartRequest={handleStartRequest}
              />
            </div>
            {state.activeTab === 'history' && (
              <HistoryPanel
                key={`history-${selectedServer.id}`}
                history={state.history.filter(e => e.serverId === selectedServer.id)}
                onClear={() => dispatch({ type: 'HISTORY_CLEAR', serverId: selectedServer.id })}
                onRerun={(toolName, args) => handleRerun(toolName, args)}
                onSaveAsTest={handleSaveAsTest}
              />
            )}
            {state.activeTab === 'events' && (
              <EventsPanel
                events={state.serverEvents[selectedServer.id] ?? []}
                onClear={() => dispatch({ type: 'SERVER_EVENTS_CLEAR', serverId: selectedServer.id })}
              />
            )}
            {state.activeTab === 'log' && (
              <ConnectionLogPanel
                logs={state.connectionLogs[selectedServer.id] ?? []}
                focusedLogEntryId={state.focusedLogEntryId}
                onClear={() => dispatch({ type: 'CONNECTION_LOG_CLEAR', serverId: selectedServer.id })}
              />
            )}
            <div style={state.activeTab !== 'tests' ? { display: 'none' } : { display: 'contents' }}>
              <TestsPanel
                tests={state.tests}
                servers={state.servers}
                serverStatus={state.serverStatus}
                tools={state.tools}
                history={state.history}
                testResults={state.testResults}
                runningTestIds={state.runningTestIds}
                variables={state.testVariables}
                onSave={handleSaveTests}
                onSaveVariables={handleSaveVariables}
                onRun={handleRunTest}
                onRunAll={handleRunAllTests}
                onRunGroup={handleRunGroup}
              />
            </div>
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

      {state.editingServer && (
        <AddServerModal
          editServerId={state.editingServer.id}
          initialConfig={state.editingServer}
          onAdd={handleUpdateServer}
          onClose={() => dispatch({ type: 'SHOW_EDIT_SERVER', server: null })}
        />
      )}

      {state.authServer && (
        <AuthOverrideModal
          server={state.authServer}
          value={state.authOverrides[state.authServer.id] ?? state.authOverrides[state.authServer.name] ?? 'auto'}
          isConnected={state.serverStatus[state.authServer.id] === 'connected'}
          onSave={(value: AuthAccountSelection) => handleSaveAuthOverride(state.authServer!, value)}
          onClose={() => dispatch({ type: 'SHOW_AUTH_SERVER', server: null })}
        />
      )}
    </div>
  );
}
