import { useState } from 'react';
import type { McpEventEntry } from '../types';
import JsonViewer from './JsonViewer';

interface Props {
  events: McpEventEntry[];
  onClear: () => void;
}

const LEVEL_CLASS: Record<McpEventEntry['level'], string> = {
  debug: 'events-level-debug',
  info: 'events-level-info',
  notice: 'events-level-notice',
  warning: 'events-level-warning',
  error: 'events-level-error',
  critical: 'events-level-error',
  alert: 'events-level-error',
  emergency: 'events-level-error',
};

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

export default function EventsPanel({ events, onClear }: Props) {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  if (events.length === 0) {
    return (
      <div className="panel info-panel">
        <div className="empty-state">
          <p>No MCP events yet.</p>
          <p>Connect to a server and wait for log, progress, or list-change notifications.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel info-panel">
      <div className="info-panel-main">
        <div className="history-toolbar">
          <span className="section-title history-toolbar-title">
            {events.length} event{events.length !== 1 ? 's' : ''}
          </span>
          <button className="btn btn-secondary" onClick={onClear}>Clear</button>
        </div>

        <div className="scroll-list events-list">
          {events.map(event => {
            const expanded = expandedId === event.id;
            return (
              <div key={event.id} className="history-item">
                <div className="history-item-header" onClick={() => setExpandedId(expanded ? null : event.id)}>
                  <span className={`events-level-pill ${LEVEL_CLASS[event.level]}`}>{event.level}</span>
                  <span className="history-name">{event.title}</span>
                  <span className="history-duration">{event.method}</span>
                  <span className="history-time">{timeAgo(event.timestamp)}</span>
                  <span className="history-chevron">{expanded ? '▲' : '▼'}</span>
                </div>

                {expanded && (
                  <div className="history-item-content">
                    {event.logger && (
                      <div className="info-summary-grid info-summary-grid-compact">
                        <div className="info-summary-card">
                          <span className="info-summary-label">Logger</span>
                          <span className="info-summary-value">{event.logger}</span>
                        </div>
                      </div>
                    )}
                    {event.data !== undefined && (
                      <div>
                        <div className="section-title">Payload</div>
                        <JsonViewer data={event.data} />
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}