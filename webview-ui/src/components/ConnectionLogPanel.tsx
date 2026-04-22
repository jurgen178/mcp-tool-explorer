import { useCallback, useEffect, useRef, useState } from 'react';
import type { ConnectionLogEntry, LogSection } from '../App';
import CopyButton from './CopyButton';
import JsonViewer from './JsonViewer';

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

const SECTION_LABELS: Record<string, string> = {
  'request':          'Request',
  'response':         'Response',
  'request-headers':  'Request Headers',
  'response-headers': 'Response Headers',
  'error':            'Error',
  'text':             'Info',
};

const SECTION_LABEL_COLORS: Record<string, string> = {
  'request':          'var(--vscode-charts-blue, #3794ff)',
  'response':         'var(--vscode-charts-green, #89d185)',
  'request-headers':  'var(--vscode-symbolIcon-variableForeground, #75beff)',
  'response-headers': 'var(--vscode-symbolIcon-variableForeground, #75beff)',
  'error':            'var(--vscode-charts-red, #f44747)',
  'text':             'var(--vscode-descriptionForeground)',
};

// ── Section renderer ───────────────────────────────────────────────────────

const PRE_STYLE: React.CSSProperties = {
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
};

function DetailSections({ sections }: { sections: LogSection[] }) {
  const isJson = (kind: string) => kind === 'request' || kind === 'response';
  return (
    <div>
      {sections.map((section, i) => {
        let parsed: unknown = undefined;
        if (isJson(section.kind)) {
          // Request and response bodies can be explored with the smart JSON
          // viewer when they are valid JSON. Headers and text stay plain.
          try { parsed = JSON.parse(section.content); } catch { /* plain text fallback */ }
        }
        return (
          <div key={i} style={{ marginTop: i > 0 ? 8 : 0 }}>
            <div style={{
              fontSize: 10,
              fontWeight: 700,
              color: SECTION_LABEL_COLORS[section.kind],
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginBottom: 3,
            }}>
              {SECTION_LABELS[section.kind] ?? section.kind}
            </div>
            <div className={isJson(section.kind) ? 'log-json-wrap' : undefined}>
              {parsed !== undefined
                ? <JsonViewer data={parsed} />
                : <pre style={PRE_STYLE}>{section.content}</pre>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function serializeDetail(detail: string | LogSection[] | undefined): string {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  // Copying the log should keep the labeled section order from the UI.
  return detail.map(s => `[${SECTION_LABELS[s.kind] ?? s.kind}]\n${s.content}`).join('\n\n');
}

// ── Main component ─────────────────────────────────────────────────────────

export default function ConnectionLogPanel({ logs, onClear }: Props) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const [expandedIdx, setExpandedIdx] = useState<Set<number>>(new Set());
  const [allCopied, setAllCopied] = useState(false);

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
      `[${formatTime(l.timestamp)}] [${l.level.toUpperCase()}] ${l.message}${l.detail ? '\n' + serializeDetail(l.detail) : ''}`
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
            const hasDetail = !!entry.detail && (typeof entry.detail === 'string' ? entry.detail.length > 0 : entry.detail.length > 0);
            // Render RPC badge inline: "HTTP POST /mcp (tools/list)  →  200 OK"
            // → "HTTP POST /mcp [tools/list] → 200 OK"
            const rpcMatch = entry.message.match(/^(.*?)\s*\(([^)]+)\)\s*(→.*)$/);
            const messageParts = rpcMatch
              ? { before: rpcMatch[1], badge: rpcMatch[2], after: rpcMatch[3] }
              : null;
            return (
              <div
                key={idx}
                style={{
                  borderBottom: '1px solid var(--vscode-widget-border, #2d2d2d)',
                }}
              >
                {/* Summary line */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    padding: '4px 14px',
                    cursor: hasDetail ? 'pointer' : 'default',
                  }}
                  onClick={() => hasDetail && toggleExpand(idx)}
                >
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
                  <span style={{ flex: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontSize: 11 }}>
                    {messageParts ? (
                      <>
                        {messageParts.before}{' '}
                        <span style={{
                          fontSize: 10,
                          fontWeight: 600,
                          color: 'var(--vscode-badge-foreground, #fff)',
                          background: 'var(--vscode-badge-background, #4d4d4d)',
                          borderRadius: 3,
                          padding: '1px 5px',
                          verticalAlign: 'middle',
                        }}>
                          {messageParts.badge}
                        </span>
                        {' '}{messageParts.after}
                      </>
                    ) : entry.message}
                  </span>
                  {hasDetail && (
                    <span style={{ flexShrink: 0, fontSize: 10, color: 'var(--vscode-descriptionForeground)' }}>
                      {isExpanded ? '▼' : '▶'}
                    </span>
                  )}
                </div>

                {/* Detail block (expanded) */}
                {isExpanded && hasDetail && (
                  <div className="json-viewer-wrap" style={{ margin: '0 14px 8px 70px' }}>
                    <CopyButton text={serializeDetail(entry.detail)} />
                    {typeof entry.detail === 'string'
                      ? <pre style={PRE_STYLE}>{entry.detail}</pre>
                      : <DetailSections sections={entry.detail ?? []} />
                    }
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

