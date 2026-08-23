import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { createWorkspace } from './bootstrap.js';
import './styles.css';

const container = document.querySelector('#root');
if (container === null) throw new Error('Missing #root element');

const workspace = createWorkspace();
// Development handle: the browser smoke test drives the workspace directly.
(globalThis as unknown as { __panorama?: unknown }).__panorama = workspace;

createRoot(container).render(
  <StrictMode>
    <App workspace={workspace} />
  </StrictMode>,
);
