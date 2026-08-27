import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createWorkspace } from './bootstrap.js';
import { agentHostFor, startAgent } from './panorama/agent.js';
import { registerShell } from './panorama/install.js';
import { agentEndpointOrigin, inDesktopShell } from './panorama/shell.js';
import { reportTiming, shellBridge, startShellAgent } from './panorama/shell-agent.js';
import { injectedStartup } from './panorama/startup.js';
import './styles.css';

const container = document.querySelector('#root');
if (container === null) throw new Error('Missing #root element');

/**
 * Where database sockets go.
 *
 * In a browser, at the database: the driver opens `wss://` itself and a
 * certificate the browser does not trust is the end of the matter. In the desktop
 * application the shell owns the socket — so a self-signed instance, which is what
 * an Exasol Personal on this machine is, becomes a question a person can answer
 * instead of a refusal nobody can. The shell is asked for its address as the page
 * starts; it arrives long before anybody has typed a URL, and `connect` asks for
 * it at the moment it connects rather than holding a copy.
 */
const shell = shellBridge();
let databaseSocket: string | undefined;

const workspace = createWorkspace({ databaseSocket: () => databaseSocket });
// Development handle: the browser smoke test drives the workspace directly.
(globalThis as unknown as { __panorama?: unknown }).__panorama = workspace;

/**
 * Attach to the agent interface, whichever one this page has.
 *
 * The desktop application carries its own — the shell owns a socket, this page
 * answers the protocol on it — and it is preferred wherever it exists, because it
 * is the one that is there when nothing else was started. Failing that, the
 * development server's, over HTTP from the origin the document came from: in a
 * deployed build nothing answers and the stream simply never opens, and from the
 * shell's own scheme it is not attempted at all. See `panorama/shell.ts` and
 * `panorama/shell-agent.ts`.
 */
const endpoint = shell === null ? agentEndpointOrigin(globalThis.location) : null;
const agent =
  shell !== null
    ? startShellAgent({ host: agentHostFor(workspace), bridge: shell })
    : endpoint === null
      ? null
      : startAgent(workspace, { origin: endpoint });
(globalThis as unknown as { __panoramaAgent?: unknown }).__panoramaAgent = agent;

if (shell !== null) {
  void shell
    .invoke('database_proxy')
    .then((url) => {
      databaseSocket = typeof url === 'string' ? url : undefined;
    })
    .catch((error: unknown) => {
      // Not fatal: without it the application reaches the instances a browser
      // could, which is every instance with a certificate this machine trusts.
      console.warn('[panorama] no database socket from the shell', error);
    });
}

/**
 * Installability: the service worker that lets this launch without a tab. Only
 * in a build — in front of a dev server a cache is just a way to be shown a file
 * you have already changed — and never inside the desktop application, which has
 * the whole bundle on disk and nothing to gain from a copy of it. See
 * `panorama/install.ts` and `panorama/shell.ts`.
 */
void registerShell({
  enabled: import.meta.env.PROD && !inDesktopShell(),
  // Where this build was told it would be served from; `/` unless a deployment
  // said otherwise. See `panorama/install.ts`.
  base: import.meta.env.BASE_URL,
  host: navigator,
  onProblem: (error) => console.warn('[install] service worker not registered', error),
});

createRoot(container).render(
  <StrictMode>
    <App workspace={workspace} startup={injectedStartup()} />
  </StrictMode>,
);

/**
 * When the interface actually appeared.
 *
 * Two frames after the render call: the first is scheduled before the browser has
 * painted, the second runs after it has. Reported to the shell, where it is a log
 * line beside the launch — see `reportTiming`.
 */
requestAnimationFrame(() => {
  requestAnimationFrame(() => reportTiming('interface painted'));
});
