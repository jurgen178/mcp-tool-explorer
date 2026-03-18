import { useState } from 'react';
import { postMessage } from '../vscode';
import type { McpPrompt, RequestEntry, RequestInfo } from '../types';
import JsonViewer from './JsonViewer';

interface Props {
  serverId: string;
  prompts: McpPrompt[];
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  onStartRequest: (id: string, info: RequestInfo) => void;
}

let reqCounter = 0;
function nextReqId() { return `prompt-${Date.now()}-${++reqCounter}`; }

export default function PromptsPanel({ serverId, prompts, requests, isConnected, onStartRequest }: Props) {
  const [selected, setSelected] = useState<McpPrompt | null>(null);
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [lastReqId, setLastReqId] = useState<string | null>(null);

  const handleSelect = (prompt: McpPrompt) => {
    setSelected(prompt);
    setArgValues({});
    setLastReqId(null);
  };

  const handleGet = () => {
    if (!selected) return;
    const reqId = nextReqId();
    setLastReqId(reqId);
    onStartRequest(reqId, { type: 'prompt', name: selected.name, args: argValues });
    postMessage({
      type: 'getPrompt',
      serverId,
      promptName: selected.name,
      args: argValues,
      requestId: reqId,
    });
  };

  const result = lastReqId ? requests[lastReqId] : undefined;

  return (
    <div className="panel">
      {/* List */}
      <div className="panel-list scroll-list">
        {prompts.length === 0 ? (
          <div className="empty-state" style={{ height: 'auto', padding: '16px 12px' }}>
            <p>{isConnected ? 'No prompts available.' : 'Connect to load prompts.'}</p>
          </div>
        ) : prompts.map(p => (
          <div
            key={p.name}
            className={`list-item${selected?.name === p.name ? ' active' : ''}`}
            onClick={() => handleSelect(p)}
          >
            <div className="list-item-name">{p.name}</div>
            {p.description && <div className="list-item-sub">{p.description}</div>}
          </div>
        ))}
      </div>

      {/* Detail */}
      <div className="panel-detail">
        {selected ? (
          <>
            <div className="detail-title">{selected.name}</div>
            {selected.description && <div className="detail-desc">{selected.description}</div>}

            {selected.arguments && selected.arguments.length > 0 && (
              <>
                <div className="section-title">Arguments</div>
                {selected.arguments.map(arg => (
                  <div key={arg.name} className="form-group">
                    <label className="form-label">
                      {arg.name}
                      {arg.required && <span className="req">*</span>}
                    </label>
                    <input
                      className="form-input"
                      value={argValues[arg.name] ?? ''}
                      onChange={e => setArgValues(prev => ({ ...prev, [arg.name]: e.target.value }))}
                      placeholder={arg.description ?? ''}
                    />
                    {arg.description && <div className="form-hint">{arg.description}</div>}
                  </div>
                ))}
              </>
            )}

            {(!selected.arguments || selected.arguments.length === 0) && (
              <p style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)', marginBottom: 12 }}>
                No arguments required.
              </p>
            )}

            <button
              className="btn btn-primary"
              disabled={!isConnected || result?.status === 'pending'}
              onClick={handleGet}
            >
              {result?.status === 'pending' ? <><span className="spinner" />Loading…</> : 'Get Prompt'}
            </button>

            {result && result.status !== 'pending' && (
              <div className="result-area">
                <div className="result-header">
                  <span className={`result-label${result.isError ? ' error' : ' ok'}`}>
                    {result.isError ? '✗ Error' : '✓ Messages'}
                  </span>
                </div>
                <JsonViewer data={result.data} isError={result.isError} />
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <p>Select a prompt to fill its arguments and retrieve the messages.</p>
          </div>
        )}
      </div>
    </div>
  );
}
