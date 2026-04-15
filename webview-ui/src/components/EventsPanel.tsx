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

const EVENT_GROUP_WINDOW_MS = 450;

function timeAgo(ts: number): string {
  const seconds = Math.floor((Date.now() - ts) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function belongsToSameGroup(left: McpEventEntry | undefined, right: McpEventEntry | undefined): boolean {
  if (!left || !right || !left.groupKey || !right.groupKey) {
    return false;
  }

  return left.groupKey === right.groupKey && Math.abs(left.timestamp - right.timestamp) <= EVENT_GROUP_WINDOW_MS;
}

export default function EventsPanel({ events, onClear }: Props) {
  if (events.length === 0) {
    return (
      <div className="panel info-panel">
        <div className="empty-state">
          <p>No MCP events yet.</p>
          <p>Connect to a server and wait for log, progress, resource-updated, or list-change notifications.</p>
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
          {events.map((event, index) => {
            const previousEvent = events[index - 1];
            const nextEvent = events[index + 1];
            const groupedWithPrevious = belongsToSameGroup(previousEvent, event);
            const groupedWithNext = belongsToSameGroup(event, nextEvent);

            const groupClassName = groupedWithPrevious
              ? groupedWithNext
                ? 'events-item-group-middle'
                : 'events-item-group-end'
              : groupedWithNext
                ? 'events-item-group-start'
                : 'events-item-group-single';

            return (
              <div key={event.id} className={`events-item ${groupClassName}`}>
                <div className="events-item-header">
                  <span className={`events-level-pill ${LEVEL_CLASS[event.level]}`}>{event.level}</span>
                  <span className="events-item-title">{event.title}</span>
                  <span className="events-item-method">{event.method}</span>
                  <span className="events-item-time">{timeAgo(event.timestamp)}</span>
                </div>

                <div className="events-item-content">
                  {event.logger && <div className="events-item-meta">Logger: {event.logger}</div>}
                  {event.data !== undefined && (
                    <div className="events-item-payload">
                      <div className="section-title events-item-section-title">Payload</div>
                      <JsonViewer data={event.data} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}