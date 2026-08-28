import type { ConnectionRequest, PersonalDeployment } from '@panorama/ui';
import type { AgentHost } from '@panorama/mcp';
import { AGENT_TOOLS, answerProtocol, skillText } from '@panorama/mcp';
// The skill, compiled in. In a browser the development server reads the file, so
// an edit to the documentation is an edit to what agents are told; the desktop
// application has no file to read and no server to read it, so the document is
// part of the bundle instead. Same text, same source, one build later.
import skillDocument from '../../../../docs/AGENT-SKILL.md?raw';

/**
 * The agent interface, inside the desktop application.
 *
 * The shell owns a socket and knows nothing about the protocol: it hands the page
 * a message and expects one back. So this is the whole of the endpoint on this
 * side — subscribe, answer, reply — and everything about *what* the answers mean
 * is `answerProtocol`, which is the same code the development server calls.
 *
 * Nothing here is Tauri-specific except the two function names it is handed. The
 * shell is reached through the global the shell itself installs rather than
 * through its npm package, so the browser build carries no dependency on a
 * desktop framework it will never run in.
 */

/** What the shell offers the page. Two functions, both of them its own. */
export interface ShellBridge {
  listen(
    event: string,
    handler: (message: { payload: unknown }) => void,
  ): Promise<() => void> | (() => void);
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

/** The shell asks for an answer to this. */
export const AGENT_REQUEST_EVENT = 'panorama://agent-request';

interface TauriGlobal {
  readonly __TAURI__?: {
    readonly event?: {
      listen: (event: string, handler: (message: { payload: unknown }) => void) => Promise<unknown>;
    };
    readonly core?: {
      invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
    };
  };
}

/**
 * The shell's own API, where it has installed one.
 *
 * `withGlobalTauri` puts it on the window, which is why the page needs no
 * `@tauri-apps/api` dependency — and why a browser, having no such global, gets
 * `null` here and never tries.
 */
export const shellBridge = (host: TauriGlobal = globalThis as TauriGlobal): ShellBridge | null => {
  const listen = host.__TAURI__?.event?.listen;
  const invoke = host.__TAURI__?.core?.invoke;
  if (listen === undefined || invoke === undefined) return null;
  return {
    listen: async (event, handler) => {
      const unlisten = await listen(event, handler);
      return typeof unlisten === 'function' ? (unlisten as () => void) : (): void => {};
    },
    invoke: async (command, args) => invoke(command, args),
  };
};

/** The document, minus the note addressed to whoever opens the file. */
export const shellSkill = (): string => skillText(skillDocument);

export interface ShellAgentOptions {
  readonly host: AgentHost;
  readonly bridge: ShellBridge;
  /** Left out, the compiled-in document is used. Handed in by the tests. */
  readonly skill?: string;
  readonly onLog?: (message: string) => void;
}

export interface ShellAgent {
  close(): Promise<void>;
}

/**
 * Attaches the application to the endpoint in the shell.
 *
 * A message the shell could not have meant is dropped with a note rather than
 * answered: the only sender is the process hosting this window, so a malformed
 * request is a bug on this side of the wire and not something an agent is waiting
 * on.
 */
export const startShellAgent = async (options: ShellAgentOptions): Promise<ShellAgent> => {
  const log = options.onLog ?? ((): void => {});
  const skill = options.skill ?? shellSkill();

  const unlisten = await options.bridge.listen(AGENT_REQUEST_EVENT, (message) => {
    const payload = message.payload as { id?: unknown; body?: unknown } | null;
    const id = payload?.id;
    const body = payload?.body;
    if (typeof id !== 'number' || typeof body !== 'string') {
      log('ignored a request that was not one');
      return;
    }
    void (async (): Promise<void> => {
      const answer = await answerProtocol(options.host, body, skill);
      await options.bridge.invoke('agent_reply', { id, body: answer });
    })().catch((error: unknown) => {
      // The protocol answers its own refusals — a tool that said no comes back as
      // words the agent can act on. So reaching here means the *shell* could not
      // be told, and there is nobody left to tell: the call times out on its side
      // and this window says why on the console.
      log(
        `could not answer request ${id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  });

  // Announced only once the listener is in place: the shell refuses calls until a
  // window says it is ready, and a window that says so early loses whatever
  // arrives in between.
  await options.bridge.invoke('agent_attach', {});
  log('attached to the desktop agent endpoint');

  return {
    close: async (): Promise<void> => {
      unlisten();
      await options.bridge.invoke('agent_detach', {}).catch(() => {});
    },
  };
};

/**
 * The settings panel's routes, answered by the shell.
 *
 * The panel asks a development server for four things: whether anything is
 * attached, what Claude there is on this machine, pairing it, and opening it. In
 * the desktop application there is no server to ask — the endpoint is a socket in
 * the process hosting this window, and the machine is right there — so the same
 * four answers come from the shell over its own IPC, in the same shapes. The panel
 * needs no idea which it is talking to.
 *
 * `undefined` means "not mine": the caller then asks the network, which is what a
 * browser does and what a deployed page gets nothing from.
 */
const SHELL_ROUTES: Record<string, string> = {
  '/agent/health': 'agent_status',
  '/agent/claude': 'claude_status',
  '/agent/claude/pair': 'claude_pair',
  '/agent/claude/open': 'claude_open',
};

export const shellSetting = async <TValue>(
  path: string,
  bridge: ShellBridge | null = shellBridge(),
): Promise<TValue | undefined> => {
  const command = SHELL_ROUTES[path];
  if (bridge === null || command === undefined) return undefined;
  const answer = await bridge.invoke(command);
  if (answer === null || typeof answer !== 'object') return undefined;
  // The health route is the one the shell cannot answer on its own: it knows the
  // address and the traffic, and the page knows the tools, because the page is
  // where the catalogue lives now.
  if (path === '/agent/health') {
    return { ...(answer as object), tools: AGENT_TOOLS.map((tool) => tool.name) } as TValue;
  }
  // `pair` answers with a list; the panel reads it under this name.
  if (Array.isArray(answer)) return { outcomes: answer } as TValue;
  return answer as TValue;
};

/**
 * The databases Exasol Personal manages for this user — wherever they run.
 *
 * Asked of the shell, which runs the `exasol` command: a page cannot, and a page on
 * a hosted origin is not on the machine that would. `null` where there is no shell,
 * which is how the connection dialog knows to offer nothing at all.
 */
export interface PersonalDatabases {
  readonly installed: boolean;
  readonly deployments: readonly PersonalDeployment[];
}

/**
 * How much to find out about each deployment, because the three answers cost three
 * very different amounts:
 *
 * - `names` — instant, and nothing is offered as connectable.
 * - `probed` — a few hundred milliseconds, and the answer that matters: whether
 *   something answers at each address.
 * - `described` — seconds, sometimes many, and worth only better words on a row
 *   that cannot be connected to anyway.
 *
 * So the panel asks for all three in turn and shows each answer as it lands, rather
 * than waiting for the slowest one to say anything at all.
 */
export type DeploymentDetail = 'names' | 'probed' | 'described';

export const shellDeployments = async (
  bridge: ShellBridge | null = shellBridge(),
  detail: DeploymentDetail = 'names',
): Promise<PersonalDatabases | null> => {
  if (bridge === null) return null;
  const answer = (await bridge.invoke('exasol_deployments', {
    detail,
  })) as PersonalDatabases | null;
  if (answer === null || typeof answer !== 'object') return null;
  return { installed: answer.installed === true, deployments: answer.deployments ?? [] };
};

/**
 * What one of them needs to be connected to.
 *
 * Fetched at the moment somebody clicks, never with the list: it carries the
 * deployment's password, and it goes straight into a connection rather than into
 * any state this page keeps.
 */
export const shellDeploymentCredentials = async (
  name: string,
  bridge: ShellBridge | null = shellBridge(),
): Promise<ConnectionRequest> => {
  if (bridge === null) throw new Error('There is no desktop shell to ask.');
  const answer = (await bridge.invoke('exasol_deployment_credentials', { name })) as {
    url?: unknown;
    username?: unknown;
    password?: unknown;
  } | null;
  if (
    answer === null ||
    typeof answer.url !== 'string' ||
    typeof answer.username !== 'string' ||
    typeof answer.password !== 'string'
  ) {
    throw new Error(`The shell did not say how to connect to ${name}.`);
  }
  return {
    url: answer.url,
    credentials: { kind: 'password', username: answer.username, password: answer.password },
  };
};

/**
 * The version the shell has downloaded and is holding for the next quit.
 *
 * `null` in a browser, where there is no shell, and `null` in the desktop
 * application until something is actually staged — which is most of the time.
 */
export const shellStagedVersion = async (
  bridge: ShellBridge | null = shellBridge(),
): Promise<string | null> => {
  if (bridge === null) return null;
  const answer = await bridge.invoke('update_status');
  return typeof answer === 'string' && answer !== '' ? answer : null;
};

/**
 * Tells the shell how long something took, for the log.
 *
 * Instantness is a requirement, and this is how it is held to: the two moments a
 * person experiences — the interface appearing and the canvas starting to draw —
 * are reported from where they happen and printed beside the launch they belong to.
 * Nothing in a browser, which has no shell to tell and a console of its own.
 */
export const reportTiming = (stage: string, bridge: ShellBridge | null = shellBridge()): void => {
  if (bridge === null) return;
  void bridge.invoke('report_timing', { stage }).catch(() => {
    // A timing nobody recorded is not worth a failure.
  });
};
