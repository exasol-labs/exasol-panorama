import type { ConnectionCredentials } from '@panorama/ui';

/**
 * Connection details supplied before the page opens.
 *
 * Typing a URL and a password is fine at a desk and miserable in a headset, so
 * the details can come from the environment instead. What arrives here has
 * already been read by the dev server and injected at build time; the browser
 * never reads a file.
 *
 * A secret is never put back into an input. If one is configured it is used to
 * connect and nothing more — a password sitting in a form field would be
 * readable over someone's shoulder and recoverable from the DOM, for no benefit
 * over connecting straight away.
 */

export interface StartupOpenTable {
  readonly schema: string;
  readonly table: string;
}

export interface StartupConnection {
  readonly url: string;
  /** Prefilled into the form; harmless to show. */
  readonly username?: string;
  /** Present only when a secret was configured. Never rendered. */
  readonly credentials?: ConnectionCredentials;
  readonly autoConnect: boolean;
  /** Opened once connected, so a headset needs no interaction at all. */
  readonly open?: StartupOpenTable;
}

export type StartupEnvironment = Readonly<Record<string, string | undefined>>;

/** Blank strings are treated as absent: an unset shell variable often is one. */
const value = (environment: StartupEnvironment, name: string): string | undefined => {
  const raw = environment[name];
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim();
};

const isOff = (raw: string | undefined): boolean =>
  raw === '0' || raw?.toLowerCase() === 'false' || raw?.toLowerCase() === 'no';

/**
 * Reads the startup connection, or `null` when none is configured.
 *
 * The variable names match the ones the Exasol integration tests already use,
 * so one exported block of shell configuration drives both.
 */
export const readStartupConnection = (
  environment: StartupEnvironment,
): StartupConnection | null => {
  const url = value(environment, 'PANORAMA_EXASOL_URL');
  if (url === undefined) return null;

  const token = value(environment, 'PANORAMA_EXASOL_TOKEN');
  const password = value(environment, 'PANORAMA_EXASOL_PASSWORD');
  const username = value(environment, 'PANORAMA_EXASOL_USER');
  // A token is the more specific choice, so it wins where both are given.
  const credentials: ConnectionCredentials | undefined =
    token !== undefined
      ? { kind: 'token', token }
      : password !== undefined
        ? { kind: 'password', username: username ?? 'sys', password }
        : undefined;

  const schema = value(environment, 'PANORAMA_EXASOL_SCHEMA');
  const table = value(environment, 'PANORAMA_EXASOL_TABLE');

  return {
    url,
    ...(username === undefined ? {} : { username }),
    ...(credentials === undefined ? {} : { credentials }),
    // Connecting is the point of supplying a secret, so it happens unless it is
    // turned off explicitly. With no secret there is nothing to connect with.
    autoConnect:
      credentials !== undefined && !isOff(value(environment, 'PANORAMA_EXASOL_AUTOCONNECT')),
    ...(schema !== undefined && table !== undefined ? { open: { schema, table } } : {}),
  };
};

/**
 * What the dev server injected, if anything.
 *
 * `__PANORAMA_STARTUP__` is replaced at build time. A production build is given
 * a literal `null` rather than the configuration, so a secret cannot be baked
 * into a deployable artifact even by accident.
 */
export const injectedStartup = (): StartupConnection | null => {
  const injected: unknown =
    typeof __PANORAMA_STARTUP__ === 'undefined' ? null : __PANORAMA_STARTUP__;
  return injected === null ? null : (injected as StartupConnection);
};
