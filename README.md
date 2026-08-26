# Exasol Panorama

A spatial visual environment for exploring data in Exasol.

This repository implements **Stage 0–1** of `plans/panorama-plan-stage1.md`: the
Panorama core, the GPU table renderer, the Exasol WebSocket driver, the data
worker, and the application shell that ties them together.

The Stage 1 deliverable is one thing: **browsing an arbitrarily large Exasol
table must feel local, continuous and tactile.**

This file is about running it. Three documents in [`docs/`](docs) cover the rest:
**[ARCHITECTURE.md](docs/ARCHITECTURE.md)** is how it is built and why — the
model, the layering, the module map, the flows, and a decision record of
everything that is not obvious from the code. **[TESTING.md](docs/TESTING.md)** is
how we know it works — the suite, the doubles, the coverage gate, and the browser
probes. **[AGENT-SKILL.md](docs/AGENT-SKILL.md)** is how to drive it as an agent,
and is the page the server itself serves.

---

MIT licensed — see [LICENSE](LICENSE).

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

#### Connecting to a local instance (self-signed certificate)

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
the other. This is the constraint the plan asked Stage 1 to answer: the driver
itself is fine (its integration tests pass against a real instance over TLS),
but browser-direct access to a self-signed instance needs a manual trust step —
which is a strong argument for the thin gateway the plan keeps as an option.

```bash
npm test               # the test suite
npm run verify         # typecheck + coverage — the gate
npm run build          # production bundle
```

`npm run verify` is what CI runs on every push and pull request, along with
`format:check` and the installability probe — see
[.github/workflows/verify.yml](.github/workflows/verify.yml). Nothing in CI is a
CI-only standard: if it passes there, it passes here.

Everything else about the tests — the browser probes, the coverage thresholds, the
opt-in runs against a real database — is in [TESTING.md](docs/TESTING.md).

### Installing it as an application

The build is installable: a browser can launch it in its own window, from a dock,
a home screen or a headset's library, with no wrapper around it. To try that:

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

#### Releasing it

`.github/workflows/release.yml` builds the application, drives **that build** in a
browser — worker registered, manifest and every icon checked, network taken away
and the application launched again — and publishes the result as a zip on a GitHub
release. Tag it and the release makes itself:

```bash
npm version patch      # or edit package.json; the tag has to match it
git push --follow-tags
```

Run the workflow by hand from the Actions tab to build and check without
publishing anything. The zip is the whole product: static files to copy anywhere
an HTTPS origin will serve them, with a `SERVING.md` inside saying what a host has
to get right.

**Anywhere** is meant literally. The build is relative, so one artifact installs at
an origin's root, under a repository name, or several directories deep — the
manifest's URLs resolve against the manifest, and the service worker takes its
scope from the directory it was served from. `PANORAMA_BASE=/some/path/` forces
absolute URLs for a deployment that needs them.

`.github/workflows/pages.yml` deploys it to this repository's GitHub Pages site on
every change to the application: it builds, drives the built files **mounted under
a path** to prove the relative build survives one, then pushes them to
`gh-pages`.

A service worker is registered **only in a build** — in front of the dev server a
cache is just a way of being shown a file you have already changed.

The route from here to a store listing (a Trusted Web Activity for Play and the
Meta Horizon Store, and what a desktop shell would and would not buy) is
evaluated in [`plans/panorama-packaging-plan.md`](plans/panorama-packaging-plan.md).

### If the canvas stays blank

The renderer reports startup and per-frame failures as a message in the sidebar
and on the console, and retries with WebGL when the preferred backend cannot
start or cannot draw its first frame. Each attempt gets a **fresh canvas
element**: a graphics context is bound to its canvas for that canvas's lifetime,
so retrying on the same element cannot obtain a context at all and fails with a
misleading "WebGL not supported".

WebGPU is preferred but has **not** been verified on real hardware — no
WebGPU-capable browser was available while this was built, so every renderer
screenshot in `scripts/shots/` is WebGL. To force a backend without rebuilding:

```
http://localhost:5173/?backend=webgl
http://localhost:5173/?backend=webgpu
```

The overlay's **Backend** field shows which one is live; `—` with 0 FPS means no
engine ever started. It starts collapsed to the frame-rate pill in the top-right
corner of the canvas — click that for the full set of numbers, and **Hide** to put
it away again.

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

### Letting an agent drive it

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

`overview` is where to start — what is open, what is
being edited, where the history stands. `entities`, `entity` and `rows` describe
the boxes and read their cells; `history` is the commit graph; `session` is what
is selected. `dispatch` applies a document command — one, or a list of
them — `checkout` moves the history head, `label` renames a box, and `open_table`,
`action`, `query` and `chart` do the things a document command cannot express on
its own. `catalogue` lists the database. `session_dispatch` changes what is
selected, and `skill` is the page describing all of it. The handshake says how many
tools there are, which matters — see below.

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

#### If an agent cannot see a tool that is there

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

### Viewing it in a headset

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
[TESTING.md §8](docs/TESTING.md#8-browser-probes).

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
command an agent would send.

Three dependency rules hold the shape together, and each buys a specific freedom:

- no package outside `exasol/` knows about Exasol WebSocket packets;
- no package outside `renderer/` knows about Babylon objects;
- no package outside `chart-echarts/` knows that ECharts exists.

**[ARCHITECTURE.md](docs/ARCHITECTURE.md) is the full account** — the constraint the
design answers to, the core model, the layering and module map, the principal
flows, the cross-cutting concerns, a decision record of everything that is not
obvious from the code, the test strategy, and an honest register of what is still
weak.

Two things worth knowing before reading any of it:

> The database may cause data to arrive late. It may never cause Panorama to
> respond late.

and: nothing is ever held whole. Not a result set, not an export, not a chart's
input.

---

## Status against the Stage 1 plan

Delivered and covered by tests:

- Panorama Core: entity ids, table entity, session context, command dispatcher,
  immutable commits, branchable history DAG, HEAD.
- Commands: `CreateTableEntity`, `MoveEntities`, `ResizeEntity`, `ResizeColumn`,
  `ReorderColumns`, `SetColumnVisibility`, `RemoveEntities`.
- Babylon canvas: pan, zoom, entity picking, table movement, table resize,
  column resize, scrollbar dragging, LOD thresholds.
- Row and column virtualisation, smooth wheel/trackpad scrolling, velocity
  tracking, predictive prefetch, block LRU cache with byte-based eviction.
- An agent interface: a Model Context Protocol endpoint on the development
  server with fifteen tools over the live session — the document, the commit
  graph, the session and the database — verified against a real browser by
  `npm run agent-check`.
- A settings panel that finds Claude on this machine, pairs it with this session
  and opens it.
- An action halo on the activated table, with a working close button that
  releases the result set as well as removing the entity.
- Charts of any table, set up in a box beside their own live preview, drawn by the
  same two GPU batches as everything else, hoverable and selectable mark by mark,
  able to open a table of the rows behind whatever has been picked out — and
  exported as SVG, PNG or PDF, verified as files by Ghostscript and `pdftotext`.
  Plus a `custom` type whose ECharts option is written out, which puts the whole
  library — radar, sankey, treemap, gauge — within reach of an agent.
- Export to CSV, XLSX and Parquet: encoded in the data worker, streamed to disk,
  with progress, cancellation and a save dialog — verified end to end through a
  real pointer and a real download by `npm run export-check`, and verified as
  files by pyarrow and openpyxl.
- Bindings: connector records, derived geometry, cascade on delete, and
  directional lines rendered behind the tables they join.
- Foreign keys read from `SYS.EXA_ALL_CONSTRAINT_COLUMNS`, followable cells, and
  the filtered result set behind them — verified against a live instance.
- Exasol driver: connect, authenticate (password and access token), disconnect,
  list schemas, list tables, describe table, execute, result-set metadata, total
  row count, arbitrary range fetch, explicit result-set close.
- Data worker with response versioning, stale-response rejection, bounded
  concurrency, duplicate suppression, cancellation and per-block retry backoff.
- Performance overlay with the metrics the plan lists.
- WebXR entry against the same scene and the same table renderer.
- Pathological relations: very tall, very wide, large strings, null-heavy, and
  full type coverage — available in the app without a database.

Deliberately not done, because it cannot be done from here:

- **No pixels have been looked at.** Every renderer decision is verified
  structurally (draw lists, batch contents, glyph geometry, camera maths) and
  against Babylon's headless engine. Typography, colour and the _feel_ of
  scrolling need a human at a real display, which is what Stage 1E is for.
- **No frame timings on real hardware.** The tests prove the renderer's work is
  proportional to visible cells and independent of latency; they do not prove
  60 FPS on a given machine. The overlay is there to measure it.
- **The Exasol protocol is now verified against a live instance.** The
  integration tests pass against Exasol over TLS: login with real RSA/PKCS#1
  password encryption, schema and table listing, `describeTable`, opening a
  result set, positional range fetches, and explicit result-set close.
