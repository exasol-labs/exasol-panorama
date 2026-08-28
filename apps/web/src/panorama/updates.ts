/**
 * Noticing that a new version is waiting, without ever getting in the way.
 *
 * The service worker installs a new build and then waits (see
 * `../service-worker.ts`), so the new version is what opens next time rather than
 * what interrupts this time. That is the right behaviour and it has one flaw: it
 * is completely silent. A window left open for a week runs last week's build and
 * gives no sign of it.
 *
 * So this watches for the waiting worker and reports it once. It reports and does
 * nothing else — no reload, no prompt, no button that swaps the application out
 * from under a half-written statement. What the user does with the knowledge is
 * the user's business, and closing the window is all it takes.
 *
 * Three ways the same fact arrives, because which one fires depends on when the
 * update happened relative to this page:
 *
 * - It was already waiting when the page opened — `registration.waiting`.
 * - It arrives while the page is open — `updatefound`, then that worker reaching
 *   `installed`.
 * - Nothing told us, because nothing asks on its own: a browser checks for a new
 *   worker on navigation and roughly daily, which for an application somebody
 *   leaves open is never. Hence the poll.
 *
 * The poll deliberately does not start at launch. The first seconds of a session
 * are when the application is being judged and when the network is busiest with
 * the things the user actually asked for; a version check belongs after that, and
 * nothing is lost by asking a minute late.
 */

/** How long after opening before the first check. Late, on purpose. */
export const FIRST_CHECK_MS = 60_000;

/** And how often after that. Rare: this is a courtesy, not a heartbeat. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1_000;

/**
 * How often the page asks the shell what it is holding.
 *
 * Much more often than the shell itself looks for an update, and that is not a
 * contradiction: this is a lock and a string over a local pipe, not a network
 * round trip, and the cost of asking is nothing next to a note that appears four
 * hours after the thing it describes.
 *
 * Polled rather than pushed. An event from the shell would be tidier by a hair
 * and would need a second channel, its own lifecycle and its own failure mode,
 * for a fact that changes once in a working day.
 */
export const ASK_SHELL_EVERY_MS = 5 * 60 * 1_000;

export interface WatchShellOptions {
  /** Asks the shell what it has staged; `null` while there is nothing. */
  readonly ask: () => Promise<string | null>;
  /** Called once, with the version that will be installed on the next quit. */
  readonly onStaged: (version: string) => void;
  readonly firstCheckMs?: number | undefined;
  readonly checkEveryMs?: number | undefined;
  readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((timer: unknown) => void) | undefined;
}

/**
 * Watches the desktop shell for an update it has downloaded and is holding.
 *
 * The shell does the looking, the downloading and — when the window closes — the
 * installing; all this does is find out, so the page can say so. It stops asking
 * once there is an answer: a second staged version cannot arrive before the first
 * one is installed, and the first one is installed by quitting.
 */
export const watchShellUpdate = (options: WatchShellOptions): (() => void) => {
  const setTimer = options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));

  let timer: unknown = null;
  let stopped = false;
  const ask = (): void => {
    void options.ask().then(
      (version) => {
        if (stopped) return;
        if (version !== null) {
          options.onStaged(version);
          return;
        }
        timer = setTimer(ask, options.checkEveryMs ?? ASK_SHELL_EVERY_MS);
      },
      // A shell that will not answer is not a thing to report: there is nothing
      // the person could do about it and nothing to show.
      () => {
        if (!stopped) timer = setTimer(ask, options.checkEveryMs ?? ASK_SHELL_EVERY_MS);
      },
    );
  };
  timer = setTimer(ask, options.firstCheckMs ?? FIRST_CHECK_MS);

  return (): void => {
    stopped = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
};

/** The part of a `ServiceWorker` this needs, so a test needs no browser. */
export interface WatchedWorker {
  readonly state: string;
  addEventListener(type: 'statechange', listener: () => void): void;
}

/** The part of a `ServiceWorkerRegistration` this needs. */
export interface WatchedRegistration {
  readonly waiting: WatchedWorker | null;
  readonly installing: WatchedWorker | null;
  addEventListener(type: 'updatefound', listener: () => void): void;
  update(): Promise<unknown>;
}

export interface WatchUpdatesOptions {
  readonly registration: WatchedRegistration;
  /**
   * Whether a worker is in charge of this page, asked *when it matters*.
   *
   * This is what tells an update from a first install: on a first install a
   * worker reaches `installed` too, and telling somebody who has just opened
   * Panorama for the first time that a new version is ready would be nonsense —
   * the version they are running *is* the new one.
   *
   * A function rather than a value, and that is not a style choice. On a first
   * visit the page is not controlled when the watch begins: the worker activates
   * and calls `clients.claim()` a beat later. A boolean captured at the start is
   * therefore `false` for the whole session, which silently turns every update
   * into a "first install" and reports nothing, ever. Asked at the moment a
   * worker finishes installing, the answer is the one the question meant.
   */
  readonly controlled: () => boolean;
  /** Called once, when a new version is genuinely waiting to be used. */
  readonly onWaiting: () => void;
  readonly firstCheckMs?: number | undefined;
  readonly checkEveryMs?: number | undefined;
  /**
   * Injected so a test can drive the clock rather than wait on it. The handle is
   * opaque: a browser's timer is a number and Node's is an object, and this
   * module has no reason to have an opinion about which it was handed.
   */
  readonly setTimer?: ((run: () => void, ms: number) => unknown) | undefined;
  readonly clearTimer?: ((timer: unknown) => void) | undefined;
}

/**
 * Watches one registration and calls back at most once. Returns a function that
 * stops the polling, for a page that is going away.
 */
export const watchForUpdate = (options: WatchUpdatesOptions): (() => void) => {
  const { registration, controlled, onWaiting } = options;
  const setTimer = options.setTimer ?? ((run, ms) => globalThis.setTimeout(run, ms));
  const clearTimer =
    options.clearTimer ??
    ((timer) => globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>));

  let told = false;
  const tell = (): void => {
    if (told) return;
    told = true;
    onWaiting();
  };

  /**
   * A worker that has finished installing behind the one in charge.
   *
   * `installed` rather than `activated` is the state to watch: activation is what
   * this policy is deliberately deferring until the windows close, so waiting for
   * it would mean never saying anything at all.
   */
  const whenInstalled = (worker: WatchedWorker | null): void => {
    if (worker === null || !controlled()) return;
    if (worker.state === 'installed') {
      tell();
      return;
    }
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') tell();
    });
  };

  // Already there before this page ever ran.
  if (registration.waiting !== null && controlled()) tell();
  registration.addEventListener('updatefound', () => whenInstalled(registration.installing));

  let timer: unknown = null;
  const check = (): void => {
    // Failure is silence: a machine with no network is not a machine with a
    // problem to report, and there is nothing here worth a console line.
    void registration.update().catch(() => undefined);
    timer = setTimer(check, options.checkEveryMs ?? CHECK_EVERY_MS);
  };
  timer = setTimer(check, options.firstCheckMs ?? FIRST_CHECK_MS);

  return (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
};
