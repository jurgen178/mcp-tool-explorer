import { useState, useCallback, useEffect, useRef } from 'react';
import type { McpServerConfig, McpTool, SchemaProperty, InputSchema, HistoryEntry, TestCase, TestAssertion, TestAssertionType, TestRunResult } from '../types';
import JsonViewer from './JsonViewer';

interface Props {
  tests: TestCase[];
  servers: McpServerConfig[];
  serverStatus: Record<string, string>;
  tools: Record<string, McpTool[]>;
  history: HistoryEntry[];
  variables: Record<string, string>;
  testResults: Record<string, TestRunResult>;
  runningTestIds: string[];
  onSave: (tests: TestCase[]) => void;
  onSaveVariables: (variables: Record<string, string>) => void;
  onRun: (test: TestCase) => void;
  onRunAll: () => void;
  onRunGroup: (group: string) => void;
}

let idCounter = 0;
function newId() { return `test-${Date.now()}-${++idCounter}`; }

function emptyTest(serverId: string, toolName: string, group?: string): TestCase {
  return {
    id: newId(),
    name: 'New test',
    ...(group ? { group } : {}),
    serverId,
    toolName,
    args: {},
    assertion: { type: 'no-error' },
  };
}

// ── Shared form helpers (mirrored from ToolsPanel) ──────────────────────────

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

function toFieldId(prefix: string, name: string) {
  return `${prefix}-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function FieldInput({ name, schema, isRequired, value, onChange }: {
  name: string; schema: SchemaProperty; isRequired: boolean; value: string; onChange: (v: string) => void;
}) {
  const fieldId = toFieldId('test-field', name);
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
        ? <textarea id={fieldId} className="form-textarea" value={value} onChange={e => onChange(e.target.value)} placeholder={schema.type === 'array' ? '["item1"]' : '{"key":"value"}'} rows={3} title={name} />
        : <input id={fieldId} className="form-input" type={schema.type === 'number' || schema.type === 'integer' ? 'number' : 'text'} value={value} onChange={e => onChange(e.target.value)} placeholder={String(schema.default ?? '')} title={name} />
      }
      {schema.description && <div className="form-hint">{schema.description}</div>}
    </div>
  );
}

function ToolForm({ tool, values, onChange }: {
  tool: McpTool;
  values: Record<string, string>;
  onChange: React.Dispatch<React.SetStateAction<Record<string, string>>>;
}) {
  const props = (tool.inputSchema as InputSchema)?.properties ?? {};
  const required = (tool.inputSchema as InputSchema)?.required ?? [];
  if (Object.keys(props).length === 0) return <p className="form-note">No parameters.</p>;
  const set = (key: string, val: string) => onChange(prev => ({ ...prev, [key]: val }));
  return (
    <>
      {Object.entries(props).map(([key, schema]) => (
        <FieldInput key={key} name={key} schema={schema} isRequired={required.includes(key)} value={values[key] ?? ''} onChange={val => set(key, val)} />
      ))}
    </>
  );
}

// ── Assertion labels ──────────────────────────────────────────────────────────

const ASSERTION_LABELS: Record<TestAssertionType, string> = {
  'no-error': 'No error (just runs without error)',
  'contains': 'Output contains text',
  'equals':   'Output equals (JSON)',
  'json-path': 'JSON path equals',
};

function StatusIcon({ testId, results, running }: { testId: string; results: Record<string, TestRunResult>; running: string[] }) {
  if (running.includes(testId)) return <span className="test-status-icon test-status-running" title="Running"><span className="spinner" /></span>;
  const r = results[testId];
  if (!r) return <span className="test-status-icon test-status-idle" title="Not run">○</span>;
  if (r.status === 'pass')  return <span className="test-status-icon test-status-pass"  title="Passed">✓</span>;
  if (r.status === 'fail')  return <span className="test-status-icon test-status-fail"  title="Failed">✗</span>;
  return <span className="test-status-icon test-status-error" title="Error">!</span>;
}

// ── Variables editor ──────────────────────────────────────────────────────────

function VariablesEditor({ variables, onSave }: {
  variables: Record<string, string>;
  onSave: (v: Record<string, string>) => void;
}) {
  const [entries, setEntries] = useState<Array<{ id: number; k: string; v: string }>>(() =>
    Object.entries(variables).map(([k, v], i) => ({ id: i, k, v }))
  );
  const [newKey, setNewKey] = useState('');
  const [newVal, setNewVal] = useState('');
  const nextId = useRef(Object.keys(variables).length);

  const commit = (next: typeof entries) => {
    const obj: Record<string, string> = {};
    for (const { k, v } of next) if (k.trim()) obj[k.trim()] = v;
    onSave(obj);
  };
  const update = (id: number, field: 'k' | 'v', val: string) =>
    setEntries(prev => prev.map(e => e.id === id ? { ...e, [field]: val } : e));
  const remove = (id: number) => { const next = entries.filter(e => e.id !== id); setEntries(next); commit(next); };
  const add = () => {
    if (!newKey.trim()) return;
    const next = [...entries, { id: ++nextId.current, k: newKey.trim(), v: newVal }];
    setEntries(next); commit(next); setNewKey(''); setNewVal('');
  };

  return (
    <div className="test-vars-editor">
      {entries.map(e => (
        <div key={e.id} className="test-var-row">
          <input className="test-var-key" value={e.k} onChange={ev => update(e.id, 'k', ev.target.value)} onBlur={() => commit(entries)} placeholder="NAME" spellCheck={false} />
          <span className="test-var-eq">=</span>
          <input className="test-var-val" value={e.v} onChange={ev => update(e.id, 'v', ev.target.value)} onBlur={() => commit(entries)} placeholder="value" spellCheck={false} />
          <button className="test-var-del" onClick={() => remove(e.id)} title="Remove variable">×</button>
        </div>
      ))}
      <div className="test-var-row test-var-add-row">
        <input className="test-var-key" value={newKey} onChange={e => setNewKey(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="NEW_VAR" spellCheck={false} />
        <span className="test-var-eq">=</span>
        <input className="test-var-val" value={newVal} onChange={e => setNewVal(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add(); }} placeholder="value" spellCheck={false} />
        <button className="btn btn-secondary test-var-add" onClick={add} disabled={!newKey.trim()} title="Add variable">+</button>
      </div>
      {entries.length > 0 && <div className="test-vars-hint">Use <code>{'{{NAME}}'}</code> in test arguments to substitute</div>}
    </div>
  );
}

export default function TestsPanel({
  tests, servers, serverStatus, tools, history, variables, testResults, runningTestIds,
  onSave, onSaveVariables, onRun, onRunAll, onRunGroup,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(() => tests[0]?.id ?? null);
  const [showVars, setShowVars] = useState(false);

  const selected = tests.find(t => t.id === selectedId) ?? null;

  const upsert = useCallback((updated: TestCase) => {
    const next = tests.some(t => t.id === updated.id)
      ? tests.map(t => t.id === updated.id ? updated : t)
      : [...tests, updated];
    onSave(next);
  }, [tests, onSave]);

  const handleNew = () => {
    const serverId = servers[0]?.id ?? '';
    const toolName = (tools[serverId] ?? [])[0]?.name ?? '';
    const t = emptyTest(serverId, toolName, selected?.group);
    onSave([...tests, t]);
    setSelectedId(t.id);
  };

  const handleDelete = (id: string) => {
    const next = tests.filter(t => t.id !== id);
    onSave(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
  };

  // Groups
  const groups = [...new Set(tests.map(t => t.group).filter(Boolean) as string[])].sort();
  const allGroups = groups;
  const hasGroups = groups.length > 0;

  const renderTestItem = (test: TestCase) => (
    <div
      key={test.id}
      className={`list-item tests-list-item${selectedId === test.id ? ' active' : ''}`}
      onClick={() => setSelectedId(test.id)}
    >
      <div className="tests-list-item-row">
        <StatusIcon testId={test.id} results={testResults} running={runningTestIds} />
        <span className="list-item-name tests-list-item-name">{test.name}</span>
      </div>
      <div className="list-item-sub">{test.toolName}</div>
    </div>
  );

  const total   = tests.length;
  const passed  = tests.filter(t => testResults[t.id]?.status === 'pass').length;
  const failed  = tests.filter(t => testResults[t.id]?.status === 'fail' || testResults[t.id]?.status === 'error').length;
  const running = runningTestIds.length;
  const varCount = Object.keys(variables).length;

  return (
    <div className="panel tests-panel">
      {/* ── Left list ─────────────────────────────────────────────────────── */}
      <div className="panel-list tests-list">
        <div className="tests-list-toolbar">
          <button className="btn btn-primary tests-btn-new" onClick={handleNew}>+ New</button>
          <button
            className="btn btn-secondary tests-btn-run-all"
            onClick={onRunAll}
            disabled={tests.length === 0 || running > 0}
            title="Run all tests"
          >
            {running > 0 ? <><span className="spinner" /> Running…</> : '▶ Run all'}
          </button>
          <button
            className={`btn btn-secondary tests-btn-vars${showVars ? ' active' : ''}`}
            onClick={() => setShowVars(v => !v)}
            title="Manage environment variables — use {{NAME}} in test args"
          >
            {varCount > 0 ? `⚙ Vars (${varCount})` : '⚙ Vars'} {showVars ? '▲' : '▼'}
          </button>
        </div>

        {showVars && (
          <div className="test-vars-panel">
            <VariablesEditor variables={variables} onSave={onSaveVariables} />
          </div>
        )}

        {total > 0 && (
          <div className="tests-summary">
            {running > 0
              ? <span className="tests-summary-running">Running {running}/{total}…</span>
              : <>
                  <span className="tests-summary-pass">{passed} passed</span>
                  {failed > 0 && <span className="tests-summary-fail">{failed} failed</span>}
                  {passed === 0 && failed === 0 && <span className="tests-summary-idle">{total} not run</span>}
                </>
            }
          </div>
        )}

        {tests.length === 0 ? (
          <div className="empty-state empty-state-compact">
            <p>No tests yet.</p>
            <p>Click <strong>+ New</strong> to create one.</p>
          </div>
        ) : hasGroups ? (
          <>
            {groups.map(group => {
              const groupTests = tests.filter(t => t.group === group);
              const groupRunning = groupTests.some(t => runningTestIds.includes(t.id));
              return (
                <div key={group} className="tests-group">
                  <div className="tests-group-header">
                    <span className="tests-group-name">{group}</span>
                    <button
                      className="tests-group-run-btn"
                      onClick={() => onRunGroup(group)}
                      disabled={groupRunning}
                      title={`Run all tests in "${group}"`}
                    >▶</button>
                  </div>
                  {groupTests.map(renderTestItem)}
                </div>
              );
            })}
            {tests.filter(t => !t.group).length > 0 && (
              <div className="tests-group">
                <div className="tests-group-header tests-group-header-ungrouped">
                  <span className="tests-group-name">Other</span>
                </div>
                {tests.filter(t => !t.group).map(renderTestItem)}
              </div>
            )}
          </>
        ) : (
          tests.map(renderTestItem)
        )}
      </div>

      {/* ── Right editor ──────────────────────────────────────────────────── */}
      <div className="panel-detail tests-editor">
        {selected ? (
          <TestEditor
            key={selected.id}
            test={selected}
            servers={servers}
            serverStatus={serverStatus}
            tools={tools}
            history={history}
            allGroups={allGroups}
            result={testResults[selected.id]}
            isRunning={runningTestIds.includes(selected.id)}
            onChange={upsert}
            onRun={() => onRun(selected)}
            onDelete={() => handleDelete(selected.id)}
          />
        ) : (
          <div className="empty-state">
            <p>Select a test or click <strong>+ New</strong> to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ── TestEditor ────────────────────────────────────────────────────────────────

interface EditorProps {
  test: TestCase;
  servers: McpServerConfig[];
  serverStatus: Record<string, string>;
  tools: Record<string, McpTool[]>;
  history: HistoryEntry[];
  allGroups: string[];
  result: TestRunResult | undefined;
  isRunning: boolean;
  onChange: (t: TestCase) => void;
  onRun: () => void;
  onDelete: () => void;
}

function TestEditor({ test, servers, serverStatus, tools, history, allGroups, result, isRunning, onChange, onRun, onDelete }: EditorProps) {
  const [useJson, setUseJson] = useState(true);
  const [argsJson, setArgsJson] = useState(() => JSON.stringify(test.args, null, 2));
  const [formValues, setFormValues] = useState<Record<string, string>>({});
  const [argsError, setArgsError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [showHistory, setShowHistory] = useState(false);

  const serverTools = tools[test.serverId] ?? [];
  const isConnected = serverStatus[test.serverId] === 'connected';

  // If toolName is blank or stale (tools loaded after new-test was created), snap to first available
  useEffect(() => {
    if (serverTools.length > 0 && !serverTools.find(t => t.name === test.toolName)) {
      onChange({ ...test, toolName: serverTools[0].name });
    }
  }, [test.serverId, serverTools.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = serverTools.find(t => t.name === test.toolName) ?? null;
  const hasFormFields = Object.keys(selectedTool?.inputSchema?.properties ?? {}).length > 0;

  // History entries for this exact tool + server combination (no args filter — empty args {} is valid)
  const toolHistory = history
    .filter(e => e.serverId === test.serverId && e.name === test.toolName && e.status !== 'pending')
    .slice(0, 6);

  const set = <K extends keyof TestCase>(key: K, value: TestCase[K]) => onChange({ ...test, [key]: value });
  const setAssertion = <K extends keyof TestAssertion>(key: K, value: TestAssertion[K]) =>
    onChange({ ...test, assertion: { ...test.assertion, [key]: value } });

  const handleToggleMode = () => {
    if (useJson) {
      // JSON → Form: populate form values from current JSON
      try {
        const parsed = JSON.parse(argsJson) as Record<string, unknown>;
        const fv: Record<string, string> = {};
        for (const [k, v] of Object.entries(parsed)) {
          fv[k] = typeof v === 'object' ? JSON.stringify(v) : String(v);
        }
        setFormValues(fv);
        setArgsError(null);
      } catch { return; } // stay in JSON mode on parse error
    } else {
      // Form → JSON: serialize form values
      if (selectedTool) {
        const args = buildArgs(selectedTool, formValues);
        const json = JSON.stringify(args, null, 2);
        setArgsJson(json);
        setArgsError(null);
        onChange({ ...test, args });
      }
    }
    setUseJson(v => !v);
  };

  const handleArgsChange = (raw: string) => {
    setArgsJson(raw);
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
        onChange({ ...test, args: parsed as Record<string, unknown> });
        setArgsError(null);
      } else {
        setArgsError('Arguments must be a JSON object {}');
      }
    } catch {
      setArgsError('Invalid JSON');
    }
  };

  const handleFormChange = (next: React.SetStateAction<Record<string, string>>) => {
    const resolved = typeof next === 'function' ? next(formValues) : next;
    setFormValues(resolved);
    if (selectedTool) {
      onChange({ ...test, args: buildArgs(selectedTool, resolved) });
    }
  };

  const getServerEndpoint = (serverId: string): string | undefined => {
    const s = servers.find(srv => srv.id === serverId);
    if (!s) return undefined;
    if (s.url) return s.url;
    if (s.command) return [s.command, ...(s.args ?? [])].join(' ');
    return undefined;
  };

  const handleServerChange = (serverId: string) => {
    const firstTool = (tools[serverId] ?? [])[0]?.name ?? '';
    setArgsJson('{}');
    setFormValues({});
    setArgsError(null);
    onChange({ ...test, serverId, toolName: firstTool, args: {}, serverEndpoint: getServerEndpoint(serverId) });
  };

  // Keep serverEndpoint in sync when server list loads (e.g. on first render the field may be missing)
  useEffect(() => {
    const endpoint = getServerEndpoint(test.serverId);
    if (endpoint && test.serverEndpoint !== endpoint) {
      onChange({ ...test, serverEndpoint: endpoint });
    }
  }, [test.serverId, servers.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleImportHistory = (entry: HistoryEntry) => {
    const imported = (entry.args ?? {}) as Record<string, unknown>;
    const json = JSON.stringify(imported, null, 2);
    setArgsJson(json);
    setUseJson(true);
    onChange({ ...test, args: imported });
    setShowHistory(false);
  };

  const handleToolChange = (toolName: string) => {
    setArgsJson('{}');
    setFormValues({});
    setArgsError(null);
    onChange({ ...test, toolName, args: {} });
  };

  const handleCaptureSnapshot = () => {
    if (result?.actual === undefined) return;
    const snapshotJson = JSON.stringify(result.actual, null, 2);
    onChange({ ...test, assertion: { type: 'equals', expected: snapshotJson } });
  };

  return (
    <div className="test-editor-form">
      {/* ── Header ── */}
      <div className="test-editor-header">
        <input
          className="form-input test-name-input"
          value={test.name}
          onChange={e => set('name', e.target.value)}
          placeholder="Test name"
        />
        <div className="test-editor-header-actions">
          <button
            className="btn btn-primary"
            onClick={onRun}
            disabled={isRunning || !isConnected}
            title={!isConnected ? 'Connect to the server first' : 'Run this test (Ctrl+Enter)'}
          >
            {isRunning ? <><span className="spinner" /> Running…</> : '▶ Run'}
          </button>
          {confirmDelete ? (
            <>
              <button className="btn btn-danger" onClick={onDelete}>Confirm delete</button>
              <button className="btn btn-secondary" onClick={() => setConfirmDelete(false)}>Cancel</button>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={() => setConfirmDelete(true)} title="Delete test">🗑</button>
          )}
        </div>
      </div>

      {!isConnected && (
        <div className="test-not-connected-hint">
          Server "<strong>{servers.find(s => s.id === test.serverId)?.name ?? test.serverId}</strong>" is not connected — connect it to run this test.
        </div>
      )}

      {/* ── Server & Tool ── */}
      <div className="test-editor-row">
        <div className="form-group test-editor-field-server">
          <label className="form-label">Server</label>
          <select
            className="form-select"
            value={test.serverId}
            onChange={e => handleServerChange(e.target.value)}
          >
            {servers.map(s => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group test-editor-field-tool">
          <label className="form-label">Tool</label>
          {serverTools.length > 0 ? (
            <select
              className="form-select"
              value={test.toolName}
              onChange={e => handleToolChange(e.target.value)}
            >
              {serverTools.map(t => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="form-input"
              value={test.toolName}
              onChange={e => handleToolChange(e.target.value)}
              placeholder="Tool name (connect server to browse)"
            />
          )}
        </div>
      </div>

      {/* ── Tool description ── */}
      {selectedTool?.description && (
        <p className="test-tool-desc">{selectedTool.description}</p>
      )}

      {/* ── Group ── */}
      <div className="form-group">
        <label className="form-label">Group <span className="form-hint-inline">(optional)</span></label>
        <input
          className="form-input"
          list="test-group-datalist"
          value={test.group ?? ''}
          onChange={e => onChange({ ...test, group: e.target.value || undefined })}
          placeholder="e.g. Basic, Auth, Edge Cases"
        />
        <datalist id="test-group-datalist">
          {allGroups.map(g => <option key={g} value={g} />)}
        </datalist>
      </div>

      {/* ── Arguments ── */}
      <div className="form-group">
        <div className="test-args-header">
          <label className="form-label test-args-label">Arguments</label>
          <div className="test-args-toolbar">
            {toolHistory.length > 0 && (
              <div className="test-history-import">
                <button
                  className="btn btn-secondary test-history-btn"
                  onClick={() => setShowHistory(v => !v)}
                  title="Import args from a previous call in History"
                >
                  From history {showHistory ? '▲' : '▼'}
                </button>
                {showHistory && (
                  <div className="test-history-menu">
                    {toolHistory.map(e => (
                      <button key={e.id} className="test-history-entry" onClick={() => handleImportHistory(e)}>
                        <span className={`test-history-status${e.isError ? ' is-error' : ' is-ok'}`}>
                          {e.isError ? '✗' : '✓'}
                        </span>
                        <span className="test-history-time">{new Date(e.timestamp).toLocaleTimeString()}</span>
                        <span className="test-history-args">{e.args !== undefined ? JSON.stringify(e.args).slice(0, 60) : '(no args)'}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {hasFormFields && (
              <button className="btn btn-secondary test-args-mode-toggle" onClick={handleToggleMode}>
                {useJson ? 'Form view' : 'JSON view'}
              </button>
            )}
          </div>
        </div>

        {useJson ? (
          <>
            <textarea
              className={`form-textarea test-args-textarea${argsError ? ' input-error' : ''}`}
              value={argsJson}
              onChange={e => handleArgsChange(e.target.value)}
              onKeyDown={e => { if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); if (!isRunning && isConnected) onRun(); } }}
              rows={5}
              spellCheck={false}
            />
            {argsError && <div className="validation-error">{argsError}</div>}
          </>
        ) : selectedTool ? (
          <ToolForm tool={selectedTool} values={formValues} onChange={handleFormChange} />
        ) : (
          <p className="form-note">Connect the server to use form mode.</p>
        )}
      </div>

      {/* ── Assertion ── */}
      <div className="form-group">
        <label className="form-label">Assertion</label>
        <select
          className="form-select"
          value={test.assertion.type}
          onChange={e => onChange({ ...test, assertion: { type: e.target.value as TestAssertionType } })}
        >
          {(Object.keys(ASSERTION_LABELS) as TestAssertionType[]).map(k => (
            <option key={k} value={k}>{ASSERTION_LABELS[k]}</option>
          ))}
        </select>
      </div>

      {(test.assertion.type === 'contains' || test.assertion.type === 'equals') && (
        <div className="form-group">
          <label className="form-label">
            {test.assertion.type === 'contains' ? 'Expected text (substring)' : 'Expected output (JSON)'}
          </label>
          <textarea
            className="form-textarea test-assertion-textarea"
            value={test.assertion.expected ?? ''}
            onChange={e => setAssertion('expected', e.target.value)}
            rows={4}
            spellCheck={false}
            placeholder={test.assertion.type === 'equals' ? 'Paste expected JSON here, or use "Capture as snapshot" below' : 'Text that must appear in the output'}
          />
        </div>
      )}

      {test.assertion.type === 'json-path' && (
        <>
          <div className="form-group">
            <label className="form-label">JSON path (dot notation)</label>
            <input
              className="form-input"
              value={test.assertion.path ?? ''}
              onChange={e => setAssertion('path', e.target.value)}
              placeholder="e.g. [0].text or result.value"
            />
            <div className="form-hint">Use dot/bracket notation, e.g. <code>[0].text</code></div>
          </div>
          <div className="form-group">
            <label className="form-label">Expected value at path</label>
            <input
              className="form-input"
              value={test.assertion.pathExpected ?? ''}
              onChange={e => setAssertion('pathExpected', e.target.value)}
              placeholder="Expected string value"
            />
          </div>
        </>
      )}

      {/* ── Result ── */}
      {(result || isRunning) && (
        <div className={`test-result test-result-${isRunning ? 'running' : result!.status}`}>
          <div className="test-result-header">
            {isRunning && <><span className="spinner" /> Running…</>}
            {!isRunning && result && (
              <>
                <span className="test-result-status">
                  {result.status === 'pass'  && '✓ Passed'}
                  {result.status === 'fail'  && '✗ Failed'}
                  {result.status === 'error' && '! Error'}
                </span>
                <span className="test-result-duration">{result.durationMs}ms</span>
                {result.actual !== undefined && (
                  <button
                    className="btn btn-secondary test-result-snapshot-btn"
                    onClick={handleCaptureSnapshot}
                    title="Use the actual output as the new expected value"
                  >
                    Capture as snapshot
                  </button>
                )}
              </>
            )}
          </div>
          {!isRunning && result?.message && (
            <pre className="test-result-message">{result.message}</pre>
          )}
          {!isRunning && result?.actual !== undefined && (
            <div className="test-result-actual">
              <div className="test-result-actual-label">Actual output:</div>
              <JsonViewer data={result.actual} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}
