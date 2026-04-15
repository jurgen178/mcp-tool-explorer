import { useState } from 'react';
import type { HistoryEntry } from '../types';
import JsonViewer from './JsonViewer';
import ResultViewer from './ResultViewer';

interface Props {
  history: HistoryEntry[];
  onClear: () => void;
  onRerun: (toolName: string, args: unknown) => void;
}

function timeAgo(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5)    return 'just now';
  if (s < 60)   return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

const TYPE_ICON: Record<HistoryEntry['type'], string> = {
  tool:     '🔧',
  resource: '📄',
  prompt:   '💬',
};

export default function HistoryPanel({ history, onClear, onRerun }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (history.length === 0) {
    return (
      <div className="panel history-panel history-panel-empty">
        <div className="empty-state">
          <p>No requests yet.</p>
          <p>Run a tool, read a resource, or get a prompt to see history here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel history-panel">
      <div className="history-toolbar">
        <span className="section-title history-toolbar-title">
          {history.length} request{history.length !== 1 ? 's' : ''}
        </span>
        <button
          className="btn btn-secondary"
          id="history-clear-button"
          onClick={onClear}
        >
          Clear
        </button>
      </div>

      <div className="scroll-list history-list">
        {history.map(entry => {
          const expanded = expandedId === entry.id;
          const isResultError = entry.isError || entry.status === 'error';

          return (
            <div key={entry.id} className="history-item">
              <div
                className="history-item-header"
                onClick={() => setExpandedId(expanded ? null : entry.id)}
              >
                <span title={entry.type}>{TYPE_ICON[entry.type]}</span>
                <span className="history-name">{entry.name}</span>

                {/* status */}
                {entry.status === 'pending' && <span className="spinner history-spinner" />}
                {entry.status !== 'pending' && (
                  <span className={`history-status ${isResultError ? 'is-error' : 'is-ok'}`}>
                    {isResultError ? '✗' : '✓'}
                  </span>
                )}

                {/* duration */}
                {entry.durationMs !== undefined && (
                  <span className="history-duration">{entry.durationMs}ms</span>
                )}

                {/* time */}
                <span className="history-time">{timeAgo(entry.timestamp)}</span>

                {/* re-run (tools only) */}
                {entry.type === 'tool' && entry.status !== 'pending' && (
                  <button
                    className="icon-btn history-rerun-btn"
                    title="Re-run in Tools tab"
                    onClick={e => { e.stopPropagation(); onRerun(entry.name, entry.args); }}
                  >↩</button>
                )}

                <span className="history-chevron">
                  {expanded ? '▲' : '▼'}
                </span>
              </div>

              {expanded && (
                <div className="history-item-content">
                  {entry.args !== undefined && (
                    <div className="history-request-block">
                      <div className="section-title">Request</div>
                      <JsonViewer data={entry.args} />
                    </div>
                  )}
                  {entry.result !== undefined && (
                    <div className="history-response-block">
                      <div className={`section-title${isResultError ? ' history-response-title-error' : ''}`}>
                        {isResultError ? 'Error' : 'Response'}
                      </div>
                      <ResultViewer data={entry.result} isError={isResultError} />
                    </div>
                  )}
                  {entry.status === 'pending' && (
                    <p className="history-pending-text">
                      Waiting for response…
                    </p>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
