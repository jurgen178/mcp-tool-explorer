import { useEffect, useMemo, useRef, useState } from 'react';
import { postMessage } from '../vscode';
import { usePanelResize } from '../hooks/usePanelResize';
import type { McpPrompt, RequestEntry, RequestInfo, CapabilityLoadState, MessageToWebview } from '../types';
import JsonViewer from './JsonViewer';
import CopyButton from './CopyButton';
import { extractTextValues } from '../resultInterpreters';

interface Props {
  serverId: string;
  prompts: McpPrompt[];
  loadState: CapabilityLoadState;
  requests: Record<string, RequestEntry>;
  isConnected: boolean;
  onStartRequest: (id: string, info: RequestInfo) => void;
  onOpenServerLog: () => void;
}

let reqCounter = 0;
function nextReqId() { return `prompt-${Date.now()}-${++reqCounter}`; }
let completionReqCounter = 0;
function nextCompletionReqId() { return `prompt-complete-${Date.now()}-${++completionReqCounter}`; }
function promptArgFieldId(name: string) {
  return `prompt-arg-${name.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function normalizePromptArgs(argValues: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(argValues).filter(([, value]) => value.trim() !== ''),
  );
}

function getVisibleCompletionValues(values: string[] | undefined, currentValue: string): string[] {
  if (!values || values.length === 0) {
    return [];
  }

  return values.filter(value => value !== currentValue);
}

export default function PromptsPanel({ serverId, prompts, loadState, requests, isConnected, onStartRequest, onOpenServerLog }: Props) {
  const { listRef, handleRef } = usePanelResize({ storageKey: 'panel-list-width:prompts' });
  const [selected, setSelected] = useState<McpPrompt | null>(null);
  const [search, setSearch] = useState('');
  const [argValues, setArgValues] = useState<Record<string, string>>({});
  const [lastReqId, setLastReqId] = useState<string | null>(null);
  const [activeResultTab, setActiveResultTab] = useState<'raw' | 'text'>('raw');
  const [completionValues, setCompletionValues] = useState<Record<string, string[]>>({});
  const latestCompletionReqByArg = useRef<Record<string, string>>({});
  const completionTimeouts = useRef<Record<string, number>>({});

  useEffect(() => {
    const handler = (event: MessageEvent<MessageToWebview>) => {
      const msg = event.data;
      if (msg.type !== 'promptArgumentCompletion') return;

      const latestRequestId = latestCompletionReqByArg.current[msg.argumentName];
      if (!latestRequestId || latestRequestId !== msg.requestId) return;

      setCompletionValues(prev => ({ ...prev, [msg.argumentName]: msg.values }));
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, []);

  useEffect(() => () => {
    Object.values(completionTimeouts.current).forEach(timeoutId => window.clearTimeout(timeoutId));
  }, []);

  const resetCompletions = () => {
    Object.values(completionTimeouts.current).forEach(timeoutId => window.clearTimeout(timeoutId));
    completionTimeouts.current = {};
    latestCompletionReqByArg.current = {};
    setCompletionValues({});
  };

  const clearCompletionForArgument = (argumentName: string) => {
    const pendingTimeoutId = completionTimeouts.current[argumentName];
    if (pendingTimeoutId !== undefined) {
      window.clearTimeout(pendingTimeoutId);
      delete completionTimeouts.current[argumentName];
    }

    delete latestCompletionReqByArg.current[argumentName];
    setCompletionValues(prev => ({ ...prev, [argumentName]: [] }));
  };

  const requestCompletion = (promptName: string, argumentName: string, value: string, nextArgValues: Record<string, string>, delay = 180) => {
    if (!isConnected || loadState !== 'loaded') {
      clearCompletionForArgument(argumentName);
      return;
    }

    const pendingTimeoutId = completionTimeouts.current[argumentName];
    if (pendingTimeoutId !== undefined) {
      window.clearTimeout(pendingTimeoutId);
    }

    completionTimeouts.current[argumentName] = window.setTimeout(() => {
      const requestId = nextCompletionReqId();
      latestCompletionReqByArg.current[argumentName] = requestId;

      const contextArgs = normalizePromptArgs(nextArgValues);
      delete contextArgs[argumentName];

      postMessage({
        type: 'completePromptArgument',
        serverId,
        promptName,
        argumentName,
        value,
        contextArgs,
        requestId,
      });
    }, delay);
  };

  useEffect(() => {
    if (!selected) return;
    if (prompts.some(prompt => prompt.name === selected.name)) return;

    setSelected(null);
    setArgValues({});
    setLastReqId(null);
    setActiveResultTab('raw');
    resetCompletions();
  }, [prompts, selected]);

  const handleSelect = (prompt: McpPrompt) => {
    setSelected(prompt);
    setArgValues({});
    setLastReqId(null);
    setActiveResultTab('raw');
    resetCompletions();
    // Pre-fetch completions for all arguments immediately (0ms delay) so the
    // dropdown indicator is already visible when the user focuses a field.
    if (isConnected && loadState === 'loaded') {
      for (const arg of prompt.arguments ?? []) {
        requestCompletion(prompt.name, arg.name, '', {}, 0);
      }
    }
  };

  const handleGet = () => {
    if (!selected) return;
    const args = normalizePromptArgs(argValues);
    const reqId = nextReqId();
    setLastReqId(reqId);
    onStartRequest(reqId, { type: 'prompt', name: selected.name, args });
    postMessage({
      type: 'getPrompt',
      serverId,
      promptName: selected.name,
      args,
      requestId: reqId,
    });
  };

  const result = lastReqId ? requests[lastReqId] : undefined;
  const searchLower = search.toLowerCase();
  const filteredPrompts = search
    ? prompts.filter(p => p.name.toLowerCase().includes(searchLower) || p.description?.toLowerCase().includes(searchLower))
    : prompts;
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
      <div className="panel-list" ref={listRef}>
        {prompts.length >= 10 && (
          <div className="tool-search-bar">
            <input className="tool-search-input" type="search" placeholder="Filter prompts…"
              value={search} onChange={e => setSearch(e.target.value)} />
          </div>
        )}
        {prompts.length === 0 ? (
          <div className="empty-state empty-state-compact">
            <p>
              {loadState === 'loading'
                ? 'Loading prompts…'
                : loadState === 'error'
                  ? 'Failed to load prompts.'
                  : isConnected
                    ? 'No prompts available.'
                    : 'Connect to load prompts.'}
            </p>
            {loadState === 'error' && (
              <button className="btn btn-secondary empty-state-action" onClick={onOpenServerLog}>View log</button>
            )}
          </div>
        ) : filteredPrompts.length === 0 ? (
          <div className="empty-state empty-state-compact"><p>No prompts match "{search}".</p></div>
        ) : filteredPrompts.map(p => (
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

      <div className="panel-resize-handle" ref={handleRef} />

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
                    {(() => {
                      const currentValue = argValues[arg.name] ?? '';
                      const visibleCompletionValues = getVisibleCompletionValues(completionValues[arg.name], currentValue);

                      return (
                        <>
                    <label className="form-label" htmlFor={promptArgFieldId(arg.name)}>
                      {arg.name}
                      {arg.required && <span className="req">*</span>}
                    </label>
                    <input
                      id={promptArgFieldId(arg.name)}
                      className="form-input"
                      list={visibleCompletionValues.length ? `${promptArgFieldId(arg.name)}-list` : undefined}
                      value={currentValue}
                      onChange={e => {
                        const nextValue = e.target.value;
                        let nextState: Record<string, string>;

                        if (nextValue !== '') {
                          nextState = { ...argValues, [arg.name]: nextValue };
                        } else {
                          const { [arg.name]: _removed, ...rest } = argValues;
                          nextState = rest;
                        }

                        setArgValues(nextState);
                        requestCompletion(selected.name, arg.name, nextValue, nextState);
                      }}
                      onFocus={() => {
                        // Only request if no pending timeout and no values yet —
                        // avoids cancelling an in-progress prefetch.
                        if (currentValue.trim() === '' && visibleCompletionValues.length === 0
                            && completionTimeouts.current[arg.name] === undefined) {
                          requestCompletion(selected.name, arg.name, '', argValues);
                        }
                      }}
                      placeholder={arg.description ?? ''}
                      title={arg.name}
                    />
                    {visibleCompletionValues.length ? (
                      <datalist id={`${promptArgFieldId(arg.name)}-list`}>
                        {visibleCompletionValues.map(value => (
                          <option key={value} value={value} />
                        ))}
                      </datalist>
                    ) : null}
                    {arg.description && <div className="form-hint">{arg.description}</div>}
                        </>
                      );
                    })()}
                  </div>
                ))}
              </>
            )}

            {(!selected.arguments || selected.arguments.length === 0) && (
              <p className="form-note">
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
        ) : prompts.length > 0 ? (
          <div className="empty-state">
            <p>Select a prompt to fill its arguments and retrieve the messages.</p>
          </div>
        ) : null}
      </div>
    </div>
  );
}
