import { useState } from 'react';
import type { FormEvent } from 'react';
import type { ConnectionCredentials, ConnectionRequest, ConnectionStatus } from './types.js';
import { LinkedText } from './LinkedText.js';

/**
 * The connection dialog.
 *
 * Credentials live in this component's local state for exactly as long as it
 * takes to submit them, and are handed straight to the connection subsystem.
 * They never reach the world model, the history graph, or any log line.
 *
 * It is the form for when there is no connection, and nothing else. It used to
 * stay on screen once one was made, with every field disabled and a button to
 * undo itself — a quarter of the sidebar spent saying "connected". So the shell
 * puts it away instead, and the way off a live connection is where the
 * connection is now named: on the explorer's indicator.
 */

export interface ConnectionDialogProps {
  readonly status: ConnectionStatus;
  readonly error?: string | null;
  readonly defaultUrl?: string;
  readonly defaultUsername?: string;
  readonly onConnect: (request: ConnectionRequest) => void;
}

type AuthMode = 'password' | 'token';

export const ConnectionDialog = ({
  status,
  error = null,
  defaultUrl = 'wss://localhost:8563',
  defaultUsername = 'sys',
  onConnect,
}: ConnectionDialogProps): React.JSX.Element => {
  const [url, setUrl] = useState(defaultUrl);
  const [mode, setMode] = useState<AuthMode>('password');
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');

  const busy = status === 'connecting';

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (busy) return;
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
              onChange={(event) => setUsername(event.target.value)}
            />
          </label>
          <label className="pn-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              autoComplete="current-password"
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
            onChange={(event) => setToken(event.target.value)}
          />
        </label>
      )}

      {error !== null && error !== '' ? (
        <p className="pn-error" role="alert">
          {/*
            A connection failure is the one message that routinely tells the
            user to go and open a URL — accepting a self-signed certificate is
            done in another tab, not here — so the URL is a link rather than
            something to retype.
          */}
          <LinkedText text={error} />
        </p>
      ) : null}

      <div className="pn-field pn-field--row">
        <button type="submit" disabled={busy}>
          {busy ? 'Connecting…' : 'Connect'}
        </button>
        <span className={`pn-status pn-status--${status}`}>{status}</span>
      </div>
    </form>
  );
};
