import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionLogEntry } from '../App';
import CopyButton from './CopyButton';

interface Props {
  logs: ConnectionLogEntry[];
  onClear: () => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

const LEVEL_COLORS: Record<string, string> = {
  info:  'var(--vscode-charts-blue, #3794ff)',
  warn:  'var(--vscode-charts-yellow, #e5c07b)',
  error: 'var(--vscode-charts-red, #f44747)',
};

export default function ConnectionLogPanel({ logs, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
  const [allCopied, setAllCopied] = useState(false);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs.length]);

  const toggleExpand = (idx: number) => {
    setExpandedIdx(prev => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };

  const handleCopyAll = useCallback(() => {
    const text = logs.map(l =>
      `[${formatTime(l.timestamp)}] [${l.level.toUpperCase()}] ${l.message}${l.detail ? '\n' + l.detail : ''}`
    ).join('\n\n');
    navigator.clipboard.writeText(text).then(() => {
      setAllCopied(true);
      setTimeout(() => setAllCopied(false), 1500);
    });
  }, [logs]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      {/* Toolbar */}
      <div className="history-toolbar">
        <span className="section-title" style={{ margin: 0 }}>Connection Log</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={handleCopyAll}
            title="Copy all logs to clipboard"
          >
            {allCopied ? '✓ Copied' : 'Copy'}
          </button>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={onClear}
            disabled={logs.length === 0}
          >
            Clear
          </button>
        </div>
      </div>

      {/* Log entries */}
      <div style={{ flex: 1, overflowY: 'auto', fontFamily: 'var(--vscode-editor-font-family, monospace)', fontSize: 'var(--vscode-editor-font-size, 12px)' }}>
        {logs.length === 0 ? (
          <div style={{ padding: '20px 14px', color: 'var(--vscode-descriptionForeground)', fontSize: 12 }}>
            No log entries yet. Connect to a server to see diagnostic details.
          </div>
        ) : (
          logs.map((entry, idx) => {
            const isExpanded = expandedIdx.has(idx);
            return (
              <div
                key={idx}
                style={{
                  borderBottom: '1px solid var(--vscode-widget-border, #2d2d2d)',
                  cursor: entry.detail ? 'pointer' : 'default',
                }}
                onClick={() => entry.detail && toggleExpand(idx)}
              >
                {/* Summary line */}
                <div style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 8,
                  padding: '4px 14px',
                }}>
                  <span style={{ color: 'var(--vscode-descriptionForeground)', flexShrink: 0, fontSize: 11 }}>
                    {formatTime(entry.timestamp)}
                  </span>
                  <span style={{
                    color: LEVEL_COLORS[entry.level],
                    fontWeight: 600,
                    flexShrink: 0,
                    width: 38,
                    fontSize: 11,
                    textTransform: 'uppercase',
                  }}>
                    {entry.level}
                  </span>
                  <span style={{
                    flex: 1,
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}>
                    {entry.message}
                  </span>
                  {entry.detail && (
                    <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
                      {isExpanded ? '▼' : '▶'}
                    </span>
                  )}
                </div>

                {/* Detail block (expanded) */}
                {isExpanded && entry.detail && (
                  <div className="json-viewer-wrap" style={{ margin: '0 14px 6px 70px' }}>
                    <CopyButton text={entry.detail} />
                    <pre style={{
                      padding: '6px 10px',
                      background: 'var(--vscode-textCodeBlock-background, #1e1e1e)',
                      border: '1px solid var(--vscode-widget-border, #333)',
                      borderRadius: 3,
                      fontSize: 11,
                      lineHeight: 1.5,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-all',
                      overflowX: 'auto',
                      maxHeight: 300,
                      overflowY: 'auto',
                      margin: 0,
                    }}>
                      {entry.detail}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
