<!--
  This document is served to agents over the Model Context Protocol, as the prompt
  `panorama` and the resource `panorama://skill`, by the development server that
  hosts the agent interface. It is the source: the server reads this file, there is
  no second copy of it in the code, and a test insists every tool is written down
  here. Edit it as documentation and agents get the edit.
-->

# Driving Panorama

Panorama is a spatial canvas of database tables, queries and charts. This server
is a pipe to a _live_ one: every answer comes from the session in the page, and
your edits appear on screen and undo like a person's.

**This server is for the canvas, not for the database.** Anything heavy — scanning,
aggregating, counting, profiling, DDL — belongs on the shortest route to the
engine: the local `exasol` CLI if `overview` reports a database on this machine,
a native Exasol MCP server otherwise, and this only for what neither can answer.
Work out what is true there; put _that_ on the canvas here. Check first that it is
the same database — `overview` reports the URL, name and version this session
reached — and read whatever semantic layer exists before writing SQL.

## The shape of it

A box is a **relation** (a stored table), a **query** (a statement built on
another box), or a **chart** (a picture of one). Boxes are connected by arrows,
and an arrow can mean four things: a connector (a followed key, a derivation), a
**data** arrow (supplies a chart's named data set), a **filter** arrow (a chart's
selection fills in a `{{name}}` in a statement), or a rows arrow (a drill-down).

Every persistent change is one of sixteen commands, applied through `dispatch`.
There is no undo stack: history is a graph, `checkout` moves the head, and
committing from an inner commit branches rather than discarding anything.
Selection, hover and drafts are _session_ state and are not in history.

## The tools

**Read.** `skill` (this page, answered by the server, so it works before anything
is open) · `overview` (start here: what is open, which database, where history
stands) · `entities` · `entity` (one box in detail) · `rows` (cells that have
arrived; a cell that has not is not null) · `history` · `session` · `catalogue`
(schemas and tables — but explore on a shorter route where you have one).

**Write.** `dispatch` (any document command; `commands` for several) ·
`session_dispatch` (selection, hover, focus, picked marks) · `label` · `checkout`
· `open_table` · `action` (the halo: close, edit, sql, chart, rows, export…) ·
`query` (write and run a statement on a query box) · `chart` (set a chart up, or
pan its window).

Answers are terse by default. Pass `verbose` for ids, widths and composed
statements.

## Charts

**Writing an ECharts option is its own page:** `skill(page: "charts")`. It is
where the series that draw, the ones that come out inert, and the handful of
settings this canvas silently drops are written down — read it before writing one
rather than after. What follows is the shape of the mechanism.

A chart is given **named data sets**. Its own reduction is always there as
`primary`; name your own in `spec.frames` for anything that shape cannot express:

- `group` — one row per category, like the reduction. Its own question entirely:
  it does not take the chart's `breakdown` unless it names one.
- `rows` — the rows as they are, projected to the columns named. What a heatmap,
  a scatter with a size channel, a graph's edges or a tree's parents needs.
- `resample` — a long series reduced to a few hundred points where the rows are.
  `extremes` (default) keeps each bucket's high and low, so a spike survives;
  `mean` for a trend; `lttb` for the shape. `rolling: N` adds a trailing average
  over N rows as `<column>_meanN`, computed before the reduction — the line and
  its trend, from one data set.
- `scalar` — one number, read as `{"$param": "name"}` anywhere in the option.

With `type: "custom"`, `spec.extra` is the entire ECharts option and reads a data
set the way any ECharts example does — `datasetId` and `encode`:

    frames: [{ name: "m", kind: "rows", columns: ["BAND", "TYPE", "PCT"], key: "BAND" }]
    extra:  {"series":[{"type":"heatmap","datasetId":"m",
                        "encode":{"x":"BAND","y":"TYPE","value":"PCT"}}]}

A series binds one data set, and a graph or a sankey needs two. So a data set can
also go wherever a _list_ belongs, as objects keyed by its columns:

    frames: [{ name: "nodes", kind: "rows", columns: ["name", "value"] },
             { name: "edges", kind: "rows", columns: ["source", "target", "value"] }]
    extra:  {"series":[{"type":"graph","layout":"force",
                        "data":{"$rows":"nodes"},"links":{"$rows":"edges"}}]}

Nothing is typed in as a literal, so the picture cannot go stale.

A data set reads the chart's own box unless `from` names another — which draws a
data arrow for you, so a panel of several aggregations, a graph of nodes and edges
or a tree of parents is one `chart` call. `key` says which column a drawn mark
stands for: give it and picking a mark means something.

**Windows.** A window is a _range selector_, not a rolling one — for a moving
average use `rolling`. A `rows` or `resample` data set may say which part of a
relation it reads: `{by: "position", from, count}`, or `{by: "value", column, from, to}` for a
range, which stops reading once the column passes the bound. Move a position
window with `chart(tableId, pan: {frame, pages})` — one commit, and the picture
you had stays on screen until the next window arrives.

**Numbers.** Figures carry twelve significant digits, so binary addition noise
never reaches a label. `precision` reads them to a stated number of places.

## Tables that hold a document

Some schemas store nested documents — from `exasol-json-tables`, or a MongoDB
collection through `exasol-mongodb-vs` — as a family of ordinary tables: one per
object and array, joined by `_id`, `_parent` and `_pos`, with each property
spread across a value column per type it turned out to have and boolean masks
recording what SQL cannot say.

Panorama reads those as the document. A box shows one column per **property**,
and `entity` says so: a column with a `document` field presents several, and its
`says` lists what a cell of it can be beyond a value — `missing` always, `null`
and `empty string` where the source recorded them.

**`rows` uses JSON's own distinction and adds nothing.** A property that was
_missing_ is an **absent key**; one that was explicitly `null` is `null`. A
present empty string is `""`. So `{"note": null}` and `{}` are two different
documents, which is exactly what they were. Do not read an absent key as "not
fetched" — that comes back as `notFetchedYet`.

A nested value is tagged, because a list of three is not the number three:
`{"items": 3}` for a list, `{"object": "p0"}` for an embedded document. Its
`document.opens` names the child table and the column to match on, and
`action(tableId, "rows")` is not how to get there — open the child table with a
filter, or press the cell the way a person does.

`action(tableId, "json")` switches the box between the document and the columns
storing it. Reach for the stored view when you are about to write SQL: the
database knows `note|n` and has never heard of a property called `note` being
absent. Every column of a document box also carries the result-set index it
reads, so a box showing nine columns over thirteen is still unambiguous.

## What a picked mark means

Marks carry the data set and row they were drawn from. `session_dispatch` with
`SetSelectedMarks` picks them out; `session` then reports each one with the column
and value the rows behind it share. `action(tableId, "rows")` opens those rows as
a table of their own. This works for any chart type whose data set has a `key`.

## Cross-filtering

A statement may leave a predicate open: write `{{name}}` where a condition
belongs and pass `filters: [{name, from}]` to `query` to say which chart decides
it. Pick something in that chart and this box — and everything built on it —
re-runs. Nothing picked is `1 = 1`, so a box shows its data until somebody
chooses; a `{{name}}` no arrow answers for is left in the statement for the
database to refuse, which is better than a query that quietly ran unfiltered.

## Read the feedback

You cannot see the picture, so it is measured for you. `entity` on a chart
reports:

- `drawn.box`, `polygons`, `labels`, `covers` — the _shape_ it came out.
- `drawn.clipped` — labels that fell outside the box, by name.
- `drawn.datasets` and `drawn.series` — what each series read, through which
  channels, and how many marks it drew.
- `drawn.unresolved` — **read this first.** A channel naming a column its data
  set has not got, a data set asked for a column the rows have not got, or a
  `$param` nothing answered for. A series with no marks and an unresolved channel
  is the failure that otherwise looks like success.
- `drawn.pickable: false` — it drew shapes and none can be pointed at. A calendar
  heatmap does this: correct, and inert. Not something rewriting the option fixes.
- `chart.reads` — each data set, the box it came from, its key, its window, and
  how much of the relation it saw.
- `chart.offered` — for a written option, the reduction it was _handed_; not a
  claim it used any of it.
- `scopedBy` on a query box — what is filling each `{{name}}`, and from where.

The status may still be `loading` right after a call: the rows are read and the
picture drawn over the frames that follow. Ask again.

## Habits that pay

1. `overview` first, then compute on the shortest route, then put the result here.
2. Every field belongs to one kind of data set: a `window` on a `group` is refused
   rather than dropped, and the refusal says which kinds do read it.
3. Read from what a box's `readsFrom` says. Only a box built on another query or
   chart reads `derived_table`; naming the relation is clearer.
4. After setting a chart up, ask again and read `unresolved` and `marks` before
   believing the picture.
5. Name your boxes with `label`. A canvas where seven boxes all say
   "RAW.CLAIMS · SQL" is one you have to read the statements to navigate.
6. Send several commands in one `dispatch` rather than several calls.
7. A refusal is an answer: it says what was wrong in the terms you sent it.
8. Exasol reads a backslash inside a string literal as an ordinary character, so
   `\u00b7` in a statement is six characters and not a middot. Put the character
   in directly, or use `UNICODECHR`. `query` says so when it sees one.
