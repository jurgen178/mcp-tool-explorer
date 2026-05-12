import { useState, useCallback } from 'react';
import type { McpServerConfig, McpTool, TestCase, TestAssertion, TestAssertionType, TestRunResult } from '../types';
import JsonViewer from './JsonViewer';

interface Props {
  tests: TestCase[];
  servers: McpServerConfig[];
  serverStatus: Record<string, string>;
  tools: Record<string, McpTool[]>;
  testResults: Record<string, TestRunResult>;
  runningTestIds: string[];
  onSave: (tests: TestCase[]) => void;
  onRun: (test: TestCase) => void;
  onRunAll: () => void;
}

let idCounter = 0;
function newId() { return `test-${Date.now()}-${++idCounter}`; }

function emptyTest(serverId: string, toolName: string): TestCase {
  return {
    id: newId(),
    name: 'New test',
    serverId,
    toolName,
    args: {},
    assertion: { type: 'no-error' },
  };
}

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

export default function TestsPanel({
  tests, servers, serverStatus, tools, testResults, runningTestIds, onSave, onRun, onRunAll,
}: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(() => tests[0]?.id ?? null);

  const selected = tests.find(t => t.id === selectedId) ?? null;

  // ── Mutations ─────────────────────────────────────────────────────────────

  const upsert = useCallback((updated: TestCase) => {
    const next = tests.some(t => t.id === updated.id)
      ? tests.map(t => t.id === updated.id ? updated : t)
      : [...tests, updated];
    onSave(next);
  }, [tests, onSave]);

  const handleNew = () => {
    const serverId = servers[0]?.id ?? '';
    const toolName = (tools[serverId] ?? [])[0]?.name ?? '';
    const t = emptyTest(serverId, toolName);
    onSave([...tests, t]);
    setSelectedId(t.id);
  };

  const handleDelete = (id: string) => {
    const next = tests.filter(t => t.id !== id);
    onSave(next);
    if (selectedId === id) setSelectedId(next[0]?.id ?? null);
  };

  const handleRunAll = () => {
    onRunAll();
  };

  // ── Summary ───────────────────────────────────────────────────────────────
  const total   = tests.length;
  const passed  = tests.filter(t => testResults[t.id]?.status === 'pass').length;
  const failed  = tests.filter(t => testResults[t.id]?.status === 'fail' || testResults[t.id]?.status === 'error').length;
  const running = runningTestIds.length;

  return (
    <div className="panel tests-panel">
      {/* ── Left list ─────────────────────────────────────────────────────── */}
      <div className="panel-list tests-list">
        <div className="tests-list-toolbar">
          <button className="btn btn-primary tests-btn-new" onClick={handleNew}>+ New</button>
          <button
            className="btn btn-secondary tests-btn-run-all"
            onClick={handleRunAll}
            disabled={tests.length === 0 || running > 0}
            title="Run all tests"
          >
            {running > 0 ? <><span className="spinner" /> Running…</> : '▶ Run all'}
          </button>
        </div>

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
        ) : tests.map(test => (
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
        ))}
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
  result: TestRunResult | undefined;
  isRunning: boolean;
  onChange: (t: TestCase) => void;
  onRun: () => void;
  onDelete: () => void;
}

function TestEditor({ test, servers, serverStatus, tools, result, isRunning, onChange, onRun, onDelete }: EditorProps) {
  const [argsJson, setArgsJson] = useState(() => JSON.stringify(test.args, null, 2));
  const [argsError, setArgsError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const serverTools = tools[test.serverId] ?? [];
  const isConnected = serverStatus[test.serverId] === 'connected';

  const set = <K extends keyof TestCase>(key: K, value: TestCase[K]) => onChange({ ...test, [key]: value });
  const setAssertion = <K extends keyof TestAssertion>(key: K, value: TestAssertion[K]) =>
    onChange({ ...test, assertion: { ...test.assertion, [key]: value } });

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

  const handleServerChange = (serverId: string) => {
    const firstTool = (tools[serverId] ?? [])[0]?.name ?? '';
    onChange({ ...test, serverId, toolName: firstTool });
  };

  const handleCaptureSnapshot = () => {
    if (!result?.actual) return;
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
            title={!isConnected ? 'Connect to the server first' : 'Run this test'}
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
              onChange={e => set('toolName', e.target.value)}
            >
              {serverTools.map(t => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          ) : (
            <input
              className="form-input"
              value={test.toolName}
              onChange={e => set('toolName', e.target.value)}
              placeholder="Tool name (connect server to browse)"
            />
          )}
        </div>
      </div>

      {/* ── Tool description ── */}
      {serverTools.find(t => t.name === test.toolName)?.description && (
        <p className="test-tool-desc">{serverTools.find(t => t.name === test.toolName)!.description}</p>
      )}

      {/* ── Arguments ── */}
      <div className="form-group">
        <label className="form-label">Arguments (JSON)</label>
        <textarea
          className={`form-textarea test-args-textarea${argsError ? ' input-error' : ''}`}
          value={argsJson}
          onChange={e => handleArgsChange(e.target.value)}
          rows={5}
          spellCheck={false}
        />
        {argsError && <div className="validation-error">{argsError}</div>}
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
              placeholder="e.g. content[0].text"
            />
            <div className="form-hint">Use dot notation: <code>content[0].text</code></div>
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
                {result.status !== 'pass' && result.actual !== undefined && (
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
