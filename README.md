<div align="center">

<img src="apps/web/public/icons/icon-512.png" alt="" width="84" height="84">

# Exasol Panorama

**A spatial canvas for exploring data in Exasol.**

Tables, queries and charts as boxes on an infinite plane, drawn by the GPU,
connected by lines that mean something — and driven by a person and an agent at
the same time, on the same document.

[![verify](https://github.com/exasol-labs/exasol-panorama/actions/workflows/verify.yml/badge.svg)](https://github.com/exasol-labs/exasol-panorama/actions/workflows/verify.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node ≥ 20.11](https://img.shields.io/badge/node-%E2%89%A5%2020.11-3c873a.svg)](https://nodejs.org)

[Quick start](#quick-start) · [Let an agent drive it](#letting-an-agent-drive-it) ·
[Architecture](docs/ARCHITECTURE.md) · [Testing](docs/TESTING.md) ·
[Agent interface](docs/AGENT-SKILL.md)

<img src="scripts/shots/summary-panels.png" alt="A table on the Panorama canvas with per-column summary panels beneath it" width="900">

</div>

---

## Why a canvas

A query console answers one question at a time and throws the previous answer
away. A notebook remembers, but it remembers in a line — and exploration is not a
line. You open a table, notice something odd in one column, follow a key to find
out what it points at, compare it against last year, back up two steps and try the
other branch. What you want when you are done is not the last result. It is the
six results side by side, and the arrows between them.

Panorama makes every answer a **thing**: a box on an infinite plane you can move,
resize, label and point at. A table is a box. A statement written against it is a
box beside it, with an arrow saying where it came from. A chart is a box, and
picking a mark inside it filters the boxes downstream. Follow a foreign key in a
cell and the matching rows open next to you, joined by a line. Nothing you have
learnt disappears because you asked the next question.

<img src="scripts/shots/fk-followed.png" alt="Following a foreign key opens the matching row as a new box, joined by an arrow" width="900">

Two properties make that hold up against a real warehouse rather than a demo.

**It stays local-feeling at any size.** Nothing is ever held whole — not a result
set, not an export, not a chart's input. Rows are windowed, prefetched in the
direction you are already scrolling, and cached against a byte budget, so a
ten-billion-row relation flings under the pointer like a local file. One sentence
sets almost every boundary in the codebase:

> The database may cause data to arrive late. It may never cause Panorama to
> respond late.

A cell that has not arrived yet is drawn as _absent_ — never as blank, never as
zero.

**History is a graph, not an undo stack.** Every persistent change is one of
sixteen commands, and each is a commit. Move the head back to an earlier state,
keep working, and you branch rather than destroy: the line of inquiry you walked
away from is still there to return to. Selection, hover and half-written SQL are
_session_ state and stay out of history, where they belong.

## Two hands on one document

Panorama offers its live session to an agent over the Model Context Protocol —
and this is not an export, a screenshot pipe or a replica. **There is no second
copy of the document.** An agent's edits are the same sixteen commands your
pointer produces, applied to the session in the open page. They appear on screen
as they are made, they undo like yours, and they land in the same history graph.

That symmetry is what makes the collaboration direct rather than a game of
telephone:

- **The agent sees what you see.** `overview` reports what is open, which
  database, and where history stands; `entities`, `entity` and `rows` read the
  boxes and the cells that have actually arrived. You never have to describe your
  canvas to it.
- **You see what the agent did, while it does it.** It opens boxes, labels them,
  wires them together. Disagree with one? Drag it somewhere else, close it, or
  check out the commit before it — the same three gestures you would use on your
  own work.
- **Pictures are measured, not imagined.** An agent cannot see pixels, so a chart
  reports what it actually drew: marks per series, labels that fell outside the
  box, and every channel that named a column the data has not got. "Looked
  plausible, drew nothing" is the failure this closes.
- **Neither side does the other's job.** Heavy work — scanning, aggregating,
  profiling, DDL — belongs on the shortest route to the engine, and the handshake
  ranks those routes and says so. This server is for the canvas: work out what is
  true elsewhere, then put _that_ on the plane, where a person can see it.
- **Pairing is one button.** **Settings → Pair with Claude** registers the
  endpoint with Claude Code and the desktop app, and opens whichever is on the
  machine.

The whole agent-facing interface is written down once, in
**[docs/AGENT-SKILL.md](docs/AGENT-SKILL.md)**, and the server serves that very
file as its first tool — so the documentation you read and the instructions the
agent reads cannot drift apart.

## What you can do

- **Open anything.** Browse schemas and tables in the explorer tree, or use the
  generated sample relations that need no database at all — including a
  ten-billion-row table, a 5 000-column one, a null-heavy one, and one covering
  every Exasol type.
- **Scroll, fling, resize.** Row and column virtualisation with smooth
  wheel/trackpad scrolling; resize tables and columns, reorder and hide them.
- **Read a column.** Distinct counts, nulls, top values or a histogram, in a
  panel under the table.
- **Follow a key.** Foreign keys are read from
  `SYS.EXA_ALL_CONSTRAINT_COLUMNS`; a followable cell opens the rows it points at
  as a new, connected box.
- **Write SQL in place.** A statement box built on another box — and you keep
  both, and everything downstream re-runs.
- **Chart it.** Bar, line, area, scatter, pie, stacked — drawn by the same two GPU
  batches as everything else, hoverable and selectable mark by mark. Open the rows
  behind whatever you picked, or let that selection cross-filter the boxes built on
  it. A `custom` type writes the ECharts option out in full, which brings radar,
  sankey, treemap and gauge within reach.
- **Take it with you.** Charts export as SVG, PNG or PDF; result sets export to
  CSV, XLSX or Parquet — encoded off the main thread, streamed to disk, with
  progress and cancellation.
- **Install it, or wear it.** One build, packaged two ways: a desktop
  application with a window of its own, and a browser install that starts with no
  network — the same bytes either way. In a headset it enters WebXR on the same
  scene, with the same renderer.

<img src="scripts/shots/chart-shown.png" alt="A pie chart of a table's rows, drawn as a box on the canvas" width="470">

---

## Quick start

```bash
npm install
npm run dev            # http://localhost:5173
```

The app opens with a **Sample data** panel that needs no database. It serves
locally generated relations through the same data worker, cache and scheduler a
real connection uses — including a 10-billion-row table and a 5 000-column one.

To use a real database, fill in the connection panel (`wss://host:8563`, user +
password, or an Exasol SaaS personal access token), open a schema in the
explorer tree, and click a table.

```bash
npm test               # the test suite
npm run verify         # typecheck + coverage — the gate
npm run build          # production bundle
```

`npm run verify` is what CI runs on every push and pull request, along with
`format:check` and the installability probe — see
[.github/workflows/verify.yml](.github/workflows/verify.yml). Nothing in CI is a
CI-only standard: if it passes there, it passes here.

### Connecting to a local instance (self-signed certificate)

A browser refuses a `wss://` handshake to a host whose certificate it does not
trust, and — unlike a page navigation — it never offers to make an exception. It
just reports a generic failure. Development instances are almost always
self-signed, so:

1. Check what the certificate is actually issued for:
   `openssl s_client -connect localhost:8563 -brief </dev/null`
   Exasol's own certificate is usually `CN=localhost`.
2. Open `https://localhost:8563` in a tab and accept the warning. The page will
   not load anything afterwards — the port speaks the database protocol, not
   HTTP — but the exception is recorded.
3. Connect Panorama to **`wss://localhost:8563`**.

Use the _same host_ as the certificate. `localhost` and `127.0.0.1` are
different hosts to a browser, so an exception accepted for one does nothing for
the other. The driver itself is fine here — its integration tests pass against a
real instance over TLS — but browser-direct access to a self-signed instance
needs that manual trust step, which is the strongest argument there is for
putting a thin gateway in front of one.

### Supplying connection details at startup

Typing a URL and a password is fine at a desk and miserable in a headset, so the
details can be given before the page opens — as environment variables, or in a
`.env.local` at the repository root:

```bash
PANORAMA_EXASOL_URL=wss://db.internal:8563
PANORAMA_EXASOL_USER=analyst
PANORAMA_EXASOL_PASSWORD=…        # or PANORAMA_EXASOL_TOKEN, which wins
PANORAMA_EXASOL_SCHEMA=SALES      # optional: opened once connected
PANORAMA_EXASOL_TABLE=ORDERS
PANORAMA_EXASOL_AUTOCONNECT=0     # optional: prefill, but wait to be asked
```

The names are the ones the Exasol integration tests already use, so one exported
block drives both. A URL alone prefills the form. Add a secret and Panorama
connects on load; name a schema and table too and it opens that table, so a
headset needs no interaction at all.

A secret is never put back into an input: it is used to connect and nothing more.
A password sitting in a form field is readable over a shoulder and recoverable
from the DOM, for no benefit over having connected already.

**These details never reach a build.** They are injected by the dev server only;
`npm run build` is handed a literal `null` whatever the environment holds, so a
password cannot be baked into a deployable artifact. There is a test for that,
because it is the kind of guarantee that quietly stops being true.

### If the canvas stays blank

The renderer reports startup and per-frame failures as a message in the sidebar
and on the console, and retries with WebGL when the preferred backend cannot
start or cannot draw its first frame. Each attempt gets a **fresh canvas
element**: a graphics context is bound to its canvas for that canvas's lifetime,
so retrying on the same element cannot obtain a context at all and fails with a
misleading "WebGL not supported".

To force a backend without rebuilding:

```
http://localhost:5173/?backend=webgl
http://localhost:5173/?backend=webgpu
```

The overlay's **Backend** field shows which one is live; `—` with 0 FPS means no
engine ever started. It starts collapsed to the frame-rate pill in the top-right
corner of the canvas — click that for the full set of numbers, and **Hide** to put
it away again.

---

## Letting an agent drive it

An agent reaches Panorama over the Model Context Protocol. The endpoint is part
of the development server, so there is one thing to start:

```bash
npm run dev              # the app, and the agent endpoint with it
```

The repository ships an `.mcp.json`, so a client that reads one — Claude Code
does — finds the server as `panorama` without being told. For anything that
speaks only stdio there is a pipe:

```bash
claude mcp add panorama -- npm run agent
```

Both reach the same place. `curl http://localhost:5173/agent/health` says whether
a session has attached; the page attaches by being open, and nothing else.

Or press the gear. The **Settings** panel at the foot of the sidebar shows the
endpoint's address, whether this page is attached and whether anything has asked
it a question yet — and, since the development server is on the same machine as
Claude, what Claude there is on it. **Pair with Claude** tells Claude Code about
this endpoint (through `claude mcp add`, so the CLI writes its own configuration)
and adds the stdio pipe to the desktop application's configuration, merged into
whatever else is in it. **Open Claude app** starts it — or **Open Claude
Code**, in a new terminal window in this project's directory, on a machine with no
application to open. Both say what they did, and the panel then shows the pairing
as done.

<img src="scripts/shots/settings.png" alt="The Settings panel, showing the agent endpoint and the pairing controls" width="320">

`overview` is where to start — what is open, what is being edited, where the
history stands. `entities`, `entity` and `rows` describe the boxes and read their
cells; `history` is the commit graph; `session` is what is selected. `dispatch`
applies a document command — one, or a list of them — `checkout` moves the history
head, `label` renames a box, and `open_table`, `action`, `query` and `chart` do the
things a document command cannot express on its own. `catalogue` lists the
database. `session_dispatch` changes what is selected, and `skill` is the page
describing all of it. The handshake says how many tools there are, which
matters — see below.

Every answer comes from the session in the page — there is no second copy of the
document — so an agent and a person are looking at the same thing, and an agent's
edits appear on screen as they are made and undo like anyone else's.

The whole interface is written down once, in
**[docs/AGENT-SKILL.md](docs/AGENT-SKILL.md)** — the boxes, the command and history
model, charts and their named data sets, what a picked mark means, cross-filtering,
and which feedback to read first. It is documentation, reviewed and formatted like
the rest of `docs/`, and the server **serves that file** three ways: as the
`skill` **tool**, first in the list, which is the one mechanism every client
surfaces; and as the prompt `panorama` and the resource `panorama://skill` for a
client that shows those. Same text every way. The tool is answered by the server
rather than forwarded to the page, so it works before anything is open. There is no
second copy of it in the code, the handshake says to call it first, and a test
insists every tool is written down in it.

This server is for the canvas, not for the database. The handshake ranks the routes
to the engine by how far the rows have to travel: a local `exasol` CLI first where
the database is on this machine, a native Exasol MCP server next, this server for
the canvas — and check first that the other route is the same database. Why the
interface is shaped this way is in
[ARCHITECTURE.md §9.10](docs/ARCHITECTURE.md#910-the-agent-interface).

### If an agent cannot see a tool that is there

Almost always the same thing, and it is not on the agent's side: **a client fetches
the tool list once, when it connects, and then shows what it fetched.** So a client
that connected before a tool existed — or while nothing was listening at all, which
looks the same to it — keeps showing the old list however many times the server is
corrected.

Two things to check, in order:

1. **Is the endpoint running?** `curl http://localhost:5173/agent/health`. It lives
   on the development server; without `npm run dev` there is nothing there, and a
   client that connected anyway is holding a memory of one.
2. **Which catalogue is the agent looking at?** The handshake stamps it, in
   `serverInfo.version` (`0.1.0+16.850d7b2f`: sixteen tools and a hash of them) and
   again in words at the end of the instructions. Ask the agent what its client
   shows. A different number means a cached list, not a missing tool.

The fix is to reconnect the server in the client — in Claude Code, `/mcp`; in the
desktop application, restart it. The stdio pipe now watches the stamp and sends
`notifications/tools/list_changed` when it moves, so a client that honours it is
corrected on its own, including when the server appears after the client did.

To see what a client will actually get, ask the server rather than the code:

```bash
curl -s -X POST http://localhost:5173/agent/mcp \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | jq '.result.tools | length, .[0].name'
```

---

## Viewing it in a headset

WebXR is only offered on a secure page. `http://localhost` counts as one, which
is why the desktop never needed anything — but a headset reaching this machine
over the network sees a plain LAN address, which does not, and the browser
refuses a session before Panorama is ever asked.

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
server answers perfectly well locally. Note that testing with `curl` against your
own LAN address proves nothing there: it never leaves the machine, so it never
crosses the filter.

**Over the network**, where nothing is in the way:

```bash
npm run dev:vr
```

This generates a self-signed certificate naming the machine's current LAN
address, serves over HTTPS, and prints the URL. The headset warns once, because
nothing vouches for a certificate a machine made for itself; accepting it makes
the origin secure. The certificate is regenerated whenever the LAN address
changes, because one for yesterday's DHCP lease fails in a way that looks like a
bug in the app.

Either way: open a table, then press **Enter XR**. The button only appears where
a headset is actually on offer, so it stays hidden on the desktop — if it is
missing in the headset, the page is not secure or the session was refused, and
the notice says which.

---

## Getting it as an application

One web build, packaged two ways, and both come out of a release:

|                         | What it is                                                                                            | Where it fits                                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Desktop application** | `apps/desktop` — the build in a window of its own, bundled by Tauri: a `.dmg`, an installer, a `.deb` | A machine you work on. Nothing to install first, and where the agent endpoint is going to live                       |
| **PWA**                 | the built directory, installed by a browser from any HTTPS origin                                     | Headsets, phones, tablets, a locked-down laptop — anywhere a browser is the only way in, and the only route to WebXR |

The desktop shell holds no part of the application: it opens a window onto the
same `dist` the PWA ships and its Rust is a `main` and a comment. That is
deliberate — everything that decides what Panorama _is_ stays in TypeScript,
where it is tested, and the two packagings cannot drift into different products.
Which one you are inside is answered at runtime, in
[`shell.ts`](apps/web/src/panorama/shell.ts), and today it decides exactly one
thing: the desktop application does not cache its own bundle, because it is
already on the disk.

### The desktop application

```bash
npm run desktop        # a window on the dev server: needs `npm run dev` in another terminal
npm run desktop:build  # builds the web app, then bundles it
npm run desktop:debug  # the same bundle with devtools left in — right-click, Inspect Element
```

The bundles land in `apps/desktop/src-tauri/target/release/bundle/` — or
`target/debug/bundle/` for the devtools one. They are
**unsigned**: macOS will refuse the first launch until it is opened from the
right-click menu, or `xattr -d com.apple.quarantine` is applied, and Windows will
warn. Signing needs certificates this repository does not hold.

Two things to know before judging it, both measured in the window rather than
assumed. The webview is the platform's own, and on macOS 26 WKWebView _does_ offer
WebGPU — but Panorama's WebGPU path fails there while building its glyph texture,
so the renderer does what it is built to do and **retries on WebGL**, which is
what actually draws. WebView2 on Windows is Chromium; WebKitGTK on Linux has no
WebGPU at all. And **no webview offers WebXR** — the shell says so on startup — so
a headset is the PWA's job, not this one's.

`npm run desktop` is the interesting one for development: the window is served by
the development server, so the agent endpoint is on the page's own origin and
Claude can drive that window today, exactly as it drives a tab.

### Installing it from a browser

A browser can launch the same build in its own window, from a dock, a home screen
or a headset's library, with no wrapper around it. To try that:

```bash
npm run build
npm run preview        # http://localhost:4173
```

Then use the install control in the address bar (Chrome and Edge: the icon at the
right; Safari: **Share → Add to Dock**; Android and the Quest Browser: **Install**
in the menu). It launches without browser chrome, keeps its own window, and — the
part worth checking — **starts with no network at all**, because the build is on
the device. The sample tables work offline; a database, of course, does not.

Nothing is cached but the application itself. No query result, no schema, no row
ever goes into that cache: a stale row shown as current is a worse failure than
being offline. See [`shell-cache.ts`](apps/web/src/panorama/shell-cache.ts).

```bash
npm run install-check  # builds, serves, and drives it: worker, manifest, offline
npm run icons          # redraws the icons after a change to the mark
```

A service worker is registered **only in a build** — in front of the dev server a
cache is just a way of being shown a file you have already changed.

### Releasing both

`.github/workflows/release.yml` builds the web application, drives **that build**
in a browser — worker registered, manifest and every icon checked, network taken
away and the application launched again — publishes it as a zip, and then bundles
the desktop application on macOS, Windows and Linux runners and adds those to the
same release. One tag, both artifacts, one gate in front of them:

```bash
npm version patch      # or edit package.json; the tag has to match it
git push --follow-tags
```

Run the workflow by hand from the Actions tab to build and check without
publishing anything. The zip is the whole web product: static files to copy
anywhere an HTTPS origin will serve them, with a `SERVING.md` inside saying what a
host has to get right. The desktop bundles are built per platform, because a
bundle can only be made by the operating system it is for.

**Anywhere** is meant literally. The build is relative, so one artifact installs at
an origin's root, under a repository name, or several directories deep — the
manifest's URLs resolve against the manifest, and the service worker takes its
scope from the directory it was served from. `PANORAMA_BASE=/some/path/` forces
absolute URLs for a deployment that needs them.

`.github/workflows/pages.yml` deploys it to this repository's GitHub Pages site on
every change to the application: it builds, drives the built files **mounted under
a path** to prove the relative build survives one, then pushes them to
`gh-pages`.

---

## Testing

`npm run verify` is the gate: a type check across every package, then the suite
with its coverage thresholds enforced. **[TESTING.md](docs/TESTING.md)** is the
full account — the two Vitest projects, the doubles and the injected clock, the six
kinds of test, what the 100 % line gate is for, and an honest register of the
gaps. Three things are worth knowing from here.

### Looking at pixels

The test suite proves structure; it cannot prove appearance. Eleven probe scripts
close that gap by driving the real application in a real browser with a real
pointer and reading back the geometry the canvas actually produced:

```bash
npx playwright install chromium   # once
npm run dev -- --port 5199        # in one terminal
npm run smoke                     # in another
```

`smoke`, `halo-check`, `halo-reach`, `halo-exclusive`, `binding-check`,
`route-check`, `summary-check`, `sql-check`, `chart-check`, `export-check`,
`agent-check`, and `probe` as a graphics scratch pad. What each one asserts, the
techniques behind them, and how to read their output are in
[TESTING.md §8](docs/TESTING.md#8-browser-probes). The screenshots in this file
come out of those runs, in `scripts/shots/`.

### Checking the export files against someone else's reader

No test can prove a format is right against the code that wrote it, so the samples
are written out on request and opened with libraries this repository does not
depend on — pyarrow, openpyxl, Ghostscript, `pdftotext`. The commands are in
[TESTING.md §9](docs/TESTING.md#9-checking-files-against-other-peoples-readers).

### Against a real Exasol

The driver's integration tests are skipped unless `PANORAMA_EXASOL_URL` is set;
see [TESTING.md §10](docs/TESTING.md#10-against-a-real-exasol).

---

## Architecture

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

**[ARCHITECTURE.md](docs/ARCHITECTURE.md) is the full account** — the constraint the
design answers to, the core model, the layering and module map, the principal
flows, the cross-cutting concerns, a decision record of everything that is not
obvious from the code, the test strategy, and an honest register of what is still
weak.

---

## Known limits

Worth knowing before you judge something a bug:

- **WebGPU is preferred and does not yet work anywhere it has been tried.** No
  WebGPU-capable browser was available while this was built, so every renderer
  screenshot here is WebGL. The first engine that offered it — WKWebView on
  macOS 26, in the desktop application — refused the glyph texture and produced
  validation errors on the first frame, and the renderer fell back to WebGL as
  designed. So the fallback is proven on real hardware and the fast path is
  proven broken; a graphics bug to chase, not a mystery.
- **No frame timings on real hardware.** The tests prove the renderer's work is
  proportional to visible cells and independent of database latency; they do not
  prove 60 FPS on a given machine. That is what the performance overlay is for.
- **Typography, colour and the _feel_ of scrolling need a human at a real
  display.** Everything about them is verified structurally — draw lists, batch
  contents, glyph geometry, camera maths — which is not the same as looking good.
- **The agent endpoint still lives on the development server.** A deployed PWA
  is the application alone, and the desktop shell does not carry the endpoint
  yet — so an installed Panorama has no agent, which is the next thing to fix and
  the reason the desktop shell exists. `npm run desktop` has one, because the
  window is pointed at the dev server. See
  [`plans/panorama-agent-local-plan.md`](plans/panorama-agent-local-plan.md).
- **The desktop application has not been driven by a test.** The suite and the
  probes cover the web build, which is all of the application; nothing yet
  launches the bundle and checks that it opened, drew, and could read a table.

---

## Documentation

- **[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)** — how it is built and why: the
  model, the layering, the module map, the flows, and a decision record of
  everything that is not obvious from the code.
- **[docs/TESTING.md](docs/TESTING.md)** — how we know it works: the suite, the
  doubles, the coverage gate, and the browser probes.
- **[docs/AGENT-SKILL.md](docs/AGENT-SKILL.md)** — how to drive it as an agent,
  and the page the server itself serves.

MIT licensed — see [LICENSE](LICENSE).
