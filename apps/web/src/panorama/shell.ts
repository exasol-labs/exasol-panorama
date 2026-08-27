/**
 * Whether this page is inside the desktop application rather than in a browser.
 *
 * The same build serves both — `apps/desktop` bundles this very `dist` — so the
 * two are told apart at runtime rather than by building twice. One artifact, two
 * packagings, and no chance of the browser build and the desktop build diverging
 * into different applications.
 *
 * There is exactly one thing this decides today, and it is not cosmetic. The
 * installed browser application keeps its shell in a cache so it can launch with
 * no network; the desktop application *is* on the device already, so a cache in
 * front of it can only ever be a way of being shown a file that has since been
 * replaced by an update. The shell also serves the document from its own scheme,
 * where registering a worker fails — so the check saves a warning as well as a
 * bug. See `install.ts` for the other half of that decision.
 *
 * What it will decide next is where the agent endpoint is: in a browser it is the
 * origin the page came from, and in the shell it is the process hosting the
 * window. That is why this is a named concept rather than an inline condition at
 * the one call site.
 *
 * The marker is the shell's own: Tauri defines `__TAURI_INTERNALS__` on the
 * window before any application code runs. Read through a parameter so both
 * answers can be tested without pretending to be a webview.
 */

export interface ShellHost {
  readonly __TAURI_INTERNALS__?: unknown;
}

export const inDesktopShell = (host: ShellHost = globalThis as ShellHost): boolean =>
  host.__TAURI_INTERNALS__ !== undefined;

export interface PageLocation {
  readonly protocol: string;
  readonly origin: string;
}

/**
 * Where this page's agent endpoint is, or `null` when it has none.
 *
 * In a browser it is the origin the document came from — the development server,
 * which hosts both, or a deployed origin where the stream simply never opens.
 * That is the existing arrangement and it is unchanged.
 *
 * The desktop application is the case worth spelling out. Its document is served
 * from the shell's own scheme, and an event stream against a scheme that is not
 * HTTP is refused *when it is constructed* rather than by failing to connect —
 * which, at module scope, is a blank window instead of an application. So the
 * answer there is `null` and nothing is attempted.
 *
 * With one exception, and it is the useful one: `npm run desktop` points the shell
 * at the development server, so the document arrives over HTTP from a process that
 * *does* host the endpoint. Deciding on the document's scheme rather than on being
 * in the shell is what keeps an agent working in that window.
 */
export const agentEndpointOrigin = (
  location: PageLocation,
  host: ShellHost = globalThis as ShellHost,
): string | null => {
  if (!inDesktopShell(host)) return location.origin;
  return location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : null;
};
