# Panorama — Architecture

Panorama is a spatial environment for exploring data in Exasol: tables, queries
and charts as boxes on an infinite canvas, drawn by the GPU, connected by lines
that mean something, and driveable by a person or by an agent.

This document is for somebody who has to change the system. It states the
constraint the design answers to, the model everything else is a projection of,
the rules about what may depend on what, and — at length, in §9 — the decisions
that are not obvious from the code, with the reasoning that produced them. The
[README](../README.md) covers running it; this covers why it is shaped as it is.

1. [The constraint](#1-the-constraint) — the one sentence the rest follows from
2. [System context](#2-system-context) — participants and trust boundaries
3. [The core model](#3-the-core-model) — entities, commands, history, session state
4. [Layers and dependency rules](#4-layers-and-dependency-rules) — what may know what
5. [Module map](#5-module-map) — what each package owns
6. [Where the work happens](#6-where-the-work-happens) — main thread and data worker
7. [Principal flows](#7-principal-flows) — six paths end to end
8. [Cross-cutting concerns](#8-cross-cutting-concerns) — performance, drawing, text,
   trust, extension seams
9. [Decision record](#9-decision-record) — the reasoning, by area
10. [Testing as architecture](#10-testing-as-architecture) — four kinds of test and
    the probes
11. [Known weaknesses and direction](#11-known-weaknesses-and-direction)
12. [Glossary](#12-glossary)

---

## 1. The constraint

One sentence sets almost every boundary in the codebase:

> The database may cause data to arrive late. It may never cause Panorama to
> respond late.

Exasol relations are routinely billions of rows and can be thousands of columns
wide. A spatial interface promises direct manipulation — drag a table, it moves,
now, at the frame rate — and that promise cannot be conditional on a fetch. So:

- **Nothing is ever held whole.** Not a result set, not an export, not a chart's
  input. Everything is windowed, streamed or reduced.
- **The conceptual model does not scale with row count.** A table is an entity;
  its rows are not (§3.1). Ten rows and ten billion rows are the same amount of
  document.
- **The frame loop never waits.** Reads during a frame are synchronous against
  whatever has arrived; anything slower happens off the main thread and lands
  later (§6).
- **Late data is drawn as absent, not as empty.** A cell that has not arrived is
  a placeholder, never a blank and never a zero.

A second constraint is quieter but has shaped as much: **the same actions must be
available to a pointer, a keyboard, a headset and an agent.** That forces every
persistent change through one semantic vocabulary (§3.2) rather than into event
handlers, and it is why an MCP server could be added late without touching the
renderer.

---

## 2. System context

```
    ┌────────────┐        ┌──────────────────────────────────────────┐
    │   Exasol   │◀──ws──▶│  data worker        (browser worker)     │
    └────────────┘        │  driver, result sets, encoders, reducers │
                          └────────────────┬─────────────────────────┘
                                  blocks ▲ │ ▼ requests
    ┌────────────┐        ┌────────────────┴─────────────────────────┐
    │   agent    │◀─MCP──▶│  page               (browser main thread)│
    │ (Claude …) │        │  core model, renderer, React shell       │
    └────────────┘        └────────────────┬─────────────────────────┘
                                           │ HTTP (dev only)
                          ┌────────────────┴─────────────────────────┐
                          │  development server                      │
                          │  Vite + the agent endpoint               │
                          └──────────────────────────────────────────┘
```

Four participants, three trust boundaries:

| Participant | Runs in          | Sees                                                  |
| ----------- | ---------------- | ----------------------------------------------------- |
| Exasol      | elsewhere        | SQL and fetch requests                                |
| Data worker | a browser worker | credentials, sockets, raw protocol, whole result sets |
| Page        | the main thread  | the document, decoded blocks, the canvas              |
| Agent       | its own process  | the page's state, through the endpoint's tools        |

Credentials cross exactly one of those boundaries — from the connection dialog's
local state into the worker's `connect` message — and go no further (§8.4). The
agent endpoint exists only while the development server does, binds to loopback,
and holds no state of its own (§9.10).

---

## 3. The core model

`packages/core` is the centre. It has no dependencies on a renderer, a database,
a DOM or a framework, and everything else in the system is a projection of it.

### 3.1 Entities and the world

`WorldState` is an immutable record of entities, their stacking order, and the
bindings between them. Every command produces a new value sharing structure with
the last, which is what makes a snapshot per history commit affordable.

The decisive modelling choice: **rows and cells are not entities.** A table's
identity, position, size and column views are document state; its rows are an
ephemeral projection of an open result set. Without this, a ten-billion-row table
would be a ten-billion-node document.

An entity today is always a table, and a table is one of three things — a stored
relation, a written statement, or a chart — distinguished by its `source`. That
union is why a query and a chart are _tables_ rather than panels: they move,
resize, bind, export and close through the same code.

### 3.2 Commands

Every persistent change is one of sixteen values in `Command`. Plain JSON, no
methods, no classes: they cross a worker boundary, replay from history, log
legibly, and can be sent by an agent unchanged.

`applyCommand(world, command, constraints) → Result<WorldState, CommandError>`
is a pure function. Failure is a returned value, not an exception, so a refusal
is something a caller must handle rather than something that unwinds a frame.

### 3.3 History is a graph, not a stack

Undo moves an active head around an immutable DAG; it never destroys a commit.
Committing while the head has children creates a sibling branch, and both futures
stay reachable:

```
A ── B ── C ── D
      \
       E ── F
```

`setHead` is the general operation; undo and redo are the two-step special cases.
An agent gets the general form (`checkout`), which is how a branch is reached.

### 3.4 Session state

Selection, hover, drags, pointer position, the picked-out columns, the picked
chart marks, which halo action is pressed. Temporary, never in history —
_selecting something is not an edit_ — but semantically accessible, so an agent
can ask what is selected and can select something itself.

The document/session split is the load-bearing distinction in the interaction
design. A drag produces session state at pointer speed and exactly **one**
command when it ends; a typed statement lives in session state until it is run.
Sixty commits per second of dragging would make history useless as a record of
what somebody did.

---

## 4. Layers and dependency rules

```
                     ┌──────────────────────────┐
                     │  apps/web  (composition) │
                     └────────────┬─────────────┘
        ┌───────────────┬─────────┴────────┬──────────────┐
        ▼               ▼                  ▼              ▼
   ┌─────────┐    ┌──────────┐      ┌──────────┐    ┌─────────┐
   │ renderer│    │    ui    │      │  worker  │    │   mcp   │
   └────┬────┘    └────┬─────┘      └────┬─────┘    └────┬────┘
        │              │                 │               │
        ├──────────────┴─────┬───────────┴───────┬───────┘
        ▼                    ▼                   ▼
   ┌─────────┐         ┌──────────┐        ┌──────────┐
   │  table  │         │  chart   │        │  exasol  │
   └────┬────┘         └────┬─────┘        └────┬─────┘
        └───────────────────┴───────────────────┘
                            ▼
                        ┌──────┐
                        │ core │
                        └──────┘
```

Three rules, enforced by inspection and by dependency direction:

1. **No package outside `exasol/` knows about Exasol WebSocket packets.**
2. **No package outside `renderer/` knows about Babylon objects.**
3. **No package outside `chart-echarts/` knows that ECharts exists.**

Each rule buys a specific freedom: the driver can be replaced, the renderer can
be replaced, and the chart library can be replaced — and the third has already
paid for itself, since ECharts is used through a seam narrow enough that it never
touches the canvas (§9.6).

A fourth rule is about _shape_ rather than dependencies: **a package that needs
something from the application takes it as an interface, not as an import.** The
renderer declares `TableViewProvider` and `InteractionHost`; the agent layer
declares `AgentHost`. The composition root satisfies them by having the methods.
This is why `packages/renderer` can be tested with no workspace, and
`packages/mcp` with no browser.

---

## 5. Module map

| Package         | Owns                                                                                                                | Must not know                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `core`          | World, entities, commands, history DAG, session, placement, query chains, chart specification                       | Anything about rendering, databases, the DOM |
| `table`         | Result chunks, column vectors, viewport arithmetic, block cache, prefetch policy, fetch scheduling                  | The renderer; Exasol                         |
| `exasol`        | The driver: login (RSA/PKCS#1), metadata queries, result sets, positional fetch, SQL literals                       | Everything above it                          |
| `worker`        | The data-worker protocol, the worker host, the main-thread client, the table data controller                        | Babylon, React                               |
| `renderer`      | Babylon scene, camera, batched GPU drawing, glyph atlas, hit testing, interaction, halo, connectors, summary panels | Where data comes from                        |
| `chart`         | Chart specification semantics, row reduction, the geometry contract a chart returns                                 | Any chart library                            |
| `chart-echarts` | The ECharts adapter: option building, display-list extraction, triangulation, colour parsing                        | The canvas, the document                     |
| `export`        | Streaming CSV, XLSX and Parquet encoders; chart figures as SVG and PDF                                              | The renderer; the database                   |
| `ui`            | React shell: connection dialog, schema explorer, export panel, settings, performance overlay                        | The canvas internals                         |
| `mcp`           | Agent interface: tool catalogue, MCP endpoint, the bridge into the live session                                     | Which client is calling                      |
| `test-support`  | Deterministic mock sources, virtual clock, pathological relation generators                                         | Production code paths                        |
| `apps/web`      | Composition: workspace, canvas component, worker bootstrap, agent host, installability                              | —                                            |
| `apps/desktop`  | Packaging only: a window onto `apps/web`'s build, bundled by Tauri                                                  | Everything. It holds no application code     |

`apps/desktop` deserves a sentence, because a second deployable usually means a
second place for behaviour to hide and this one must not become that. It is a
Tauri crate whose `main` opens a window on the `dist` that `apps/web` produces —
the same bytes the browser install ships. What is packaged twice is one
application, and the only thing the page asks about which packaging it is in is
`apps/web/src/panorama/shell.ts`: a service worker belongs in front of a network
and not in front of a file on disk. When the agent endpoint moves into the shell
(see `plans/panorama-agent-local-plan.md`), it arrives as a transport under the
existing bridge, not as a second copy of the protocol.

Inside the composition root, four objects rather than one:

| Object                | Owns                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------ |
| `workspace.ts`        | The connection, the open tables and their views, placement, query boxes, chart actions, the host projections |
| `export-jobs.ts`      | Exports in flight, their progress and what became of them                                                    |
| `column-summaries.ts` | The statistics under a picked-out column                                                                     |
| `chart-pictures.ts`   | What a chart reduced to, what it drew, and what the pointer is doing to it                                   |

The split is by what the state is _about_ rather than by layer. Each holds its own
maps and answers its own questions; only the first has ever heard of a table.

---

## 6. Where the work happens

```
MAIN THREAD                          DATA WORKER
─────────────────────────            ─────────────────────────
Babylon renderer                     Exasol WebSocket client
input and interaction                protocol decoding
camera                               result-set lifecycle
bounded row cache  ◀── blocks ─────  fetch scheduling
prefetch policy    ─── wants ─────▶  column conversion
                                     export encoding
                                     chart reduction
```

The row cache lives on the **main thread**, deliberately, against the obvious
reading of the constraint. The renderer needs a synchronous cell read during a
frame, and the cache is pure bookkeeping over already-decoded typed arrays.
Everything expensive — the socket, protocol decoding, request scheduling, vector
construction, encoding a Parquet file, reducing a billion rows to twenty numbers
— stays in the worker, which is what the constraint is actually about. Blocks
cross the boundary with their buffers transferred, not copied.

Two things follow. Encoding an export happens next to the connection, so the
bytes never enter the page (§9.7). Reducing a chart happens next to the result
set, so a chart of ten billion rows sends a few dozen numbers to the canvas
(§9.6).

---

## 7. Principal flows

### 7.1 Opening a table

```
explorer click ─▶ workspace.openTable
                    ├─ describeTable (worker → Exasol)   what columns
                    ├─ buildTableEntity                  ids, widths, size
                    ├─ findFreePlacement                 where it goes
                    ├─ dispatch CreateTableEntity        one commit
                    └─ open a result set + a TableView   rows follow later
```

The entity is created only after the columns are known: a table whose shape is a
guess would resize under the user. Placement is a search for free space measured
from wherever the request came from — the explorer, or the table a key was
followed from — because a box that lands on top of another is worse than one that
lands slightly further away (§9.5).

### 7.2 Scrolling

```
wheel ─▶ interaction ─▶ session (smoothed) ─▶ frame:
                                              view.update(delta)
                                              → viewport → wanted blocks
                                              → controller.refresh()
                                                 ├─ pin visible, touch nearby
                                                 └─ request the rest
         frame: buildTableDrawList reads cells synchronously; misses draw
                as placeholders
```

Scrolling never awaits anything. The prefetch policy is velocity-aware — a fling
asks for blocks ahead of where it is going — and the cache evicts by byte budget,
so a ten-billion-row relation and a one-million-row relation of the same width
cost the same client memory (§10).

### 7.3 Deriving a query

```
halo "SQL" ─▶ openQuery: a query box beside the table, bound to it,
              seeded with SELECT * FROM <that table's name>
   editing ─▶ session draft (no commits while typing)
       run ─▶ composeQuery: the chain → one statement
              dispatch SetTableQuery + SetTableColumns + SetTableMode
              re-open the result set; refresh everything built on it
```

A box holds **one step**, not a pipeline, and refers to its input as
`derived_table`. The steps are joined by _naming_ — each becomes a common table
expression — rather than by nesting, so a refinement of a refinement is still one
readable statement (§9.4). Because a box stores a reference rather than a copy,
changing an early step refreshes everything downstream.

### 7.4 Drawing a chart

```
halo "chart" ─▶ a chart box bound to the table, opened on its setup
      setup ─▶ ChartSpec draft; every control redraws the picture
  reduction ─▶ worker: rows → categories × series (a few dozen numbers)
     layout ─▶ chart-echarts: ECharts lays out; zrender's display list is
               read back as polygons and text runs
       draw ─▶ the same two GPU batches as everything else
```

ECharts is a **layout engine, not a renderer** (§9.6). It never touches a canvas;
its geometry is extracted and drawn by the same batches that draw tables, which is
what makes a chart hoverable, exportable and XR-safe for free.

### 7.5 Exporting

```
halo "export" ─▶ formats disclosed in place
       format ─▶ shell opens a save dialog (needs the click's activation)
                 worker: its own result set → encoder → sink, chunk by chunk,
                 waiting for each write before reading more
                 progress → ExportJobs → the panel
```

Nothing is buffered whole; back-pressure comes from the sink. A cancelled or
failed export leaves **no file**, because a truncated Parquet file has no footer
and a truncated workbook has no directory (§9.7).

### 7.6 An agent edit

```
agent ─▶ MCP endpoint (dev server) ─▶ event stream ─▶ page bridge
                                                      └─ runOperation
                                                         ├─ read: project state
                                                         └─ write: dispatch
      ◀── the answer, posted back ──────────────────────────┘
```

The endpoint holds no state: every answer comes from the live session in the page,
so an agent and a person are looking at the same document, and an agent's edits
appear on screen as they are made and undo like anyone else's (§9.10).

---

## 8. Cross-cutting concerns

### 8.1 The performance contract

Enforced by tests, not by hope:

- `packages/worker/test/latency-stress.test.ts` replays one scripted fling
  against 0, 50, 250 and 1 000 ms of simulated fetch latency and asserts that
  scroll position, rendered rows and per-frame work are **identical**. Only how
  many cells have data yet differs.
- `packages/worker/test/table-controller.test.ts` asserts that a ten-billion-row
  relation and a one-million-row relation of the same width consume the same
  client memory to within 25 %.

Per-frame work is **measured before it is optimised** (§9.8). The frame CPU across
the heaviest cases is 0.5–0.9 ms; two per-frame costs were found by measurement
and removed, and one plausible-sounding optimisation was left alone because the
measurement said it was not the problem.

### 8.2 Rendering: two draw calls and one ordering law

Every visible table renders into **one** batched quad mesh and **one** batched
glyph mesh. Two draw calls for the whole canvas, whatever is on it.

The consequence is a law that has to be designed around rather than worked
around: **all quads draw before all glyphs, and all polygons before all quads.**
There is no per-element ordering. A panel drawn over a neighbouring table cannot
hide that table's _text_, so overlap has to be solved geometrically — which is why
a summary panel flips above its table when there is something below it, and why a
chart's marks are polygons pushed before the box background is not an option.

### 8.3 Text

The grid talks to `TextRenderer`; the implementation is a canvas-rasterised glyph
atlas drawn as instanced quads. Replacing it with an MSDF engine means replacing
one factory. Two rules come from the atlas: a row shows all of its text or none of
it (no half-clipped glyphs), and there is exactly one font family — so a written
chart option asking for another is overridden, because it would be measured in ours
and drawn in ours.

### 8.4 Trust and credentials

- Credentials pass from the dialog's local state to the worker's `connect` message
  and no further. They are not in the world model, the history, a log line, or any
  agent-visible projection.
- The page keeps the _URL_ of a live connection, because the explorer's indicator
  names it and an agent needs it to establish which database this is — and nothing
  else about it.
- The agent endpoint is loopback-only, exists only under the dev server, and its
  two routes that can start a process or write a file require a JSON POST, so a
  cross-origin form cannot reach them.

### 8.5 Extensibility seams

| Seam           | Interface                                | Already used for                                 |
| -------------- | ---------------------------------------- | ------------------------------------------------ |
| Data source    | `TableDataSource`                        | Exasol; deterministic mocks; demo relations      |
| Text           | `TextRenderer`                           | Canvas atlas                                     |
| Chart library  | `ChartSurface`                           | ECharts                                          |
| Renderer host  | `TableViewProvider`, `InteractionHost`   | The workspace                                    |
| Agent host     | `AgentHost`                              | The workspace                                    |
| File sink      | `ByteSink`                               | File System Access API; collecting sink in tests |
| Machine access | `ClaudeEnvironment`                      | Node; a fake machine in tests                    |
| Installability | `registerShell`, `ShellCacheEnvironment` | The build; fakes for cache storage and network   |

XR is not a seam but a consequence: because the halo, the connectors and the
charts are all drawn by the same batches, the entire interface exists in the 3-D
scene already. Entering XR moves the camera; it does not switch renderers.

---

## 9. Decision record

The decisions a reader would otherwise have to reverse-engineer, grouped by area.
Each entry is the decision, why, and what it costs.

### 9.1 The document model

**Rows and cells are not entities.** A table, its position, its size and its
column views are document state; rows are a projection of an open result set. The
conceptual model therefore never scales with row count. Consequence: anything that
wants to talk about a row does so by _position within a result set_, and positions
are only meaningful for that result set's lifetime.

**Row positions are not row identity.** An open Exasol result set gives a concrete
sequence for as long as it lives. Reopening one — after a reconnect, or after a
statement changed — starts a new generation, and every cached block from the old
one is discarded rather than reused. Stale rows drawn confidently are worse than
placeholders.

**History is a graph, not a stack.** Undo moves a head; it never destroys a
commit. Committing from an inner commit branches rather than discarding the
future, so nothing a person did is unreachable. Cost: a world snapshot per commit,
paid for by structural sharing.

**Drags do not spam history.** A drag is session state, previewed by deriving the
entity's transform every frame, and produces exactly one `MoveEntities` when it
ends. A typed statement is the same split for the same reason: the draft is
session state, and running it is one commit.

**A query is a kind of table, not a kind of panel.** `TableSource` is a union:
relation, query, chart. Everything downstream — hit testing, bindings, the halo,
scrolling, the block cache, export — treats all three the same. Adding the chart
kind later cost a member of a union rather than a parallel code path.

**A query's shape is discovered, not described.** A stored relation can be
described before it is opened; a statement's columns are not known until it runs.
So a query table is created with no columns and reshaped by `SetTableColumns`
afterwards, which is also what makes re-running a changed statement work.

**A box's name is its own.** `SetTableLabel` exists because a canvas where seven
boxes all read `RAW.CLAIMS · SQL` is one you have to read the statements to
navigate. A stored relation cannot be renamed: it has a name, and the name is the
relation's.

### 9.2 Interaction

**Exactly one entity is activated at a time.** Activation is a single id in
session state, not a per-entity flag, so it is impossible to have two halos on
screen. The renderer allows a margin around an activated entity for the halo, and
around a table with a picked-out column for its panel.

**Bindings connect entities and survive movement.** A binding is its own record
with `fromId` and `toId`; connector geometry is derived every frame from the two
transforms. Nothing has to be kept in sync, moving a table appends no commits, and
no derived geometry leaks into history.

**Following a foreign key is what bindings are for first.** A cell in a key column
is a link; clicking it opens the referenced table filtered to the matching rows,
bound to the cell's table, with the filter as the connector's label.

**Columns are picked out by their headers, and picking is not an edit.** Selected
columns are session state, a flat set of column-view ids — flat because ids are
unique, so the set says which table each belongs to, and two tables side by side
can each have columns picked out while they are compared.

**Where a halo button sits says what it does.** Buttons that make a _new_ box run
down the right edge — the edge the connector will leave from — and buttons that
act on the box run along the top, with close on the corner between them. Each
action declares its line, so a new one cannot be added without deciding what it
does.

**A capability the table lacks is greyed out, not hidden.** A greyed control says
"not for this table"; a missing one says nothing at all. Whether a table can run
SQL is a property of what backs it, so it comes from the host rather than being
recorded on the entity.

**Export is a disclosure, not four buttons.** One button that wrote "a file" would
have to choose a format; a headset has nowhere to put a modal asking which. So
pressing it replaces it, in place, with one button per format — the same halo with
a different list of actions.

### 9.3 Data access and paging

**The row cache is on the main thread; everything expensive is not.** See §6.

**The worker waits to be told each chunk landed.** Encoding is next to the
connection, but the sink is in the page, so the worker sends a chunk and waits for
an acknowledgement before reading more. Without that, a fast reader and a slow
disk would buffer a Parquet file in memory — which is the one thing the design
forbids.

**A summary is asked of the source, never derived from the screen.** Statistics
for a picked-out column are a `GROUP BY` at the database, not a scan of the rows
that happen to be cached. A summary of the visible window would change as you
scroll and would be wrong in a way nobody could see.

**Derived state is recomputed from its inputs every frame, not fired from
whatever changed them.** Connector geometry, column summaries, drill-down filters
and chart emphasis all work this way: one place decides what should be true, and
no new gesture can bypass it. Where that costs measurable work, the answer is a
cheap identity comparison, not an event (§9.8).

### 9.4 SQL chains

**A query box holds one step, not a pipeline.** Written out in full, a refinement
of a refinement of a table is a statement wrapped in a statement wrapped in a
table name, and by the third level nobody can see their own `WHERE` clause. So a
box says `FROM derived_table` and means "whatever I was opened on".

**The steps are joined by naming, not by nesting.** Each earlier step becomes a
named common table expression and the last becomes the outer query, so the
composed statement reads in the order it was built. An identifier replaces an
identifier, which stays valid wherever a table reference can go.

**`derived_table` is only for a table that is actually derived.** A box built on a
stored relation names that relation — the application seeds it that way, and a box
reports `readsFrom` so anything else writing a statement (an agent) can too.
Writing `derived_table` where the relation has a name still runs, and comes back
with a note saying which table it was.

**A step that brings its own `WITH` is merged, not concatenated.** Two `WITH`
clauses in a row is not a statement; it parsed on one database by luck. The
clause is found and its bindings are merged into ours, `RECURSIVE` and all, and
generated names give way to written ones so a statement binding
`derived_table_1` itself cannot collide.

**Changing a step refreshes what was built on it.** A box stores a reference to
its input rather than a copy of everything before it, so re-running an early step
re-runs the tree below it in order, parent before child.

### 9.5 Placement and the canvas

**A table opens in the nearest free space, measured from where the request came
from.** Inside the view beats close to the source: a table you cannot see has not
opened as far as the user is concerned. "Near" is measured from an _edge_, not a
point, so a box pushed along the edge beats one shoved sideways past whatever was
already there.

**A line goes round a table rather than through it.** Connector routing tries a
handful of shaped paths and scores them by how much of another table they cross,
then by length. Drawing and picking read their obstacles from one function, so the
marker cannot end up somewhere the line is not.

**A connector's mark names the relationship.** A foreign key shows a key, a query
line shows the same `SQL` mark as the button that made it, a chart line shows the
same three bars. One shared constant apiece, so a button and the line it produced
cannot drift. Two of the three marks are geometry rather than glyphs, because the
atlas rasterises whatever the system font provides and block characters are a full
em wide apiece.

### 9.6 Charts

**A chart is a kind of table too.** A third `TableSource` member holding a
specification and a reference to what it charts. It moves, binds, closes and
refreshes through the machinery that already existed.

**Presentation and numbers are kept apart.** `ChartSpec` is the question — which
column against which measure, how ordered, how many. The reduction is the answer.
The specification is document state; the numbers never are.

**The rows are reduced in the worker, next to the result set.** A chart of ten
billion rows is still a few dozen numbers; sending the rows to discover that would
be sending the table to draw a picture of it. What the chart read is reported with
it, because a picture cannot say "the first twenty thousand rows".

**ECharts is a layout engine, not a renderer.** It is driven in SSR mode with a
platform text-measurement hook, and zrender's display list is read back as
polygons and text runs. Tooltips and animation are turned off because neither
survives the seam: the geometry is read once per change, so an animation would be
captured as a still frame of itself.

**A chart reads named data sets, and the reduction is one of them.** The
reduction — a category, its measures, one row per group — is what a bar chart
wants and cannot express a matrix with a third column to colour by, a scatter
sized by a fourth, or a graph's edge list. So a specification may name data sets
of its own: `rows` for the rows as they are, `group` for another grouping of them,
`scalar` for one number. Each is offered to the layout under its own name with its
columns declared, so a written option reads it the way any ECharts example does —
`datasetId` and `encode`, no Panorama grammar to learn. The one exception is a
scalar, which ECharts has no concept of: `{"$param": "name"}` anywhere in an
option becomes the number, and is left in place and reported when nothing answers
to the name, because a nought substituted for a base rate is a line somebody
believes. All of it is built from one read of the rows, in the worker, next to
them. The declaration is document state and the contents are session state, like
a table and its rows.

**Which box a data set reads is an arrow, not a field.** A chart's specification
says what shape each data set has; a binding of kind `data`, labelled with the data
set's name, says which box supplies its rows. One fact in one place, and three
things fall out of it: the canvas shows what feeds what, because a data binding is
drawn like any other line; cutting the line is how you stop it feeding; and it is
in the history, so it undoes with everything else. A name with no arrow reads the
chart's own relation, which is what every chart did before there were arrows. The
worker groups the data sets by the box they read and reads each box once — three
data sets are three questions about a result set, not three fetches of it.

**Anything measured over a big list is walked, not spread.** `Math.min(...xs)` is
a call with one argument per coordinate, and past about thirty thousand shapes the
argument list is longer than the stack: the geometry report threw
`Maximum call stack size exceeded` on a chart of twelve thousand polylines. The
picture had drawn fine, so what failed was every attempt to _ask about_ it — which
read as a box that had gone bad rather than as a bug in one function. Spreading a
list into a call is now treated as a size limit rather than as a style, here and in
the display-list walk.

**A picked mark is traced back through its data set, not through the chart's
settings.** Every mark carries the data set and the row it was drawn from, stamped
as the geometry is read out of the layout — the only moment anything knows which
row a triangle belongs to. Each data set carries the column its rows are
identified by and the _values_ of it, kept beside the rows because a label and a
value are different things: `String(7)` writes a fine axis label and cannot be
compared with a number. So resolving a pick is one rule for every kind of chart —
a heatmap cell, a sankey ribbon and a bar all end at a column and a value — and
selection, hovering and drilling in stopped being features of the built-in
reduction. A row filter is one predicate, so a matrix cell drills down on whichever
axis it named as its key; a data set that named none can be picked out and not
drilled into, and says so rather than guessing that its first column is the
subject.

**What scopes a statement is an arrow, and what fills it in is a selection.** A
statement may leave a predicate open as `{{name}}`; a binding of kind `filter`,
labelled with that name, says which chart decides it. What is picked out there
becomes the predicate, through the same resolution that opens the rows behind a
mark — so a cell means one thing whether it opens a table of its own or narrows a
box on the other side of the canvas. Two choices are worth stating. Braces rather
than a bare identifier: an unresolved identifier is valid SQL and would query the
wrong thing, and a predicate has no such spelling, so a `{{name}}` nothing answers
for is a statement the database refuses rather than one that quietly ran
unfiltered. And nothing picked is `1 = 1`, not `1 = 0`: a knob at rest shows the
data. The re-run is decided in the frame tick from what is true now, like every
other derived thing here, so an arrow drawn by a pointer, an agent or an undo all
take effect the same way.

**A field belongs to one kind of data set, and a field in the wrong one is
refused.** The top-level check that refuses an unknown setting was the right rule
in the wrong place only: a `window` on a `group` data set was dropped as quietly as
a misspelt name, and what came back was five hundred and ninety-one rows where a
hundred and twenty had been asked for. So each kind declares what it reads, a
field belonging to another kind is refused, and the refusal says which kinds do
read it. Written as a table of kinds rather than as the one case reported, because
the class of failure is what matters.

**Where ECharts binds one data set and a series needs two, a data set goes in as
rows.** A graph and a sankey read nodes _and_ links, and a dataset binding feeds
only the first — so an edge list had to be typed into the option as literals, which
is a picture that silently lies the moment the query changes. `{"$rows": "name"}`
anywhere a list belongs becomes that data set's rows as objects keyed by its
columns, which is exactly what those series read. The same shape as `$param` and
for the same reason: one small piece of grammar, where the library has no concept
to borrow.

**A series longer than the screen is a window, and the reduction happens where the
rows are.** A data set may say which part of a relation it reads — a row offset and
a count, which is the table's own mechanism and right when the relation is already
in the order the axis is in; or a range along a column, which is what survives a
change of scope, and which stops reading as soon as the column has passed the
bound. A `resample` data set then cuts what it read down to a few hundred points in
the worker, keeping the extremes of each bucket by default because a mean hides the
spike that was the reason to look. Two rules make this safe to move along. The
limit on points is the _layout_, not the database: a million points is nothing to
an engine and impossible for a walk that visits every element in JavaScript. A window is a range
selector rather than a rolling one, so a moving average is its own thing: `rolling`
adds a trailing mean over the rows, computed before the reduction, as a column of
its own — an average of the data rather than of the picture. And
the chart keeps drawing the window it has while the next one is in flight —
§1 does not get an exception for charts, and blanking on every step is the one
thing a person moving along a series cannot use.

**A cross-tabulation is two columns, not two measures.** A second grouping column
makes the series its distinct values, which is the only way to express claim type
against decile. A grouped bar chart, a stacked one and a heatmap are then the same
numbers laid out differently — and for a written option they arrive as
`[category, breakdown, value]` triples, because there is no arrangement of columns
that is a triple.

**One chart type is a text field, and it is aimed at an agent.** `custom` hands
the whole ECharts option over: the reduced rows arrive as a dataset it may use,
and nothing of Panorama's is merged on top except a transparent background, the
palette, the font and the three settings that cannot be honoured. Writing an
option by hand in a textarea is a poor use of an afternoon and a good use of a
language model.

**A chart can show the rows behind what has been picked out of it.** Which made a
row filter a _membership_ predicate: one value is `= x`, several are `IN (…)`, a
missing category is spelled out separately because SQL's `IN` does not match null,
and no values at all is `1 = 0` — the honest reading of "the rows behind nothing".

### 9.7 Export

**Encoding belongs where the connection is.** A file of a billion rows must never
pass through the page as values. The worker reads its own result set for the
export — sharing the table's would move the window the user is looking at — and
streams encoded bytes to a sink in the page.

**Nothing is held whole.** CSV is a text stream; XLSX is a ZIP written entry by
entry with sizes known in advance; Parquet is written row-group by row-group with
the footer last. All three were chosen for being writable in one pass.

**Parquet gets the type the database declared, where the mapping is exact.**
`DECIMAL(p,s)` becomes a decimal, dates become dates, and anything that cannot be
represented faithfully becomes a string rather than a lossy number.

**A NULL is not an empty string.** They are different values, and a file that
cannot tell them apart is a file somebody will draw a wrong conclusion from.

**The encoders are checked by someone else's reader.** A test cannot validate a
format it also implements, so `PANORAMA_EXPORT_SAMPLES` writes files that pyarrow
and openpyxl open, and chart exports are checked by Ghostscript and `pdftotext`.

**A chart exports as a picture, and the picture is the box.** SVG comes from the
chart library, PDF is generated directly from the same geometry the canvas drew,
and PNG is the SVG rasterised by the browser — each format asked of whatever is
best at it.

### 9.8 The shell and the frame

**The SQL editor is the one DOM overlay, deliberately.** Text editing is a solved
problem in the DOM and an unsolved one on a canvas. It is positioned by projecting
the box's world rectangle through the camera every frame, which is the price of
the exception — and the reason there is only one.

**Two draw calls, and the ordering law they imply.** See §8.2.

**A rounded corner in the quad batch is a stack of strips.** The halo's buttons
are rounded to the same three pixels as the explorer's rows, at the same
twenty-two pixel height, because the canvas and the panel beside it are one
interface and a square control next to a column of rounded ones reads as an older
part of the application. Getting there is not a declaration: the ordering law
(§8.2) puts every polygon under every quad, and the halo draws over tables, whose
bodies are quads — so the shape cannot be a polygon with arcs in it. It is built
instead as a full-width middle band plus a few inset strips at each end
(`table/rounded.ts`), stepped finely enough that the staircase reads as a curve,
which was checked by screenshot at four times scale rather than argued about. The
cost is eighteen quads per button against the thousands a table draws.

**Hit testing still treats a rounded button as its rectangle.** The sliver outside
a three-pixel arc is under two square pixels of a twenty-two pixel button, and a
pointer made to respect the curve is a button with a dead corner. The trade is
recorded rather than hidden: draw and pick agree everywhere it matters, and the
three halo probes still pass unchanged.

**The explorer colours a relation by what it is, and never only by colour.** A
table, a view and a virtual table are three different things to open — the second
has no row count until it is run, and the third federates out to another system —
and at thirteen pixels two words are indistinguishable while three marks are not.
So each has its own drawing _and_ its own muted hue: the hue is what makes a
column of thirty rows scannable, the drawing is what survives a reader who cannot
separate two colours, and the tooltip carries the word. The hues are restrained rather than
washed out, which took a correction: the first attempt put the table colour
seventeen points of blue away from the grey it replaced, and since most schemas
are mostly tables, opening one still looked monotone. A distinction that has to be
looked for twice is not one. What carries a hue at thirteen pixels is chroma and
area, so these have some of each — the stroke got a filled header band to sit in —
while still staying quieter than the canvas, which is the only thing here that
should win an attention contest.

**A virtual schema is marked by the presence of a mark, not by its colour.**
Ordinary schemas still carry no icon, because a mark every row at the top level
shares distinguishes nothing and the chevron already says the row opens. The
virtual one appears _because_ it is the difference, and its colour then ties it to
the tables inside it. A visible caption was tried and removed: on a panel of
thirty rows it was the loudest thing in it, so the word lives in the row's
accessible name and its tooltip instead — where it costs no attention and is still
there for a reader who is listening to the page.

**"Virtual" is carried from the catalogue, not inferred.** `SCHEMA_IS_VIRTUAL` and
`TABLE_IS_VIRTUAL` are read in the driver and travel as an optional flag through
the worker to the tree and to the agent's `catalogue`. Said only when true: every
ordinary schema carrying `virtual: false` would be noise in every answer. It earns
the plumbing because it changes what the rows _are_ — an absent row count is
explained rather than looking like statistics nobody gathered, and an agent
choosing where to compute learns that the shortest route to the engine is not the
shortest route to these rows.

**The row-number gutter is as wide as its longest number.** A fixed gutter either
wastes room or clips; the width follows the row count.

**The instrumentation overlay starts collapsed.** The frame budget is a design
constraint and a number nobody can see is a number nobody defends — which argues
for the overlay existing, not for a panel of diagnostics over somebody's data
before they have asked for one. So the frame rate stays on screen as a pill and
the rest is a click behind it. The probes are the reason this is worth writing
down: nine of them opened by clicking **Hide** first, and the default is now what
they wanted all along.

**Per-frame work is measured before it is optimised.** A chart's layout cache was
keyed by a _serialised_ specification — 1.2 ms per ten seconds of frames, against
0.005 ms for the identity comparison that replaced it, since a specification is
immutable and the object is the key. Deciding whether a table had a column picked
out scanned every column every frame even with nothing picked: 20.5 ms per ten
seconds of frames on a five-thousand-column table, against 0.06 ms once the empty
case is answered first. A third candidate — the glyph layout's per-run array of
quad objects — was measured and left alone, because frame CPU is 0.5–0.9 ms and
allocation is not what limits anything.

**A test harness that mirrors production is not a test of it.** The factory that
builds a data source is injected, so the deterministic mocks and the real driver
are reached by the same code path rather than by a parallel one.

### 9.9 Distribution: installed, not wrapped

**The deliverable is the web application, made installable.** The renderer needs a
browser engine — no system webview ships WebXR, and Electron compiles VR out — so
every wrapper considered was a downgrade on the two axes this application lives
on. A web app manifest plus a service worker gets a launcher entry, its own
window and an offline start on desktop, Android, iOS and the Quest Browser, and
is also the input to the only store route that keeps WebXR: a Trusted Web
Activity. The evaluation, including what a desktop shell would and would not buy,
is `plans/panorama-packaging-plan.md`.

**The cache holds the shell and never data.** A row kept from a query is a row
that can be shown as current when it is not, and a database browser that lies
about the database is worse than one that says it is offline. So the worker
answers the document network-first, hashed assets cache-first, and passes
everything else through untouched — the socket, the schema and every result set
behave exactly as they do in a tab (`apps/web/src/panorama/shell-cache.ts`).

**The build emits the list of what to cache.** "Cache what has been used" is the
tempting policy and it is wrong here: the renderer imports its shader chunks the
first time it draws something, so an install that had only what the launch
happened to fetch produced an application that started offline and then could not
open a table. A build plugin writes `shell-assets.json` and the worker fetches all
of it while installing. It is a file rather than a compiled-in constant because
the names are hashed and change every deployment.

**Cached copies are matched ignoring `Vary`.** Hosts routinely answer static
files with `Vary: Origin` — Vite's own preview server does, as do the usual CDN
configurations — and a request whose `Origin` differs from the one that filled the
cache then does not match it, silently, so cache-first became network-first
against no network. Ignoring it is sound and not merely convenient: these are
hashed public assets, and the Cache API stores bodies already decoded.

**The build is relative, so it does not have to be told where it will live.**
Every address in it resolves against the document that names it: the manifest's
`start_url`, `scope` and icons resolve against the manifest, the document's assets
sit beside the document, and the service worker derives its base from the
directory it was served from — a worker's scope _is_ that directory, so the file's
own address is the most reliable statement of where the application is. One
artifact therefore installs correctly at an origin's root, under a repository name
on a project site, or three directories deep, and `PANORAMA_BASE` exists only for
a deployment that needs absolute URLs. This was worth doing rather than
configuring: GitHub serves an access-controlled Pages site from a generated
hostname, and which path a project site occupies there is not a thing to establish
by deploying and hoping.

**The worker is registered only in a build.** In front of a development server a
cache is a way of being shown a file you have already changed. The flag is passed
in at the call site rather than read inside, so both sides of it are testable.

**Nothing about installability is trusted to review.** Every failure mode here is
silent — a missing icon size means no install prompt, a declared size that does
not match the file means an icon the platform ignores, a manifest the document
does not link is a manifest nobody reads. So `npm run install-check` builds,
serves and drives the real thing, and asserts what is on the device is only the
shell; `apps/web/test/manifest.test.ts` checks the declarations against the bytes.

### 9.10 The agent interface

**It is a pipe, not a second application.** The document, its history and the
session exist in one core in one browser tab. A server with its own copy would be
a second opinion about what the document is. So the endpoint holds no state: a
call goes down a pipe, the page runs it against the live session, the answer comes
back — which is why an agent's edits appear on screen and undo like anyone else's.

**It lives on the development server.** There is nothing for it to do without the
application, so it belongs in the process already serving it: one thing to start,
one origin, no port to agree on. Two plain HTTP routes carry it, and it is bound
to loopback.

**The tool catalogue and the tool handlers are separate, with a seam test.** The
half that offers the tools runs in a process with no document, so it cannot import
the half that needs one. A test insists the two name exactly the same tools —
without it, a tool could exist and do nothing.

**The catalogue says which catalogue it is.** A client fetches the tool list once,
when it connects, and then shows what it fetched. That is reasonable of it, and it
produced the longest-running failure in this repository's short history: an agent
read a fourteen-tool catalogue for days while the server had grown to sixteen, and
three separate fixes went into a server nobody was talking to. Worse, for most of
that time no development server was running at all, so the list being shown was
the memory of one. Nothing on either side was wrong and nothing on either side
could say so. So `serverInfo.version` now carries a fingerprint of the tools being
offered — count and hash — and the handshake says the number and the first name in
words. A mismatch is one comparison rather than an investigation.

**A stale list is corrected rather than waited out.** The stdio pipe watches that
stamp and sends `notifications/tools/list_changed` when it moves, which includes
the case that caused all this: connect with nothing listening, start the server
later, and the client is told to ask again rather than left holding a snapshot.
The `tools.listChanged` capability is declared because it is now true. The pipe
still knows nothing about the protocol beyond one JSON value per line — it
compares two strings.

**End-to-end checks that start their own server prove the wrong thing.** The
verification that said the skill was reachable started a development server, asked
it, and shut it down. It was correct and it was irrelevant: what an agent talks to
is a server somebody else started, and its tool list is whatever their client
cached. `agent-check` now prints the stamp for exactly that comparison, and drives
the connect-to-nothing-then-a-server sequence directly.

**A hand-written mirror of someone else's shape needs a seam.** Commands are
described twice: as interfaces in the core, and as a table of field names for the
agent. Nothing checked that the two used the same names, and they did not —
`SetSelectedColumns(columnIds)` where the reducer reads `ids`, which crashed the
page for any agent that followed the documented schema. Now every command an agent
can send is built the way an agent would build it and applied to a real core,
where a wrong name shows up as state that did not change.

**Answers are terse by default.** What comes back is what a next step needs;
column ids, widths, scroll offsets and composed statements are behind `verbose`.
The statement is said once. A five-thousand-column table reports the first sixty
names with a count, because a list of five thousand names is not a description.

**A cell that has not arrived is not null.** `rows` returns only what has been
fetched, with a count of what has not. Null is a value a database can return.

**Three commands are not offered.** `CreateTableEntity`, `SetTableColumns` and
`SetTableSource` describe what a table _reads_, and none of it can be invented:
the columns come from a result set and the source needs a connection. The refusal
names the tool that does the job properly.

**A picture exists whether or not anybody is looking at it.** Culling skips
entities outside the camera's view, which for a table is the whole of the story:
what a table is can be read from the document. A chart is not like that — what it
came out like exists only once it has been laid out, and that is the only feedback
there is on a written option. So a chart box parked off-screen was culled before
the host was ever asked to lay it out, and an agent reading its geometry got
`null` with a note saying to ask again, forever, while the reduction said `ready`.
The renderer now lays out a chart it is not going to draw. It costs one layout per
change rather than one per frame — the host caches by specification, data and size
— so an off-screen chart costs what an on-screen one costs, once.

**A reason, not a "not yet".** `status: "ready"` with no geometry and "ask again
once the canvas has laid it out" was one answer to five different questions, and
for the one above it was false: no amount of asking would have helped. Now the
reason is named — the rows are still arriving, the reduction failed and why, it
came back empty, there is no specification, nothing is drawing at all — and only
the case where waiting helps says to wait. A state an agent cannot resolve is
worse than either half of it alone.

**A picture can be asked what it came out like.** A chart reports the rectangle it
was laid out for, what it drew, what that covers and — by name — any label that
fell outside the box, read from the layout the renderer last asked for. It is the
only feedback there is on a layout nobody at the other end of a pipe can see.

**The skill is a document, and the server serves the document.** The tool list says
what may be called and the handshake says what the server is for; neither says how
the pieces go together, and an agent that has to work that out by trying things
spends its first several calls learning what a page could have told it. So there is
a page — [AGENT-SKILL.md](AGENT-SKILL.md), reviewed and formatted like everything
else in `docs/` — and the development server reads that file and offers it three
ways: as a prompt, as a resource, and as the `skill` **tool**, first in the list.

The tool is there because of what happened without it. Prompts and resources are
what the protocol has for exactly this, and an agent whose client surfaces only
tools reported that it could not find the page at all — so the two correct doors
were doors nobody could open. Tools are the one mechanism every client shows, so
the page is a tool as well. It is answered by the server rather than forwarded to
the page, which also makes it the one tool worth calling before anything is open.

Three consequences worth stating. Nothing in the code holds a copy, so editing the
documentation _is_ editing what agents are told. The reading happens in the one
file that knows it is running on somebody's computer — the dev-server plugin —
because the package is bundled for a browser too, and the text reaches the protocol
layer as data. And a server that cannot find the document offers no prompts and no
resources rather than an empty one, because claiming a capability with nothing
under it is worse than not claiming it. A seam test reads the document and insists
every tool appears in it.

**This is not the only way into the database, and the handshake says so — in
order.** The routes to the engine are not equal, and the difference is how far the
rows travel: a local `exasol` CLI runs beside the engine, a native Exasol MCP
server is a process away, and this route is a browser tab and a block cache away.
So the instructions rank them. Where `overview` reports a URL on this machine —
localhost or 127.0.0.1, which is what an Exasol Personal instance looks like — the
CLI is named as the first choice for anything heavy, because it will always be the
fastest thing available; a native server comes next; this server is for the canvas
and for what the other two cannot answer. The instructions also say to establish
that the other route is the _same_ database — `overview` reports the URL, name,
version and session id — and to read whatever semantic layer exists before writing
SQL.

---

## 10. Testing as architecture

The test strategy is part of the design rather than a layer over it, and two of
its properties are architectural claims in their own right.

**The suite runs without a browser, a GPU or a database.** That is not a
convenience; it is the layering of §4 stated as a fact about the build. Every
impure thing is injected — the clock, the randomness, the socket, the data source,
the engine, the byte sink — so most of the system is testable as data in and data
out, which is why some two thousand cases run in twenty seconds. The day a
draw-list function reaches for `window`, its test stops compiling.

**Latency invariance is asserted, not hoped for.** The claim in §1 — that the
database cannot make Panorama slow — is checked by replaying one scripted fling at
0, 50, 250 and 1 000 ms of simulated latency and demanding that the scroll
positions, the rows walked, the cells read and the peak cache size come out
identical. Only how many of those cells have data yet is allowed to differ. No
amount of frame-rate measurement makes that point as sharply.

The rest is carried by unit tests over pure functions; harness tests that run the
real composition root over mock sources; **seam tests**, where one thing mirrors
another — the tool catalogue against the tool handlers, the agent's field names
against the core's command shapes, a connector's marker against the line that drew
it — every one of which was written after the mirror had already drifted;
**property tests** at the four boundaries whose input is not ours to choose (the
statement scanner, SQL construction, an agent's arguments, and command sequences
against the document), which is where a scanner that never returned and a literal
that fell back to exponent notation were found; and **browser probes**,
because anything the GPU drew cannot be asserted from a unit test at all
(`readPixels` on a composited canvas returns black, and a line hidden behind a
table is invisible to both pixels and geometry), so the probes drive the real
application with a real pointer and read back the geometry it actually produced.

The coverage gate is also a design tool rather than a report: at **100 % of
lines**, unreachable code fails the build, so a defensive branch has to be
justified or deleted. Several dead methods in this codebase were found that way
rather than by review.

**[TESTING.md](TESTING.md) is the full account** — the layout and the two Vitest
projects, the doubles and the injected clock, the six kinds of test in detail, the
probe techniques, verifying file formats against other people's readers, and a
register of the gaps.

---

## 11. Known weaknesses and direction

An honest register. Nothing here is urgent; all of it is real.

| Weakness                                              | Why it is one                                                                                                                                                                                                                 | Direction                                                                                                                                   |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.ts` is ~1 800 lines                        | Down from 2 200 after three collaborators were extracted, but the chart _actions_ and the table lifecycle still share one object                                                                                              | Extract the chart actions once a fourth kind of box arrives, which is when the seam will be obvious                                         |
| `table-draw.ts` is ~1 100 lines                       | One pure function that draws everything about a table — chrome, rows, halo, panels, charts                                                                                                                                    | Low-risk to split by region, because it is pure; no reason to until it changes shape                                                        |
| `interaction.ts` is ~850 lines                        | One object routing every gesture; the cases are flat but there are many                                                                                                                                                       | Table-driven dispatch would compress it, at the cost of the plain reading it has now                                                        |
| The agent's command table mirrors the core by hand    | Two descriptions of one shape, held together by a seam test rather than by construction                                                                                                                                       | Generating one from the other needs runtime type information the build deliberately does not keep                                           |
| No persistence                                        | The world lives for the session; nothing is written                                                                                                                                                                           | The history DAG is already a serialisable value; the missing part is a store and a document identity                                        |
| One connection at a time                              | `connectionId` is a single value on the workspace, and entities carry it                                                                                                                                                      | The model already names it per entity, so this is a shell and worker change, not a model change                                             |
| Discovery depends on what a client chooses to surface | The skill is a tool, a prompt _and_ a resource, because a client that shows only tools makes the other two invisible — which is how it was found                                                                              | Watch what clients actually show, and add doors rather than assume one                                                                      |
| A calendar heatmap draws and cannot be pointed at     | Its cells are drawn by the calendar component and carry no row index anywhere in the display list, so the structural search has nothing to find. Every other series type Panorama has met links its elements back to its rows | Reported rather than hidden: `drawn.pickable` is false and says so, which makes it measurable instead of a caveat to remember               |
| A matrix cell drills down on one axis                 | A row filter is one predicate, so a data set names one key column and a cell of a cross-tabulation opens the rows of whichever axis that is                                                                                   | A predicate of several clauses, which cross-filtering wants too — [plans/panorama-chart-data-plan.md](../plans/panorama-chart-data-plan.md) |
| The agent endpoint is development-only                | Deliberate, but it means an agent cannot drive a deployed page                                                                                                                                                                | If that is wanted, it is a hosted endpoint with authentication, not a flag                                                                  |
| An installed app remembers nothing but the shell      | Credentials are typed per session and never stored, which is a defensible answer for a development tool and an irritating one for an application launched from a dock                                                         | A product decision, not a packaging one: a page can offer no better than the browser's password manager; a shell could use the keychain     |
| XR has never run on real hardware                     | The renderer's XR path is exercised headlessly and reviewed, but no session has been entered on a device                                                                                                                      | The one measurement that decides the distribution plan — `plans/panorama-packaging-plan.md`                                                 |

---

## 12. Glossary

| Term              | Means                                                                      |
| ----------------- | -------------------------------------------------------------------------- |
| **Entity**        | A box in the document: today always a table                                |
| **Source**        | What a table reads: a relation, a statement, or a chart specification      |
| **Command**       | One semantic change to the document; the only way persistent state changes |
| **Commit**        | A command plus the world it produced, in the history graph                 |
| **Session state** | Selection, hover, drags, drafts — temporary, never in history              |
| **View**          | The main-thread object holding one table's scroll, layout and block cache  |
| **Block**         | A fixed-size window of rows, fetched and cached as a unit                  |
| **Generation**    | A result set's incarnation; blocks from an older one are never reused      |
| **Draw list**     | The quads, polygons and text runs one box contributes to a frame           |
| **Halo**          | The buttons around an activated box                                        |
| **Binding**       | A persistent relationship between two entities, drawn as a connector       |
| **Derived table** | What a query box calls the table it refines                                |
| **Reduction**     | Turning a result set into the few dozen numbers a chart draws              |
| **Picture**       | A chart's reduced numbers, its laid-out geometry, and the emphasis on it   |
