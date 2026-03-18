import { useState, useEffect } from 'react';
import { postMessage } from '../vscode';
import type { McpTool, SchemaProperty, InputSchema, RequestEntry, RequestInfo, HistoryEntry } from '../types';
import JsonViewer from './JsonViewer';

interface Props {
  serverId: string;
  tools: McpTool[];
  history: HistoryEntry[];
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  pendingRerun: { toolName: string; args: unknown } | null;
  onPendingRerunConsumed: () => void;
  onStartRequest: (id: string, info: RequestInfo) => void;
}

let reqCounter = 0;
function nextReqId() { return `tool-${Date.now()}-${++reqCounter}`; }

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
    const known = Object.keys(schema.properties);
    for (const key of Object.keys(obj)) {
      if (!known.includes(key)) warnings.push(`Unknown property: "${key}"`);
    }
  }
  return { errors, warnings };
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function ToolsPanel({
  serverId, tools, history, requests, isConnected,
  pendingRerun, onPendingRerunConsumed, onStartRequest,
}: Props) {
  const [selectedTool, setSelectedTool] = useState<McpTool | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [jsonArgs, setJsonArgs] = useState('{}');
  const [useJson, setUseJson] = useState(false);
  const [lastReqId, setLastReqId] = useState<string | null>(null);
  const [expandedPrev, setExpandedPrev] = useState<string | null>(null);

  // Handle re-run signal from History tab
  useEffect(() => {
    if (!pendingRerun) return;
    const tool = tools.find(t => t.name === pendingRerun.toolName);
    if (tool) {
      setSelectedTool(tool);
      setJsonArgs(JSON.stringify(pendingRerun.args ?? {}, null, 2));
      setUseJson(true);
      setLastReqId(null);
    }
    onPendingRerunConsumed();
  }, [pendingRerun]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSelectTool = (tool: McpTool) => {
    setSelectedTool(tool);
    setFormValues({});
    setJsonArgs('{}');
    setLastReqId(null);
    setExpandedPrev(null);
  };

  const handleRun = (argsOverride?: Record<string, unknown>) => {
    if (!selectedTool) return;
    let args: Record<string, unknown>;
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
    setLastReqId(reqId);
    onStartRequest(reqId, { type: 'tool', name: selectedTool.name, args });
    postMessage({ type: 'callTool', serverId, toolName: selectedTool.name, args, requestId: reqId });
  };

  const result = lastReqId ? requests[lastReqId] : undefined;
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
          <div className="empty-state" style={{ height: 'auto', padding: '16px 12px' }}>
            <p>{isConnected ? 'No tools available.' : 'Connect to load tools.'}</p>
          </div>
        ) : tools.map(tool => (
          <div
            key={tool.name}
            className={`list-item${selectedTool?.name === tool.name ? ' active' : ''}`}
            onClick={() => handleSelectTool(tool)}
          >
            <div className="list-item-name">{tool.name}</div>
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

            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
              <span className="section-title" style={{ margin: 0 }}>Input</span>
              <button
                style={{ fontSize: 11, padding: '1px 8px', marginLeft: 'auto' }}
                className="btn btn-secondary"
                onClick={() => setUseJson(v => !v)}
              >
                {useJson ? 'Form view' : 'JSON view'}
              </button>
            </div>

            {useJson ? (
              <div className="form-group">
                <label className="form-label">Arguments (JSON)</label>
                <textarea
                  className="form-textarea"
                  value={jsonArgs}
                  onChange={e => setJsonArgs(e.target.value)}
                  rows={8}
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
                <JsonViewer data={result.data} isError={result.isError} />
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
                        <span style={{ color: isErr ? 'var(--vscode-charts-red,#f44747)' : 'var(--vscode-charts-green,#4ec9b0)', fontWeight: 700 }}>
                          {isErr ? '✗' : '✓'}
                        </span>
                        <button className="prev-call-expand" onClick={() => setExpandedPrev(exp ? null : entry.id)}>
                          {new Date(entry.timestamp).toLocaleTimeString()}
                          {entry.durationMs !== undefined && ` · ${entry.durationMs}ms`}
                        </button>
                        <button
                          className="btn btn-secondary"
                          style={{ fontSize: 10, padding: '1px 7px', flexShrink: 0 }}
                          disabled={!isConnected}
                          title="Re-run with same arguments"
                          onClick={() => handleRun(entry.args as Record<string, unknown>)}
                        >↩ Re-run</button>
                      </div>
                      {exp && (
                        <div style={{ marginBottom: 8 }}>
                          {entry.args !== undefined && (
                            <div style={{ marginBottom: 6 }}>
                              <div className="section-title">Args</div>
                              <JsonViewer data={entry.args} />
                            </div>
                          )}
                          {entry.result !== undefined && (
                            <div>
                              <div className="section-title">{isErr ? 'Error' : 'Result'}</div>
                              <JsonViewer data={entry.result} isError={isErr} />
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
    return <p style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', marginBottom: 12 }}>No parameters.</p>;
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
  const label = <label className="form-label">{name}{isRequired && <span className="req">*</span>}</label>;

  if (schema.type === 'boolean') return (
    <div className="form-group">
      {label}
      <select className="form-select" style={{ width: 'auto' }} value={value} onChange={e => onChange(e.target.value)}>
        <option value="">(unset)</option><option value="true">true</option><option value="false">false</option>
      </select>
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );

  if (schema.enum) return (
    <div className="form-group">
      {label}
      <select className="form-select" value={value} onChange={e => onChange(e.target.value)}>
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
        ? <textarea className="form-textarea" value={value} onChange={e => onChange(e.target.value)} placeholder={schema.type === 'array' ? '["item1","item2"]' : '{"key":"value"}'} rows={3} />
        : <input className="form-input" type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={String(schema.default ?? '')} />
      }
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );
}

