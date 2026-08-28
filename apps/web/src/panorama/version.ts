/**
 * What version this is, and what version is waiting.
 *
 * Two different questions with two different answers, and keeping them apart is
 * the point of this file. *This* build's number is compiled in, so asking costs
 * nothing and cannot fail. The number of a build that has arrived since — the one
 * a waiting service worker is holding — cannot be compiled into anything, because
 * it did not exist when this was built. It has to be fetched.
 */

/**
 * The version this page is running.
 *
 * `__PANORAMA_VERSION__` is replaced by the build, and the guard is not
 * decoration: the test run compiles this module without the definition, so
 * removing it turns every test that renders the shell into a `ReferenceError`.
 * The same guard, for the same reason, is in `startup.ts`.
 *
 * An empty string is the honest answer to "which version is this" when nothing
 * said — and the settings panel shows no row rather than an empty one.
 */
export const appVersion = (): string =>
  typeof __PANORAMA_VERSION__ === 'undefined' ? '' : __PANORAMA_VERSION__;

/** Where the build publishes its number for a running page to read. */
export const VERSION_PATH = 'version.json';

/**
 * The version in a fetched `version.json`, or `null` for anything else.
 *
 * Anything else is a real possibility rather than a defensive flourish: a page
 * served under a path whose host answers 404 with an HTML page will parse, and
 * naming a version out of somebody's error document is worse than not naming one.
 */
export const versionIn = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null) return null;
  const version = (body as { version?: unknown }).version;
  return typeof version === 'string' && version !== '' ? version : null;
};

/**
 * Where to ask, from where the application says it is served.
 *
 * `import.meta.env.BASE_URL` is a path — `/`, or `/panorama/` under one — and a
 * path is not a base a `URL` can be built against; `new URL('version.json', '/')`
 * throws. So it is resolved against the document first, which is what makes it
 * absolute and what makes a build served under a path ask its own host rather
 * than somebody's root.
 */
export const versionUrl = (base: string, here: string): string =>
  new URL(VERSION_PATH, new URL(base, here)).href;

/**
 * Asks the deployment what it is now, for a page that has been told an update is
 * waiting.
 *
 * `no-store`, because the whole question is what changed, and the one thing worse
 * than not knowing is being handed the answer this page started with.
 */
export const fetchVersion = async (
  base: string,
  /** The document's own URL, which is what makes `base` absolute. */
  here: string,
  get: (url: string, init: RequestInit) => Promise<Response> = (url, init) => fetch(url, init),
): Promise<string | null> => {
  try {
    const response = await get(versionUrl(base, here), { cache: 'no-store' });
    if (!response.ok) return null;
    return versionIn(await response.json());
  } catch {
    return null;
  }
};
