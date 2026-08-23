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
password, or an Exasol SaaS personal access token), pick a schema, and click a
table.

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
pointer — pressing its close button, and confirming that hovering one table
while another is selected leaves exactly one halo on screen.

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
  Babylon renderer    React shell      (future MCP adapter)
```

Interaction never mutates a mesh and never mutates the document directly. A
pointer drag produces _session_ state while it is live, and exactly one
semantic command when it ends — the same command an agent would send.

### Packages

| Package                 | Responsibility                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `packages/core`         | World model, entities, semantic commands, branchable history graph, session state                                    |
| `packages/table`        | Result chunks, viewport arithmetic, row cache, prefetch policy, fetch scheduler — renderer- and database-independent |
| `packages/exasol`       | JSON-over-WebSockets driver: login (RSA/PKCS#1), metadata, result sets, positional fetch                             |
| `packages/worker`       | Data-worker protocol, worker host, main-thread client and table data controller                                      |
| `packages/renderer`     | Babylon.js scene, camera, batched GPU table renderer, glyph atlas, hit testing, interaction                          |
| `packages/ui`           | React shell: connection dialog, explorer, performance overlay                                                        |
| `packages/test-support` | Deterministic mock data sources, virtual clock, pathological relation generators                                     |
| `apps/web`              | Composition root: workspace, canvas, worker bootstrap                                                                |

Two boundaries are enforced by inspection and by dependency direction:

- no package outside `exasol/` knows about Exasol WebSocket packets;
- no package outside `renderer/` knows about Babylon objects.

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

**Credentials never enter the world model.** They pass from the connection
dialog's local state to the data worker's `connect` message, and no further.
Panorama's canonical state holds a `connectionId`.

**Text is behind an abstraction.** The grid talks to `TextRenderer`; the current
implementation is a canvas-rasterised glyph atlas drawn as instanced quads.
Replacing it with an MSDF engine means replacing one factory.

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

**Following a foreign key is the first thing bindings are for.** A cell in a
single-column foreign key column renders as a link; clicking it opens the
referenced table filtered to the matching rows, sized to them, and joins the two
with a directed, labelled connector. Composite keys are deliberately _not_
followable: one cell of a multi-column key cannot identify the right rows.

**Entity actions live in the halo.** Activating a table — pointer hover, and
whatever stands in for it elsewhere: touch, or an XR gaze or controller ray —
reveals a small row of buttons just above its top edge. They are GPU-drawn like
everything else, sized in screen pixels so they stay usable when zoomed out, and
placed outside the table so they never cover data. Picking runs in two passes — a
table's own bounds first, topmost down, and only then the halo band above one —
so the pointer can travel from a table onto a button without the button
vanishing under the cursor, the band never shadows the table beneath it, and a
pointer that jumps straight onto a button still lands on it. `close` is the first
action; the button reports an _intent_ and the composition root performs it,
because closing a table also has to release its result set.

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
- An action halo on the activated table, with a working close button that
  releases the result set as well as removing the entity.
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
