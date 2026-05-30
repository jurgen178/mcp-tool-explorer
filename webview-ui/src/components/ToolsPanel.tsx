import { useState, useEffect } from 'react';
import { postMessage } from '../vscode';
import { usePanelResize } from '../hooks/usePanelResize';
import type { McpTool, SchemaProperty, InputSchema, RequestEntry, RequestInfo, HistoryEntry, CapabilityLoadState } from '../types';
import JsonViewer from './JsonViewer';
import ResultViewer from './ResultViewer';
import McpAppViewer from './McpAppViewer';

interface Props {
  serverId: string;
  tools: McpTool[];
  loadState: CapabilityLoadState;
  history: HistoryEntry[];
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  pendingRerun: { serverId: string | null; toolName: string; args: unknown } | null;
  onPendingRerunConsumed: () => void;
  onStartRequest: (id: string, info: RequestInfo) => void;
  onSaveAsTest: (toolName: string, args: unknown) => void;
  onOpenLogForRequest: (requestId: string) => void;
}

let reqCounter = 0;
function nextReqId() { return `tool-${Date.now()}-${++reqCounter}`; }
function toFieldId(prefix: string, name: string) {
  return `${prefix}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

// JSON validation

function validateJsonArgs(json: string, schema: InputSchema): { errors: string[]; warnings: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    return { errors: [`Invalid JSON: ${e instanceof Error ? e.message : 'parse error'}`], warnings: [] };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { errors: ['Arguments must be a JSON object { … }'], warnings: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const errors: string[] = [];
  const warnings: string[] = [];
  if (schema.required) {
    for (const req of schema.required) {
      if (obj[req] === undefined) errors.push(`Missing required: "${req}"`);
    }
  }
  if (schema.properties) {
    // Unknown fields are warnings, not hard errors, so users can still try
    // vendor-specific or forward-compatible arguments when needed.
    const known = Object.keys(schema.properties);
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) {
        const caseMatch = known.find(k => k.toLowerCase() === key.toLowerCase());
        warnings.push(caseMatch
          ? `Unknown property: "${key}" — did you mean "${caseMatch}"? Property names are case-sensitive.`
          : `Unknown property: "${key}"`);
      }
    }
  }
  return { errors, warnings };
}

// Flatten parsed args into flat form-values (mirrors TestsPanel)
function flattenArgs(obj: Record<string, unknown>, props: Record<string, SchemaProperty>, prefix: string): Record<string, string> {
  const fv: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    const schema = props[k];
    if (schema?.type === 'object' && schema.properties && typeof v === 'object' && v !== null && !Array.isArray(v)) {
      Object.assign(fv, flattenArgs(v as Record<string, unknown>, schema.properties as Record<string, SchemaProperty>, path));
    } else {
      fv[path] = typeof v === 'object' ? JSON.stringify(v) : String(v ?? '');
    }
  }
  return fv;
}

// Component

export default function ToolsPanel({
  serverId, tools, loadState, history, requests, isConnected,
  pendingRerun, onPendingRerunConsumed, onStartRequest, onSaveAsTest, onOpenLogForRequest,
}: Props) {
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [search, setSearch] = useState('');
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [jsonArgs, setJsonArgs] = useState('{}');
  const [useJson, setUseJson] = useState(false);
  const [lastReqIdByTool, setLastReqIdByTool] = useState<Record<string, string>>({});
  const [lastArgsByTool, setLastArgsByTool] = useState<Record<string, Record<string, unknown>>>({});
  const [expandedPrev, setExpandedPrev] = useState<string | null>(null);
  const [savedTestIds, setSavedTestIds] = useState<Set<string>>(new Set());
  const { listRef, handleRef } = usePanelResize({ storageKey: 'panel-list-width:tools' });

  const searchLower = search.toLowerCase();
  const filteredTools = search
    ? tools.filter(t => t.name.toLowerCase().includes(searchLower) || t.description?.toLowerCase().includes(searchLower))
    : tools;

  // Handle re-run signal from History tab
  useEffect(() => {
    if (!pendingRerun) return;
    if (pendingRerun.serverId !== serverId) return;
    const tool = tools.find(t => t.name === pendingRerun.toolName);
    if (tool) {
      const args = (pendingRerun.args ?? {}) as Record<string, unknown>;
      setSelectedTool(tool);
      setJsonArgs(JSON.stringify(args, null, 2));
      setFormValues(flattenArgs(args, tool.inputSchema?.properties ?? {}, ''));
      // keep the user's current view mode — don't force JSON
    }
    onPendingRerunConsumed();
  }, [pendingRerun, serverId, tools, onPendingRerunConsumed]);

  useEffect(() => {
    if (!selectedTool) return;
    const stillExists = tools.some(tool => tool.name === selectedTool.name);
    if (stillExists) return;

    setSelectedTool(null);
    setFormValues({});
    setJsonArgs('{}');
    setUseJson(false);
    setExpandedPrev(null);
  }, [tools, selectedTool]);

  useEffect(() => {
    if (selectedTool !== null) return;
    if (tools.length === 0) return;
    setSelectedTool(tools[0]);
    setFormValues({});
    setJsonArgs('{}');
    setUseJson(false);
    setExpandedPrev(null);
  }, [tools, selectedTool]);

  const handleSelectTool = (tool: McpTool) => {
    setSelectedTool(tool);
    setFormValues({});
    setJsonArgs('{}');
    setExpandedPrev(null);
    setLastReqIdByTool(prev => { const { [tool.name]: _, ...rest } = prev; return rest; });
  };

  const handleRun = (argsOverride?: Record<string, unknown>) => {
    if (!selectedTool) return;
    let args: Record<string, unknown>;
    // Re-runs, JSON mode, and form mode all converge here so request tracking,
    // history, and result tabs stay consistent regardless of how a call starts.
    if (argsOverride !== undefined) {
      args = argsOverride;
      setJsonArgs(JSON.stringify(argsOverride, null, 2));
      setFormValues(flattenArgs(argsOverride, selectedTool.inputSchema?.properties ?? {}, ''));
      // keep the user's current view mode — don't force JSON
    } else if (useJson) {
      const v = selectedTool ? validateJsonArgs(jsonArgs, selectedTool.inputSchema) : null;
      if (v && v.errors.length > 0) return;
      try { args = JSON.parse(jsonArgs); }
      catch { return; }
    } else {
      args = buildArgs(selectedTool, formValues);
    }
    const reqId = nextReqId();
    setLastReqIdByTool(prev => ({ ...prev, [selectedTool.name]: reqId }));
    setLastArgsByTool(prev => ({ ...prev, [selectedTool.name]: args }));
    onStartRequest(reqId, { type: 'tool', name: selectedTool.name, args });
    postMessage({ type: 'callTool', serverId, toolName: selectedTool.name, args, requestId: reqId });
  };

  const handleSaveAsTestEntry = (entryId: string, toolName: string, args: unknown) => {
    onSaveAsTest(toolName, args);
    setSavedTestIds(prev => new Set([...prev, entryId]));
    setTimeout(() => setSavedTestIds(prev => { const next = new Set(prev); next.delete(entryId); return next; }), 1500);
  };

  const lastReqId = selectedTool ? (lastReqIdByTool[selectedTool.name] ?? null) : null;
  const lastArgs = selectedTool ? (lastArgsByTool[selectedTool.name] ?? {}) : {};
  const result = lastReqId ? requests[lastReqId] : undefined;
  const latestHistoryByTool = new Map<string, HistoryEntry>();

  for (const entry of history) {
    if (!latestHistoryByTool.has(entry.name)) {
      latestHistoryByTool.set(entry.name, entry);
    }
  }

  const prevCalls = selectedTool
    ? history.filter(e => e.name === selectedTool.name && e.status !== 'pending').slice(0, 6)
    : [];
  const validation = useJson && selectedTool
    ? validateJsonArgs(jsonArgs, selectedTool.inputSchema)
    : null;

  return (
    <div className="panel">
      {/* List */}
      <div className="panel-list" ref={listRef}>
        {tools.length >= 10 && (
          <div className="tool-search-bar">
            <input
              className="tool-search-input"
              type="search"
              placeholder="Filter tools…"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
        )}
        {tools.length === 0 ? (
          <div className="empty-state empty-state-compact">
            <p>
              {loadState === 'loading'
                ? 'Loading tools…'
                : loadState === 'error'
                  ? 'Failed to load tools.'
                  : isConnected
                    ? 'No tools available.'
                    : 'Connect to load tools.'}
            </p>
          </div>
        ) : filteredTools.length === 0 ? (
          <div className="empty-state empty-state-compact"><p>No tools match "{search}".</p></div>
        ) : filteredTools.map(tool => (
          <div
            key={tool.name}
            className={`list-item${selectedTool?.name === tool.name ? ' active' : ''}`}
            onClick={() => handleSelectTool(tool)}
          >
            <div className="tool-list-item-header">
              <div className="list-item-name">{tool.name}</div>
              {tool._meta?.ui?.resourceUri && (
                <span className="mcp-app-badge" title="Opens an interactive UI">MCP App</span>
              )}
              {latestHistoryByTool.get(tool.name)?.status === 'pending' && (
                <span className="tool-list-running" title="Request is still running">
                  <span className="spinner tool-list-running-spinner" />
                  Running
                </span>
              )}
            </div>
            {tool.description && <div className="list-item-sub">{tool.description}</div>}
          </div>
        ))}
      </div>

      <div className="panel-resize-handle" ref={handleRef} />

      {/* Detail */}
      <div className="panel-detail" onKeyDown={e => { if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); handleRun(); } }}>
        {selectedTool ? (
          <>
            <div className="detail-title">{selectedTool.name}</div>
            {selectedTool.description && <div className="detail-desc">{selectedTool.description}</div>}

            <div className="tool-panel-input-header">
              <span className="section-title tool-panel-input-title">Input</span>
              <button
                className="btn btn-secondary tool-panel-mode-toggle"
                onClick={() => {
                  if (useJson) {
                    // JSON → Form: parse current JSON into form values
                    try {
                      const parsed = JSON.parse(jsonArgs) as Record<string, unknown>;
                      setFormValues(flattenArgs(parsed, selectedTool?.inputSchema?.properties ?? {}, ''));
                    } catch { /* keep existing formValues */ }
                  } else {
                    // Form → JSON: serialize form values to JSON
                    setJsonArgs(JSON.stringify(selectedTool ? buildArgs(selectedTool, formValues) : {}, null, 2));
                  }
                  setUseJson(v => !v);
                }}
              >
                {useJson ? 'Form view' : 'JSON view'}
              </button>
            </div>

            {useJson ? (
              <div className="form-group">
                <label className="form-label" htmlFor={`tool-json-args-${serverId}`}>Arguments (JSON)</label>
                <textarea
                  id={`tool-json-args-${serverId}`}
                  className="form-textarea"
                  value={jsonArgs}
                  onChange={e => setJsonArgs(e.target.value)}
                  onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); handleRun(); } }}
                  rows={8}
                  title="Arguments as JSON"
                />
                {validation && (validation.errors.length > 0 || validation.warnings.length > 0) && (
                  <div className="validation-hints">
                    {validation.errors.map((err, i)  => <div key={i} className="validation-error">⚠ {err}</div>)}
                    {validation.warnings.map((w, i)  => <div key={i} className="validation-warning">○ {w}</div>)}
                  </div>
                )}
              </div>
            ) : (
              <ToolForm tool={selectedTool} values={formValues} onChange={setFormValues} />
            )}

            <button
              className="btn btn-primary"
              disabled={!isConnected || result?.status === 'pending' || (useJson && (validation?.errors.length ?? 0) > 0)}
              onClick={() => handleRun()}
              title="Run Tool (Ctrl+Enter)"
            >
              {result?.status === 'pending' ? <><span className="spinner" />Running…</> : 'Run Tool'}
            </button>

            {result && result.status !== 'pending' && (
              <div className="result-area">
                <div className="result-header tool-result-header">
                  <span className={`result-label${result.isError ? ' error' : ' ok'}`}>
                    {result.isError ? '✗ Error' : '✓ Result'}
                  </span>
                  {result.isError && lastReqId && (
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 11, padding: '1px 8px' }}
                      onClick={() => onOpenLogForRequest(lastReqId)}
                      title="Open the matching connection log entry"
                    >View log</button>
                  )}
                </div>
                <ResultViewer data={result.data} isError={result.isError} />
                {!result.isError && selectedTool._meta?.ui?.resourceUri && (
                  <McpAppViewer
                    serverId={serverId}
                    resourceUri={selectedTool._meta.ui.resourceUri}
                    toolArgs={lastArgs}
                    toolResult={result.data}
                    toolStructuredContent={result.structuredContent}
                  />
                )}
              </div>
            )}

            {/* Previous calls */}
            {prevCalls.length > 0 && (
              <div className="prev-calls">
                <hr className="divider" />
                <div className="section-title">Previous Calls</div>
                {prevCalls.map(entry => {
                  const isErr = entry.isError || entry.status === 'error';
                  const exp = expandedPrev === entry.id;
                  return (
                    <div key={entry.id}>
                      <div className="prev-call-item">
                        <span className={`prev-call-status${isErr ? ' is-error' : ' is-ok'}`}>
                          {isErr ? '✗' : '✓'}
                        </span>
                        <button className="prev-call-expand" onClick={() => setExpandedPrev(exp ? null : entry.id)}>
                          {new Date(entry.timestamp).toLocaleTimeString()}
                          {entry.durationMs !== undefined && ` · ${entry.durationMs}ms`}
                        </button>
                        <button
                          className="btn btn-secondary prev-call-rerun"
                          disabled={!isConnected}
                          title="Re-run with same arguments"
                          onClick={() => handleRun(entry.args as Record<string, unknown>)}
                        >↩ Re-run</button>
                        <button
                          className="btn btn-secondary prev-call-rerun"
                          title="Save this call with its arguments to Tests"
                          disabled={savedTestIds.has(entry.id)}
                          style={savedTestIds.has(entry.id) ? { cursor: 'default' } : undefined}
                          onClick={() => handleSaveAsTestEntry(entry.id, entry.name, entry.args)}
                        >{savedTestIds.has(entry.id) ? '✓ Saved' : 'Save as test'}</button>
                      </div>
                      {exp && (
                        <div className="prev-call-body">
                          {entry.args !== undefined && (
                            <div className="prev-call-args">
                              <div className="section-title">Args</div>
                              <JsonViewer data={entry.args} />
                            </div>
                          )}
                          {entry.result !== undefined && (
                            <div>
                              <div className="section-title">{isErr ? 'Error' : 'Result'}</div>
                              <ResultViewer data={entry.result} isError={isErr} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <p>Select a tool from the list to inspect and run it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ToolForm

function buildObject(props: Record<string, SchemaProperty>, values: Record<string, string>, prefix: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(props)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (schema.type === 'object' && schema.properties) {
      const nested = buildObject(schema.properties as Record<string, SchemaProperty>, values, path);
      if (Object.keys(nested).length > 0) args[key] = nested;
    } else {
      const val = values[path];
      if (val === undefined || val === '') continue;
      if (schema.type === 'number' || schema.type === 'integer') args[key] = Number(val);
      else if (schema.type === 'boolean') args[key] = val === 'true';
      else if (schema.type === 'array') {
        try { args[key] = JSON.parse(val); } catch { args[key] = val; }
      } else args[key] = val;
    }
  }
  return args;
}

function buildArgs(tool: McpTool, values: Record<string, string>): Record<string, unknown> {
  return buildObject(tool.inputSchema?.properties ?? {}, values, '');
}

interface ToolFormProps {
  tool: McpTool;
  values: Record<string, string>;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}

function ToolForm({ tool, values, onChange }: ToolFormProps) {
  const props = tool.inputSchema?.properties ?? {};
  const required = tool.inputSchema?.required ?? [];
  if (Object.keys(props).length === 0) {
    return <p className="form-note">No parameters.</p>;
  }
  const set = (path: string, val: string) => onChange(prev => ({ ...prev, [path]: val }));
  return (
    <>
      {Object.entries(props).map(([key, schema]) => (
        <FieldInput key={key} name={key} schema={schema} isRequired={required.includes(key)} values={values} path={key} onChange={set} />
      ))}
    </>
  );
}

interface FieldInputProps { name: string; schema: SchemaProperty; isRequired: boolean; values: Record<string, string>; path: string; onChange: (path: string, val: string) => void; }

function FieldInput({ name, schema, isRequired, values, path, onChange }: FieldInputProps) {
  const fieldId = toFieldId('tool-field', path);
  const value = values[path] ?? '';
  const label = <label className="form-label" htmlFor={fieldId}>{name}{isRequired && <span className="req">*</span>}</label>;

  if (schema.type === 'object' && schema.properties) {
    const nestedRequired = (schema as InputSchema).required ?? [];
    return (
      <div className="form-group-object">
        <div className="form-group-object-label">{name}{isRequired && <span className="req">*</span>}</div>
        <div className="form-group-object-fields">
          {Object.entries(schema.properties).map(([k, s]) => (
            <FieldInput key={k} name={k} schema={s as SchemaProperty} isRequired={nestedRequired.includes(k)}
              values={values} path={`${path}.${k}`} onChange={onChange} />
          ))}
        </div>
      </div>
    );
  }

  if (schema.type === 'boolean') return (
    <div className="form-group">
      {label}
      <select id={fieldId} className="form-select form-select-auto" value={value} onChange={e => onChange(path, e.target.value)} title={name}>
        <option value="">(unset)</option><option value="true">true</option><option value="false">false</option>
      </select>
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );

  if (schema.enum) return (
    <div className="form-group">
      {label}
      <select id={fieldId} className="form-select" value={value} onChange={e => onChange(path, e.target.value)} title={name}>
        <option value="">(select)</option>
        {schema.enum.map((v, i) => <option key={i} value={String(v)}>{String(v)}</option>)}
      </select>
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );

  const MULTILINE_NAMES = new Set(['code', 'before', 'after', 'content', 'body', 'text', 'script', 'source', 'input', 'template']);
  const isMultiline = schema.type === 'array' || !schema.type || MULTILINE_NAMES.has(name.toLowerCase());
  return (
    <div className="form-group">
      {label}
      {isMultiline
        ? <textarea id={fieldId} className="form-textarea" value={value} onChange={e => onChange(path, e.target.value)} placeholder={schema.type === 'array' ? '["item1","item2"]' : (schema.type === 'string' ? '' : '{"key":"value"}')} rows={schema.type === 'string' ? 6 : 3} title={name} />
        : <input id={fieldId} className="form-input" type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'} value={value} onChange={e => onChange(path, e.target.value)} placeholder={String(schema.default ?? '')} title={name} />
      }
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );
}

