import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ConnectionCredentials, ConnectionRequest, ConnectionStatus } from './types.js';

/**
 * The connection dialog.
 *
 * Credentials live in this component's local state for exactly as long as it
 * takes to submit them, and are handed straight to the connection subsystem.
 * They never reach the world model, the history graph, or any log line.
 */

export interface ConnectionDialogProps {
  readonly status: ConnectionStatus;
  readonly error?: string | null;
  readonly defaultUrl?: string;
  readonly defaultUsername?: string;
  readonly onConnect: (request: ConnectionRequest) => void;
  readonly onDisconnect: () => void;
}

type AuthMode = 'password' | 'token';

export const ConnectionDialog = ({
  status,
  error = null,
  defaultUrl = 'wss://localhost:8563',
  defaultUsername = 'sys',
  onConnect,
  onDisconnect,
}: ConnectionDialogProps): React.JSX.Element => {
  const [url, setUrl] = useState(defaultUrl);
  const [mode, setMode] = useState<AuthMode>('password');
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');

  const busy = status === 'connecting';
  const connected = status === 'connected';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy || connected) return;
    const credentials: ConnectionCredentials =
      mode === 'password' ? { kind: 'password', username, password } : { kind: 'token', token };
    onConnect({ url, credentials });
    // Clear the secret as soon as it has been handed over.
    setPassword('');
    setToken('');
  };

  return (
    <form className="pn-panel pn-connection" onSubmit={submit}>
      <h2 className="pn-panel__title">Connection</h2>

      <label className="pn-field">
        <span>Database URL</span>
        <input
          type="text"
          value={url}
          spellCheck={false}
          disabled={connected}
          onChange={(event) => setUrl(event.target.value)}
        />
      </label>

      <div className="pn-field pn-field--row" role="radiogroup" aria-label="Authentication">
        <label>
          <input
            type="radio"
            name="auth-mode"
            value="password"
            checked={mode === 'password'}
            disabled={connected}
            onChange={() => setMode('password')}
          />
          User &amp; password
        </label>
        <label>
          <input
            type="radio"
            name="auth-mode"
            value="token"
            checked={mode === 'token'}
            disabled={connected}
            onChange={() => setMode('token')}
          />
          Access token
        </label>
      </div>

      {mode === 'password' ? (
        <>
          <label className="pn-field">
            <span>User</span>
            <input
              type="text"
              value={username}
              autoComplete="username"
              disabled={connected}
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="pn-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
              disabled={connected}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
        </>
      ) : (
        <label className="pn-field">
          <span>Personal access token</span>
          <input
            type="password"
            value={token}
            autoComplete="off"
            disabled={connected}
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
      )}

      {error !== null && error !== '' ? (
        <p className="pn-error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="pn-field pn-field--row">
        {connected ? (
          <button type="button" onClick={onDisconnect}>
            Disconnect
          </button>
        ) : (
          <button type="submit" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        )}
        <span className={`pn-status pn-status--${status}`}>{status}</span>
      </div>
    </form>
  );
};
