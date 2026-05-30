import { useEffect, useMemo, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { usePanelResize } from '../hooks/usePanelResize';
import type { McpResource, RequestEntry, RequestInfo, CapabilityLoadState } from '../types';
import JsonViewer from './JsonViewer';
import CopyButton from './CopyButton';
import { extractTextValues } from '../resultInterpreters';

interface Props {
  serverId: string;
  resources: McpResource[];
  loadState: CapabilityLoadState;
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  onStartRequest: (id: string, info: RequestInfo) => void;
  onOpenServerLog: () => void;
}

let reqCounter = 0;
function nextReqId() { return `res-${Date.now()}-${++reqCounter}`; }

export default function ResourcesPanel({ serverId, resources, loadState, requests, isConnected, onStartRequest, onOpenServerLog }: Props) {
  const { listRef, handleRef } = usePanelResize({ storageKey: 'panel-list-width:resources' });
  const [selected, setSelected] = useState<McpResource | null>(null);
  const [search, setSearch] = useState('');
  const [lastReqId, setLastReqId] = useState<string | null>(null);
  const [activeResultTab, setActiveResultTab] = useState<'raw' | 'text'>('raw');
  const tabExplicitlySetRef = useRef(false);

  useEffect(() => {
    if (!selected) return;
    if (resources.some(resource => resource.uri === selected.uri)) return;

    setSelected(null);
    setLastReqId(null);
    setActiveResultTab('raw');
    tabExplicitlySetRef.current = false;
  }, [resources, selected]);

  const handleRead = () => {
    if (!selected) return;
    const reqId = nextReqId();
    setLastReqId(reqId);
    onStartRequest(reqId, { type: 'resource', name: selected.uri });
    postMessage({ type: 'readResource', serverId, uri: selected.uri, requestId: reqId });
  };

  const result = lastReqId ? requests[lastReqId] : undefined;
  const searchLower = search.toLowerCase();
  const filteredResources = search
    ? resources.filter(r => r.name.toLowerCase().includes(searchLower) || r.uri.toLowerCase().includes(searchLower))
    : resources;
  const textResults = useMemo(
    () => (result && result.status !== 'pending' ? extractTextValues(result.data) : []),
    [result],
  );

  useEffect(() => {
    if (result?.status === 'done' || result?.status === 'error') {
      if (!tabExplicitlySetRef.current) {
        setActiveResultTab(textResults.length > 0 ? 'text' : 'raw');
      }
    }
  }, [lastReqId, result?.status, textResults.length]);

  return (
    <div className="panel">
      {/* List */}
      <div className="panel-list" ref={listRef}>
        {resources.length >= 10 && (
          <div className="tool-search-bar">
            <input className="tool-search-input" type="search" placeholder="Filter resources…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        )}
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
            {loadState === 'error' && (
              <button className="btn btn-secondary empty-state-action" onClick={onOpenServerLog}>View log</button>
            )}
          </div>
        ) : filteredResources.length === 0 ? (
          <div className="empty-state empty-state-compact"><p>No resources match "{search}".</p></div>
        ) : filteredResources.map(r => (
          <div
            key={r.uri}
            className={`list-item${selected?.uri === r.uri ? ' active' : ''}`}
            onClick={() => { setSelected(r); setLastReqId(null); setActiveResultTab('raw'); tabExplicitlySetRef.current = false; }}
          >
            <div className="list-item-name">{r.name}</div>
            <div className="list-item-sub">{r.uri}</div>
            {r.mimeType && <div className="list-item-sub">{r.mimeType}</div>}
          </div>
        ))}
      </div>

      <div className="panel-resize-handle" ref={handleRef} />

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
                        onClick={() => { tabExplicitlySetRef.current = true; setActiveResultTab('raw'); }}
                      >Raw</button>
                      <button
                        className={`result-tab${activeResultTab === 'text' ? ' active' : ''}`}
                        onClick={() => { tabExplicitlySetRef.current = true; setActiveResultTab('text'); }}
                      >Text</button>
                    </div>
                  )}
                </div>
                {activeResultTab === 'text' && textResults.length > 0 ? (
                  <div className="text-result-list">
                    {textResults.map((text, index) => (
                      <div key={index} className="text-result-wrapper">
                        <pre className="text-result">{text}</pre>
                        <CopyButton text={text} />
                      </div>
                    ))}
                  </div>
                ) : (
                  <JsonViewer data={result.data} isError={result.isError} />
                )}
              </div>
            )}
          </>
        ) : resources.length > 0 ? (
          <div className="empty-state">
            <p>Select a resource to read its content.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
