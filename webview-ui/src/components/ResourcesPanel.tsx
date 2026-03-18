import { useState } from 'react';
import { postMessage } from '../vscode';
import type { McpResource, RequestEntry, RequestInfo } from '../types';
import JsonViewer from './JsonViewer';

interface Props {
  serverId: string;
  resources: McpResource[];
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  onStartRequest: (id: string, info: RequestInfo) => void;
}

let reqCounter = 0;
function nextReqId() { return `res-${Date.now()}-${++reqCounter}`; }

export default function ResourcesPanel({ serverId, resources, requests, isConnected, onStartRequest }: Props) {
  const [selected, setSelected] = useState<McpResource | null>(null);
  const [lastReqId, setLastReqId] = useState<string | null>(null);

  const handleRead = () => {
    if (!selected) return;
    const reqId = nextReqId();
    setLastReqId(reqId);
    onStartRequest(reqId, { type: 'resource', name: selected.uri });
    postMessage({ type: 'readResource', serverId, uri: selected.uri, requestId: reqId });
  };

  const result = lastReqId ? requests[lastReqId] : undefined;

  return (
    <div className="panel">
      {/* List */}
      <div className="panel-list scroll-list">
        {resources.length === 0 ? (
          <div className="empty-state" style={{ height: 'auto', padding: '16px 12px' }}>
            <p>{isConnected ? 'No resources available.' : 'Connect to load resources.'}</p>
          </div>
        ) : resources.map(r => (
          <div
            key={r.uri}
            className={`list-item${selected?.uri === r.uri ? ' active' : ''}`}
            onClick={() => { setSelected(r); setLastReqId(null); }}
          >
            <div className="list-item-name">{r.name}</div>
            <div className="list-item-sub">{r.uri}</div>
            {r.mimeType && <div className="list-item-sub">{r.mimeType}</div>}
          </div>
        ))}
      </div>

      {/* Detail */}
      <div className="panel-detail">
        {selected ? (
          <>
            <div className="detail-title">{selected.name}</div>
            {selected.description && <div className="detail-desc">{selected.description}</div>}

            <div className="form-group">
              <label className="form-label">URI</label>
              <input className="form-input" readOnly value={selected.uri} />
            </div>
            {selected.mimeType && (
              <div className="form-group">
                <label className="form-label">MIME Type</label>
                <input className="form-input" readOnly value={selected.mimeType} />
              </div>
            )}

            <button
              className="btn btn-primary"
              disabled={!isConnected || result?.status === 'pending'}
              onClick={handleRead}
            >
              {result?.status === 'pending' ? <><span className="spinner" />Reading…</> : 'Read Resource'}
            </button>

            {result && result.status !== 'pending' && (
              <div className="result-area">
                <div className="result-header">
                  <span className={`result-label${result.isError ? ' error' : ' ok'}`}>
                    {result.isError ? '✗ Error' : '✓ Content'}
                  </span>
                </div>
                <JsonViewer data={result.data} isError={result.isError} />
              </div>
            )}
          </>
        ) : (
          <div className="empty-state">
            <p>Select a resource to read its content.</p>
          </div>
        )}
      </div>
    </div>
  );
}
