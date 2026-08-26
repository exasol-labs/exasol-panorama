/**
 * Registering the service worker, and the one condition on doing it.
 *
 * A development server rewrites modules as they are edited; a worker that answers
 * from a cache in front of it turns a saved file into a stale page and an hour
 * into a debugging session. So this runs in a build and not in development — the
 * flag is passed in rather than read here, so the decision is visible at the call
 * site and testable from both sides.
 *
 * There is a second reason, and it is the more concrete one: the worker is built
 * as its own entry point, so in development nothing is served at that path and
 * the request falls through to the application's own document. A browser handed
 * HTML where a script was asked for refuses it, correctly and confusingly.
 *
 * Registration is otherwise best-effort. A worker is a launch optimisation and an
 * offline story; a browser that refuses one (a private window, a policy, an
 * insecure origin) should still get the application, so a failure is reported and
 * dropped rather than raised.
 */

/** The worker's file name, which is also the last part of the path it is served at. */
export const SERVICE_WORKER_FILE = 'service-worker.js';

interface ServiceWorkerRegistrar {
  register(path: string, options: { readonly scope: string }): Promise<unknown>;
}

interface RegistrarHost {
  readonly serviceWorker?: ServiceWorkerRegistrar | undefined;
}

export interface RegisterShellOptions {
  /** False in development, where a cache in front of the dev server only lies. */
  readonly enabled: boolean;
  /**
   * Where the application is served from, ending in a slash — `import.meta.env`'s
   * `BASE_URL` at the call site.
   *
   * A worker can only claim the directory it is served from, so a build hosted
   * under a path has to register the worker under that path: asking for `/` from
   * a page at `/panorama/` is refused outright by the browser, and asking for
   * `/service-worker.js` fetches whatever is at the origin's root, which is
   * somebody else's application.
   */
  readonly base?: string | undefined;
  readonly host?: RegistrarHost | undefined;
  readonly onProblem?: ((error: unknown) => void) | undefined;
}

/**
 * What happened, as a value: the browser probe reads it, and it is the difference
 * between "this browser cannot" and "this build chose not to".
 */
export type ShellRegistration = 'registered' | 'failed' | 'unsupported' | 'disabled';

export const registerShell = async (options: RegisterShellOptions): Promise<ShellRegistration> => {
  if (!options.enabled) return 'disabled';
  const registrar = options.host?.serviceWorker;
  if (registrar === undefined) return 'unsupported';
  const base = options.base ?? '/';
  try {
    await registrar.register(`${base}${SERVICE_WORKER_FILE}`, { scope: base });
    return 'registered';
  } catch (error) {
    options.onProblem?.(error);
    return 'failed';
  }
};
