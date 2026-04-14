import { useEffect, useMemo, useState } from 'react';
import { postMessage } from '../vscode';
import type { McpResource, RequestEntry, RequestInfo, CapabilityLoadState } from '../types';
import JsonViewer from './JsonViewer';
import { extractTextValues } from '../resultInterpreters';

interface Props {
  serverId: string;
  resources: McpResource[];
  loadState: CapabilityLoadState;
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  onStartRequest: (id: string, info: RequestInfo) => void;
}

let reqCounter = 0;
function nextReqId() { return `res-${Date.now()}-${++reqCounter}`; }

export default function ResourcesPanel({ serverId, resources, loadState, requests, isConnected, onStartRequest }: Props) {
  const [selected, setSelected] = useState<McpResource | null>(null);
  const [lastReqId, setLastReqId] = useState<string | null>(null);
  const [activeResultTab, setActiveResultTab] = useState<'raw' | 'text'>('raw');

  useEffect(() => {
    if (!selected) return;
    if (resources.some(resource => resource.uri === selected.uri)) return;

    setSelected(null);
    setLastReqId(null);
    setActiveResultTab('raw');
  }, [resources, selected]);

  const handleRead = () => {
    if (!selected) return;
    const reqId = nextReqId();
    setLastReqId(reqId);
    onStartRequest(reqId, { type: 'resource', name: selected.uri });
    postMessage({ type: 'readResource', serverId, uri: selected.uri, requestId: reqId });
  };

  const result = lastReqId ? requests[lastReqId] : undefined;
  const textResults = useMemo(
    () => (result && result.status !== 'pending' ? extractTextValues(result.data) : []),
    [result],
  );

  useEffect(() => {
    if (result?.status === 'done' || result?.status === 'error') {
      setActiveResultTab(textResults.length > 0 ? 'text' : 'raw');
    }
  }, [lastReqId, result?.status, textResults.length]);

  return (
    <div className="panel">
      {/* List */}
      <div className="panel-list scroll-list">
        {resources.length === 0 ? (
          <div className="empty-state empty-state-compact">
            <p>
              {loadState === 'loading'
                ? 'Loading resources…'
                : loadState === 'error'
                  ? 'Failed to load resources.'
                  : isConnected
                    ? 'No resources available.'
                    : 'Connect to load resources.'}
            </p>
          </div>
        ) : resources.map(r => (
          <div
            key={r.uri}
            className={`list-item${selected?.uri === r.uri ? ' active' : ''}`}
            onClick={() => { setSelected(r); setLastReqId(null); setActiveResultTab('raw'); }}
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
              <label className="form-label" htmlFor="resource-uri">URI</label>
              <input id="resource-uri" className="form-input form-input-readonly" readOnly value={selected.uri} title="Resource URI" />
            </div>
            {selected.mimeType && (
              <div className="form-group">
                <label className="form-label" htmlFor="resource-mime-type">MIME Type</label>
                <input id="resource-mime-type" className="form-input form-input-readonly" readOnly value={selected.mimeType} title="Resource MIME type" />
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
                  {textResults.length > 0 && (
                    <div className="result-tabs">
                      <button
                        className={`result-tab${activeResultTab === 'raw' ? ' active' : ''}`}
                        onClick={() => setActiveResultTab('raw')}
                      >Raw</button>
                      <button
                        className={`result-tab${activeResultTab === 'text' ? ' active' : ''}`}
                        onClick={() => setActiveResultTab('text')}
                      >Text</button>
                    </div>
                  )}
                </div>
                {activeResultTab === 'text' && textResults.length > 0 ? (
                  <div className="text-result-list">
                    {textResults.map((text, index) => (
                      <pre key={index} className="text-result">{text}</pre>
                    ))}
                  </div>
                ) : (
                  <JsonViewer data={result.data} isError={result.isError} />
                )}
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
