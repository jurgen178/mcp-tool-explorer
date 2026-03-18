import { useState } from 'react';
import type { McpServerConfig } from '../types';

interface Props {
  onAdd: (config: McpServerConfig) => void;
  onClose: () => void;
}

type ServerType = 'stdio' | 'sse' | 'http';

export default function AddServerModal({ onAdd, onClose }: Props) {
  const [name, setName]     = useState('');
  const [type, setType]     = useState<ServerType>('stdio'); // user picks: stdio / sse / http
  const [command, setCmd]   = useState('');
  const [args, setArgs]     = useState('');
  const [env, setEnv]       = useState('');
  const [url, setUrl]       = useState('');
  const [headers, setHdr]   = useState('');
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
    if ((type === 'sse' || type === 'http') && !url.trim()) { setError('URL is required.'); return; }

    const config: Omit<McpServerConfig, 'id' | 'source'> = {
      name:    name.trim(),
      type,
      command: type === 'stdio' ? command.trim() : undefined,
      args:    type === 'stdio' ? args.split(/\s+/).filter(Boolean) : undefined,
      env:     type === 'stdio' ? parseKvLines(env) : undefined,
      url:     type !== 'stdio' ? url.trim() : undefined,
      headers: type !== 'stdio' ? parseKvLines(headers) : undefined,
    };

    onAdd(config as McpServerConfig);
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={e => e.stopPropagation()}>
        <div className="modal-title">Add MCP Server</div>

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
            <button type="submit" className="btn btn-primary">Add Server</button>
          </div>
        </form>
      </div>
    </div>
  );
}
