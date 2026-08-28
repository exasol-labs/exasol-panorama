import { describe, expect, it } from 'vitest';
import type { WatchedRegistration, WatchedWorker } from '../src/panorama/updates.js';
import { CHECK_EVERY_MS, FIRST_CHECK_MS, watchForUpdate } from '../src/panorama/updates.js';
import { VERSION_PATH, fetchVersion, versionIn, versionUrl } from '../src/panorama/version.js';

/**
 * A service worker that has installed a new build and is waiting for the windows
 * to close, and the page noticing it.
 *
 * The policy it serves is in `plans/panorama-live-updates-plan.md`: the update
 * applies when the application is closed and never while it is open, which leaves
 * exactly one thing for the page to do — say so, once, and otherwise stay out of
 * the way.
 */

const worker = (state: string): WatchedWorker & { move(to: string): void } => {
  const listeners: Array<() => void> = [];
  let current = state;
  return {
    get state(): string {
      return current;
    },
    addEventListener: (_type, listener) => listeners.push(listener),
    move(to: string): void {
      current = to;
      for (const listener of [...listeners]) listener();
    },
  };
};

const registration = (
  parts: { waiting?: WatchedWorker | null; installing?: WatchedWorker | null } = {},
): WatchedRegistration & { found(installing: WatchedWorker): void; checks: number } => {
  const found: Array<() => void> = [];
  const state = {
    waiting: parts.waiting ?? null,
    installing: parts.installing ?? null,
    checks: 0,
    addEventListener: (_type: 'updatefound', listener: () => void) => found.push(listener),
    update: async (): Promise<unknown> => {
      state.checks += 1;
      return undefined;
    },
    found(installing: WatchedWorker): void {
      state.installing = installing;
      for (const listener of [...found]) listener();
    },
  };
  return state;
};

/** A clock a test drives, so nothing here waits a real minute. */
const timers = (): {
  setTimer: (run: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
  readonly pending: Array<{ run: () => void; ms: number }>;
  fire(): void;
  cleared: number;
} => {
  const pending: Array<{ run: () => void; ms: number }> = [];
  const clock = {
    pending,
    cleared: 0,
    setTimer: (run: () => void, ms: number): unknown => {
      pending.push({ run, ms });
      return pending.length;
    },
    clearTimer: (): void => {
      clock.cleared += 1;
    },
    fire(): void {
      const next = pending.shift();
      next?.run();
    },
  };
  return clock;
};

const watch = (
  parts: Parameters<typeof registration>[0],
  extra: { controlled?: boolean } = {},
): {
  told: string[];
  clock: ReturnType<typeof timers>;
  worker: ReturnType<typeof registration>;
  stop: () => void;
} => {
  const clock = timers();
  const found = registration(parts);
  const told: string[] = [];
  const stop = watchForUpdate({
    registration: found,
    controlled: () => extra.controlled ?? true,
    onWaiting: () => told.push('waiting'),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { told, clock, worker: found, stop };
};

describe('noticing a waiting version', () => {
  it('says so when one was already waiting before the page opened', () => {
    const { told } = watch({ waiting: worker('installed') });
    expect(told).toEqual(['waiting']);
  });

  it('says so when one finishes installing while the page is open', () => {
    const { told, worker: found } = watch({});
    expect(told).toEqual([]);
    const arriving = worker('installing');
    found.found(arriving);
    // Not yet: a worker that is still installing is not one anybody can use.
    expect(told).toEqual([]);
    arriving.move('installed');
    expect(told).toEqual(['waiting']);
  });

  it('says so once, however many ways it hears', () => {
    const { told, worker: found } = watch({ waiting: worker('installed') });
    const arriving = worker('installed');
    found.found(arriving);
    found.found(arriving);
    expect(told).toEqual(['waiting']);
  });

  /**
   * An install that fails goes straight to `redundant`. Nothing is waiting, so
   * there is nothing to say — and saying it would send somebody to close a window
   * for a version that does not exist.
   */
  it('says nothing about a worker that never finished installing', () => {
    const { told, worker: found } = watch({});
    const arriving = worker('installing');
    found.found(arriving);
    arriving.move('redundant');
    expect(told).toEqual([]);
  });

  /**
   * A first install reaches `installed` exactly like an update does, and telling
   * somebody who has just opened Panorama for the first time that a new version
   * is ready would be nonsense: what they are running *is* the new one. The
   * difference is whether a worker was already in charge of this page.
   */
  it('says nothing on a first install, which looks the same and is not', () => {
    const { told, worker: found } = watch({ waiting: worker('installed') }, { controlled: false });
    expect(told).toEqual([]);
    const arriving = worker('installing');
    found.found(arriving);
    arriving.move('installed');
    expect(told).toEqual([]);
  });
});

describe('asking whether there is one', () => {
  /**
   * Nothing asks on its own: a browser looks for a new worker on navigation and
   * roughly daily, which for an application somebody leaves open for a week is
   * never. So the page asks — but late, because the first seconds of a session
   * belong to the person who just opened it.
   */
  it('waits a minute before the first check, then asks rarely', () => {
    const { clock, worker: found } = watch({});
    expect(clock.pending[0]?.ms).toBe(FIRST_CHECK_MS);
    expect(found.checks).toBe(0);

    clock.fire();
    expect(found.checks).toBe(1);
    expect(clock.pending[0]?.ms).toBe(CHECK_EVERY_MS);

    clock.fire();
    expect(found.checks).toBe(2);
  });

  it('stops asking when the page goes away', () => {
    const { clock, stop } = watch({});
    stop();
    expect(clock.cleared).toBe(1);
    // And is safe to call twice, which a React effect will do under StrictMode.
    stop();
    expect(clock.cleared).toBe(1);
  });

  /**
   * A machine with no network is not a machine with a problem to report. The
   * check is a courtesy and a failed one is worth nothing to anybody.
   */
  it('says nothing at all when the check itself fails', () => {
    const clock = timers();
    const stop = watchForUpdate({
      registration: {
        waiting: null,
        installing: null,
        addEventListener: () => undefined,
        update: () => Promise.reject(new Error('offline')),
      },
      controlled: () => true,
      onWaiting: () => expect.unreachable('a failed check is not an update'),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
    expect(() => clock.fire()).not.toThrow();
    stop();
  });

  it('uses real timers when none are handed to it', () => {
    const found = registration({});
    const stop = watchForUpdate({
      registration: found,
      controlled: () => true,
      onWaiting: () => undefined,
      firstCheckMs: 0,
    });
    expect(() => stop()).not.toThrow();
  });
});

describe('what the waiting version is called', () => {
  it('reads a version out of what the deployment published', () => {
    expect(versionIn({ version: '0.2.0' })).toBe('0.2.0');
  });

  /**
   * A host that answers a missing file with an HTML error page parses as
   * something, and naming a version out of somebody's error document is worse
   * than not naming one — the notice says "a new version" instead, which is true.
   */
  it('reads nothing out of anything else', () => {
    expect(versionIn(null)).toBeNull();
    expect(versionIn('0.2.0')).toBeNull();
    expect(versionIn({})).toBeNull();
    expect(versionIn({ version: 7 })).toBeNull();
    expect(versionIn({ version: '' })).toBeNull();
  });

  it('asks the deployment, past any cache', async () => {
    const asked: Array<{ url: string; cache: string | undefined }> = [];
    const version = await fetchVersion(
      '/',
      'https://panorama.example/index.html',
      async (url, init) => {
        asked.push({ url, cache: init.cache });
        return new Response(JSON.stringify({ version: '0.2.0' }), { status: 200 });
      },
    );
    expect(version).toBe('0.2.0');
    expect(asked[0]?.url).toBe(`https://panorama.example/${VERSION_PATH}`);
    // The whole question is what changed; a cached answer is the one answer that
    // is always wrong.
    expect(asked[0]?.cache).toBe('no-store');
  });

  /**
   * `BASE_URL` is a path, not a URL, and `new URL('version.json', '/')` throws —
   * so the base has to be resolved against the document before anything is built
   * on it. Under a path it must ask its own host rather than somebody's root.
   */
  it('asks its own host, wherever the build was served from', () => {
    expect(versionUrl('/', 'https://panorama.example/index.html')).toBe(
      'https://panorama.example/version.json',
    );
    expect(versionUrl('/panorama/', 'https://example.com/panorama/index.html')).toBe(
      'https://example.com/panorama/version.json',
    );
  });

  it('gives up quietly on a refusal or a failure', async () => {
    expect(
      await fetchVersion('/', 'https://x/', async () => new Response('', { status: 404 })),
    ).toBeNull();
    expect(
      await fetchVersion('/', 'https://x/', () => Promise.reject(new Error('offline'))),
    ).toBeNull();
  });
});
