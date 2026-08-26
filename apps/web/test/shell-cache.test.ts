import { describe, expect, it } from 'vitest';
import {
  SHELL_ASSETS_PATH,
  SHELL_CACHE,
  SHELL_PATHS,
  isShellAsset,
  shellCacheHandlers,
} from '../src/panorama/shell-cache.js';

/**
 * The cache policy of an installed Panorama.
 *
 * The claim being tested is not "it caches" — it is *what* it caches, and the
 * consequence of getting that wrong is not a slow launch but a wrong number on
 * the screen. So most of what is here is about what the worker refuses to touch.
 *
 * Fakes rather than the real Cache API, which jsdom does not have: the handlers
 * take the storage and the network as arguments precisely so that being offline
 * is something a test can simply be.
 */

const ORIGIN = 'https://panorama.example';

/**
 * Two deployments, and the difference between them is the point of most of this.
 *
 * An application at an origin's root can treat `/assets/` as its own. One served
 * under a path cannot: there, `/` is somebody else's page and `/assets/` somebody
 * else's assets, and a worker that claimed them would serve one site's files to
 * another. So every case below is run against both bases.
 */
const AT_ROOT = `${ORIGIN}/`;
const UNDER_PATH = `${ORIGIN}/exasol-panorama/`;

interface Stored {
  readonly url: string;
  readonly body: string;
}

const response = (body: string, init: { ok?: boolean; type?: string } = {}): Response =>
  ({
    ok: init.ok ?? true,
    status: (init.ok ?? true) ? 200 : 500,
    type: init.type ?? 'basic',
    body,
    clone: (): Response => response(body, init),
  }) as unknown as Response;

const request = (
  url: string,
  init: { method?: string; mode?: string; destination?: string } = {},
): Request =>
  ({
    url: new URL(url, ORIGIN).href,
    method: init.method ?? 'GET',
    mode: init.mode ?? 'cors',
    destination: init.destination ?? '',
  }) as unknown as Request;

const bodyOf = (given: Response): string => (given as unknown as { body: string }).body;

/**
 * A cache storage that can be inspected, and made to fail on demand.
 *
 * `match` behaves the way a real one does when the host answered with a `Vary`
 * header: a lookup that does not say `ignoreVary` misses. Every entry is treated
 * as varying, because in practice every entry does — see `MATCH_ANY_VARIANT` in
 * the module under test, and the probe run that found it the hard way.
 */
const fakeCaches = (
  options: { failPut?: boolean; add?: (url: string) => Promise<Response> } = {},
) => {
  const caches = new Map<string, Map<string, Response>>();
  const addAllCalls: string[][] = [];
  const api = {
    async open(name: string) {
      const entries = caches.get(name) ?? new Map<string, Response>();
      caches.set(name, entries);
      return {
        async match(given: Request | string, matchOptions?: { ignoreVary?: boolean }) {
          if (matchOptions?.ignoreVary !== true) return undefined;
          const url = typeof given === 'string' ? new URL(given, ORIGIN).href : given.url;
          return entries.get(url);
        },
        async put(given: Request, value: Response) {
          if (options.failPut === true) throw new Error('quota exceeded');
          entries.set(given.url, value);
        },
        async addAll(urls: string[]) {
          addAllCalls.push(urls);
          for (const url of urls) entries.set(new URL(url, ORIGIN).href, response(`shell ${url}`));
        },
        async add(url: string) {
          const fetched = await (options.add?.(url) ?? Promise.resolve(response(`asset ${url}`)));
          entries.set(new URL(url, ORIGIN).href, fetched);
        },
      };
    },
    async keys() {
      return [...caches.keys()];
    },
    async delete(name: string) {
      return caches.delete(name);
    },
  };
  return {
    api: api as unknown as CacheStorage,
    addAllCalls,
    names: (): string[] => [...caches.keys()],
    seed(name: string, entries: readonly Stored[]): void {
      const map = new Map<string, Response>();
      for (const entry of entries) map.set(new URL(entry.url, ORIGIN).href, response(entry.body));
      caches.set(name, map);
    },
    contents(name = SHELL_CACHE): string[] {
      return [...(caches.get(name)?.keys() ?? [])];
    },
  };
};

const handlersWith = (
  storage: ReturnType<typeof fakeCaches>,
  network: (given: Request | string) => Promise<Response>,
  base: string = AT_ROOT,
) => shellCacheHandlers({ caches: storage.api, fetch: network, base });

/** A network that answers the build's asset list, and nothing else. */
const listing = (body: unknown, init: { ok?: boolean; broken?: boolean; base?: string } = {}) => {
  const url = new URL(SHELL_ASSETS_PATH, init.base ?? AT_ROOT).href;
  return async (given: Request | string): Promise<Response> => {
    if (given !== url) throw new TypeError('Failed to fetch');
    const answer = response('list', { ok: init.ok ?? true });
    return {
      ...answer,
      json: async () => {
        if (init.broken === true) throw new SyntaxError('Unexpected token');
        return body;
      },
    } as unknown as Response;
  };
};

const offline = async (): Promise<Response> => {
  throw new TypeError('Failed to fetch');
};

describe('what belongs to the shell', () => {
  for (const base of [AT_ROOT, UNDER_PATH]) {
    describe(`served at ${base}`, () => {
      it('claims the hashed assets and the files a launch names', () => {
        expect(isShellAsset(`${base}assets/index-a1b2c3.js`, base)).toBe(true);
        expect(isShellAsset(`${base}icons/icon-192.png`, base)).toBe(true);
        expect(isShellAsset(`${base}manifest.webmanifest`, base)).toBe(true);
      });

      it('claims nothing from another origin, however it is spelled', () => {
        expect(isShellAsset('https://other.example/assets/index.js', base)).toBe(false);
        expect(isShellAsset('wss://db.internal:8563/', base)).toBe(false);
      });

      it('refuses anything carrying a query, because the answer depends on it', () => {
        expect(isShellAsset(`${base}assets/index.js?v=2`, base)).toBe(false);
      });

      it('refuses a path that is not part of the build', () => {
        expect(isShellAsset(`${base}mcp`, base)).toBe(false);
        expect(isShellAsset(base, base)).toBe(false);
      });
    });
  }

  /**
   * The failure this arrangement exists to rule out: an application under a path
   * treating the origin's own `/assets/` as its own. On a project site that is a
   * neighbour's files, and serving them from this cache would be serving one site
   * out of another's worker.
   */
  it('does not claim the origin root when it is served under a path', () => {
    expect(isShellAsset(`${ORIGIN}/assets/somebody-else.js`, UNDER_PATH)).toBe(false);
    expect(isShellAsset(`${ORIGIN}/manifest.webmanifest`, UNDER_PATH)).toBe(false);
    expect(isShellAsset(`${ORIGIN}/`, UNDER_PATH)).toBe(false);
    // And the reverse: a root deployment does not answer for a subdirectory that
    // happens to be named like one of its own.
    expect(isShellAsset(`${UNDER_PATH}assets/index.js`, AT_ROOT)).toBe(false);
  });
});

describe('installing', () => {
  it('fetches the shell into its own cache', async () => {
    const storage = fakeCaches();
    await handlersWith(storage, offline).install();
    expect(storage.addAllCalls).toEqual([SHELL_PATHS.map((path) => new URL(path, AT_ROOT).href)]);
    expect(storage.names()).toEqual([SHELL_CACHE]);
  });

  /**
   * Why the build emits a list at all: the renderer imports shader chunks the
   * first time it draws something, so an install that cached only what the launch
   * happened to fetch left an offline application unable to open a table.
   */
  it('also fetches everything the build said it produced', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(
      storage,
      listing(['/assets/index-a1.js', '/assets/shader-b2.js']),
    );
    await handlers.install();
    expect(storage.contents()).toContain(`${ORIGIN}/assets/index-a1.js`);
    expect(storage.contents()).toContain(`${ORIGIN}/assets/shader-b2.js`);
  });

  it('takes from the list only what the shell could contain', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(
      storage,
      listing([
        '/assets/index-a1.js',
        'https://elsewhere.example/tracker.js',
        '/etc/passwd',
        '/assets/index.js?token=secret',
        42,
        null,
      ]),
    );
    expect(await handlers.listedAssets()).toEqual(['/assets/index-a1.js']);
  });

  it('installs anyway when there is no list to read', async () => {
    for (const network of [
      offline,
      listing([], { ok: false }),
      listing(null, { broken: true }),
      listing({ assets: ['/assets/index-a1.js'] }),
    ]) {
      const storage = fakeCaches();
      const handlers = handlersWith(storage, network);
      await handlers.install();
      expect(await handlers.listedAssets()).toEqual([]);
      expect(storage.contents()).toEqual(SHELL_PATHS.map((path) => new URL(path, AT_ROOT).href));
    }
  });

  /**
   * Under a path, everything moves: the document, the list, and every asset in
   * it. This is the case a build hosted at an origin's root can never exercise
   * and a project site is always in.
   */
  it('installs an application served under a path, entirely under that path', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(
      storage,
      listing(['assets/index-a1.js', 'icons/icon-192.png'], { base: UNDER_PATH }),
      UNDER_PATH,
    );
    await handlers.install();
    const cached = storage.contents();
    expect(cached).toContain(`${UNDER_PATH}assets/index-a1.js`);
    expect(cached).toContain(`${UNDER_PATH}icons/icon-192.png`);
    expect(cached).toContain(UNDER_PATH);
    expect(cached).toContain(`${UNDER_PATH}manifest.webmanifest`);
    // Nothing of the origin's own root, which belongs to whatever else is there.
    expect(cached.some((url) => !url.startsWith(UNDER_PATH))).toBe(false);
  });

  it('serves that application its own document when the network is gone', async () => {
    const storage = fakeCaches();
    storage.seed(SHELL_CACHE, [{ url: `${UNDER_PATH}`, body: 'the app' }]);
    const handlers = handlersWith(storage, offline, UNDER_PATH);
    const answer = await handlers.handle(request(`${UNDER_PATH}deep/link`, { mode: 'navigate' }))!;
    expect(bodyOf(answer)).toBe('the app');
  });

  it('is not failed by one asset a deployment no longer has', async () => {
    const storage = fakeCaches({
      add: async (url) => {
        if (url.includes('gone')) throw new TypeError('404');
        return response(`asset ${url}`);
      },
    });
    const handlers = handlersWith(storage, listing(['/assets/gone-a1.js', '/assets/here-b2.js']));
    await handlers.install();
    expect(storage.contents()).toContain(`${ORIGIN}/assets/here-b2.js`);
  });
});

describe('activating', () => {
  it('discards earlier Panorama caches and leaves everything else alone', async () => {
    const storage = fakeCaches();
    storage.seed('panorama-shell-v0', [{ url: '/', body: 'old' }]);
    storage.seed(SHELL_CACHE, [{ url: '/', body: 'new' }]);
    storage.seed('something-else', [{ url: '/', body: 'theirs' }]);
    await handlersWith(storage, offline).activate();
    expect(storage.names()).toEqual([SHELL_CACHE, 'something-else']);
  });
});

describe('answering the document', () => {
  it('takes the network when there is one, and keeps a copy', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(storage, async () => response('fresh'));
    const answer = await handlers.handle(request('/', { mode: 'navigate' }))!;
    expect(bodyOf(answer)).toBe('fresh');
    expect(storage.contents()).toEqual([`${ORIGIN}/`]);
  });

  it('serves the last copy when the network is gone', async () => {
    const storage = fakeCaches();
    storage.seed(SHELL_CACHE, [{ url: '/', body: 'cached' }]);
    const handlers = handlersWith(storage, offline);
    const answer = await handlers.handle(request('/', { mode: 'navigate' }))!;
    expect(bodyOf(answer)).toBe('cached');
  });

  it('serves the cached document for a deep link it has never seen', async () => {
    const storage = fakeCaches();
    storage.seed(SHELL_CACHE, [{ url: '/', body: 'cached' }]);
    const handlers = handlersWith(storage, offline);
    const answer = await handlers.handle(request('/somewhere', { mode: 'navigate' }))!;
    expect(bodyOf(answer)).toBe('cached');
  });

  it('reports the network failure when there is nothing to fall back on', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(storage, offline);
    await expect(handlers.handle(request('/', { mode: 'navigate' }))).rejects.toThrow(
      'Failed to fetch',
    );
  });

  it('recognises the document by what it is for as well as by navigation', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(storage, async () => response('fresh'));
    const answer = handlers.handle(request('/', { destination: 'document' }));
    expect(answer).not.toBeNull();
    expect(bodyOf(await answer!)).toBe('fresh');
  });

  it('does not keep a copy of an error page', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(storage, async () => response('server error', { ok: false }));
    await handlers.handle(request('/', { mode: 'navigate' }))!;
    expect(storage.contents()).toEqual([]);
  });
});

describe('answering a hashed asset', () => {
  it('serves it from the cache without asking the network', async () => {
    const storage = fakeCaches();
    storage.seed(SHELL_CACHE, [{ url: '/assets/index-a1.js', body: 'cached' }]);
    let asked = 0;
    const handlers = handlersWith(storage, async () => {
      asked += 1;
      return response('network');
    });
    const answer = await handlers.handle(request('/assets/index-a1.js'))!;
    expect(bodyOf(answer)).toBe('cached');
    expect(asked).toBe(0);
  });

  /**
   * The failure this exists for: cached, and then not found, because the host
   * said `Vary: Origin` and the request that filled the cache carried a different
   * one. Offline, the miss became a fetch against no network — so an application
   * that had every byte on the device could not draw a table.
   */
  it('finds it even though the host said the response varies', async () => {
    const storage = fakeCaches();
    storage.seed(SHELL_CACHE, [{ url: '/assets/index-a1.js', body: 'cached' }]);
    const handlers = handlersWith(storage, offline);
    const answer = await handlers.handle(request('/assets/index-a1.js'))!;
    expect(bodyOf(answer)).toBe('cached');
  });

  it('fetches and keeps one it has not seen', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(storage, async () => response('network'));
    const answer = await handlers.handle(request('/assets/index-a1.js'))!;
    expect(bodyOf(answer)).toBe('network');
    expect(storage.contents()).toEqual([`${ORIGIN}/assets/index-a1.js`]);
  });

  it('still answers when the copy cannot be kept', async () => {
    const storage = fakeCaches({ failPut: true });
    const handlers = handlersWith(storage, async () => response('network'));
    const answer = await handlers.handle(request('/assets/index-a1.js'))!;
    expect(bodyOf(answer)).toBe('network');
  });

  it('does not keep an opaque response from somewhere else', async () => {
    const storage = fakeCaches();
    const handlers = handlersWith(storage, async () => response('opaque', { type: 'opaque' }));
    await handlers.handle(request('/assets/index-a1.js'))!;
    expect(storage.contents()).toEqual([]);
  });
});

describe('what the worker keeps its hands off', () => {
  it('passes through a request for data', () => {
    const handlers = handlersWith(fakeCaches(), offline);
    expect(handlers.handle(request('/query?sql=select+1'))).toBeNull();
    expect(handlers.handle(request('https://other.example/rows.json'))).toBeNull();
  });

  it('passes through anything that is not a GET, including to the shell', () => {
    const handlers = handlersWith(fakeCaches(), offline);
    expect(handlers.handle(request('/', { method: 'POST', mode: 'navigate' }))).toBeNull();
    expect(handlers.handle(request('/assets/index-a1.js', { method: 'HEAD' }))).toBeNull();
  });

  it('passes through the agent interface, which is a dev server and not a build', () => {
    const handlers = handlersWith(fakeCaches(), offline);
    expect(handlers.handle(request('/mcp'))).toBeNull();
  });
});
