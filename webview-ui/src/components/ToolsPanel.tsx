import { useState, useEffect } from 'react';
import { postMessage } from '../vscode';
import type { McpTool, SchemaProperty, InputSchema, RequestEntry, RequestInfo, HistoryEntry, CapabilityLoadState } from '../types';
import JsonViewer from './JsonViewer';
import ResultViewer from './ResultViewer';

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
}

let reqCounter = 0;
function nextReqId() { return `tool-${Date.now()}-${++reqCounter}`; }
function toFieldId(prefix: string, name: string) {
  return `${prefix}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

// ── JSON validation ───────────────────────────────────────────────────────────

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

// ── Component ─────────────────────────────────────────────────────────────────

export default function ToolsPanel({
  serverId, tools, loadState, history, requests, isConnected,
  pendingRerun, onPendingRerunConsumed, onStartRequest,
}: Props) {
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [jsonArgs, setJsonArgs] = useState('{}');
  const [useJson, setUseJson] = useState(false);
  const [lastReqIdByTool, setLastReqIdByTool] = useState<Record<string, string>>({});
  const [expandedPrev, setExpandedPrev] = useState<string | null>(null);

  // Handle re-run signal from History tab
  useEffect(() => {
    if (!pendingRerun) return;
    if (pendingRerun.serverId !== serverId) return;
    const tool = tools.find(t => t.name === pendingRerun.toolName);
    if (tool) {
      setSelectedTool(tool);
      setJsonArgs(JSON.stringify(pendingRerun.args ?? {}, null, 2));
      setUseJson(true);
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

  const handleSelectTool = (tool: McpTool) => {
    setSelectedTool(tool);
    setFormValues({});
    setJsonArgs('{}');
    setExpandedPrev(null);
  };

  const handleRun = (argsOverride?: Record<string, unknown>) => {
    if (!selectedTool) return;
    let args: Record<string, unknown>;
    // Re-runs, JSON mode, and form mode all converge here so request tracking,
    // history, and result tabs stay consistent regardless of how a call starts.
    if (argsOverride !== undefined) {
      args = argsOverride;
      setJsonArgs(JSON.stringify(argsOverride, null, 2));
      setUseJson(true);
    } else if (useJson) {
      try { args = JSON.parse(jsonArgs); }
      catch { return; }
    } else {
      args = buildArgs(selectedTool, formValues);
    }
    const reqId = nextReqId();
    setLastReqIdByTool(prev => ({ ...prev, [selectedTool.name]: reqId }));
    onStartRequest(reqId, { type: 'tool', name: selectedTool.name, args });
    postMessage({ type: 'callTool', serverId, toolName: selectedTool.name, args, requestId: reqId });
  };

  const lastReqId = selectedTool ? (lastReqIdByTool[selectedTool.name] ?? null) : null;
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
      <div className="panel-list scroll-list">
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
        ) : tools.map(tool => (
          <div
            key={tool.name}
            className={`list-item${selectedTool?.name === tool.name ? ' active' : ''}`}
            onClick={() => handleSelectTool(tool)}
          >
            <div className="tool-list-item-header">
              <div className="list-item-name">{tool.name}</div>
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

      {/* Detail */}
      <div className="panel-detail">
        {selectedTool ? (
          <>
            <div className="detail-title">{selectedTool.name}</div>
            {selectedTool.description && <div className="detail-desc">{selectedTool.description}</div>}

            <div className="tool-panel-input-header">
              <span className="section-title tool-panel-input-title">Input</span>
              <button
                className="btn btn-secondary tool-panel-mode-toggle"
                onClick={() => setUseJson(v => !v)}
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
            >
              {result?.status === 'pending' ? <><span className="spinner" />Running…</> : 'Run Tool'}
            </button>

            {result && result.status !== 'pending' && (
              <div className="result-area">
                <div className="result-header">
                  <span className={`result-label${result.isError ? ' error' : ' ok'}`}>
                    {result.isError ? '✗ Error' : '✓ Result'}
                  </span>
                </div>
                <ResultViewer data={result.data} isError={result.isError} />
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

// ── ToolForm ──────────────────────────────────────────────────────────────────

function buildArgs(tool: McpTool, values: Record<string, string>): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const props = tool.inputSchema?.properties ?? {};
  for (const [key, schema] of Object.entries(props)) {
    const val = values[key];
    if (val === undefined || val === '') continue;
    // Form mode only does lightweight scalar coercion. Nested objects and arrays
    // are expected to come from the dedicated JSON input mode.
    if (schema.type === 'number' || schema.type === 'integer') args[key] = Number(val);
    else if (schema.type === 'boolean') args[key] = val === 'true';
    else args[key] = val;
  }
  return args;
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
  const set = (key: string, val: string) => onChange(prev => ({ ...prev, [key]: val }));
  return (
    <>
      {Object.entries(props).map(([key, schema]) => (
        <FieldInput key={key} name={key} schema={schema} isRequired={required.includes(key)} value={values[key] ?? ''} onChange={val => set(key, val)} />
      ))}
    </>
  );
}

interface FieldInputProps { name: string; schema: SchemaProperty; isRequired: boolean; value: string; onChange: (v: string) => void; }

function FieldInput({ name, schema, isRequired, value, onChange }: FieldInputProps) {
  const fieldId = toFieldId('tool-field', name);
  const label = <label className="form-label" htmlFor={fieldId}>{name}{isRequired && <span className="req">*</span>}</label>;

  if (schema.type === 'boolean') return (
    <div className="form-group">
      {label}
      <select id={fieldId} className="form-select form-select-auto" value={value} onChange={e => onChange(e.target.value)} title={name}>
        <option value="">(unset)</option><option value="true">true</option><option value="false">false</option>
      </select>
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );

  if (schema.enum) return (
    <div className="form-group">
      {label}
      <select id={fieldId} className="form-select" value={value} onChange={e => onChange(e.target.value)} title={name}>
        <option value="">(select)</option>
        {schema.enum.map((v, i) => <option key={i} value={String(v)}>{String(v)}</option>)}
      </select>
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );

  const isMultiline = schema.type === 'array' || schema.type === 'object' || !schema.type;
  return (
    <div className="form-group">
      {label}
      {isMultiline
        ? <textarea id={fieldId} className="form-textarea" value={value} onChange={e => onChange(e.target.value)} placeholder={schema.type === 'array' ? '["item1","item2"]' : '{"key":"value"}'} rows={3} title={name} />
        : <input id={fieldId} className="form-input" type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={String(schema.default ?? '')} title={name} />
      }
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );
}

