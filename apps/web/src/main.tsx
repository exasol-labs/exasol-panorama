import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createWorkspace } from './bootstrap.js';
import { startAgent } from './panorama/agent.js';
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
 * Unconditional on purpose: the endpoint only exists while the dev server is
 * serving this page, so in a build the stream simply never opens — and there is
 * no flag to remember to turn on when an agent is wanted.
 */
const agent = startAgent(workspace);
(globalThis as unknown as { __panoramaAgent?: unknown }).__panoramaAgent = agent;

createRoot(container).render(
  <StrictMode>
    <App workspace={workspace} startup={injectedStartup()} />
  </StrictMode>,
);
