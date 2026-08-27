import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createWorkspace } from './bootstrap.js';
import { startAgent } from './panorama/agent.js';
import { registerShell } from './panorama/install.js';
import { agentEndpointOrigin, inDesktopShell } from './panorama/shell.js';
import { injectedStartup } from './panorama/startup.js';
import './styles.css';

const container = document.querySelector('#root');
if (container === null) throw new Error('Missing #root element');

const workspace = createWorkspace();
// Development handle: the browser smoke test drives the workspace directly.
(globalThis as unknown as { __panorama?: unknown }).__panorama = workspace;

/**
 * Attach to the agent interface on the development server.
 *
 * Wherever the document came from over HTTP, that is: the endpoint only exists
 * while the dev server is serving this page, so in a deployed build the stream
 * simply never opens — and there is no flag to remember to turn on when an agent
 * is wanted. The desktop application serves its document from its own scheme,
 * which an event stream refuses outright, so there it is not attempted at all.
 * See `panorama/shell.ts`.
 */
const endpoint = agentEndpointOrigin(globalThis.location);
const agent = endpoint === null ? null : startAgent(workspace, { origin: endpoint });
(globalThis as unknown as { __panoramaAgent?: unknown }).__panoramaAgent = agent;

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
