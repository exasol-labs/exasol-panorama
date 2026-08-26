# Panorama — Testing

Panorama promises something a test suite cannot see: that a table of ten billion
rows feels local under your hand. Everything in this document exists because that
promise has to be checked anyway.

It is the companion to [ARCHITECTURE.md](ARCHITECTURE.md), which explains what the
system is; this explains how we know it works. It is written for somebody about to
add a test, or about to wonder why a test they expected to exist does not, or
about to be stopped by the coverage gate and decide what to do about it.

1. [What the tests are for](#1-what-the-tests-are-for)
2. [Running them](#2-running-them)
3. [The shape of the suite](#3-the-shape-of-the-suite)
4. [Determinism: injected time, injected chance](#4-determinism-injected-time-injected-chance)
5. [The doubles, and why there is almost no mocking](#5-the-doubles-and-why-there-is-almost-no-mocking)
6. [Kinds of test](#6-kinds-of-test) — the taxonomy, including the
   [property-based suites](#65-property-based-tests) and what they found
7. [Coverage as a design tool](#7-coverage-as-a-design-tool)
8. [Browser probes](#8-browser-probes)
9. [Checking files against other people's readers](#9-checking-files-against-other-peoples-readers)
10. [Against a real Exasol](#10-against-a-real-exasol)
11. [Adding a test: where does it go?](#11-adding-a-test-where-does-it-go)
12. [Known gaps](#12-known-gaps)

---

## 1. What the tests are for

Two claims need support, and they need different kinds of evidence.

**The logic is correct.** A command applied to a world produces the world it
should; a query chain composes into the statement it should; a Parquet file says
what it should. This is ordinary and the suite is thorough about it — some two
thousand cases, nearly all of them data in, data out.

**The system stays responsive.** This is the constraint the architecture answers
to ([ARCHITECTURE.md §1](ARCHITECTURE.md#1-the-constraint)): the database may cause
data to arrive late, and may never cause Panorama to respond late. A frame rate is
not a thing you can assert in a unit test, but the properties that produce it are:

- that the work done per frame does not depend on the size of the relation;
- that the work done per frame does not depend on the latency of the fetch;
- that no code path holds a result set, an export or a chart's input whole.

So the interesting tests in this repository are not about return values. They
replay the same scripted fling at four latencies and demand that the _work_ come
out identical (§6.5); they count cell reads and cache bytes rather than
milliseconds (§6.6); they walk a result set and assert it was walked once, in
order, in whole batches.

Two properties of the design are what make any of this affordable. Most of the
system is pure — draw lists, layout, routing, reduction, encoding are all
functions — and everything impure is injected: the clock, the randomness, the
socket, the data source, the engine, the file sink. Nothing has to be intercepted
because nothing reaches for a global.

---

## 2. Running them

```bash
npm test               # the whole suite, once
npm run test:watch     # the whole suite, on change
npm run coverage       # the suite with the coverage thresholds enforced
npm run typecheck      # tsc --noEmit across every package
npm run verify         # typecheck + coverage — the gate
npm run format:check   # prettier
```

`npm run verify` is the gate, and it is the one to run before saying something
works. At the time of writing it reports 2 151 passing tests in 122 files (5
skipped: the opt-in database tests), 100 % of lines covered, and takes about 20
seconds plus a few for the type check.

The browser probes are deliberately _not_ in `npm test` — they need a real
browser and a running dev server, and they are described in §8.

There is no CI configuration in this repository. `npm run verify` is run by hand,
which is worth knowing before you rely on a green history.

---

## 3. The shape of the suite

Tests live in `test/` beside the `src/` they exercise — `packages/<name>/test/`
and `apps/web/test/` — never interleaved with source. A file named
`<subject>.test.ts` tests `src/<subject>.ts`; one named
`<subject>.properties.test.ts` states what must hold for _every_ input to it
(§6.5); files without `.test.` in the name are helpers and fixtures for their
neighbours.

`vitest.config.ts` defines two projects, because half the codebase must not be
allowed to touch a DOM:

| Project | Environment | Includes                                                                                        |
| ------- | ----------- | ----------------------------------------------------------------------------------------------- |
| `logic` | `node`      | `packages/{core,table,chart,chart-echarts,exasol,export,mcp,worker,test-support,renderer}/test` |
| `dom`   | `jsdom`     | `packages/ui/test`, `apps/web/test`                                                             |

The renderer sits in the `node` project on purpose. It draws with Babylon, but
everything in it that decides _what_ to draw is arithmetic over plain data, and
running it without a DOM is what keeps it that way: the day a draw-list function
reaches for `window`, its test stops compiling rather than silently starting to
depend on a browser.

`resolve.alias` maps every `@panorama/*` specifier to that package's
`src/index.ts`. Tests therefore run against TypeScript source, not build output:
there is no build step in the edit-test loop, coverage is measured over the real
source, and a change is impossible to test against a stale artefact. The same
alias map is exported and reused by the web app's Vite config, so the application
and the tests resolve packages identically.

What each suite is responsible for:

| Suite                | Cases | Proves                                                                                                                                                                               |
| -------------------- | ----: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `core/test`          |   289 | Commands against worlds, the history graph and branching, session state, entities, ids, placement, query chains, bindings, chart specifications                                      |
| `table/test`         |   139 | The block cache and its eviction, row windows, smooth scroll and velocity, prefetch, chunks and vectors, column summaries, formatting                                                |
| `chart/test`         |    44 | The reduction — grouping, cross-tabulation, limits, gaps versus zeroes, sampled versus exact — and mark picking                                                                      |
| `chart-echarts/test` |   104 | ECharts driven headless into geometry: polygons, text, triangulation, layout bounds                                                                                                  |
| `exasol/test`        |   136 | The wire protocol, login and RSA, result sets, data types, SQL construction, error mapping, socket lifecycle                                                                         |
| `export/test`        |   151 | CSV, XLSX, Parquet and Thrift encoding; SVG, PNG and PDF figures; streaming row walks; sinks                                                                                         |
| `worker/test`        |    78 | The data worker and its client, the table controller, endpoints, export streaming, and the latency invariance test                                                                   |
| `renderer/test`      |   473 | Draw lists for tables, charts, query boxes, summary panels; the halo; connector routing; hit testing; interaction; glyph atlas and text; camera, LOD, quad batching, frame stats, XR |
| `mcp/test`           |   171 | The protocol, the tool catalogue and its handlers, command parsing, snapshots, the HTTP route, the bridge, the stdio host, Claude discovery                                          |
| `ui/test`            |    85 | The React panels, through their accessible roles                                                                                                                                     |
| `apps/web/test`      |   378 | The composition root: the workspace and its collaborators, the canvas, the editors, the agent bridge, startup, placement, export jobs                                                |
| `test-support/test`  |    37 | The doubles themselves — see §5                                                                                                                                                      |

---

## 4. Determinism: injected time, injected chance

No test in this repository calls `Math.random`, and none depends on wall-clock
time. This is not tidiness; a failing interaction test is worthless if it cannot
be replayed.

**Randomness** comes from `seededRandom` in `@panorama/test-support` — thirteen
lines of linear congruence. The mock data source takes a seed, and so does the id
factory used by fixtures (`testIds`), which is handed an injected `now` and
`random` rather than reaching for either.

**Time** comes from an injected `Scheduler`, which is just
`(callback, delayMs) => void`. Three exist:

- `immediateScheduler` — a microtask, for tests that only care about ordering;
- `timeoutScheduler` — the real one;
- `ManualScheduler` — a virtual clock that keeps a due-time-ordered queue and
  fires it on demand.

The virtual clock is what makes latency testable. Advance it and the responses
arrive in _due-time_ order, which is not the order they were requested — so
out-of-order arrival, the thing that actually breaks a windowed cache, is
reproducible rather than occasional. Jitter is seeded, so a specific interleaving
can be re-run until it is understood.

**Values** are index-derived: `generateValue(type, column, row)` is a pure
function, so row 4 300 of a generated relation always holds the same data,
whichever test asked for it and whichever order the fetches arrived in.

The harnesses expose three ways to let work happen, and the distinction matters
often enough to be worth learning:

| Call             | Does                                                          | Use when                                                                                                             |
| ---------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `settle()`       | Runs every scheduled fetch, then drains microtasks            | Almost always                                                                                                        |
| `drive(promise)` | Runs scheduled work on real event-loop turns until it settles | Something crosses a platform API that resolves on a task rather than a microtask — `CompressionStream`, for instance |
| `pump(rounds)`   | Runs a bounded number of turns, leaving work part-finished    | Asserting on an intermediate state: a half-filled table, a cancelled export                                          |

---

## 5. The doubles, and why there is almost no mocking

The whole repository contains three `vi.mock` calls — two in
`renderer/test/engine-backends.test.ts`, to make a Babylon engine constructor
throw the way a machine without WebGPU does, and one in `App.test.tsx`, to stand
in for the canvas component in a jsdom with no WebGL — against ninety-odd plain
`vi.fn` spies passed in as arguments. That ratio is the policy: **dependencies are
injected, not intercepted.** A module mock asserts something about the module
graph; an injected double asserts something about an interface, which is the thing
that has to keep working.

The doubles, and the interface each stands in for:

| Double                                           | Stands in for           | Notes                                                                                                                                                                       |
| ------------------------------------------------ | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MockTableDataSource` (`test-support`)           | `TableDataSource`       | Generated relations, scriptable latency and jitter, scriptable failure (`everyNth`, `firstAttempts`), optional "cannot report a row count", optional failure to open at all |
| `generators.ts` (`test-support`)                 | Real relations          | `TYPE_COVERAGE` (one column per Exasol type Panorama must render), and the pathological shapes: ten billion rows, five thousand columns, mostly-NULL, very long strings     |
| `FakeSocket` / `fake-exasol.ts` (`exasol`)       | A WebSocket to Exasol   | Scripted: the test drives open, message and close, and reads what was sent                                                                                                  |
| `NullEngine` (Babylon's own)                     | A GPU                   | Lets the real renderer construct real meshes and materials with no context                                                                                                  |
| `testRasterizer` / test text system (`renderer`) | A canvas 2D context     | Deterministic glyph metrics, so text layout is arithmetic rather than a font's opinion                                                                                      |
| `createInProcessEndpointPair` (`worker`)         | `postMessage` both ways | The real worker and the real client, wired to each other in one process — the protocol is exercised, the thread is not                                                      |
| `FakeHost` (`mcp`)                               | The live application    | A world an agent's tools can be run against without a page                                                                                                                  |
| `ThriftReader` (`export`)                        | A Parquet reader        | See §9 — written from the specification, independently of the writer                                                                                                        |

One library rather than a double: **`fast-check`** generates the inputs for the
property suites (§6.5) and shrinks a failure to the smallest case that still
fails. It is the only test dependency here that produces values rather than
standing in for something, and its seeds are pinned wherever it is used — so it
obeys the same rule as everything else in this section: nothing in the suite is
allowed to be different on the next run.

Two harnesses assemble those into something bigger than a unit:
`packages/worker/test/harness.ts` (a real `DataWorker` and `DataWorkerClient` over
mock sources) and `apps/web/test/harness.ts` (the whole `Workspace` over that
worker, with every source request recorded so a test can assert on the SQL that
was sent). Between them, most of the application is testable in a Node process
with no browser and no database.

The doubles have their own tests (`packages/test-support/test`, 37 cases). Every
other suite trusts them, so a mock that lies is worse than no mock: if
`MockTableDataSource` renumbered a filtered session's positions wrongly, several
hundred tests would agree with it.

---

## 6. Kinds of test

Seven kinds, plus the probes in §8. Each answers a question the others cannot.

### 6.1 Pure-function tests

The bulk of the suite. `applyCommand`, the history graph, viewport arithmetic, the
block cache, placement, connector routing, the chart reduction, the encoders, the
option builder, the agent's projections — data in, data out, no setup. This is why
two thousand cases run in twenty seconds, and it is a property of the
architecture, not of the tests: purity was chosen partly to get this.

### 6.2 Component tests in jsdom

`packages/ui/test` and the `.tsx` files in `apps/web/test` render React through
`@testing-library/react` and query, predominantly, by accessible role and label —
`getByRole`, `getByLabelText` — rather than by class name. Two reasons: a query by role fails
when the markup stops being usable, which is exactly when we want to hear about
it, and the probes in §8 then drive the same elements by the same names, so the
DOM contract is written down once.

What they cannot prove is anything about the canvas. jsdom has no WebGL, no
layout, and no compositor. A component test can prove the chart editor sends the
right specification; only a probe can prove a chart appeared.

### 6.3 Harness tests

`apps/web/test/workspace.test.ts` and its neighbours run the real composition
root: a `Workspace`, a real `DataWorker` behind an in-process endpoint pair, mock
sources, a virtual clock. They open a table, scroll it, derive a query from it,
chart it, export it, undo it — and assert on world state, on the SQL the worker
was asked for, and on what the renderer would be handed.

These are the tests that catch integration mistakes without a browser, and they
are worth the setup: the majority of real defects in this codebase lived in the
seams between components that were each individually correct.

### 6.4 Seam tests

Where one thing mirrors another, a test asserts the mirror holds. Every one of
these was written _after_ the mirror had already drifted, and each drift was a
user-visible bug:

| Mirror                                                                         | The test insists                                            | What it caught                                                                                                                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AGENT_TOOLS` (offered by the dev server) ↔ `AGENT_HANDLERS` (run in the page) | The two name exactly the same tools                         | A tool that existed and did nothing — the halves run in different processes                                                                            |
| `COMMAND_FIELDS` (the agent's parser) ↔ `Command` (the core)                   | Every command an agent can send round-trips into a real one | `SetSelectedColumns` naming its field `columnIds` where the core says `ids`, which crashed the page; and `SetTableLabel` missing entirely              |
| `connectorMidpoint` (probe) ↔ `connectorPath` (renderer)                       | Drawing and picking agree where a line is                   | Probes reporting `null` for a marker that was on screen                                                                                                |
| Halo geometry (`halo.ts`) ↔ the probe sweep                                    | Every button is hit-testable where it is drawn              | A reorganised halo silently unreachable at a fixed pitch                                                                                               |
| Chart mark geometry ↔ halo button geometry                                     | A button and the thing it creates share one constant        | A three-bar glyph 33 px tall in a 30 px button                                                                                                         |
| `AGENT_TOOLS` ↔ `docs/AGENT-SKILL.md`                                          | Every tool is written down in the skill                     | Written to keep it true: a tool nobody wrote down is one an agent finds by accident, and one written down and then removed is one it looks for in vain |

The pattern generalises: any time information is written down twice — once for a
machine, once for a person; once in a process, once in another — write the test
that says so, in the same commit.

### 6.5 Property-based tests

Where the input is not ours to choose, the example tests are a list of cases
somebody thought of. Four boundaries take arbitrary input, and each has a
`*.properties.test.ts` beside it stating what must hold for **every** input:

| Suite                              | Input it does not choose            | What it insists on                                                                                                                                                                                                                                            |
| ---------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `core/test/query-chain.properties` | Whatever was typed into a query box | The statement scanner answers about any string; a reference is never rewritten inside a literal, a quoted identifier or a comment; a composed chain binds no name twice and no name a step already uses; every reference to the input is resolved             |
| `exasol/test/sql.properties`       | Cell contents and catalogue names   | Any text round-trips through a literal and through an identifier; a value is either a closed literal saying exactly the value or a bare token that can be nothing else; a predicate contains only the words and symbols it means to write                     |
| `mcp/test/arguments.properties`    | JSON an agent sent                  | Every tool answers with a value or an `AgentError` — never a `TypeError`; the JSON Schema an agent reads accepts exactly what the runtime check accepts; every command survives the pipe unchanged; nothing that passes the boundary can crash `applyCommand` |
| `core/test/document.properties`    | Command sequences with rogue values | The world stays internally consistent after every command of every sequence; a refusal changes nothing; the history walks back and forward without loss and branches rather than overwrites                                                                   |

Two rules make these fit the repository rather than fight it.

**Every `fc.assert` pins its seed.** Random inputs mean different lines reached on
every run, which the 100 % line gate would report as a number that moves on its
own; and a counterexample nobody can replay is one nobody can fix. `numRuns` is
pinned too, at 200–500, which keeps the whole suite inside its twenty seconds.

**A property is read back by something that did not write it** wherever the
subject is a format. `exasol/test/sql-scanner.ts` reads SQL literals and
identifiers the way the dialect defines them, and
`mcp/test/json-schema-check.ts` validates against the JSON Schema specification —
both written independently of the code they judge, exactly as
`export/test/thrift-reader.ts` is (§9). A property checked against our own writer
proves only that we are consistent.

### 6.6 Invariance tests

`packages/worker/test/latency-stress.test.ts` is the Stage 1C acceptance test and
the clearest statement of the architecture's central claim. It replays one
scripted fling — 240 frames, 40 pixels each, over a ten-billion-row relation — at
0, 50, 250 and 1 000 ms of simulated latency, and demands that scroll positions,
the rows the renderer walks, the cells it reads and the peak cache size come out
**identical**. The only thing allowed to differ between runs is how many of those
cells had data in them yet.

If that test passes, latency cannot reach the interaction loop. No amount of
frame-rate measurement makes that point as sharply, and no amount of code review
keeps it true.

### 6.7 Budget tests

Related, and worth calling out as a technique: where a cost matters, the test
asserts **counted work, not elapsed time**. Cells read, blocks fetched, bytes
cached, batches written, allocations avoided. `export/test/rows.test.ts` asserts a
result set is walked once, in order, in whole batches; `table/test/cache.test.ts`
asserts what eviction keeps.

Wall-clock assertions are absent on purpose: they are flaky on shared hardware,
they say nothing about _why_ something got slower, and the numbers that matter
here are per-frame numbers that only a real GPU can produce. Those are measured in
the browser instead — the performance overlay reports them, and the probes read
them back (§8).

### 6.8 Opt-in tests

Two suites are skipped unless an environment variable is set, because the default
run must need nothing but Node: the Exasol integration tests (§10) and the export
sample writer (§9). `describe.skipIf` rather than a separate command, so they are
visible in the run — five skipped tests are a reminder that they exist.

---

## 7. Coverage as a design tool

`npm run coverage` enforces four thresholds, and only one of them is interesting:

| Metric     | Threshold | Currently |
| ---------- | --------: | --------: |
| Lines      | **100 %** |     100 % |
| Functions  |      99 % |   99.70 % |
| Statements |      99 % |   99.37 % |
| Branches   |      96 % |   96.11 % |

**The line gate is the point.** At 100 %, code that cannot be reached fails the
build. That turns coverage from a report into a design tool: a line nothing
executes is either untested behaviour, or behaviour that does not exist and should
be deleted. Three dead methods in this codebase — `ExportJobs.cancelAll`,
`ChartPictures.hasLayout`, `ChartPictures.forgetEmphasis` — were found by the gate
and deleted rather than covered. Nothing in review had noticed them.

The other three are set just under what the suite achieves, and they are the
honest residue: defensive `??` fallbacks for states the types already exclude, and
branches only a real browser or a real GPU takes. They are ratchets, not targets —
if a change pushes branches from 96.03 % to 95.9 %, that is a request to test the
change, not to lower the number.

Excluded from measurement, in `vitest.config.ts`: `index.ts` re-export barrels,
`.d.ts`, `types.ts`, and the two entry points (`apps/web/src/main.tsx`,
`apps/web/src/data-worker.ts`) which are a single side-effectful call each,
exercised through the functions they delegate to.

A property test must be a source of _new_ covered lines, never the reason an
existing one is covered: coverage that depends on which inputs were drawn is
coverage that can vanish on a seed change. That is the other half of why the seeds
are pinned.

**When the gate stops you**, in order of preference: delete the code; make the
defensive branch impossible in the types instead of at runtime; test it; and only
then widen the exclusion — with a comment saying why, as the existing ones do.

---

## 8. Browser probes

### 8.1 Why they exist

The suite proves structure. It cannot prove appearance, and for a canvas
application the gap is wide. Two facts close off the obvious routes:

- **`readPixels` on a composited canvas returns black.** Once a frame has been
  handed to the compositor, the drawing buffer is not there to be read. Screenshots
  are possible; reading back the pixel a shader wrote, from the page, is not.
- **A line hidden behind a table is invisible to pixels _and_ to geometry.**
  Connectors draw beneath tables, so a badly routed line does not look like a
  crossing; it looks like a line that stops and starts somewhere else. There is no
  pixel to sample, and the draw list is perfectly happy.

So eleven probe scripts drive the real application in a real browser with a real
pointer, and read back the geometry the canvas actually produced. They also cover
the things only a browser has at all: WebGL, the save dialog, downloads, WebXR,
`EventSource`.

### 8.2 Running them

Chromium once, then a dev server on the port the probes expect:

```bash
npx playwright install chromium
npm run dev -- --port 5199        # in one terminal
npm run smoke                     # in another
```

Every probe reads `PANORAMA_SMOKE_URL` (default `http://localhost:5199/`), and
`smoke` also reads `PANORAMA_SMOKE_DPR=2` to reproduce a Retina display — device
pixel ratio has broken glyph rendering before. Screenshots land in
`scripts/shots/`. Chromium is launched with
`--use-gl=angle --use-angle=swiftshader`, so the probes need no GPU and produce
the same pixels on any machine.

Each probe prints a JSON report and then a `problems:` line collecting every page
error, console error and failed request the run produced. Read both: an empty
`problems` with a wrong report is still a failure.

### 8.3 Three techniques

**Read state back from the session, not from the screen.** The page exposes the
workspace as `globalThis.__panorama` (and the agent bridge as
`__panoramaAgent`), so a probe can ask what the application believes — which
entity is activated, which halo action is hovered, what the pointer's world
position is, how many quads and glyphs the last frame drew. That is a real
assertion about the running system, and it is available where a pixel is not.

**Derive the screen-to-world mapping; never assume the camera.** A probe that
hard-codes a camera position tests the camera, not the thing it was aimed at. So
the probes move the pointer to two known screen points, read the world
coordinates the session reports for each, and solve for scale and offset. Every
subsequent click is computed through that mapping.

**Find things by feel, not by arithmetic.** `scripts/lib/halo-sweep.mjs` sweeps
the pointer along both lines of the halo and records where each action turned out
to be, instead of computing where each button should be. Copying the layout
arithmetic into the probe would mean a reorganised halo passes its own check while
being unreachable — which is precisely what happened once. Where geometry genuinely
must be shared, it lives in one file used by both sides
(`scripts/lib/connector-midpoint.mjs` mirrors the renderer's path, and says so).

### 8.4 What each probe answers

| Probe                    | Drives                                                                                                                   | Exists because                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `npm run smoke`          | Every sample relation, a fling through ten billion rows, a five-thousand-column table scrolled sideways, a column resize | The frame-rate claim is only a claim until a browser holds it under load                      |
| `npm run halo-check`     | Hovering, pressing and closing from the halo                                                                             | A halo button is drawn by the GPU and hit-tested by arithmetic; both have to agree            |
| `npm run halo-reach`     | Walking the pointer across the gap to a halo on a table that is _not_ selected                                           | A reported bug: the halo reverted to the selected table as the pointer left the hovered one   |
| `npm run halo-exclusive` | Two tables, one selected, hovering each in turn                                                                          | Two halos on screen at once is the failure mode of the activation rule                        |
| `npm run binding-check`  | Following a foreign key, and the connector it leaves behind                                                              | The marker must be where the line is                                                          |
| `npm run route-check`    | A connector routed around a table parked between two joined ones                                                         | Neither pixels nor draw lists can see a line hidden behind a box (§8.1)                       |
| `npm run summary-check`  | Picking a column, and the statistics panel that appears under it                                                         | Glyph and quad counts prove a panel was drawn, not merely computed                            |
| `npm run sql-check`      | The query box: greying on sample tables, drag, composition, highlighting                                                 | Half of it is canvas and half is a DOM overlay sitting exactly on top                         |
| `npm run chart-check`    | Every chart control, the marks, picking, the drill-down table, SVG/PNG/PDF                                               | The form is DOM, the chart is geometry, and the export is a file                              |
| `npm run export-check`   | CSV, XLSX and Parquet as real downloads, through the real halo                                                           | Encoders being correct says nothing about the button working                                  |
| `npm run agent-check`    | The endpoint, the tools, an edit, the refusals, and the stdio pipe                                                       | Three parts in three processes that can only be wrong together                                |
| `npm run probe`          | A scratch pad for graphics-stack questions                                                                               | Some questions — atlas orientation, which material passes vertex colours — only a GPU answers |

`export-check` sets a non-zero exit code when a download is missing or starts with
the wrong bytes. The others report and leave the judgement to the reader; see §12.

The scratch pad is a different animal from the rest: `scripts/probe/` is a tiny
Vite app plus a runner, kept in the repository so the next graphics question has
somewhere to be asked. It currently checks glyph atlas orientation — exactly one
variant shows a red "A" — and is meant to be edited.

---

## 9. Checking files against other people's readers

**No test can prove a format is correct against the code that writes it.** A test
that asserts our Parquet writer produced our expected bytes is a test that we were
consistent, which is not the question. The question is whether pyarrow can open
it. So the export tests take two independent routes.

**A reader written from the specification.**
`packages/export/test/thrift-reader.ts` decodes Thrift compact protocol — field
headers, zigzag varints, list headers — written from the specification and
deliberately not from the writer in `src/parquet/thrift.ts`. The tests encode with
one and decode with the other, so a misunderstanding of the format would have to
have been made twice, in two directions, to pass.

**Real files, opened by libraries this repository does not depend on.** The sample
writer is opt-in, and the tools are somebody else's:

```bash
PANORAMA_EXPORT_SAMPLES=/tmp/panorama-export npm test
python3 -m venv /tmp/verify && /tmp/verify/bin/pip install pyarrow openpyxl
/tmp/verify/bin/python -c "import pyarrow.parquet as pq; print(pq.read_table('/tmp/panorama-export/types.parquet').schema)"
/tmp/verify/bin/python -c "import openpyxl; print(openpyxl.load_workbook('/tmp/panorama-export/types.xlsx').active.max_row)"
```

The shapes written are chosen to be awkward: full type coverage, a mostly-NULL
relation, 1 200 columns, an empty result set, several Parquet row groups, and the
values the generators do not produce — thirty-six-digit decimals, exponent
notation, the edges of Excel's calendar and of the Unix epoch, embedded quotes,
delimiters, newlines, carriage returns, astral-plane characters.

A chart's picture formats go the same way, through tools that had no hand in
writing them:

```bash
gs -dNOPAUSE -dBATCH -sDEVICE=nullpage chart.pdf  # does a real reader accept it
pdftotext chart.pdf -                             # is the text real text
python3 -c "import xml.dom.minidom as m; m.parse('chart.svg')"
sips -g pixelWidth -g pixelHeight chart.png
```

`pdftotext` is the interesting one: a PDF whose text has been drawn as outlines
looks identical and is useless, and only a reader that extracts text can tell the
difference.

---

## 10. Against a real Exasol

`packages/exasol/test/integration.test.ts` runs only when given a URL, because the
suite must pass with no database anywhere:

```bash
PANORAMA_EXASOL_URL=wss://localhost:8563 \
PANORAMA_EXASOL_USER=sys PANORAMA_EXASOL_PASSWORD=exasol \
PANORAMA_EXASOL_SCHEMA=SALES PANORAMA_EXASOL_TABLE=ORDERS \
NODE_TLS_REJECT_UNAUTHORIZED=0 \
npm test
```

The schema and table are optional; the tests that need them skip individually
without them. `NODE_TLS_REJECT_UNAUTHORIZED=0` is for a development instance's
self-signed certificate, and is what Node needs — a _browser_ connecting to the
same instance needs the manual trust step the [README](../README.md#quick-start)
describes, which no test can perform for you.

What this proves that `FakeSocket` cannot: the login handshake and RSA password
encryption against a real server, the actual shape of result-set responses
including the chunking thresholds, real data-type metadata, and the error codes a
real engine returns. The fake is scripted from these; when the two disagree, the
fake is wrong.

---

## 11. Adding a test: where does it go?

| You changed                                                     | Write                                                                              | Where                                    |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------- |
| A pure function — layout, routing, reduction, encoding          | A data-in-data-out test                                                            | `packages/<pkg>/test/<subject>.test.ts`  |
| A command, or how the world responds to one                     | A case in `apply.test.ts` — and check §6.4: does the agent's parser know about it? | `packages/core/test`                     |
| Something that crosses the worker boundary                      | A harness test                                                                     | `packages/worker/test`                   |
| Something the workspace orchestrates                            | A harness test through the real `Workspace`                                        | `apps/web/test/workspace.test.ts`        |
| A React panel                                                   | A role-queried component test                                                      | `packages/ui/test`                       |
| Anything drawn on the canvas                                    | A draw-list test for _what_ is drawn, **and** a probe for _that_ it is drawn       | `packages/renderer/test` + `scripts/`    |
| An agent tool                                                   | An operation test against `FakeHost`, plus the catalogue seam                      | `packages/mcp/test`                      |
| A file format                                                   | Encode-and-decode with an independent reader, plus a sample shape                  | `packages/export/test`                   |
| Anything whose cost scales with rows                            | A counted-work assertion, not a timing one (§6.6)                                  | beside the subject                       |
| Anything that parses, quotes or escapes input it did not choose | A property, with a pinned seed and an independent reader (§6.5)                    | `<subject>.properties.test.ts` beside it |
| A double or a generator                                         | A test for the double itself (§5)                                                  | `packages/test-support/test`             |

Two rules that are not obvious from the table. **Test through the interface that
is going to keep existing** — a role query rather than a class name, an injected
double rather than a module mock, the workspace rather than its private fields.
And **when you fix a seam, write the seam test in the same commit**: every entry
in §6.4 exists because two things that mirrored each other drifted, and drifted
silently.

---

## 12. Known gaps

Recorded honestly, in rough order of how much they should bother you.

| Gap                                                                                                                                                                                                                                                                                                                  | Consequence                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **The probes report; they do not assert.** Only `export-check` sets an exit code. The rest print a JSON report for a human or an agent to read.                                                                                                                                                                      | A probe can regress into nonsense and still "pass". Each should assert its own report and exit non-zero.               |
| **No CI.** `npm run verify` and the probes are run by hand.                                                                                                                                                                                                                                                          | Nothing prevents a regression from being committed; a green history means only that somebody looked.                   |
| **WebGPU has never run on real hardware.** No WebGPU-capable browser was available; every screenshot in `scripts/shots/` is WebGL through SwiftShader.                                                                                                                                                               | The preferred backend is the least tested one. The fallback path to WebGL is tested; the fast path is not.             |
| **No visual regression baseline.** Screenshots are written for people to look at, not compared.                                                                                                                                                                                                                      | A purely visual regression — a colour, a shadow, a two-pixel drift — is invisible to the suite.                        |
| **jsdom is not a browser.** No layout, no compositor, no WebGL.                                                                                                                                                                                                                                                      | Anything that depends on measured layout is only provable in a probe.                                                  |
| **WebXR is untested on a device.** `xr-stage.test.ts` covers the arithmetic; a headset has not run it.                                                                                                                                                                                                               | The headset path is structurally right and empirically unknown.                                                        |
| **Integration coverage depends on somebody's database.** The opt-in suite is the only check against a real engine, and it is skipped by default.                                                                                                                                                                     | Protocol drift in a new Exasol version would be found late.                                                            |
| **Property coverage stops at four boundaries.** The statement scanner, SQL construction, the agent's arguments and the document (§6.5). The export encoders, the viewport and cache arithmetic, and `formatCell` are covered by examples alone — and all three take their input from a database rather than from us. | A malformed cell value in someone else's data is the likeliest remaining source of a surprise.                         |
| **The chart surface is pinned to ECharts' internals.** The geometry tests read zrender's display list.                                                                                                                                                                                                               | An ECharts upgrade is a test-suite event, and deliberately so — see [ARCHITECTURE.md §9.6](ARCHITECTURE.md#96-charts). |
