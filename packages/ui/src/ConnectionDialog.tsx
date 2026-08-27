import { useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ConnectionCredentials,
  ConnectionRequest,
  ConnectionStatus,
  PersonalDeployment,
} from './types.js';
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
 *
 * Two ways in, when there are two. Where Exasol Personal is installed, the
 * deployments it manages are one tab and typing an address is the other, and the
 * deployments come first because they are the answer to everything the form asks.
 * Where it is not installed there are no tabs at all — a single choice presented
 * as a choice is furniture.
 */

/**
 * The tool's own word for a status, made readable without being reinterpreted.
 *
 * `database_connection_failed` is what `exasol status` says and it is the truth;
 * "database connection failed" is the same truth with the underscores taken out.
 * Only one value is given a different word: `checking` is this application's own,
 * for a row it has not yet asked about.
 */
const readableStatus = (status: string): string =>
  status === 'checking' ? 'checking…' : status.replaceAll('_', ' ');

/** Whether an address is this machine, for deciding what identifies a row. */
const here = (host: string): boolean =>
  host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * The short thing on the right of a row.
 *
 * What identifies a deployment depends on where it is. Six on this machine differ
 * only by port, so the port is the answer; one in a cloud has a host nobody would
 * guess, so the host is. A deployment that is not running has no address at all,
 * and what is worth saying then is that it is not running.
 */
const whereItIs = (deployment: PersonalDeployment): string => {
  if (deployment.url === undefined) return readableStatus(deployment.status);
  const [host, port] = deployment.url.replace(/^wss?:\/\//u, '').split(':');
  return here(host ?? '') ? `port ${port ?? ''}` : (host ?? deployment.status);
};

/**
 * The whole truth, one hover away: where it is deployed, the exact address, and
 * whatever the tool had to say about it — which for a deployment that is not
 * running is a sentence about how to start it.
 */
const describeDeployment = (deployment: PersonalDeployment): string =>
  [deployment.infrastructure, deployment.url ?? deployment.status, deployment.message]
    .filter((part) => part !== undefined && part !== '')
    .join(' · ');

export interface ConnectionDialogProps {
  readonly status: ConnectionStatus;
  readonly error?: string | null;
  readonly defaultUrl?: string;
  readonly defaultUsername?: string;
  readonly onConnect: (request: ConnectionRequest) => void;
  /**
   * Databases Exasol Personal manages for this user, if anything was able to look.
   *
   * `undefined` where nothing looked — a browser — and an empty list where
   * something looked and found none, which are different things and are shown
   * differently: silence, and a sentence.
   */
  readonly deployments?: readonly PersonalDeployment[] | undefined;
  /** True when the thing that looks is here but has nothing installed yet. */
  readonly deploymentsAvailable?: boolean;
  /** Connect to one by name; whoever supplied the list knows its password. */
  readonly onOpenDeployment?: (name: string) => void;
}

type AuthMode = 'password' | 'token';

export const ConnectionDialog = ({
  status,
  error = null,
  defaultUrl = 'wss://localhost:8563',
  defaultUsername = 'sys',
  onConnect,
  deployments,
  deploymentsAvailable = false,
  onOpenDeployment,
}: ConnectionDialogProps): React.JSX.Element => {
  const [url, setUrl] = useState(defaultUrl);
  const [mode, setMode] = useState<AuthMode>('password');
  const [username, setUsername] = useState(defaultUsername);
  const [password, setPassword] = useState('');
  const [token, setToken] = useState('');

  const busy = status === 'connecting';

  /**
   * Which way in is on screen.
   *
   * `null` until somebody picks, and then it stays picked: the deployments arrive
   * from the shell a couple of seconds after the dialog does, and a tab that moved
   * under a person who had already chosen the form would be worse than a tab that
   * started in the wrong place.
   */
  const [chosen, setChosen] = useState<'personal' | 'manual' | null>(null);
  const personalOffered = deploymentsAvailable && onOpenDeployment !== undefined;
  const anyDeployments = deployments !== undefined && deployments.length > 0;
  // Personal by default, but not when it is empty: a tab with nothing in it is not
  // where somebody who came here to connect should land, even though the tab is
  // still worth offering so they can see that the tool is installed.
  const tab = chosen ?? (personalOffered && anyDeployments ? 'personal' : 'manual');

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

  /**
   * The deployments Exasol Personal manages, when there are any to offer.
   *
   * First in the dialog, and deliberately: on a machine with Exasol Personal
   * installed this is the answer to every question the form below asks, and a
   * person who has one running should not have to look up a port to reach it.
   *
   * Each row says three things, because each is the answer to a real question.
   * *Whether it is running*, since a database that is not cannot be connected to —
   * as a dot for the eye and in the row's label for anything reading it aloud.
   * *Where it is*, because Exasol Personal deploys to a cloud as readily as to this
   * machine, and "which of my six" is answered by a port only when they are all
   * here. And its *name*, which is what a person calls it.
   */
  const deploymentRows =
    !deploymentsAvailable || onOpenDeployment === undefined ? null : (
      <section className="pn-connection__local">
        {deployments === undefined || deployments.length === 0 ? (
          <p className="pn-hint">
            No Exasol Personal deployments yet. <code>exasol install local</code> makes one.
          </p>
        ) : (
          <ul className="pn-list" aria-label="Exasol Personal deployments">
            {deployments.map((deployment) => {
              const running = deployment.url !== undefined;
              return (
                <li key={deployment.name}>
                  <button
                    type="button"
                    // A database that is not running cannot be opened, and saying
                    // so on the row is better than a failure a second later.
                    disabled={busy || !running}
                    // The status is in the name rather than only in the colour of
                    // the dot: a row nobody can see should still say whether it
                    // can be opened.
                    aria-label={`${deployment.name}, ${deployment.status}`}
                    title={describeDeployment(deployment)}
                    onClick={() => onOpenDeployment(deployment.name)}
                  >
                    <span className="pn-list__name">
                      <span
                        className={`pn-dot pn-dot--${running ? 'running' : 'idle'}`}
                        aria-hidden="true"
                      />
                      {deployment.name}
                    </span>
                    <span className="pn-list__kind">{whereItIs(deployment)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    );

  const tabs = !personalOffered ? null : (
    <div
      className="pn-tabs"
      role="tablist"
      aria-label="How to connect"
      onKeyDown={(event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        event.preventDefault();
        setChosen(tab === 'personal' ? 'manual' : 'personal');
      }}
    >
      {(['personal', 'manual'] as const).map((which) => (
        <button
          key={which}
          type="button"
          role="tab"
          id={`pn-tab-${which}`}
          aria-selected={tab === which}
          aria-controls={`pn-panel-${which}`}
          // The unselected tab is out of the tab order, which is what makes a
          // tablist one stop rather than two.
          tabIndex={tab === which ? 0 : -1}
          className={tab === which ? 'pn-tabs__tab pn-tabs__tab--on' : 'pn-tabs__tab'}
          onClick={() => setChosen(which)}
        >
          {which === 'personal' ? 'Personal' : 'Manual'}
        </button>
      ))}
    </div>
  );

  return (
    <form className="pn-panel pn-connection" onSubmit={submit}>
      <h2 className="pn-panel__title">Connection</h2>

      {tabs}

      {tab === 'personal' ? (
        <div role="tabpanel" id="pn-panel-personal" aria-labelledby="pn-tab-personal">
          {deploymentRows}
        </div>
      ) : (
        <div
          className="pn-connection__manual"
          role={personalOffered ? 'tabpanel' : undefined}
          {...(personalOffered
            ? { id: 'pn-panel-manual', 'aria-labelledby': 'pn-tab-manual' }
            : {})}
        >
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
        </div>
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
        {/*
          Only the form has something to submit. The status stays on both, because
          a connection started by clicking a deployment is still a connection
          somebody is waiting for.
        */}
        {tab === 'manual' ? (
          <button type="submit" disabled={busy}>
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        ) : null}
        <span className={`pn-status pn-status--${status}`}>{status}</span>
      </div>
    </form>
  );
};
