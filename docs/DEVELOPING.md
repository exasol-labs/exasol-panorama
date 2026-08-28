# Developing Panorama

Running it from source, the commands worth knowing, and how the two packagings are
built and released.

For _why_ it is shaped the way it is, read
[ARCHITECTURE.md](ARCHITECTURE.md). For how it is proved, read
[TESTING.md](TESTING.md).

---

## 1. Running it

Node ≥ 20.11, and nothing else.

```bash
npm install
npm run dev            # http://localhost:5173
```

Connecting it to a database is [CONNECTING.md](CONNECTING.md).

There is a set of synthetic relations for driving it without one — a
ten-billion-row table, a 5 000-column one, a null-heavy one, and one covering
every Exasol type — served through the same data worker, cache and scheduler a
real connection uses. **Nothing in the interface offers them**, because somebody
opening Panorama has come to look at their own data. They live in
`apps/web/src/panorama/demo.ts` under the schema `PANORAMA_DEMO`, and the two
things that use them reach them by name:

```js
// In a browser probe — see scripts/lib/open-sample.mjs
await openSample(page, 'VERY_WIDE');
// As an agent would
{ "name": "open_table", "arguments": { "schema": "PANORAMA_DEMO", "table": "SALES" } }
```

## 2. The commands

| Command                 | What it does                                                                |
| ----------------------- | --------------------------------------------------------------------------- |
| `npm run dev`           | The app, and the agent endpoint with it                                     |
| `npm test`              | The suite                                                                   |
| `npm run verify`        | Typecheck across every package, then the suite with coverage — **the gate** |
| `npm run build`         | Production bundle                                                           |
| `npm run preview`       | Serves that bundle on `http://localhost:4173`                               |
| `npm run format`        | Prettier over everything                                                    |
| `npm run desktop`       | A window on the dev server: needs `npm run dev` in another terminal         |
| `npm run desktop:build` | Builds the web app, then bundles it                                         |
| `npm run desktop:debug` | The same bundle with devtools left in — right-click, Inspect Element        |
| `npm run dev:probe`     | The dev server on port 5199, which the browser probes expect                |
| `npm run icons`         | Redraws the icons after a change to the mark                                |

`npm run verify` is what CI runs on every push and pull request, along with
`format:check` and the installability probe — see
[.github/workflows/verify.yml](../.github/workflows/verify.yml). Nothing in CI is a
CI-only standard: if it passes there, it passes here.

The browser probes — `smoke`, `resize-check`, `chart-check` and the rest — are in
[TESTING.md §8](TESTING.md#8-browser-probes).

> **If you are changing something a user will see in the desktop application,
> finish with `npm run desktop:build`.** The bundle in
> `apps/desktop/src-tauri/target/release/bundle/` is a release build; nothing in
> the source tree or the development server reaches it until it is rebuilt.

## 3. If the canvas stays blank

The renderer reports startup and per-frame failures as a message in the sidebar
and on the console, and retries with WebGL when the preferred backend cannot start
or cannot draw its first frame. Each attempt gets a **fresh canvas element**: a
graphics context is bound to its canvas for that canvas's lifetime, so retrying on
the same element cannot obtain a context at all and fails with a misleading "WebGL
not supported".

To force a backend without rebuilding:

```
http://localhost:5173/?backend=webgl
http://localhost:5173/?backend=webgpu
```

The overlay's **Backend** field shows which one is live; `—` with 0 FPS means no
engine ever started. It starts collapsed to the frame-rate pill in the top-right
corner of the canvas — click that for the full set of numbers, and **Hide** to put
it away again.

## 4. The desktop application

One web build, packaged two ways, and both come out of a release:

|                         | What it is                                                                                            | Where it fits                                                                 |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| **Desktop application** | `apps/desktop` — the build in a window of its own, bundled by Tauri: a `.dmg`, an installer, a `.deb` | A machine you work on, and where the agent endpoint lives                     |
| **PWA**                 | the built directory, installed by a browser from any HTTPS origin                                     | Headsets, phones, tablets, a locked-down laptop — and the only route to WebXR |

The desktop shell holds no part of the application: it opens a window onto the same
`dist` the PWA ships, and the only other thing it owns is a socket. That is
deliberate — everything that decides what Panorama _is_ stays in TypeScript, where
it is tested, and the two packagings cannot drift into different products. Which
one you are inside is answered at runtime, in
[`shell.ts`](../apps/web/src/panorama/shell.ts).

It behaves like an application rather than like a program that happens to have a
window: **one instance** — a second launch, from the Dock, from Spotlight or from
an agent's pipe, focuses the window you already have — and it **comes back where
you left it**, size and position remembered between launches.

Bundles land in `apps/desktop/src-tauri/target/release/bundle/`, or
`target/debug/bundle/` for the devtools one. A release builds one per platform: a
`.dmg` on macOS, an NSIS `-setup.exe` and an `.msi` on Windows, a `.deb` and an
AppImage on Linux.

```bash
cp -R "apps/desktop/src-tauri/target/release/bundle/macos/Exasol Panorama.app" /Applications/
open -a "Exasol Panorama"
```

Open the **`.app`**, not the file inside it. `Contents/MacOS/panorama-desktop` is a
Unix executable, and Finder runs one of those inside Terminal — so double-clicking
it gets you a terminal full of the shell's log and then the window. The same file
_is_ the right thing to give an agent (`--mcp-stdio`, see
[AGENTS.md](AGENTS.md)) and the right thing to run when you want to watch that log.

The bundles are **unsigned**: on a machine that did not build them, macOS refuses
the first launch until it is opened from the right-click menu, and Windows warns.
The release workflow signs and notarises as soon as the repository holds a
Developer ID — the six secrets it wants are named in
[`.github/workflows/release.yml`](../.github/workflows/release.yml), and until they
are there it says so on every run rather than shipping quietly unsigned.

Two things to know before judging it, both measured in the window rather than
assumed. The webview is the platform's own, and on macOS 26 WKWebView _does_ offer
WebGPU — but Panorama's WebGPU path fails there while building its glyph texture,
so the renderer does what it is built to do and **retries on WebGL**, which is what
actually draws. WebView2 on Windows is Chromium; WebKitGTK on Linux has no WebGPU
at all. And **no webview offers WebXR** — the shell says so on startup — so a
headset is the PWA's job, not this one's.

## 5. Installing it from a browser

A browser can launch the same build in its own window, from a dock, a home screen
or a headset's library, with no wrapper around it:

```bash
npm run build
npm run preview        # http://localhost:4173
```

Then use the install control in the address bar (Chrome and Edge: the icon at the
right; Safari: **Share → Add to Dock**; Android and the Quest Browser: **Install**
in the menu). It launches without browser chrome, keeps its own window, and — the
part worth checking — **starts with no network at all**, because the build is on
the device. A database, of course, does not follow it there.

Nothing is cached but the application itself. No query result, no schema, no row
ever goes into that cache: a stale row shown as current is a worse failure than
being offline. See
[`shell-cache.ts`](../apps/web/src/panorama/shell-cache.ts).

```bash
npm run install-check  # builds, serves, and drives it: worker, manifest, offline
```

A service worker is registered **only in a build** — in front of the dev server a
cache is just a way of being shown a file you have already changed.

## 6. In a headset

WebXR is only offered on a secure page. `http://localhost` counts as one, which is
why the desktop never needed anything — but a headset reaching this machine over
the network sees a plain LAN address, which does not, and the browser refuses a
session before Panorama is ever asked.

**Over USB** — the reliable route, and the one to reach for first:

```bash
npm run dev:quest
```

`adb reverse` makes the _headset's own_ `localhost` reach this machine down the
cable, so nothing crosses the network and the page is a secure context with no
certificate and no warning. It needs `adb` (`brew install
android-platform-tools`), Developer Mode enabled for the headset in the Meta
Horizon phone app, and the USB debugging prompt accepted inside the headset. Then
open `http://localhost:5173/` in the headset's browser.

This is also the only route that works on a machine whose endpoint security drops
inbound connections — FortiClient, Defender, Jamf and their like are common on
managed laptops, and the symptom is `ERR_EMPTY_RESPONSE` in the headset while the
server answers perfectly well locally. Testing with `curl` against your own LAN
address proves nothing there: it never leaves the machine, so it never crosses the
filter.

**Over the network**, where nothing is in the way:

```bash
npm run dev:vr
```

This generates a self-signed certificate naming the machine's current LAN address,
serves over HTTPS, and prints the URL. The headset warns once, because nothing
vouches for a certificate a machine made for itself; accepting it makes the origin
secure. The certificate is regenerated whenever the LAN address changes, because
one for yesterday's DHCP lease fails in a way that looks like a bug in the app.

Either way: open a table, then press **Enter XR**. The button only appears where a
headset is actually on offer, so it stays hidden on the desktop — if it is missing
in the headset, the page is not secure or the session was refused, and the notice
says which.

## 7. The updater's signing key

Panorama's desktop application updates itself, and `tauri-plugin-updater` verifies
every update with a **minisign** signature. That check cannot be turned off, which
makes one keypair the most consequential secret in this repository.

- The **public** half is committed, in `tauri.conf.json` under
  `plugins.updater.pubkey`. It is shipped inside every installed application and
  is what each of them checks an update against.
- The **private** half and its password are not in the repository and never can
  be — `.gitignore` refuses `*.key` — and live in two places only: escrow, and the
  repository's secrets, as `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`.

**Losing the private key cannot be recovered from.** Not "until we rotate it":
every already-installed copy verifies against the public key compiled into it, and
no new key can produce a signature those copies will accept. The only remedy would
be asking every user to download a new application by hand. The password is a
second factor rather than a second copy of the same risk — it means the repository
secret leaking is not on its own enough to sign an update — and it has to be
escrowed alongside the key, because either without the other is useless.

This is separate from Apple code signing. The six `APPLE_*` secrets in
`release.yml` are about Gatekeeper trusting the application; this is about an
installed Panorama trusting the bytes of its own update. Neither substitutes for
the other.

To generate a replacement — which is only ever right before anything has been
released with the current one:

```bash
npx tauri signer generate --write-keys ~/panorama-updater.key
```

## 8. Releasing

[`.github/workflows/release.yml`](../.github/workflows/release.yml) builds the web
application, drives **that build** in a browser — worker registered, manifest and
every icon checked, network taken away and the application launched again —
publishes it as a zip, then bundles the desktop application on macOS, Windows and
Linux runners and adds those to the same release. One tag, both artifacts, one gate
in front of them:

```bash
npm version patch      # or edit package.json; the tag has to match it
git push --follow-tags
```

Run the workflow by hand from the Actions tab to build and check without publishing
anything. The zip is the whole web product: static files to copy anywhere an HTTPS
origin will serve them, with a `SERVING.md` inside saying what a host has to get
right.

**Anywhere** is meant literally. The build is relative, so one artifact installs at
an origin's root, under a repository name, or several directories deep — the
manifest's URLs resolve against the manifest, and the service worker takes its
scope from the directory it was served from. `PANORAMA_BASE=/some/path/` forces
absolute URLs for a deployment that needs them.

[`.github/workflows/pages.yml`](../.github/workflows/pages.yml) deploys it to this
repository's GitHub Pages site on every change to the application: it builds,
drives the built files **mounted under a path** to prove the relative build
survives one, then pushes them to `gh-pages`.

## 9. The shape of it

```
                   Panorama Core  (world model, commands, history DAG)
                          │
        ┌─────────────────┼──────────────────┐
        ▼                 ▼                  ▼
  Babylon renderer    React shell        MCP adapter
```

One model at the centre and three projections of it. Interaction never mutates a
mesh and never mutates the document directly: a pointer drag produces _session_
state while it is live and exactly one semantic command when it ends — the same
command an agent would send. That is the whole reason an agent could be given the
canvas without the renderer knowing.

Three dependency rules hold the shape together, and each buys a specific freedom:

- no package outside `exasol/` knows about Exasol WebSocket packets;
- no package outside `renderer/` knows about Babylon objects;
- no package outside `chart-echarts/` knows that ECharts exists.

**[ARCHITECTURE.md](ARCHITECTURE.md) is the full account** — the constraint the
design answers to, the core model, the layering and module map, the principal
flows, the cross-cutting concerns, a decision record of everything that is not
obvious from the code, the test strategy, and an honest register of what is still
weak.
