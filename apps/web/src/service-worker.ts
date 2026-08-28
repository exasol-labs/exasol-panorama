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
  readonly location: { readonly href: string };
  readonly clients: { claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: 'install' | 'activate', listener: (event: WaitableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = globalThis as unknown as WorkerScope;

const handlers = shellCacheHandlers({
  caches,
  fetch: (request) => fetch(request),
  /**
   * Where the application is, worked out from where this worker is.
   *
   * A worker's scope is its own directory, so the directory this script was
   * served from *is* the application root — whether that is the origin's root or
   * a path under it. Derived rather than configured: a base compiled in here
   * could disagree with where the file actually ended up, and the disagreement
   * would show up as an application that installs and then cannot find itself.
   */
  base: new URL('./', scope.location.href).href,
});

/**
 * Installed, and then it waits.
 *
 * `skipWaiting()` is deliberately not called, and that omission is the whole of
 * Panorama's update policy on the web. A worker that skips waiting takes control
 * of pages that are already open, which means a new version arrives in the middle
 * of somebody's work — at a moment chosen by whoever deployed it rather than by
 * the person reading a query. Left to wait, it activates when the last window of
 * the application closes, so the new version is what opens next time and never
 * what interrupts this time.
 *
 * The page notices the waiting worker and says so, quietly, rather than leaving
 * an update to be discovered by accident — see `panorama/updates.ts`.
 *
 * A *first* install still activates at once, because there is no worker to wait
 * behind. That is what `clients.claim()` below is for, and it is the case where
 * taking over immediately is right: without it an installed application would not
 * work offline until its second launch.
 */
scope.addEventListener('install', (event) => {
  event.waitUntil(handlers.install());
});

scope.addEventListener('activate', (event) => {
  event.waitUntil(handlers.activate().then(() => scope.clients.claim()));
});

scope.addEventListener('fetch', (event) => {
  const answer = handlers.handle(event.request);
  if (answer !== null) event.respondWith(answer);
});
