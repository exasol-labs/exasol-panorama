# Exasol Panorama

A spatial visual environment for exploring data in Exasol.

This repository implements **Stage 0–1** of `plans/panorama-plan-stage1.md`: the
Panorama core, the GPU table renderer, the Exasol WebSocket driver, the data
worker, and the application shell that ties them together.

The Stage 1 deliverable is one thing: **browsing an arbitrarily large Exasol
table must feel local, continuous and tactile.**

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

The test suite proves structure, not appearance. Two scripts close that gap;
both need a browser (`npx playwright install chromium` once):

```bash
npm run dev                      # in one terminal, on port 5199
PANORAMA_SMOKE_URL=http://localhost:5199/ npm run smoke
```

`PANORAMA_SMOKE_DPR=2` reproduces a Retina display. `npm run smoke` drives the real app — opens each sample relation, flings through
ten billion rows, scrolls a five-thousand-column table sideways — then writes
screenshots to `scripts/shots/` and reports the overlay metrics and any console
errors. `npm run probe` is a scratch pad for settling graphics-stack questions
that only a GPU can answer; it is how the material and texture-orientation
recipes in `packages/renderer/src/babylon` were established. `npm run
halo-check`, `npm run halo-exclusive`, `npm run halo-reach` and `npm run
binding-check` drive the halo and the foreign-key follow through a real
pointer — pressing the close button on its corner, and confirming that hovering
one table while another is selected leaves exactly one halo on screen. The checks
that need a particular button sweep both lines of the halo for it, through one
shared helper, rather than each carrying its own arithmetic about where the
buttons are: the sweep proves each one is hit-testable where it is drawn, and a
reorganisation like moving them around the corner then costs one file. `npm run
export-check` presses the export button, sweeps the halo until it finds each
format, and catches the file the browser downloads. `npm run
summary-check` clicks a column header and then a second one, reads back the
statistics the source actually returned, and compares the strip of canvas below
the table before and after to prove the panels were drawn — `readPixels` reports
black on a canvas whose drawing buffer has already been composited, so two
screenshots of the same strip are the honest measurement. `npm run sql-check`
drives the query box: the greyed-out SQL button on a sample table, the overlay
tracking a real drag, the halo swept to find its buttons rather than assuming
where they are, and — after deriving a second box from the first — the one-line
statement that box shows, the composed statement it would send, and the name
coloured in both the field and the drawn box beneath it. `npm run route-check`
parks a table squarely between two joined ones and then sweeps the pointer to find
where the connector's marker ended up — which is the only honest way to ask where
the line went, since a line crossing a table is hidden behind it and pixels cannot
tell. Finding the marker off the straight line proves the route went round it, and
finding it at all proves drawing and picking agree about where. `npm run
chart-check` sweeps the halo for the charting button, presses it, reads the form
back out of the DOM, changes a control and confirms the picture followed without
costing a commit, then commits the setup and reads back the geometry the canvas
actually drew. It walks every setting the form offers, one at a time, and checks each
one drew something — not for the values they produce, which the test suite has, but
because these are the ones that reach a real ECharts through the real adapter, and a
setting that quietly produces nothing is exactly what a unit test on the option object
cannot see. Then it sweeps a real pointer across the picture to find the marks, checks
the cursor says they can be picked, clicks two of them and confirms the rest faded — because the only way to know that
the geometry the canvas drew and the geometry the hit test reads are the same
geometry is to point at it. It sweeps the chart's own halo too, and reports which
line each button landed in: the one that opens a table down the right edge, the
ones that act on the picture along the top, close on the corner. Finally it removes the file
picker, exports all three picture formats as real downloads, and checks each
file's first bytes are the format it claims to be. `npm run agent-check` speaks the
protocol to the real endpoint with a real browser attached: the handshake, the
tool list, a table opened, its rows read, a move applied and undone, a chart set
up and its marks counted on the canvas — and the refusals, because an interface
for agents is only as good as what it says when the answer is no. The stdio pipe
is driven too, since a pipe is exactly the sort of thing that works until it is
tried, and the settings routes are asked what Claude is on this machine — read
only, because pairing and opening change it and a check should not. The drill-down is watched
filling and emptying — 0, then 20, then 40, then 0 again — because "empty by
default, filling up as you select" is a claim about a sequence, and only a
sequence can check it.

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

This server is for the canvas, not for the database. Where a Model Context Protocol
server that speaks to Exasol natively is available, an agent is told to use that
for the querying — it reaches the engine, and this route reaches a browser tab —
after checking that it is the same database, which `overview` reports as the URL
this session connected to plus the name and version the server gave at login. And
to read whatever semantic layer exists before writing SQL. The handshake says all
of this; so do the descriptions of the tools it bears on.

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

Interaction never mutates a mesh and never mutates the document directly. A
pointer drag produces _session_ state while it is live, and exactly one
semantic command when it ends — the same command an agent would send.

### Packages

| Package                  | Responsibility                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `packages/core`          | World model, entities, semantic commands, branchable history graph, session state                                    |
| `packages/table`         | Result chunks, viewport arithmetic, row cache, prefetch policy, fetch scheduler — renderer- and database-independent |
| `packages/exasol`        | JSON-over-WebSockets driver: login (RSA/PKCS#1), metadata, result sets, positional fetch                             |
| `packages/export`        | Streaming CSV, XLSX and Parquet encoders over a result set — renderer- and database-independent                      |
| `packages/chart`         | Chart specification, row reduction, and the geometry contract a chart returns — no library, no renderer              |
| `packages/chart-echarts` | The ECharts adapter: option building, zrender display-list extraction, triangulation                                 |
| `packages/worker`        | Data-worker protocol, worker host, main-thread client and table data controller                                      |
| `packages/renderer`      | Babylon.js scene, camera, batched GPU table renderer, glyph atlas, hit testing, interaction                          |
| `packages/ui`            | React shell: connection dialog, explorer, performance overlay                                                        |
| `packages/mcp`           | Agent interface: the tool catalogue, the Model Context Protocol endpoint, and the bridge into the live session       |
| `packages/test-support`  | Deterministic mock data sources, virtual clock, pathological relation generators                                     |
| `apps/web`               | Composition root: workspace, canvas, worker bootstrap                                                                |

Two boundaries are enforced by inspection and by dependency direction:

- no package outside `exasol/` knows about Exasol WebSocket packets;
- no package outside `renderer/` knows about Babylon objects;
- no package outside `chart-echarts/` knows that ECharts exists.

### Where the work happens

```
MAIN THREAD                          DATA WORKER
─────────────────────────            ─────────────────────────
Babylon renderer                     Exasol WebSocket client
input and interaction                protocol decoding
camera                               result-set lifecycle
bounded row cache  ◀── blocks ─────  fetch scheduling
prefetch policy    ─── wants ─────▶  column conversion
```

The plan places the row cache in the worker. It lives on the main thread here,
deliberately: the renderer needs a _synchronous_ cell read during a frame, and
the cache is pure bookkeeping over already-decoded typed arrays. Everything
expensive — the socket, protocol decoding, request scheduling, vector
construction — stays in the worker, which is what the constraint is actually
about. Blocks cross the boundary with their buffers transferred.

### The performance contract

> The database may cause data to arrive late. It may never cause Panorama to
> respond late.

This is enforced by a test, not by hope.
`packages/worker/test/latency-stress.test.ts` replays the identical scripted
fling against 0, 50, 250 and 1 000 ms simulated fetch latency and asserts that
scroll position, rendered rows and per-frame work are **identical**; only how
many cells have data yet differs.

`packages/worker/test/table-controller.test.ts` asserts the other half: a
10-billion-row relation and a 1-million-row relation of the same width consume
the same client memory to within 25 %.

---

## Design notes

**Rows and cells are not entities.** A table, its position, its size and its
column views are document state. Rows are ephemeral projections of an open
result set, so the conceptual model never scales with row count.

**Row positions are not row identity.** An open Exasol result set provides a
concrete sequence for its lifetime. Reopening a result set — after a reconnect,
say — starts a new generation, and every cached block from the old one is
discarded rather than reused.

**History is a graph, not a stack.** Undo moves the active head; it never
destroys commits. Committing from a non-tip head creates a branch, and both
paths stay reachable.

**Drags do not spam history.** A drag lives in session state and is previewed by
the renderer; one command is dispatched on release.

**A typed query does not spam history either** — the same split, for the same
reason. The statement being written lives in session state; running it dispatches
one `SetTableQuery`. A query written a character at a time would otherwise leave
one commit per keystroke.

**A query is a kind of table, not a kind of panel.** `TableSource` is a union: a
`relation` names a stored table, a `query` carries a statement. Everything
downstream — hit testing, bindings, the halo, scrolling, the block cache — works
on both without knowing which it has. What a query table adds is a `mode`
(`editing` or `result`), because a statement has to be written before it can have
rows.

**A query's shape is discovered, not described.** A stored relation is described
before its entity is built, so its columns are known at creation. A query cannot
be: nothing knows what `SELECT` returns until it runs. So a query box is created
with no columns and reshaped from the result set it produced, via
`SetTableColumns`.

**A query box holds one step, not a pipeline.** Refining a refinement of a table
written out in full is a statement wrapped in a statement wrapped in a table
name, and by the third level the user's own `WHERE` clause is lost somewhere
inside it. So a box stores only its own step and calls its input
`derived_table` — a name no database has ever heard of, which is why it is
coloured — and the steps are joined into one statement when the query runs. A box
opened on a stored relation names that relation outright instead: it has a real
name and seeing it is useful.

The dependency lives on `QuerySource.derivedFrom`, in the same record as the
statement that depends on it, rather than being read back off the connector: the
connector is the drawing of that fact, not the fact.

**Changing a step refreshes what was built on it.** Because a box holds a
reference rather than a copy, changing an early step changes what every later step
reads — so running one re-runs the boxes above it, nearest first, and each is
reshaped from what came back. Only the ones that have a result: an editor still
being written has nothing to bring up to date. A step that no longer works against
the new shape is named in the error rather than left showing rows that no longer
come from anywhere, and the others are still refreshed. Closing a table closes
what was built on it, for the same reason: with the input gone there is nothing
for its name to mean.

**The steps are joined by naming, not by nesting.** Every step but the last
becomes a named common table expression and the last becomes the outer query, so
the composed statement reads in the order it was built rather than inside-out.
That means the substitution is an identifier for an identifier, which stays valid
wherever a table reference can appear — `FROM derived_table`,
`derived_table.COUNTRY`, `derived_table AS d`, a join, twice. Nesting each
statement inside the next would have had to produce `(…) AS derived_table`, which
is not valid in half of those places.

The name is found by lexing rather than by matching, so it is replaced where it is
a reference and left alone where it is text: `WHERE label = 'derived_table'` is a
comparison against a string, `"derived_table"` is someone who quoted it and meant
it, and a comment mentioning it is a comment. A single query on a stored relation
composes to exactly the statement the user wrote and nothing more.

**The SQL editor is the one DOM overlay, deliberately.** Everything else on the
canvas is drawn by the GPU, so that it works identically in XR. Text entry is the
exception: it is not a rectangle and a caret but selection, IME composition,
native undo, autorepeat, screen readers, and every platform keybinding the user
already knows. A GPU text editor would reimplement all of that, worse. So a real
`<textarea>` is positioned over the box from the _drawn_ transform each frame —
`renderer.drawnEntity`, the same function the canvas uses, so a drag or resize
preview carries the field with it rather than leaving it behind until the drag
commits —
while the box's GPU rendering draws the same statement underneath — which is what
XR, and every screenshot, actually sees. Canvas keyboard shortcuts skip events
whose target is an editable element, so ⌘Z in the field means "undo my typing".

The colouring is a second copy of the same text sitting exactly behind a textarea
whose own glyphs are transparent, which is the only way to colour part of what
someone is typing without giving up a real text field. Every property that decides
where a character lands has to be identical on both — a difference in any of them
shows up as colour sliding off the word it belongs to. The drawn box colours it
too, from character ranges named in the draw list: the draw list has no font to
measure with, so it says _which_ characters and the layer that lays glyphs out,
which is the one that measures, decides where they are.

**The world is measured in pixels, so XR needs a stage.** A table is 550 units
wide because it is 550 pixels wide; taken into a headset unchanged that is 550
metres and the viewer stands inside a letterform. So every mesh hangs from one
transform node that is identity on the desktop and, in XR, shrinks the scene to
human scale and stands it in front of the viewer like a screen on a wall.
Entering is a transform, not a second copy of the geometry, and taking the
headset off puts the world back on the desk at its own size.

**Support is probed before the button is offered, and warmed before it is
pressed.** `requestSession` needs transient user activation, so loading the XR
chunk and probing support inside the button's own click can outlast the
activation window and have the session refused. Both happen when the renderer
comes up instead, which also means the button appears only where a headset really
is on offer. Controller pointer selection and near interaction are turned off:
each batch is a single mesh with `isPickable = false`, so a ray could only ever
hit "the table layer", never a cell — and leaving them on drags in optional
modules that are not registered under deep ES imports, which fails the whole
initialisation.

**A connector's mark names the relationship it stands for.** A line drawn by
following a foreign key shows a key; a line to a query box shows the same `SQL`
mark as the halo button that opened it, and a line to a chart the same three
bars — one shared constant apiece, so a button and the line it produced can never
drift apart. Two of the three marks are geometry rather than glyphs, for the same
reason: the atlas rasterises whatever the system font provides. A key character is
unevenly supported, and the block-drawing characters that spell a bar chart are a
full em wide apiece however they are drawn — three of them do not fit a square
button at a size the shortest bar survives, and where they do fit they touch, so
the mark reads as one filled staircase rather than as bars. Three rectangles read
as a chart at any size and on any machine. They are returned as plain rectangles
and drawn by each caller into its own batch, because the halo has to paint its
mark into the quads, over the button face, where the polygon batch is underneath. The detail is revealed on demand, and
it is the detail worth reading: the filter for a foreign key, the statement for a
query. Re-running a query retitles its line, because a connector describing a
statement the box no longer runs is worse than one with no label at all.

**The SQL button always derives a new table; it is not a toggle.** Refining a
query is how the next one is made, so pressing it on a derived table nests that
table's statement in a fresh box beside it and leaves the original showing its
result. Going back to a box's _own_ editor is a different intent, so it is a
different button: a pencil, offered only on derived tables, because only they
have a statement to edit. Leaving an editor by Escape shows the result the box
already had — it does not run whatever is in the field.

**A derived table is tinted, not reshaped.** A table produced by a statement
takes a tint of the accent on its title bar, its title colour, and a thin accent
stripe along its top. Nothing else about it moves, so "this one was computed" is
legible at a glance and still legible at far zoom, where the title is all that is
drawn.

**A capability the table lacks is greyed out, not hidden.** The demo relations
are generated in the browser, so there is no engine to send SQL to and the halo's
SQL button is inert on them. It is still drawn: a greyed-out control says "not
for this table", where a missing one says nothing at all. Whether a table can run
SQL is a property of what backs it, not of the table, so it comes from the host
rather than being recorded on the entity.

**The agent interface is a pipe, not a second application.** An agent asks about
the document, the history and the session — and all three exist in one
`PanoramaCore`, in one browser tab. A server with its own copy would be a second
opinion about what the document is, and the two would drift the moment either was
touched. So the server holds no state at all: a tool call goes down a pipe, the
page runs it against the live session, and the answer comes back. Which is also
why an agent's edits appear on screen as they are made, and undo like anyone
else's — they are the same commands, in the same history.

It lives on the development server for the same reason. There is nothing for it to
do without the application, so it belongs in the process that is already serving
it: one thing to start, one origin for the page to talk to, and no port to agree
on. Two plain HTTP routes carry the pipe — an event stream out to the page, a post
back — because both ends have those already and neither needs a dependency. And
it is a _development_ interface: an endpoint that can edit the document has no
business in a build, so the plugin says `apply: 'serve'` and the endpoint is bound
to the loopback interface only.

The awkward part of that arrangement is that the two halves run in different
processes, and the half offering the tools must be able to list them before — and
whether or not — a page is attached. So the catalogue of tools is separated from
the doing of them: `catalogue.ts` is names, argument shapes and descriptions, and
imports nothing from the workspace, because it is loaded by the dev server's own
configuration where a `.ts` import from another package cannot be followed;
`operations.ts` holds a handler per name and runs in the page, where it can reach
for anything. A test insists the two name exactly the same tools, which is the
seam: without it a tool could exist and do nothing, and the disagreement would
only ever show up as a puzzled agent.

**This is not the only way into the database, and it says so.** A canvas session
reaches Exasol through a browser, a worker and a block cache sized for drawing —
exactly right for a hundred thousand rows on screen at sixty frames a second, and
exactly wrong for scanning a billion. So the handshake tells an agent to use a
native connection for the database work and this server for the canvas: work out
what is true with the fast path, then put _that_ on the canvas here — open the
table, derive the query box, set the chart up — so a person can see it, move it and
follow it. The two compose; neither is a substitute for the other. What is on
screen is this server's to answer for, and what is in the database is not.

That advice is worthless without a way to check the other end, because a machine
may be running several databases with a server apiece and an answer from the wrong
one is worse than no answer. So `overview` reports which database this session
actually reached: the URL it connected to, and the name, version and session id
_the server itself gave at login_ — evidence rather than a hint, since a URL is
something somebody typed. An agent is told to compare those against whatever a
native connection says about itself before mixing their answers, to say which one
it used, and to prefer the one attached to this canvas where they disagree, because
that is the one whose answers match what the person is looking at.

And it is told to read the semantic layer first where there is one. A column called
`AMT` is not a metric, and a metric called "net revenue" usually has a definition
somebody has already argued about; described metrics, dimensions, synonyms and
curated views are the context that stops an agent inventing its own from column
names. Panorama's catalogue carries what Exasol's own catalogue holds, comments
included, and a table's columns come back typed — that is the least of it, and a
semantic layer is the rest.

The guidance lives in the protocol's `instructions`, which is the one thing a
client reads _before_ choosing a tool, and again in the descriptions of the tools
it applies to — `catalogue`, `query`, `rows` — because a description read at the
moment of use is likelier to be acted on than a preamble read once.

**An answer is read by something with a finite amount of room to think in.** So
answers are terse by default. A box comes back as what it reads, how many rows it
has, and its columns' names and types — the first sixty of them, with a count when
there are more, because a five-thousand-column table exists and a list of five
thousand names is not a description of it. Column ids, pixel widths, scroll
offsets, connectors and the composed statement are all `verbose`, which is where
somebody who wants them can find them. The statement is said _once_: a draft that
matches the committed one is not news, and the composed form of a long chain is
the same base transformation echoed back on every single call.

Running a statement returns the first few rows with it, because "run it, then read
it" was two calls for every analytical step and the first thing anybody does with
a result is look at it. Which needed the rows to be _waited_ for: they arrive when
something asks for them, and on a canvas that something is the frame loop — so
there is now one place that asks and waits, and it is the difference between
reading a result and reading whatever the renderer happened to have fetched.

A box holds one statement, so running another replaces it. That is right for a
scratchpad and wrong for a result worth keeping, so a statement can be run as a
_sibling_ instead: a fresh box beside the same parent, leaving the first alone. And
a box can be given a name — `SetTableLabel`, the counterpart to the binding label
that already existed, because the box is the thing you look at and a canvas where
seven of them all say `RAW.CLAIMS · SQL` is one you have to read the statements to
navigate.

**A picture can be asked what it came out like.** A chart drawn by a written
option is a layout nobody can see from the other end of a pipe, and "it did not
throw" is not feedback. So a chart box reports what the canvas actually made of
it: the rectangle it was laid out for, how many shapes and labels it drew, what
those cover, and — by name — any label that ended up outside the box. Read from
the layout the renderer last asked for rather than laid out again, because these
are the real measurements, taken with the real glyph atlas at the size the box
really is; an approximation would report overflow that is not there and miss the
overflow that is. It is on a plain read as well as after setting a chart up, since
the geometry settles a frame or two later and asking again should not mean drawing
again.

**Arguments are described once and checked at the boundary.** Every tool needs its
arguments twice over — as JSON Schema, so an agent knows what to send, and as a
runtime check, because what arrives is whatever the agent actually sent. Written
twice they drift silently. So they are written once, as a table of fields, and
both are derived from it. `additionalProperties: false` and a refusal for an
argument that was not described, because a misspelt argument that is quietly
ignored looks to an agent exactly like one that was honoured — and it will believe
the reply.

The same check applies to commands, which is the one place a wrong shape could
reach past the type system: `MoveEntities` with a string where a list belongs has
to come back as a sentence rather than as a crash halfway through applying it.
What is _not_ re-checked is meaning. Whether the entity exists, or the column
belongs to that table, is `applyCommand`'s answer to give — the same answer a
pointer gets — and a second opinion here could disagree with the first.

Three commands are deliberately not offered. `CreateTableEntity`,
`SetTableColumns` and `SetTableSource` describe a table's _identity_ — what it
reads and what shape that has — and none of it can be invented: the columns come
from a result set, the source needs a connection behind it, and an entity
assembled by hand is a box with nothing to draw. The refusal names the tool that
does the job properly, which is more use than a valid-looking command that leaves
the application holding a table it cannot fill. For the same reason the session
commands an agent may send stop at what is worth saying: hover, presses and
pointer positions are what a pointer device says about itself frame by frame, and
an agent writing them would be describing a hand that is not there.

**Pairing is something the machine can do, so the machine is asked.** Which
client, told about which endpoint, and is anything actually talking — three
questions that were a paragraph in a README, and all three have an answer on the
machine the development server is already running on. So the settings panel asks
it: whether the `claude` command is on a login shell's PATH, whether the desktop
application is installed, and whether either already names this session. Pairing
Claude Code goes through its own `claude mcp add` rather than writing its file,
because the CLI owns that schema and an entry that is subtly wrong fails later,
where somebody is trying to use it. Pairing the desktop application does write its
file, since it has no command to run — merged rather than replaced, because it is
the user's file, and refused outright if it cannot be parsed. Opening Claude means the
application where there is one: it is a window that is already set up, and putting
somebody into a terminal they did not ask for is not the same thing. Claude Code is
what there is when there is no application — opened by asking the terminal to run
it in this project's directory, because a terminal is the one thing that cannot be
started headless: what makes Claude Code usable is having somewhere to type. The
button says which of the two it will open, since the panel already knows.

Everything that reaches the machine is behind one interface, and the deciding is
kept apart from the doing: `claude.ts` decides, `node-environment.ts` is the only
file that touches the user's files or starts their programs. That is what lets the
whole of it be tested against a machine that is not this one.

The two routes that can start a program or write a file insist on a JSON POST.
Not for form's sake: a cross-origin form post arrives without the browser asking
permission first, so without that, any page open in the same browser could ask
this machine to open Claude. JSON makes the browser ask, and this endpoint grants
nothing. It is bound to the loopback interface and exists only while the
development server does.

The nested shapes are described too. A `spec` used to arrive as an opaque object,
which meant its enumerations — `sort`, `legend`, `orientation` — were discovered by
being refused, one round trip each. So a field can carry a JSON Schema of its own,
used as written, and the ones that matter now list their values. Depth in a
position is optional, because stacking order is not something a caller placing a
box has a view on. And commands can arrive as a list, applied in order and stopped
at the first refusal, because tidying a dozen boxes should not be a dozen calls.

**A cell that has not arrived is not null.** A table is a window onto a result
set, and `rows` returns only what has been fetched — with a count of what has not,
said plainly. Null is a value a database can return, and an agent handed one for
the other would draw a conclusion about the data from the state of a cache.

**Credentials never enter the world model.** They pass from the connection
dialog's local state to the data worker's `connect` message, and no further.
Panorama's canonical state holds a `connectionId`. The shell remembers the URL of
a live connection, because the explorer's indicator has to name it, and nothing
else about it — a username is no secret, but the shell holding half a credential
for the sake of a caption is the first crack in the rule.

**The connection dialog is a question, so it goes once it is answered.** It used
to stay on screen while connected, with every field disabled and a button to undo
itself: a quarter of the sidebar spent saying "connected". What is worth saying
then is which database, and that belongs beside the tree of it — so the explorer's
title row carries a small indicator, a dot and the host, and the way off the
connection is the one control on it. A dot rather than the word, because a caption
that is only ever there when it is true is not information. Host and port rather
than the URL, because `wss://` is the part that is the same on every connection
anyone makes to Exasol, and the whole URL is still in the tooltip.

Which left the dialog's `connected` state reachable by nothing, so it went too.
The form is now the form for when there is no connection, and disconnecting lives
where the connection is named.

**Text is behind an abstraction.** The grid talks to `TextRenderer`; the current
implementation is a canvas-rasterised glyph atlas drawn as instanced quads.
Replacing it with an MSDF engine means replacing one factory.

**A row shows all of its text or none of it.** Rows scroll by the pixel, so at
any moment the row at each edge of the body is cut — and clipping a glyph
half-way up does not abbreviate a value, it changes it. A halved `8` reads as a
`0`, and a halved row _position_ reads as a different row. It looks worst at the
bottom edge, where the clip line is the horizontal scrollbar and a sliced number
looks for all the world like the bar is lying on top of it. So a partly visible
row keeps its background — the stripes still slide by the pixel, which is what
makes scrolling feel continuous — and its letters wait until they can be read.

The wait is short, because the test is against the band the glyphs actually ink
rather than the whole row. Text is centred on a baseline, so a twenty-four pixel
row can lose six or seven pixels and still show every character whole; a
whole-row rule would have left a visible gap under the header instead.

**The row-number gutter is as wide as its longest number.** A fixed gutter
cannot work, because the number in it is a _result position_: a hundred-row
table needs three digits and a ten-billion-row one needs eleven, and a width
that suits the first truncates the second. Truncation is worse here than
anywhere else on the table — an abbreviated value is still recognisably that
value, but `99999…` is a position that reads as a different position.

The width comes from the row count, not from the numbers currently on screen, so
it is settled once when the result set reports its size and never moves again
while scrolling; a gutter that grew as you passed a million would shift every
column to its right. It is never _narrower_ than the configured width either, so
an ordinary table keeps the proportions the rest of the chrome was designed
around. The extra room comes out of the cells rather than out of the table, which
on a very tall narrow table means a horizontal scrollbar appears where it did not
before — the alternative, resizing the table when its row count arrives, would
put a commit in the history for every table opened.

The per-digit width is an estimate — the widest digit of the fonts the atlas
falls through, rounded up — rather than a measurement, because hit testing has to
arrive at the same gutter as drawing and it has no text system to ask. Both go
through `tableMetrics`, so they cannot disagree.

**Two draw calls.** Every visible table renders into one batched quad mesh and
one batched glyph mesh, in painter's order. Draw calls scale with rendering
features, not with table count or table size.

**Exactly one entity is activated at a time.** `activatedEntity` is a single
value — the hovered entity, or the focused one when nothing is hovered — rather
than a predicate that several entities could satisfy. That is what keeps one
action halo on screen instead of a trail of them behind the pointer.

**Bindings connect entities and survive movement.** A binding is its own record
with `fromId`, `toId` and per-end anchors — the shape tldraw uses — but with one
deliberate difference. tldraw recomputes bound geometry in lifecycle hooks that
write back to the shape records; Panorama derives it every frame instead. A
connector's endpoints are a pure function of the two transforms, so nothing has
to be kept in sync, moving a table appends no extra commits, and no derived
geometry leaks into document history. Anchors are either `auto` — tracking the
border facing the other end, which is what makes a line _mobile_ — or `fixed` at
a normalised point, which is the _sticky_ attachment the same model will use for
notes. Removing an entity cascades to every binding that referenced it.

**A test harness that mirrors production is not a test of it.** The factory that
chooses a table's data source — a local demo relation or a live Exasol result
set — was mirrored by the worker test harness rather than called by it. The
mirror passed a followed key's filter to the demo branch; the real function
dropped it on the Exasol branch, so following a key against a database opened the
referenced table in full. Every test passed, the demo was perfect, and the bug
was only reachable with a real connection. `createTableSource` is now tested
directly, by reading back the statement the driver would send.

**Following a foreign key is the first thing bindings are for.** A cell in a
single-column foreign key column renders as a link; clicking it opens the
referenced table filtered to the matching rows, sized to them, and joins the two
with a directed, labelled connector. Composite keys are deliberately _not_
followable: one cell of a multi-column key cannot identify the right rows.

**Exporting is encoding, and encoding belongs where the connection is.** A file
of a billion rows is the one feature that invites a server: give a sidecar the
credentials, let it talk to the database, and the browser never sees the bytes.
It was the wrong answer here, for four reasons that all point the same way.
Panorama _is_ the client — the Exasol driver runs in the page, so a sidecar
would not remove the transfer, only redirect it. Credentials pass from the
connection dialog to the data worker and no further, and a sidecar would need
its own copy of them, at a second destination. The demo relations are generated
in the browser, so a sidecar could not export them at all, which means writing
the browser path anyway and having two. And it would be the first thing in this
repository that has to be deployed rather than served. So the encoders run in
the data worker, beside the socket and off the render thread — and the seam that
would have been a network boundary is `RowEncoder` instead, which is where a
Rust encoder compiled to WebAssembly would slot in if profiling ever asks for
one. That is the way to get arrow-rs into this problem: inside the worker, not
behind a port. It has not asked yet: on this machine the encoders run at roughly
2–3 million cells a second for CSV and Parquet and 1.1 million for a deflated
spreadsheet, which is about 18, 15 and 7 MB of output a second — a million rows
of a four-column table in a second or two, against a database that has to send
them first.

**Nothing is ever held whole.** All three formats were designed to be written
forwards: Parquet keeps its metadata in a footer, ZIP states an entry's size
after the entry, and CSV has no structure to patch. So the sink only ever
appends, the encoders never seek, and the file streams to disk through the File
System Access API as it is produced — a ten-billion-row export costs one batch
of memory and however long the database takes. Where that API is missing the
whole file is assembled in memory and offered as a download instead, which
works and is bounded by memory rather than by disk. The one thing that cannot
stream is a Parquet row group, because a column chunk must be contiguous; that
buffer is the writer's entire memory cost and it is bounded by a byte and row
budget rather than by the size of the relation.

**The worker waits to be told each chunk landed.** The bytes are encoded next to
the connection and the file belongs to a save dialog on the main thread, so each
chunk crosses with its buffer transferred and the encoder then waits for an
acknowledgement. Without that wait a fast database and a slow disk become an
ever-growing queue of chunks in the message port, which is an out-of-memory
failure wearing an export's clothing. The wait ends on a cancellation as well as
on an acknowledgement — an export spends most of its life inside a write, and
pressing stop has to work there rather than at the end of the batch.

**An export reads its own result set.** Sharing the one the table is browsing
would mean two readers seeking a single cursor against each other: the export
would drag the scroll about and the scroll would drag the export. So the worker
opens a second result set for the same statement and closes it afterwards.
Batches are deliberately modest for the same reason the viewport's blocks are —
one connection carries both, and an export should never be why a scroll's data
arrives late.

**Export is a disclosure, not four buttons.** One button that wrote "a file"
would have to choose a format for the user, and a headset has nowhere to put a
dialog asking which. So pressing it replaces it, in place, with one button per
format — the same halo with a different list of actions, so nothing new is drawn
and nothing new is hit-tested, and it works identically under a pointer, a
finger and an XR ray. In place, rather than as a menu of its own, so the buttons
that were not asked about stay where they were: choosing a format does not take
away the ability to close the table. The formats are spelled out on wider
buttons, because `PQT` is a puzzle and `PARQUET` is a word.

**Parquet gets the type the database declared, wherever that mapping is exact.**
Booleans, doubles, decimals and dates become Parquet's own BOOLEAN, DOUBLE,
DECIMAL and DATE, so a reader gets numbers it can sum and dates it can compare —
and a `DECIMAL(36,2)` keeps every digit, because Exasol sends those as text
precisely so that nothing is lost on the way and Parquet, unlike a spreadsheet,
has an exact decimal to put them in. Rescaling is done in integer arithmetic and
never touches a float. Timestamps, intervals, geometries and hashes stay strings:
their meaning is bound up in a session's time zone or a spatial reference the
file has no room for, and a string is at least exactly what the database said.
Reinterpreting them would be guessing, and guessing quietly is the one thing an
export must not do. A spreadsheet is typed per _cell_ instead, from the value:
what arrived as a number is a number, and a high-precision decimal stays text,
because a spreadsheet has nothing more precise than a double.

**A NULL is not an empty string.** They are different values and a file that
renders them alike has thrown information away. CSV quotes the empty string —
the only way that format has of telling them apart — and leaves a NULL as
nothing at all. A spreadsheet gets a cell with no value, which is what a blank
cell is; the blank is written rather than omitted, even though a sheet may be
sparse, because a row whose last columns were all NULL would otherwise be
narrower than its neighbours and a reader taking the sheet's width from its rows
would quietly lose those columns.

**A failed export leaves no file.** A truncated Parquet file has no footer and a
truncated workbook has no central directory, so neither would open — a
half-written export is not a small export, it is a corrupt one under the name
the user chose. So the destination is abandoned rather than closed on any
failure, and cancelling discards what had been written.

**The encoders are written here, and checked by someone else's reader.** Two
runtime dependencies is the whole of this repository's appetite, and the
alternative to a Thrift serialiser and a ZIP writer was two more — for a
download button, in a codebase that already implements RSA/PKCS#1 and a database
wire protocol. What that costs is the confidence a library would have brought,
so it is bought back: the Parquet footer is read back in the tests by a Thrift
_reader_ written independently from the specification, and `npm test` with
`PANORAMA_EXPORT_SAMPLES` set writes sample files that pyarrow and openpyxl
open. A test cannot validate a format it also implements; another
implementation can.

**The explorer is a tree, and it starts closed.** A dropdown could only ever
show one schema's contents at a time and gave no way to compare two, which is
most of what exploring a database is; it also hid the _shape_ of the database
behind an interaction, when the shape is the thing being explored. Schemas are
listed closed because a database has more of them than a sidebar has room for,
and because listing one costs a query — so opening a schema is what asks for it,
and the query happens once however often it is folded back open. A schema that
could not be listed says so _inside itself_, leaving the others usable, and
closing and reopening it is the retry.

The tree owns which schemas are open and nothing else. That is pure view state —
gone when the connection is — so it lives in the component, while what has been
loaded stays in the shell. The tree reports an opening as an intent, the same
split the halo uses: the control says what the user did and the composition root
decides whether that means work.

**A row count is the database's, or it is absent.** A table's comes free with
the listing — `EXA_ALL_TABLES` records it, maintained with the database's own
statistics — so showing it costs nothing. A _view_ has no count in the catalogue
at all: the only way to know how many rows one has is to run it, and a view over
a ten-billion-row table would then charge an arbitrary query for the privilege of
opening a schema. So a view shows no number rather than a wrong one or an
expensive one, and neither does a table whose statistics have never been
gathered — absent is not zero, and a table that really is empty says `0`.
Counts are abbreviated only from ten thousand up, because `1.20K` is exactly as
wide as `1,204` and says less; the exact figure is in the row's tooltip either
way, next to its comment.

**Tables come before views, and the icons say which is which.** Exasol returns
them interleaved and sorted by name, so the grouping is done where it is a
presentational choice rather than in the driver's query. Within each group the
database's own ordering is kept — re-sorting here would only be a second opinion
about collation. A kind neither of those goes last and spells its name out
beside the row, because a database may report one this was not written for and
guessing at an icon for it would be worse than saying what it is. The marks are
inline SVG rather than the letters the halo uses: the halo is drawn by the GPU
from a glyph atlas, where an icon would need a pipeline, but a DOM sidebar needs
none — and a grid and an eye are distinguishable at thirteen pixels where
`TABLE` and `VIEW` are not.

A schema gets no mark of its own. An icon earns its place by telling one thing
apart from another, and every row at the top level is a schema; one they all
share distinguishes nothing, and the chevron beside it already says the row
opens.

**A message that tells you to open a URL makes it a link.** The self-signed
certificate notice is the one that matters: a page cannot make an exception for
its own `wss://` handshake, so the only way through is to visit the host over
`https://` and accept the warning there. Telling someone to open a URL and then
making them retype it is a needless step in the middle of an instruction. The
links are found in the text rather than described alongside it, because a message
is a plain string all the way from the driver — it crosses the worker boundary as
`{ code, message }` — and that keeps the protocol as narrow as it was. Only
`http` and `https` are recognised, and a link always opens in a new tab:
navigating this one away would take the whole workspace with it, every open table
and any statement being written.

**A table opens in the nearest free space, measured from the explorer.** The
first few used to walk a diagonal stagger, which is fine for three and then
walks off the canvas: the fourth is half off screen and the tenth is somewhere
you have to go looking for. Now the spot is searched for, with two rules in
order — _inside the view beats close to the explorer_, because a table you
cannot see is worse than one a little further along, and then closest to the
top-left corner, which is the corner the explorer is next to and the explorer is
what was just clicked. When the view really has no room left the table goes
just outside it and the shell reveals it, which pans only as far as it must;
revealing a table that already fits does nothing at all, so the camera never
moves without cause.

**"Near" is measured from an edge, not a point.** A table opened from the
explorer wants to be near the explorer; a table opened by following a foreign key
wants to be _beside the table the key came from_, because the line drawn between
them is the point and a long line reads as two unrelated tables. Both are the
same search from a different anchor: a vertical segment the new table should end
up alongside. Distance to a segment is nought anywhere along it, so when the spot
beside the source is taken the next choice slides up or down that same edge
rather than being shoved a table's width to the right. The explorer's anchor is a
segment of no length — a corner — which puts the distance back into the vertical
and makes tables opened from the list fill the view across before down, in
reading order. Following a key used to use a fixed offset, which put the new
table straight on top of whatever was already sitting there.

The candidates are the corners the existing tables make, not a lattice over the
world. A new table can only ever sit flush against the right or the bottom of
something already there — anywhere else either overlaps or leaves a gap nothing
will fit into — so the search is a handful of positions rather than thousands, it
costs the same at any zoom, and what comes out is _aligned_ with its neighbours
rather than merely clear of them. A hole left by a closed table is filled again
by the next table that fits it.

Placement is in Core rather than in the shell, because "where does a new entity
go" is a question an agent will ask too, and it is answered from geometry alone:
the sizes of what is there, and the rectangle currently on screen. Only the last
of those belongs to the camera, so the workspace is handed a function to ask it
with. A position given explicitly is never second-guessed — a followed foreign
key and a SQL box both place themselves beside their source, and that is not a
spot to be improved upon.

**Columns are picked out by their headers, and picking is not an edit.** A click
on a header takes the column; a click on it again gives it back; a drag sweeps a
range; Escape lets go of the lot. All of it is session state — the same place a
drag and a hover live, and the same reasoning: choosing what to look at is not a
change to the document, so it leaves no commit, survives no reload, and costs
history nothing.

A sweep only ever _adds_. It lights the first column up on the way down, so the
gesture has an answer under the finger immediately, and it grows to the range
between where it began and where the pointer is now — so sweeping out too far and
coming back leaves what is between the ends rather than everything the pointer
has touched. Taking columns out is what a second click and Escape are for, which
keeps one gesture from having to mean two things. Because taking one out waits for
the release, clicking a column that is already picked out does not flicker.

Escape backs out of the narrower selection first: the columns go and the table
stays active, so letting go of a few columns does not also let go of the table
they are in. A second press clears the table.

The selection is a flat set of column ids rather than a selection belonging to
one table. Column ids are unique, so the set already says which table each
belongs to, and two tables side by side can each have columns picked out while
they are compared — which is most of what a spatial canvas is for. Closing a
table lets go of its own columns and leaves everyone else's alone.

**A picked column is washed, not repainted.** The tint goes on after the rows and
before the grid lines, and the values are glyphs, which land on top of every quad
whatever order they went in — so the striping, the hovered row and the data all
read straight through the selection. Each selected column gets an edge on both
sides, so two neighbours read as two columns rather than one wide one.

**A picked column opens a panel under it, and the panel is drawn.** Below the
table's bottom edge, aligned to the column so the eye can follow one into the
other, and outside the table's bounds for the same reason the halo is: data is
the one thing on screen that must never be covered up. A panel wider than its
narrow column overhangs to the right, and where that would cover its neighbour
the later panel is pushed along — two overlapping panels are two panels nobody
can read. Being drawn rather than a DOM overlay is what keeps it in step with a
table that moves, scrolls and zooms, and what lets it exist in a headset.

The row of panels goes above the table instead when the space below is taken by
another table. The canvas is a space users arrange themselves, so "below" is not
always empty, and a panel is opaque: dropping the row onto the table someone
parked underneath would bury its rows. Ordering cannot save it — every glyph in
the scene is drawn after every quad, so a neighbour's text would read straight
through a panel's background whatever order the backgrounds went in — so the
overlap is avoided geometrically. If both sides are occupied the row goes below,
which is where it belongs.

**What the panel says follows the data, not the declared type.** How much is
missing comes first, as a bar before it is a percentage; then how many different
values there are; then a picture. Few enough values to name and each gets a bar
with its count. Too many, and a numeric column gets a bar per range instead. A
column that is neither gets its counts and no chart, which is a truthful answer
rather than an invented one. Empty ranges keep their place in a histogram: a gap
in a distribution is part of its shape, and a chart with the gaps closed up is a
chart of different data.

**A summary is asked of the source, never derived from the screen.**
`TableDataSession.summarise` is an optional capability. Exasol answers it with
two portable aggregates over the statement the table is showing — a followed key
or a written query included — reading one column, so a five-thousand-column table
costs one column's worth of work. The demo generator has no `GROUP BY` to lean on,
so it walks its own rows, at most a hundred thousand of them, and says
`basis: 'sampled'` when it stopped early; the panel then states which rows it was
looking at. A source with no way to answer returns nothing rather than something
computed from the blocks that happen to be cached, which would be a statement
about the scroll position dressed up as a statement about the column.

Date and timestamp columns get named values rather than ranges. Binning them
needs date arithmetic that differs between databases, and an untested path
against a real database is exactly the kind of thing that ships broken — a bar
per date is usually the more useful answer for a date column anyway.

**Summaries are derived from the selection every frame**, like bindings, rather
than fired from whatever changed it: one place decides what should be loaded, and
no new gesture can bypass it. They are cached by column view, so toggling a
column off and on does not ask the database twice, and dropped when the column is
let go of. An answer that arrives after its column was let go of is discarded
rather than shown.

**A chart is a kind of table too.** `TableSource` gains a third member: a
`chart` carries a specification and a reference to the table it draws. Everything
downstream — the halo, connectors, placement, dragging, resizing, the LOD, the
chain that closes and refreshes — works on it unchanged, because it is the same
kind of thing as a query box: one step, plus the name of its input. It starts in
`editing` with a form over it and switches to `result` when the setup is
committed, exactly as a statement does.

The specification is document state and the rows are not, for the same reason a
table's rows are not: a chart entity stores the question, never the numbers.
Turning a dial is not an edit — it updates a draft in session state and redraws —
and committing the setup is one `SetChartSpec`, so a chart costs one entry in
history rather than one per control.

**The setup box splits: controls down the left, the chart in the rest of it.** A
form covering the whole box would make every setting a guess followed by a reveal,
which is the difference between configuring a chart and filling in a questionnaire
about one. The split is one function, `chartBoxLayout`, because the controls are
DOM and the picture is drawn by the GPU: two different systems have to agree on the
same two rectangles, and a disagreement would show up as a form overlapping its own
preview. The GPU paints the controls' ground too, so the split reads the same in a
headset, where there is no DOM at all. A box too narrow to split gives the whole of
itself to the form — half a form beside a sliver of chart is neither.

**A chart library's settings do not fit in a flat list.** So they are grouped by
what someone is thinking about — what to draw, which categories, how it looks, what
is written on it — and everything past the first group is folded away until wanted,
using native disclosure so keyboard and screen-reader behaviour comes for free. A
control appears only where it does something: there is no stacking on a pie and no
hole in a bar chart, so neither is offered. Which settings apply to which chart is
one table, `chartSupports`, read both by the form deciding what to show and by the
option builder deciding what to apply — so the two cannot drift into offering a dial
that turns nothing.

Under all of that is one raw field: an ECharts option, merged over everything the
controls produced. Every chart library has hundreds of settings and a form with
hundreds of controls is not a form, so the controls cover what people reach for and
the field covers the rest. The merge is deep, and lists merge element by element
rather than wholesale — which is how ECharts' own option merging behaves and the
only way the commonest override there is can work: `series: [{ itemStyle: { color:
'red' } }]` has to mean "recolour the first series", not "replace both series with
this thing that is not a series at all". Text that does not parse is reported beside
the field and the chart draws as the controls asked, which is more use than either a
blank box or a silently ignored setting.

**The setup starts with a guess, not with an empty form.** A dimension against a
measurement, so the first thing you see is a picture and the controls that made
it. Which numeric column is a measurement is guessed from its scale: a column with
decimal places is a quantity, a whole-number one is as likely to be a key, and
summing order numbers is a chart of nothing. A table with no numbers at all counts
its rows instead, which needs no measure and is the honest fallback.

**ECharts is used as a layout engine, not as a renderer.** It never touches the
canvas. Two hinges make that work. Its text measurement is replaced with
Panorama's own glyph metrics through zrender's `setPlatformAPI`, so every axis
label it positions is positioned for the text that will actually be drawn — get
this wrong and the numbers sit on top of the bars, which is exactly what happened
until the right pair of style properties was being read. And its geometry is taken
out of zrender's display list rather than off a canvas: every shape emits itself
through `buildPath` into a context that records polylines instead of painting, so
one adapter covers bars, lines, areas, sectors and scatter symbols with no
per-chart-type code. Fills are triangulated by ear clipping, strokes become
ribbons of quads, and the result joins the same two batches as every table — sharp
at any zoom, and present in a headset.

It enters the codebase the way Exasol did: behind an interface Panorama owns.
`@panorama/chart` defines `ChartSurface` and the geometry it returns and depends
on nothing; `@panorama/chart-echarts` implements it; `apps/web` is the only place
that names the library. The renderer does not know it exists.

What does not come through the seam is tooltips — ECharts skips them in the
server-side rendering mode this uses — and anything from `echarts-gl`, which needs
its own WebGL context and camera. Rotated axis labels are declined rather than
drawn upright, because the glyph batch cannot turn and a label in the wrong place
is worse than one that is missing; ECharts hides colliding labels instead, which
is its own default.

**Presentation and numbers are kept apart.** `ChartSpec` is the question — which
column, which measure, how to draw it — and `ChartData` is what came back. They
change for different reasons: a colour is not a reason to read the rows again, and
the layout cache is keyed on the specification so that turning a dial redraws
without refetching, while a frame in which nothing changed does neither.

**A chart can be pointed at, and parts of it picked out.** Hovering lifts the mark
under the pointer; pressing it picks it out and fades everything else, which is what
says "these ones, not those"; pressing the background lets go of them all. Additive,
because comparing two bars is the reason anybody picks one out in the first place.

Both are done against Panorama's own geometry rather than through the charting
library, and not for want of trying. A chart library's hover and selection are driven
by DOM events on a canvas it owns, and there is no such canvas here: the pointer
arrives from a mouse, a finger or a ray in a headset, and in the last of those there
is no DOM at all. Its own state machinery is off in the rendering mode this uses,
too — the same reason the tooltip does not survive the seam.

So the geometry carries which mark each piece belongs to, read out of the display
list at layout time. The library keeps that identity on a private key whose name
carries a module-load counter, so it is found by _shape_ — the one property holding
an object with a numeric `dataIndex` — and followed up the tree, and along the
attachment a value label has to the bar it labels. Named lookup would break on a
version bump silently, leaving a chart that draws perfectly and cannot be touched;
found by shape, the contract test has something to fail on.

Hit testing is then a point in a polygon, painter's order, last drawn wins — the same
as a column header or a connector's marker. The effects are colour, so nothing moves:
pointing at a chart cannot make it jump. And a chart's whole body below the title is
hittable, because the drawing has no gutter and no column header and hit testing must
agree with drawing, or the left edge of every picture is a row-number strip that is
not there.

The marks live in session state, like every other selection: choosing one is not an
edit. Holding them there rather than inside the library also means they survive a
re-layout, which happens whenever the box is resized. They are let go of when the
chart is set up differently, because the third bar of a chart sorted by size is not
the third bar of one sorted by name — and an export writes the chart as it is rather
than as the pointer left it.

**One chart type is a text field, and it is aimed at an agent.** Five kinds are
assembled from controls — bars, line, area, scatter, pie — and every control is
offered only where it means something. That covers what people reach for, and a
form with a control for each of ECharts' several hundred settings would not be a
form. So the sixth kind is `custom`: the option is written out, and it _is_ the
chart. Radar, sankey, treemap, heatmap, gauge, boxplot, a graph — whatever the
library draws, configured however it likes.

It is in the form because hiding it would misdescribe what the chart can do, but
writing an ECharts option by hand in a textarea is a poor use of somebody's
afternoon and a very good use of a language model's — so the tool description
spells out the whole arrangement, and the form's own hint spells out the dataset.

Nothing of Panorama's is merged on top of a written option. The five assembled
kinds treat the raw field as an _addition_, deep-merged over what the controls
produced; a custom chart is the other way round — what is underneath is a handful
of defaults being offered, so the merge is shallow and a written `dataset`
replaces ours entirely rather than leaving half of ours behind it. What is offered
is a transparent background, the canvas palette and font, and the reduced rows as
`dataset.source` with a header row of `[category, ...values]`, so a series can
read the table through `encode` like any other ECharts chart — or ignore it and
carry its own numbers. A gauge of one figure is a chart, so a custom chart is
drawable as soon as its option parses, whatever columns it names.

The reduction still happens. A written option is a picture of a few dozen numbers
rather than of a billion rows, exactly like the others, because that is what makes
charting a ten-billion-row table possible at all.

Three settings are forced over anything written, because they are not
preferences: animation is off, since the geometry is read back once per change and
an animation would be captured as a still frame of itself; tooltips are off, since
one is a DOM overlay this seam has no room for; and the font family is the
canvas's, since there is one glyph atlas and another family would be measured in
ours and drawn in ours. Hover and selection need a series index to attach a mark
to, so an exotic series may draw beautifully and pick nothing — which is said in
the tool description rather than discovered.

**A chart can show the rows behind what has been picked out of it.** The halo opens
a table beside it, empty — because a predicate over no values matches no rows, which
is the honest reading of "the rows behind nothing" — and it fills in as marks are
picked out and empties again as they are let go of. So it is a running answer to
"which rows is that bar made of" rather than a snapshot of one.

**`derived_table` is for a table that is actually derived.** A query box built on a
stored relation reads that relation, and naming it outright is clearer than
referring to it — which is what the application has always seeded such a box with.
But an agent writing a statement had to work that out from a parent id, and the
word it would guess at is the wrong one, so a box now says what to put after
`FROM`: the relation's own quoted name, or `derived_table` where the parent is
itself a query or a chart and there is no name to write. It is on the brief as
well as in the detail, because a box that has just been opened is about to have a
statement written into it, and that is the one thing the statement has to get
right. A statement that hides a named relation behind the word still runs — the
composition makes it valid — and comes back with a note saying which table it was.

**A cross-tabulation is two columns, not two measures.** The reduction groups a
category against one or more measured _columns_, which cannot express claim type
against decile: that is two columns of data. So a chart can name a second column
to group by, and then the series are its distinct values — which makes a grouped
bar chart, a stacked one, and a heatmap the same numbers laid out differently, with
no second code path anywhere downstream. One measure at a time, because two
measures split two ways is a cube and a cube is not a picture. A pair nothing was
reported for stays a gap rather than becoming a nought, which is what makes an
empty cell in a heatmap tell the truth.

A custom chart gets those same numbers as `[category, breakdown, value]` triples
rather than as a row per category, because there is no arrangement of columns that
is a triple and a heatmap reads nothing else. Without a breakdown the dataset stays
wide. That is the whole rule.

**Two `WITH` clauses in a row is not a statement.** A chain composes into one
statement, and a step that brought its own `WITH` used to be concatenated after
ours — which one database accepted by luck. Now the clause is found and its
bindings are merged into ours, `RECURSIVE` and all, which is what somebody writing
it by hand would have done; a statement that is not shaped like a clause falls back
to being written after ours, as before, since guessing would be worse than either.
The generated names give way to written ones as well: a statement that binds
`derived_table_1` itself would otherwise collide with ours, and two bindings of one
name is an error at best and the wrong table at worst.

Which made a filter a _membership_ predicate rather than an equality: picking three
bars out is one predicate over three values, not three predicates. One value stays
`= x` rather than `IN (x)`, because that is what a person reading the statement
expects and what an optimiser is likeliest to recognise; the missing category is
spelled out separately, since SQL's `IN` does not match a null; and no values at all
is `1 = 0`, which is clearer than an empty `IN ()` that half the parsers in the world
reject. Following a foreign key is now the one-value case of the same thing.

The category is filtered by its own _value_, not by its label. A label is for reading
and `String(7)` cannot be compared against a numeric column, so the chart's reduced
data keeps both and each is used for what it is. Marks of different series over the
same category count once: the rows behind "Sweden" are the same rows whichever
measure was clicked.

The table is an ordinary relation that remembers whose selection it shows, so it
closes with the chart and hangs off it on a line of its own. Its predicate is derived
from the selection every frame — the same reason column summaries are — and compared
against the one already showing, so a frame in which nothing was picked does not
reopen a result set. A chart of a written statement has no stored relation to drill
into and says so.

**A chart exports as a picture, and the picture is the box.** SVG, PNG and PDF,
behind the same halo disclosure a table's CSV, XLSX and Parquet sit behind — one
button that reveals three, in place, so the halo keeps its shape. What reaches the
file is the title, the chart and the line saying what it was drawn from, because a
picture without those is one nobody can place afterwards. The three formats share one
layout function, so an SVG, a PNG and a PDF of the same chart are the same picture
rather than three formats each with an opinion about how tall the file is.

No worker, no streaming and no progress bar: the geometry is already in hand and the
file is kilobytes, so by the time the save dialog has been answered the bytes exist.
The formats are greyed out until the chart has actually been laid out — a chart nobody
has drawn yet has nothing to write.

**Each format is asked of whatever is best at it.** The SVG is the chart library's
own, nested inside a document carrying the title and the note: the library still has
the arcs and the curves, and a drawing program is where an SVG usually ends up. The
PNG is that same SVG handed to the browser to rasterise, at twice the pixels — so the
two formats cannot disagree about what the chart looks like, and there is no second
painting routine to keep in step with the first. The PDF is written here, from the
draw list, like the Parquet and the spreadsheet: a one-page vector document is a few
hundred lines of a format that has not changed in twenty years.

The PDF uses the standard fourteen fonts, so its labels come out selectable,
searchable and copyable — most of why anybody wants a PDF rather than a picture —
which means the widths are Helvetica's rather than the application's, so a
right-aligned axis number is re-placed from the width the reader will actually lay out
instead of drifting off its tick. PDF's fill operator has no alpha, so a translucent
colour is flattened against the page: identical pixels for a page with one opaque
background, and the alternative was a graphics-state object per distinct opacity for
no visible gain.

**A chart says what it was drawn from.** The rows are reduced in the worker, next
to the result set, because a chart of ten billion rows is a few dozen numbers and
sending the rows across to discover that would be sending the whole table to draw
a picture of it. It reads a bounded number of them and states which: "100 rows"
plainly, "first 20,000 rows" in the colour reserved for things not to skim past.
Categories beyond the limit are counted and reported rather than silently dropped.
A category nobody reported a figure for is a gap in the series, not a zero — and
`Number(null)` being nought is exactly the sort of thing that makes an average
quietly wrong, so the check comes before the conversion.

**A line goes round a table rather than through it.** A connector is drawn
behind the tables, so one that crosses an unrelated table does not read as a line
behind a table — it reads as a line that stops and starts again somewhere else. So
when the straight-at-each-other curve would cross something, the other ways out of
the two tables are tried and the clearest short one wins.

Best effort by design, and cheap when there is nothing to avoid: the direct line
is scored first, and if it is clear nothing else is computed. Only when it is
blocked does the search run — every side of each end, and if none of those is
clear on its own, those curves leaned sideways as well. Leaning bends a line
without moving its ends or the direction it leaves either table by, so a route
that has to go round is still one smooth curve rather than a dog-leg. A fixed
anchor is never moved: that spot is the user's own choice.

Routes are ranked clear-before-blocked, then shorter-before-longer, then
roomier-before-tighter. Room comes last on purpose. A cubic overshoots
symmetrically, so over the top and under the bottom of an obstacle are usually the
same length to the millimetre; when they tie, the side with more space wins, which
is the one a person would have drawn. Putting room ahead of length would instead
buy clearance with a longer way round, which looks worse than the crossing it
avoids. A table boxed in on all sides has no clear route at all, and then the
honest answer is the direct line rather than a loop around the canvas.

The marker takes the path it is given rather than working one out, so hit testing
lands on the marker that was actually drawn. Both sides read their obstacles from
one function, `connectorObstacles`: if drawing and picking disagreed about what
the line went round, the marker would be picked where the line is not.

**Entity actions live in the halo.** Activating a table — pointer hover, and
whatever stands in for it elsewhere: touch, or an XR gaze or controller ray —
reveals a few buttons around its top-right corner. They are GPU-drawn like
everything else, sized in screen pixels so they stay usable when zoomed out, and
placed outside the table so they never cover data. Picking runs in two passes — a
table's own bounds first, topmost down, and only then the halo bands around one —
so the pointer can travel from a table onto a button without the button
vanishing under the cursor, the bands never shadow the table beneath them, and a
pointer that jumps straight onto a button still lands on it. `close` is the first
action; the button reports an _intent_ and the composition root performs it,
because closing a table also has to release its result set.

**Where a button sits says what it does.** The ones that make a _new_ box — write
a query, chart this, show the rows behind a selection — run down the right edge,
which is the edge the line joining them will leave from, so the halo points the
way the work is about to grow. The ones that act on the box already there — edit
its statement, save it as a file — run along the top. Close sits on the corner
between them, in neither line, because it is the one action about the box as a
whole. Each action declares which line it belongs to rather than the layout
recognising a list of names, so a new one cannot be added without deciding what
it does.

The corner is the anchor and both lines are measured from it: the top row is laid
out leftwards, so adding an action pushes the row out rather than shifting the
buttons already in it, and the column hangs below with the corner as its head —
which is why it needs no special case for the button above it. A declared width is
honoured along the top and ignored down the side, so the column is always one
standard button wide: a row can carry a spelled-out `PARQUET` and still read as a
row, where a column of several widths reads as a mistake and one wider than the row
it turns the corner from reads as a lopsided halo. Which means a mark that goes on
the side has to fit a square — and the charting mark did not, which is how it came
to be found being drawn as two bars and an ellipsis.

Turning a corner cost the hover band its single rectangle. Their union would
swallow the top-right of the table itself, and the band is tried before the
table, so those cells would stop answering — so there are two, one stopping at
the top edge and one starting at the right, meeting outside the corner. The
pointer can cross from either line to the other without passing through anything
that is neither, and a halo with nothing below its corner gets a side band of no
height, which matches no point and so needs no case of its own.

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
