# Exasol Panorama

A spatial visual environment for exploring data in Exasol.

This repository implements **Stage 0–1** of `plans/panorama-plan-stage1.md`: the
Panorama core, the GPU table renderer, the Exasol WebSocket driver, the data
worker, and the application shell that ties them together.

The Stage 1 deliverable is one thing: **browsing an arbitrarily large Exasol
table must feel local, continuous and tactile.**

This file is about running it. **[ARCHITECTURE.md](ARCHITECTURE.md)** is about how
it is built and why — the model, the layering, the module map, the flows, and a
decision record of everything that is not obvious from the code.

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
npm test               # unit + integration tests
npm run coverage       # tests with coverage thresholds enforced
npm run typecheck      # tsc --noEmit across every package
npm run verify         # typecheck + coverage
npm run build          # production bundle
```

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
engine ever started.

### Looking at pixels

The test suite proves structure; it cannot prove appearance. A dozen probe scripts
close that gap by driving the real application in a real browser with a real
pointer, and reading back the geometry the canvas actually produced. They need
Chromium once (`npx playwright install chromium`) and a dev server:

```bash
npm run dev -- --port 5199        # in one terminal
npm run smoke                     # in another
```

Every probe takes `PANORAMA_SMOKE_URL` (default `http://localhost:5199/`), and
`smoke` also takes `PANORAMA_SMOKE_DPR=2` to reproduce a Retina display.
Screenshots land in `scripts/shots/`.

| Command                  | Drives                                                                                                  |
| ------------------------ | ------------------------------------------------------------------------------------------------------- |
| `npm run smoke`          | Every sample relation, a fling through ten billion rows, a five-thousand-column table scrolled sideways |
| `npm run halo-check`     | The halo: hover, press, close                                                                           |
| `npm run halo-reach`     | Reaching a halo button across the gap, on a table that is not selected                                  |
| `npm run halo-exclusive` | That only one halo is ever on screen                                                                    |
| `npm run binding-check`  | Following a foreign key, and the connector it leaves behind                                             |
| `npm run route-check`    | A connector routed around a table parked between two joined ones                                        |
| `npm run summary-check`  | The statistics panel under a picked-out column                                                          |
| `npm run sql-check`      | The query box: greying, drag, composition, highlighting                                                 |
| `npm run chart-check`    | Every chart control, the marks, picking, the drill-down, SVG/PNG/PDF                                    |
| `npm run export-check`   | CSV, XLSX and Parquet as real downloads                                                                 |
| `npm run agent-check`    | The agent endpoint: handshake, tools, an edit, the refusals, the stdio pipe                             |
| `npm run probe`          | A scratch pad for graphics-stack questions only a GPU can answer                                        |

What each one asserts, and why these particular techniques (a canvas that has been
composited reads back black; a line hidden behind a table is invisible to pixels
_and_ to geometry), is in [ARCHITECTURE.md §10](ARCHITECTURE.md#10-testing-as-architecture).

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

There are fifteen tools. `overview` is where to start — what is open, what is
being edited, where the history stands. `entities`, `entity` and `rows` describe
the boxes and read their cells; `history` is the commit graph; `session` is what
is selected. `dispatch` applies a document command — one, or a list of
them — `checkout` moves the history head, `label` renames a box, and `open_table`,
`action`, `query` and `chart` do the things a document command cannot express on
its own. `catalogue` lists the database.

Every answer comes from the session in the page — there is no second copy of the
document — so an agent and a person are looking at the same thing, and an agent's
edits appear on screen as they are made and undo like anyone else's.

This server is for the canvas, not for the database: where a native Exasol MCP
server is available, the handshake tells an agent to compute with that one and to
check first that it is the same database. Why the interface is shaped this way is
in [ARCHITECTURE.md §9.9](ARCHITECTURE.md#99-the-agent-interface).

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

### Checking the export files against someone else's reader

The suite proves the encoders write what they meant to. It cannot prove that is
what Parquet, or Excel, or a spreadsheet's CSV import actually expects — no test
can assert that about a format it also implements. So the samples are written out
on request and opened with libraries this repository does not depend on:

```bash
PANORAMA_EXPORT_SAMPLES=/tmp/panorama-export npm test
python3 -m venv /tmp/verify && /tmp/verify/bin/pip install pyarrow openpyxl
/tmp/verify/bin/python -c "import pyarrow.parquet as pq; print(pq.read_table('/tmp/panorama-export/types.parquet').schema)"
/tmp/verify/bin/python -c "import openpyxl; print(openpyxl.load_workbook('/tmp/panorama-export/types.xlsx').active.max_row)"
```

The shapes written cover full type coverage, a mostly-NULL relation, 1 200
columns, an empty result set, several Parquet row groups, and the awkward values
the generators do not produce: thirty-six-digit decimals, exponent notation, the
edges of Excel's calendar and of the Unix epoch, embedded quotes, delimiters,
newlines, carriage returns and astral-plane characters.

A chart's picture formats are checked the same way, by tools that had no part in
writing them:

```
gs -dNOPAUSE -dBATCH -sDEVICE=nullpage chart.pdf   # does a real reader accept it
pdftotext chart.pdf -                              # is the text real text
python3 -c "import xml.dom.minidom as m; m.parse('chart.svg')"
sips -g pixelWidth -g pixelHeight chart.png
```

A chart's picture formats are checked the same way, by tools that had no hand in
writing them:

```bash
gs -dNOPAUSE -dBATCH -sDEVICE=nullpage chart.pdf  # does a real reader accept it
pdftotext chart.pdf -                             # is the text real text
python3 -c "import xml.dom.minidom as m; m.parse('chart.svg')"
sips -g pixelWidth -g pixelHeight chart.png
```

### Integration tests against a real Exasol

They are skipped unless a URL is provided:

```bash
PANORAMA_EXASOL_URL=wss://localhost:8563 \
PANORAMA_EXASOL_USER=sys PANORAMA_EXASOL_PASSWORD=exasol \
PANORAMA_EXASOL_SCHEMA=SALES PANORAMA_EXASOL_TABLE=ORDERS \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
npm test
```

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

**[ARCHITECTURE.md](ARCHITECTURE.md) is the full account** — the constraint the
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
