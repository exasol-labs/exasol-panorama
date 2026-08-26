/**
 * What an installed Panorama keeps on the device.
 *
 * The application is a static bundle that talks to a database over a socket, so
 * "installable" is almost entirely a matter of the browser being able to launch
 * it without a tab — and that needs the bundle to be there when the network is
 * not. Hence a cache, and hence a very short list of what belongs in it: the
 * document, the manifest, the icons, and the hashed assets. That is the shell.
 *
 * Nothing else. In particular **no data**: a row cached from a query is a row
 * that can be shown as current when it is not, and a database browser that lies
 * about what the database holds is worse than one that says it is offline. Every
 * request that is not part of the shell is passed through untouched, so the
 * socket, the schema and every result set behave exactly as they do in a tab.
 *
 * Two policies, decided by what the URL means rather than by a list:
 *
 * - **The document** is fetched from the network first and served from the cache
 *   only when the network fails. A new deployment is picked up on the next launch
 *   rather than after a stale document has already been shown.
 * - **Hashed assets** are served from the cache first, because their names change
 *   when their contents do. Cache-first on an immutable URL cannot be stale, and
 *   it is what makes a cold launch fast.
 *
 * The handlers are separated from the worker that installs them (see
 * `../service-worker.ts`) because a cache policy is a decision worth testing and
 * a `ServiceWorkerGlobalScope` is not worth simulating.
 */

/**
 * Bumped when the shape of what is cached changes, not when the application
 * changes — assets are versioned by their own names. Activation deletes every
 * other Panorama cache, so a bump also discards whatever the last one held.
 */
export const SHELL_CACHE = 'panorama-shell-v1';

/** The prefix that says a cache is ours, so activation can leave others alone. */
export const SHELL_CACHE_PREFIX = 'panorama-shell-';

/**
 * What is fetched at install time and must succeed: the document, and the
 * manifest so that an install prompt has something to read on a cold start.
 *
 * Relative to where the application is served rather than to the origin's root,
 * because it is not always at the root: served under a path — a project site on
 * GitHub Pages, say — `/` is somebody else's page and `/assets/` is somebody
 * else's assets. Everything here is resolved against the base the worker was
 * registered with, which the worker knows because it is its own directory.
 */
export const SHELL_PATHS: readonly string[] = ['', 'manifest.webmanifest'];

/**
 * The rest of the shell, listed by the build.
 *
 * Caching the document and letting the assets arrive as they are used sounds
 * sufficient and is not: the renderer imports its shaders lazily, so a chunk that
 * is only needed the first time a table is drawn had never been fetched, and an
 * installed application that launches offline and then cannot open a table is
 * worse than one that admits it is offline. The probe found exactly that.
 *
 * So the build emits the list of everything it produced and the worker fetches
 * all of it while installing. It is a file rather than a constant compiled in
 * here because the names are hashed: the list changes on every deployment and
 * this file does not.
 */
export const SHELL_ASSETS_PATH = 'shell-assets.json';

/** Paths whose contents never change without their names changing. */
const IMMUTABLE_PREFIXES: readonly string[] = ['assets/', 'icons/'];

/** Files beside the document that a launch needs, replaced in place by a deployment. */
const SHELL_FILES: readonly string[] = ['manifest.webmanifest'];

export interface ShellCacheEnvironment {
  readonly caches: CacheStorage;
  /** The network. Passed in so a test can be offline without a network stack. */
  readonly fetch: (request: Request | string) => Promise<Response>;
  /**
   * Where the application is served: an absolute URL ending in a slash, which is
   * the origin's root for most deployments and a subdirectory for some. Every
   * decision here is relative to it — a worker under a path must not claim the
   * origin's `/assets/`, which belongs to whatever else is hosted there.
   */
  readonly base: string;
}

export interface ShellCacheHandlers {
  /** Fill the cache with the shell. */
  install(): Promise<void>;
  /** The asset list the build emitted, filtered to what it may contain. */
  listedAssets(): Promise<string[]>;
  /** Discard the caches of earlier versions. */
  activate(): Promise<void>;
  /**
   * How to answer one request, or `null` for "not ours" — which the worker turns
   * into not calling `respondWith` at all, leaving the browser to do exactly what
   * it would have done unregistered.
   */
  handle(request: Request): Promise<Response> | null;
}

/** True for the request that loads the document, however it was arrived at. */
const isDocument = (request: Request): boolean =>
  request.mode === 'navigate' || request.destination === 'document';

/**
 * Whether a URL is part of the shell.
 *
 * Under this application's own base, no query — a query means a parameter, and a
 * parameter means the answer depends on something this worker does not model —
 * and then either an immutable asset path or one of the few named files beside
 * the document.
 */
export const isShellAsset = (url: string, base: string): boolean => {
  const root = new URL(base);
  const parsed = new URL(url, root);
  if (parsed.origin !== root.origin) return false;
  if (parsed.search !== '') return false;
  if (!parsed.pathname.startsWith(root.pathname)) return false;
  const within = parsed.pathname.slice(root.pathname.length);
  return (
    IMMUTABLE_PREFIXES.some((prefix) => within.startsWith(prefix)) || SHELL_FILES.includes(within)
  );
};

/**
 * How a cached copy is looked up.
 *
 * `ignoreVary` is not an optimisation, it is the difference between working and
 * not. Hosts routinely answer static files with `Vary: Origin` — Vite's own
 * preview server does, and so do the usual CDN configurations — and a request
 * whose `Origin` header differs from the one that filled the cache then does not
 * match it. The worker had cached everything correctly, missed on every module a
 * dynamic `import()` asked for, and fell through to a network that was not there.
 *
 * Ignoring it is sound here rather than merely convenient: these are hashed
 * public assets, the same bytes for every caller, and the Cache API stores bodies
 * already decoded — so there is nothing for a response to legitimately vary on.
 */
const MATCH_ANY_VARIANT = { ignoreVary: true } as const;

/** Cacheable responses only: not an error page, and not somebody else's opaque. */
const isStorable = (response: Response): boolean => response.ok && response.type !== 'opaque';

export const shellCacheHandlers = (environment: ShellCacheEnvironment): ShellCacheHandlers => {
  const { caches, fetch, base } = environment;

  /**
   * Put a copy away, and do not let a failure to do so fail the response the
   * page is waiting for: a full disk or a private-mode restriction is a reason
   * to be slower next time, not a reason for a blank page now.
   */
  const store = async (request: Request, response: Response): Promise<void> => {
    try {
      const cache = await caches.open(SHELL_CACHE);
      await cache.put(request, response);
    } catch {
      // Nothing to do about it, and nothing that depends on it.
    }
  };

  const fromNetworkFirst = async (request: Request, fallback: string): Promise<Response> => {
    try {
      const response = await fetch(request);
      if (isStorable(response)) await store(request, response.clone());
      return response;
    } catch (error) {
      const cache = await caches.open(SHELL_CACHE);
      const cached =
        (await cache.match(request, MATCH_ANY_VARIANT)) ??
        (await cache.match(fallback, MATCH_ANY_VARIANT));
      if (cached !== undefined) return cached;
      throw error;
    }
  };

  const fromCacheFirst = async (request: Request): Promise<Response> => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(request, MATCH_ANY_VARIANT);
    if (cached !== undefined) return cached;
    const response = await fetch(request);
    if (isStorable(response)) await store(request, response.clone());
    return response;
  };

  /**
   * A build's own list of files, or nothing if there is not one. Absent in
   * development and on any host serving something unexpected, and in both cases
   * the answer is the same: cache what was named outright and let the rest arrive
   * as it is asked for. Filtered rather than trusted: it is a fetched document,
   * and a worker that hands whatever it finds in one to `cache.add` is a worker
   * that can be told to fetch anything.
   */
  const listedAssets = async (): Promise<string[]> => {
    try {
      const response = await fetch(new URL(SHELL_ASSETS_PATH, base).href);
      if (!response.ok) return [];
      const listed: unknown = await response.json();
      if (!Array.isArray(listed)) return [];
      return listed.filter(
        (entry): entry is string => typeof entry === 'string' && isShellAsset(entry, base),
      );
    } catch {
      return [];
    }
  };

  return {
    listedAssets,

    async install(): Promise<void> {
      const cache = await caches.open(SHELL_CACHE);
      await cache.addAll(SHELL_PATHS.map((path) => new URL(path, base).href));
      const listed = await listedAssets();
      // Settled, not all: one asset a deployment no longer has should cost a
      // fetch later, not the whole install. Runtime caching picks up the rest.
      await Promise.allSettled(listed.map(async (path) => cache.add(new URL(path, base).href)));
    },

    async activate(): Promise<void> {
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE)
          .map((name) => caches.delete(name)),
      );
    },

    handle(request: Request): Promise<Response> | null {
      // A write is never ours, and neither is anything the page did not GET.
      if (request.method !== 'GET') return null;
      // The document falls back to the application's own base, which is the
      // document — not to `/`, which under a path is somebody else's page.
      if (isDocument(request)) return fromNetworkFirst(request, base);
      if (isShellAsset(request.url, base)) return fromCacheFirst(request);
      return null;
    },
  };
};
