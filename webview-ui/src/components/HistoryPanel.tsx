import { useState } from 'react';
import type { HistoryEntry } from '../types';
import JsonViewer from './JsonViewer';

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
      <div className="panel" style={{ flexDirection: 'column' }}>
        <div className="empty-state">
          <p>No requests yet.</p>
          <p>Run a tool, read a resource, or get a prompt to see history here.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ flexDirection: 'column', overflow: 'hidden' }}>
      <div className="history-toolbar">
        <span className="section-title" style={{ margin: 0 }}>
          {history.length} request{history.length !== 1 ? 's' : ''}
        </span>
        <button
          className="btn btn-secondary"
          style={{ fontSize: 11, padding: '2px 10px' }}
          onClick={onClear}
        >
          Clear
        </button>
      </div>

      <div className="scroll-list" style={{ flex: 1, overflowY: 'auto' }}>
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
                {entry.status === 'pending' && <span className="spinner" style={{ flexShrink: 0 }} />}
                {entry.status !== 'pending' && (
                  <span style={{ flexShrink: 0, fontWeight: 700, fontSize: 11, color: isResultError ? 'var(--vscode-charts-red, #f44747)' : 'var(--vscode-charts-green, #4ec9b0)' }}>
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
                    className="icon-btn"
                    style={{ fontSize: 11, flexShrink: 0 }}
                    title="Re-run in Tools tab"
                    onClick={e => { e.stopPropagation(); onRerun(entry.name, entry.args); }}
                  >↩</button>
                )}

                <span style={{ fontSize: 9, color: 'var(--vscode-descriptionForeground)', flexShrink: 0 }}>
                  {expanded ? '▲' : '▼'}
                </span>
              </div>

              {expanded && (
                <div className="history-item-body">
                  {entry.args !== undefined && (
                    <div style={{ marginBottom: 10 }}>
                      <div className="section-title">Request</div>
                      <JsonViewer data={entry.args} />
                    </div>
                  )}
                  {entry.result !== undefined && (
                    <div>
                      <div className="section-title" style={{ color: isResultError ? 'var(--vscode-charts-red, #f44747)' : undefined }}>
                        {isResultError ? 'Error' : 'Response'}
                      </div>
                      <JsonViewer data={entry.result} isError={isResultError} />
                    </div>
                  )}
                  {entry.status === 'pending' && (
                    <p style={{ fontSize: 12, color: 'var(--vscode-descriptionForeground)' }}>
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
