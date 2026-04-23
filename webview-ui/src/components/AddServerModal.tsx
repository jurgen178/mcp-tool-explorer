import { useState } from 'react';
import type { McpServerConfig } from '../types';

interface Props {
  onAdd: (config: McpServerConfig) => void;
  onClose: () => void;
  /** When set, the dialog operates in edit mode for this server. */
  editServerId?: string;
  initialConfig?: McpServerConfig;
}

type ServerType = 'stdio' | 'sse' | 'http';

function kvLines(obj: Record<string, string> | undefined): string {
  if (!obj) return '';
  return Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n');
}

export default function AddServerModal({ onAdd, onClose, editServerId, initialConfig }: Props) {
  const isEdit = editServerId !== undefined;
  const [name, setName]     = useState(initialConfig?.name ?? '');
  const [type, setType]     = useState<ServerType>((initialConfig?.type as ServerType) ?? 'stdio');
  const [command, setCmd]   = useState(initialConfig?.command ?? '');
  const [args, setArgs]     = useState((initialConfig?.args ?? []).join(' '));
  const [env, setEnv]       = useState(kvLines(initialConfig?.env));
  const [url, setUrl]       = useState(initialConfig?.url ?? '');
  const [headers, setHdr]   = useState(kvLines(initialConfig?.headers));
  const [error, setError]   = useState('');

  function parseKvLines(raw: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
    }
    return result;
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (!name.trim()) { setError('Name is required.'); return; }
    if (type === 'stdio' && !command.trim()) { setError('Command is required for stdio servers.'); return; }
    if (type === 'sse' || type === 'http') {
      if (!url.trim()) { setError('URL is required.'); return; }
      try {
        const parsed = new URL(url.trim());
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          setError('URL must start with http:// or https://');
          return;
        }
      } catch {
        setError('URL is not valid.');
        return;
      }
    }

    const config: Omit<McpServerConfig, 'id' | 'source'> = {
      name:    name.trim(),
      type,
      command: type === 'stdio' ? command.trim() : undefined,
      args:    type === 'stdio' ? args.split(/\s+/).filter(Boolean) : undefined,
      env:     type === 'stdio' ? parseKvLines(env) : undefined,
      url:     type !== 'stdio' ? url.trim() : undefined,
      headers: type !== 'stdio' ? parseKvLines(headers) : undefined,
    };

    onAdd({ ...config, id: editServerId ?? '', source: 'manual' } as McpServerConfig);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">{isEdit ? 'Edit MCP Server' : 'Add MCP Server'}</div>

        <form onSubmit={handleSubmit}>
          {/* Name + Type row */}
          <div className="modal-row" style={{ marginBottom: 12 }}>
            <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
              <label className="form-label">Name<span className="req">*</span></label>
              <input className="form-input" value={name} onChange={e => setName(e.target.value)} placeholder="my-server" autoFocus />
            </div>
            <div className="form-group" style={{ width: 110, marginBottom: 0 }}>
              <label className="form-label">Transport</label>
              <select className="form-select" value={type} onChange={e => setType(e.target.value as ServerType)}>
                <option value="stdio">stdio</option>
                <option value="http">HTTP (Streamable)</option>
                <option value="sse">SSE (legacy)</option>
              </select>
            </div>
          </div>

          {type === 'stdio' && (
            <>
              <div className="form-group">
                <label className="form-label">Command<span className="req">*</span></label>
                <input className="form-input" value={command} onChange={e => setCmd(e.target.value)} placeholder="node" />
              </div>
              <div className="form-group">
                <label className="form-label">Arguments</label>
                <input className="form-input" value={args} onChange={e => setArgs(e.target.value)} placeholder="server.js --port 3000" />
                <div className="form-hint">Space-separated argument list</div>
              </div>
              <div className="form-group">
                <label className="form-label">Environment Variables</label>
                <textarea className="form-textarea" value={env} onChange={e => setEnv(e.target.value)} placeholder={'KEY=value\nANOTHER_KEY=val'} rows={3} />
                <div className="form-hint">One KEY=value per line</div>
              </div>
            </>
          )}

          {(type === 'sse' || type === 'http') && (
            <>
              <div className="form-group">
                <label className="form-label">URL<span className="req">*</span></label>
                <input className="form-input" value={url} onChange={e => setUrl(e.target.value)}
                  placeholder={type === 'sse' ? 'http://localhost:3000/sse' : 'http://localhost:3000/mcp'} />
              </div>
              <div className="form-group">
                <label className="form-label">Request Headers</label>
                <textarea className="form-textarea" value={headers} onChange={e => setHdr(e.target.value)} placeholder={'Authorization=Bearer token\nX-Custom-Header=value'} rows={3} />
                <div className="form-hint">One KEY=value per line</div>
              </div>
            </>
          )}

          {error && <div className="error-message">{error}</div>}

          <div className="modal-actions">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary">{isEdit ? 'Save' : 'Add Server'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
