/**
 * The service worker: the thing that makes an installed Panorama launch.
 *
 * All of the policy is in `panorama/shell-cache.ts`, which is testable. This file
 * is the wiring, and it is deliberately the only place that mentions a service
 * worker global — the types for one conflict with the DOM types the rest of the
 * application is compiled against, so the few members used here are declared
 * locally rather than pulled in as a library.
 *
 * It is built as its own entry point (see `vite.config.ts`) so that it lands at
 * the root of the output with a stable name: a worker's scope is its directory,
 * and a hashed name under `assets/` could control neither the document nor a
 * client that had already registered the last one.
 */
import { shellCacheHandlers } from './panorama/shell-cache.js';

interface WaitableEvent {
  waitUntil(work: Promise<unknown>): void;
}

interface FetchEvent {
  readonly request: Request;
  respondWith(response: Promise<Response>): void;
}

interface WorkerScope {
  readonly location: { readonly origin: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: WaitableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const handlers = shellCacheHandlers({
  caches,
  fetch: (request) => fetch(request),
  origin: scope.location.origin,
});

/**
 * Take over immediately, in both directions.
 *
 * The alternative — waiting for every tab to close — is the right default for an
 * application whose pages hold state a new version might not understand. Here the
 * worker only decides where bytes come from, the pages hold their state in the
 * document itself, and an install that does nothing until the next launch is an
 * install that looks broken.
 */
scope.addEventListener('install', (event) => {
  event.waitUntil(handlers.install().then(() => scope.skipWaiting()));
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(handlers.activate().then(() => scope.clients.claim()));
});

scope.addEventListener('fetch', (event) => {
  const answer = handlers.handle(event.request);
  if (answer !== null) event.respondWith(answer);
});
