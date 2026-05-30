import { useState } from 'react';
import type { AuthAccountSelection, McpServerConfig } from '../types';

interface Props {
  server: McpServerConfig;
  value: AuthAccountSelection;
  isConnected: boolean;
  onSave: (value: AuthAccountSelection) => void;
  onClose: () => void;
}

const OPTIONS: Array<{ value: AuthAccountSelection; label: string; description: string }> = [
  {
    value: 'auto',
    label: 'Automatic',
    description: 'Use the current VS Code account silently when possible.',
  },
  {
    value: 'prompt',
    label: 'Choose account',
    description: 'Ask which account to use when OAuth is required.',
  },
  {
    value: 'disabled',
    label: 'Disabled',
    description: 'Do not perform the automatic OAuth retry after HTTP 401.',
  },
];

export default function AuthOverrideModal({ server, value, isConnected, onSave, onClose }: Props) {
  const [selection, setSelection] = useState<AuthAccountSelection>(value);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={event => event.stopPropagation()}>
        <div className="modal-title">Authentication</div>
        <div className="auth-server-name">{server.name}</div>
        <div className="form-note">This only affects MCP Tool Explorer. It does not modify MCP configuration files.</div>

        <div className="auth-options" role="radiogroup" aria-label="Authentication override">
          {OPTIONS.map(option => (
            <label key={option.value} className="auth-option">
              <input
                type="radio"
                name="auth-account-selection"
                value={option.value}
                checked={selection === option.value}
                onChange={() => setSelection(option.value)}
              />
              <span className="auth-option-text">
                <span className="auth-option-label">{option.label}</span>
                <span className="auth-option-description">{option.description}</span>
              </span>
            </label>
          ))}
        </div>

        {isConnected && (
          <div className="form-note auth-reconnect-note">Reconnect this server to apply the change.</div>
        )}

        <div className="modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onSave(selection)}>Save</button>
        </div>
      </div>
    </div>
  );
}