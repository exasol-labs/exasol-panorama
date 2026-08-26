/**
 * Finding Claude on this machine, pairing it with this session, and opening it.
 *
 * The agent interface is only useful once something is on the other end of it,
 * and the last mile of that — "which client, told about which endpoint, and is
 * it running" — is the part a person is left to do by hand from a README. This
 * does it instead, from the one process that is in a position to: the
 * development server, which is on the same machine as the client and already
 * knows the endpoint's address.
 *
 * Everything it touches is behind `ClaudeEnvironment`. Not for neatness: the
 * whole of this file looks at the user's home directory, edits a configuration
 * file and starts a process, and none of that is something a test suite should
 * do to the machine it happens to be running on.
 */

/** Where the pairing is written, and what it is called there. */
export const CLAUDE_SERVER_NAME = 'panorama';

export interface ClaudeEnvironment {
  readonly platform: string;
  readonly home: string;
  /** The absolute path of a command on the PATH, or null. */
  find(command: string): Promise<string | null>;
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<string | null>;
  writeFile(path: string, contents: string): Promise<void>;
  /** Runs a command to completion, and says how it went. */
  run(command: string, args: readonly string[]): Promise<{ code: number; output: string }>;
  /** Starts something and leaves it running, detached from this process. */
  start(command: string, args: readonly string[]): Promise<void>;
}

export interface ClaudeStatus {
  readonly platform: string;
  /** Claude Code, on the PATH. */
  readonly cli: { readonly found: boolean; readonly path?: string; readonly paired: boolean };
  /** The desktop application, and whether its configuration names this session. */
  readonly desktop: {
    readonly found: boolean;
    readonly configPath: string;
    readonly paired: boolean;
  };
  /** True when this machine is one we know how to open a terminal on. */
  readonly canOpenTerminal: boolean;
}

const DESKTOP_APP = '/Applications/Claude.app';

/**
 * Where the desktop application keeps its configuration.
 *
 * Only macOS and Windows have an answer; on anything else the desktop client
 * does not exist, and saying so is better than guessing at a path.
 */
export const desktopConfigPath = (environment: {
  readonly platform: string;
  readonly home: string;
}): string => {
  if (environment.platform === 'darwin') {
    return `${environment.home}/Library/Application Support/Claude/claude_desktop_config.json`;
  }
  if (environment.platform === 'win32') {
    return `${environment.home}/AppData/Roaming/Claude/claude_desktop_config.json`;
  }
  return '';
};

const readServers = async (
  environment: ClaudeEnvironment,
  path: string,
): Promise<Record<string, unknown>> => {
  if (path === '') return {};
  const contents = await environment.readFile(path);
  if (contents === null || contents.trim() === '') return {};
  try {
    const parsed = JSON.parse(contents) as Record<string, unknown>;
    const servers = parsed['mcpServers'];
    return typeof servers === 'object' && servers !== null
      ? (servers as Record<string, unknown>)
      : {};
  } catch {
    // A configuration file that cannot be read is not a configuration file this
    // has any business rewriting, and pairing will say so rather than replace it.
    return {};
  }
};

/** What is on this machine, and what already knows about this session. */
export const inspectClaude = async (environment: ClaudeEnvironment): Promise<ClaudeStatus> => {
  const cliPath = await environment.find('claude');
  const configPath = desktopConfigPath(environment);
  const [desktopFound, desktopServers, cliPaired] = await Promise.all([
    configPath === '' ? Promise.resolve(false) : environment.exists(DESKTOP_APP),
    readServers(environment, configPath),
    readServers(environment, `${environment.home}/.claude.json`),
  ]);
  return {
    platform: environment.platform,
    cli: {
      found: cliPath !== null,
      ...(cliPath === null ? {} : { path: cliPath }),
      paired: cliPaired[CLAUDE_SERVER_NAME] !== undefined,
    },
    desktop: {
      found: desktopFound || (configPath !== '' && (await environment.exists(configPath))),
      configPath,
      paired: desktopServers[CLAUDE_SERVER_NAME] !== undefined,
    },
    canOpenTerminal: environment.platform === 'darwin',
  };
};

export interface PairRequest {
  /** The endpoint an agent should talk to, e.g. `http://localhost:5173/agent/mcp`. */
  readonly url: string;
  /** Absolute path of the stdio pipe, for a client that speaks only that. */
  readonly bridgeScript: string;
}

export interface PairOutcome {
  readonly target: 'cli' | 'desktop';
  readonly done: boolean;
  readonly detail: string;
}

/**
 * Tells Claude Code about this session.
 *
 * Through its own command rather than by writing its file: the CLI owns that
 * schema, and a hand-written entry that is subtly wrong is worse than no entry —
 * it fails at the point where somebody is trying to use it, not here.
 */
const pairCli = async (
  environment: ClaudeEnvironment,
  request: PairRequest,
): Promise<PairOutcome> => {
  const found = await environment.find('claude');
  if (found === null) {
    return {
      target: 'cli',
      done: false,
      detail: 'Claude Code is not on the PATH of the process serving this page.',
    };
  }
  const result = await environment.run(found, [
    'mcp',
    'add',
    '--scope',
    'user',
    '--transport',
    'http',
    CLAUDE_SERVER_NAME,
    request.url,
  ]);
  return {
    target: 'cli',
    done: result.code === 0,
    detail:
      result.code === 0
        ? `Added "${CLAUDE_SERVER_NAME}" to Claude Code, for every project on this machine.`
        : `Claude Code refused: ${result.output.trim() || `exit ${result.code}`}`,
  };
};

/**
 * Tells the desktop application about this session.
 *
 * Written into its configuration, because it has no command to run — and merged
 * rather than replaced: it is the user's file, and whatever else is in it is
 * theirs. The entry is the stdio pipe, which is the transport that client
 * speaks.
 */
const pairDesktop = async (
  environment: ClaudeEnvironment,
  request: PairRequest,
): Promise<PairOutcome> => {
  const path = desktopConfigPath(environment);
  if (path === '') {
    return {
      target: 'desktop',
      done: false,
      detail: `There is no Claude desktop application on ${environment.platform}.`,
    };
  }
  const existing = await environment.readFile(path);
  if (existing !== null && existing.trim() !== '') {
    try {
      JSON.parse(existing);
    } catch {
      return {
        target: 'desktop',
        done: false,
        detail: `${path} is not valid JSON, so it has been left alone. Fix or move it and try again.`,
      };
    }
  }
  const parsed =
    existing === null || existing.trim() === ''
      ? {}
      : (JSON.parse(existing) as Record<string, unknown>);
  const servers = await readServers(environment, path);
  const contents = {
    ...parsed,
    mcpServers: {
      ...servers,
      [CLAUDE_SERVER_NAME]: {
        command: 'node',
        args: [request.bridgeScript],
        env: { PANORAMA_AGENT_URL: request.url },
      },
    },
  };
  await environment.writeFile(path, `${JSON.stringify(contents, null, 2)}\n`);
  return {
    target: 'desktop',
    done: true,
    detail: `Wrote "${CLAUDE_SERVER_NAME}" into ${path}. Restart Claude for it to be picked up.`,
  };
};

export const pairClaude = async (
  environment: ClaudeEnvironment,
  request: PairRequest,
  target: 'cli' | 'desktop' | 'both' = 'both',
): Promise<readonly PairOutcome[]> => {
  const outcomes: PairOutcome[] = [];
  if (target !== 'desktop') outcomes.push(await pairCli(environment, request));
  if (target !== 'cli') outcomes.push(await pairDesktop(environment, request));
  return outcomes;
};

export interface OpenOutcome {
  readonly opened: 'cli' | 'desktop' | null;
  readonly detail: string;
}

/**
 * How the desktop application is opened.
 *
 * Only ever asked where there is one to open, which is only ever the two
 * platforms it exists on — so this picks between them rather than guarding
 * against a third that `inspectClaude` has already ruled out.
 */
const desktopCommand = (platform: string): readonly [string, readonly string[]] =>
  platform === 'win32' ? ['cmd', ['/c', 'start', '', 'claude']] : ['open', ['-a', 'Claude']];

/**
 * Opens Claude — the application, if there is one.
 *
 * The application is what somebody who has installed it means by "open Claude":
 * it is a window that is already set up, and opening the command line instead
 * puts them in a terminal they did not ask for. So the desktop client is tried
 * first, and Claude Code is what there is when there is no application — opened
 * by asking the terminal to run it in the directory this project is being served
 * from, which is where it will find the project it is meant to be helping with.
 *
 * `prefer` overrides that in either direction, because a preference stated
 * outright should beat a default, and there are people for whom the terminal is
 * the point.
 */
export const openClaude = async (
  environment: ClaudeEnvironment,
  request: { readonly cwd: string; readonly prefer?: 'cli' | 'desktop' },
): Promise<OpenOutcome> => {
  const status = await inspectClaude(environment);
  const canOpenApp = status.desktop.found;
  const canOpenCli = status.cli.found && status.canOpenTerminal;
  const wanted = request.prefer ?? (canOpenApp ? 'desktop' : 'cli');
  // What was asked for, if it can be done, and otherwise whatever can.
  const target =
    wanted === 'desktop' && !canOpenApp
      ? 'cli'
      : wanted === 'cli' && !canOpenCli
        ? 'desktop'
        : wanted;

  if (target === 'desktop' && canOpenApp) {
    const [command, args] = desktopCommand(environment.platform);
    await environment.start(command, args);
    return { opened: 'desktop', detail: 'Opened the Claude desktop application.' };
  }
  if (target === 'cli' && canOpenCli) {
    // AppleScript, because a terminal is the one thing that cannot be started
    // headless: what makes Claude Code usable is having somewhere to type.
    const script = `tell application "Terminal" to do script "cd ${JSON.stringify(request.cwd).slice(1, -1)} && claude"\ntell application "Terminal" to activate`;
    await environment.start('osascript', ['-e', script]);
    return { opened: 'cli', detail: 'Opened Claude Code in a new Terminal window.' };
  }
  return {
    opened: null,
    detail:
      status.cli.found && !status.canOpenTerminal
        ? `Claude Code is installed, but opening a terminal is only implemented on macOS. Run "claude" in ${request.cwd}.`
        : 'Claude was not found on this machine.',
  };
};
