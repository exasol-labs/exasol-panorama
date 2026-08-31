<!--
  This document is served to agents over the Model Context Protocol, as the tool
  call `skill(page: "charts")`, the prompt `panorama-charts` and the resource
  `panorama://skill/charts`. It is the source: the server reads this file, there
  is no second copy of it in the code, and a test insists its claims still hold.
  Edit it as documentation and agents get the edit.
-->

# Writing charts in Panorama

Read this when you are about to write an ECharts option. The rest of the
interface is the other page, `skill(page: "interface")`.

Everything ECharts draws is reachable from here — a sankey, a sunburst, a
boxplot, a matrix, a graph — because `type: "custom"` hands the whole option
over. What is _not_ reachable is a short list, and it is short in a way that is
worth knowing before you write rather than after: this canvas does not use
ECharts as a renderer, and the difference shows up in about a dozen places.

## What this seam is

ECharts runs headless here, laying out into a display list that Panorama reads
the geometry out of and draws with its own two batches — the same ones that draw
every table. So a chart stays sharp at any zoom, exports as vector, and has no
DOM anywhere in it. Three consequences, all of them things you would otherwise
spend a call discovering:

**Nothing is interactive to ECharts.** No tooltips — `tooltip` is forced off,
because a tooltip is a DOM overlay that does not exist here. No clicks reach a
legend, no drag reaches a `dataZoom` slider, no `emphasis` triggers itself.
Hover and picking are Panorama's, hit-tested against the geometry, and they work
on any mark the library links back to a row. Write for a **still picture that can
be pointed at**, not for a widget.

**Animation is forced off.** The geometry is read once per change, so an
animation would be captured as a still frame of itself. `effectScatter` draws,
with its ripple frozen.

**There is one font.** `textStyle.fontFamily` is forced to the canvas's. Sizes,
weights, colours and alignment are yours; the family is not, because the text is
drawn from one glyph atlas. Labels _are_ measured with that atlas before being
positioned, so what ECharts lays out is laid out for the text you will actually
see.

## Two ways in, and they compose differently

**Assembled** — `type` of `bar`, `line`, `area`, `scatter` or `pie` — builds the
option from the controls, and `extra` is **merged over** it: deep, and lists
merge element by element. That last part is the useful one. `{"series": [{},
{"type": "line", ...}]}` keeps the built series and adds a second beside it;
`{"dataset": [{}, {...}]}` keeps `primary` and adds one. Reach for this when you
want an ordinary chart with one thing added — a reference line, a trend, a second
axis — rather than a written option that has to rebuild the axes.

**Custom** — `type: "custom"` — makes `extra` the whole option. Panorama supplies
only a transparent background, the canvas palette as `color`, the font, and
`dataset`, and it supplies them _underneath_ rather than over the top: nothing of
yours is overridden except the three settings above. The merge is shallow, so **a
written `dataset` replaces Panorama's entirely** — see the transform pattern
below for what to do about that.

Both are `chart(tableId, spec)`. `extra` is a JSON **string**, not an object.

## Getting data into an option

Every chart is handed its own reduction as a data set called `primary`, and
whatever else `spec.frames` asked for. Four kinds:

| kind       | shape                                            | reads                                                                                |
| ---------- | ------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `group`    | one row per category, a column per measure       | `category`, `values`, `aggregate`, `breakdown`, `sort`, `categoryLimit`, `precision` |
| `rows`     | the rows as they are, projected to columns named | `columns`, `key`, `rowLimit`, `window`                                               |
| `resample` | a long series cut to a few hundred points        | `x`, `values`, `method`, `points`, `rolling`, `key`, `window`                        |
| `scalar`   | one number                                       | `column`, `aggregate`                                                                |

A field belonging to another kind is refused rather than dropped. Every data set
reads the chart's own box unless `from` names another box — and giving `from`
draws the data arrow for you, which is what makes a graph of nodes _and_ edges,
or a matrix _and_ its marginal, one `chart` call.

Three ways an option reaches them:

```jsonc
// A series binds one data set, by name, and names its channels.
{ "series": [{ "type": "heatmap", "datasetId": "m",
               "encode": { "x": "BAND", "y": "TYPE", "value": "PCT" } }] }

// Where a *list* belongs and a data set cannot be bound — a graph needs two.
{ "series": [{ "type": "graph", "layout": "force",
               "data": { "$rows": "nodes" }, "links": { "$rows": "edges" } }] }

// Where a *number* belongs, so a threshold is computed rather than typed.
{ "series": [{ "type": "bar", "datasetId": "primary",
               "markLine": { "data": [{ "yAxis": { "$param": "baserate" } }] } }] }
```

`{"$rows": "n"}` becomes the rows as objects keyed by the data set's columns,
which is exactly what `graph`, `sankey`, `tree` and `radar` read. Nothing is ever
typed in as a literal, so no picture goes stale when the query behind it changes.

Give a `rows` or `resample` data set a `key` and a picked mark means something —
the rows behind it can be opened. Without one a mark can be pointed at and traced
back to nothing.

## What draws

Measured through this seam, not read off the ECharts documentation.

**Drawable and pickable, straight from a data set:** `bar`, `line`, `scatter`,
`effectScatter`, `pictorialBar`, `pie`, `funnel`, `radar`, `gauge`, `treemap`,
`sunburst`, `sankey`, `graph`, `tree`, `parallel`, `lines`, and `bar` on a
`polar` coordinate system.

**Drawable, but the data has to be the shape the series wants:** `heatmap` needs
a `visualMap` or it refuses outright; `boxplot` wants five numbers a row (or a
`{"type": "boxplot"}` dataset transform to make them); `candlestick` wants four;
`themeRiver` wants `[time, value, name]` triples on a `singleAxis`.

**Not available at all:**

- `series: {"type": "custom"}` — it needs a `renderItem` **function**, and `extra`
  is JSON. The word "custom" in a spec's `type` is Panorama's and unrelated.
- `map` and `geo` — they need GeoJSON registered through a JavaScript call, and
  there is no call to make from an option.
- `graphic` of `type: "image"`, and `symbol: "image://..."` — a raster has no
  geometry to read, so it silently draws nothing. `graphic` text, rect, circle
  and group all work, as does `symbol: "path://..."`.

**Drawable and inert:** a **calendar** heatmap read from a data set. Its cells
carry no row anywhere in the display list, so nothing about it can be hovered,
picked or drilled into. It is a correct picture that cannot be pointed at, and no
rewriting of the option changes it. `drawn.pickable: false` says so.

## The rules that bite

Each of these draws a picture that looks like a bug in your option and is not.

**Colours must be hex or `rgb()`/`rgba()`.** A named CSS colour — `"red"` — and
`hsl()` are not parsed, and what cannot be parsed is not drawn: the marks
_vanish_, the chart lays out perfectly, and `marks: 0` is the only sign. Use
`#cc0000`. A gradient is accepted and flattened to its first stop, so write the
stop you want as the first one.

**A rotated label is not drawn.** `axisLabel: {rotate: 45}` silently drops every
category label — a rotated glyph run cannot be placed truthfully by this
renderer, so it is left out rather than put in the wrong place. For long category
names use a **horizontal bar chart** (`yAxis: {type: "category"}`), or
`axisLabel: {width: 60, overflow: "truncate"}`. `interval: 0` forces every label
to be shown when `hideOverlap` has thinned them.

**`symbol: "none"` on a line makes it unpickable.** The polyline is one shape
with no per-point element, so there is no mark to hover or drill into. It is the
right choice for a dense series where nobody will point at a single point, and
the wrong one everywhere else.

**`large: true` makes a series unpickable** and does not make it cheaper here —
it draws _more_ geometry, not less. It is an optimisation for a canvas renderer
this is not. Leave it off.

**A dashed line comes out solid.** Dashes are applied when painting, and nothing
here paints. Distinguish series by colour or by width.

**`grid: {containLabel: true}`** or the axis labels fall outside the box.
`drawn.clipped` names them when they do. A `markLine`'s own label spills to the
right by default: give it `label: {position: "insideEndTop"}` or leave room.

**An option ECharts refuses throws**, and the chart does not draw at all —
`drawn` stays `null`. A heatmap with no `visualMap` is the usual way to meet
this. That is a different failure from a channel naming a column that does not
exist, which draws an empty series and reports itself.

## Composing something worth looking at

**Add to an assembled chart rather than rewriting it.** A bar chart with a base
rate on it is one `extra`, no axes required:

```jsonc
{
  "series": [
    {
      "markLine": {
        "data": [{ "yAxis": { "$param": "avg" } }],
        "lineStyle": { "color": "#cc0000" },
      },
    },
  ],
}
```

**Dataset transforms work, and chain.** `sort`, `filter`, `boxplot` and the rest
run over a data set Panorama supplied — so "the top ten by value" is ECharts'
work rather than another query. On an **assembled** chart the element-wise merge
keeps `primary` for you:

```jsonc
{
  "dataset": [
    {},
    {
      "id": "top",
      "fromDatasetId": "primary",
      "transform": { "type": "sort", "config": { "dimension": "VAL", "order": "desc" } },
    },
  ],
  "series": [{}, { "type": "line", "datasetId": "top", "encode": { "x": "CAT", "y": "VAL" } }],
}
```

On a **custom** chart a written `dataset` replaces Panorama's, so
`fromDatasetId: "primary"` finds nothing and the layout throws. Re-declare it
with `$rows` and the chain works:

```jsonc
{
  "dataset": [
    { "id": "src", "source": { "$rows": "primary" } },
    {
      "id": "top",
      "fromDatasetId": "src",
      "transform": { "type": "filter", "config": { "dimension": "VAL", "gt": 200000 } },
    },
  ],
  "series": [{ "type": "bar", "datasetId": "top", "encode": { "x": "CAT", "y": "VAL" } }],
}
```

**Several pictures in one box.** Two `grid`s with their own axes, addressed by
`gridIndex`/`xAxisIndex`/`yAxisIndex`, is a panel — a series above its
distribution, an actual above its residual. Two `yAxis` entries and
`yAxisIndex: 1` is a second scale for a rate beside a count.

**`visualMap` colours by a dimension**, continuous or `piecewise`, and reads a
real column name (`dimension: "PCT"`) rather than an index. It is what makes a
heatmap legible and what turns a bar chart into a chart that flags its own
outliers.

**A window is a range selector, not a rolling one.** For a moving average use
`resample` with `rolling: N`, which arrives as `<column>_meanN` beside the
figures — the line and its trend from one data set. Move a position window with
`chart(tableId, pan: {frame, pages})`: one commit, and the picture you had stays
on screen until the next arrives.

**Static zoom is available, interactive zoom is not.** `dataZoom: [{"type":
"inside", "start": 0, "end": 50}]` genuinely restricts what is drawn and is a
reasonable way to say "the first half". `{"type": "slider"}` draws a slider
nobody can drag — several hundred polygons of furniture for nothing.

## Size and speed

The limit is the layout, not the database. Every row of an unreduced data set
becomes elements that are walked in JavaScript to read their geometry back, so a
`rows` data set carries 5,000 by default and 20,000 at most.

Laying out and walking a scatter, in a box about 460 × 300: 500 points ≈ 25 ms,
5,000 ≈ 60 ms, 20,000 ≈ 160 ms. That is per change, not per frame, so 20,000 is
usable and a million is not the question — 20,000 dots in 460 pixels is a
silhouette either way. Prefer a `resample` data set for a long series and a
`group` for a wide one: reducing where the rows are always beats drawing more
marks than the box has pixels.

A small box needs less furniture, not smaller furniture. Below roughly 200 × 140
the axes eat the picture; `xAxis: {show: false}`, `yAxis: {show: false}` and a
grid with 2px margins is a sparkline, and it still picks.

## Read the feedback before believing the picture

You cannot see it, so it is measured. After every `chart` call, read `drawn`:

1. **`unresolved`** first, always. A channel naming a column its data set has not
   got, a data set asked for a column the rows have not got, or a `$param` or
   `$rows` nothing answered to. Each is named with the path it was found at. A
   series with no marks and an unresolved channel is the failure that otherwise
   looks exactly like success.
2. **`series[].marks`** — how many marks each series actually drew. Zero with
   nothing unresolved usually means a colour that did not parse, `large: true`,
   or `symbol: "none"`.
3. **`clipped`** — labels that ended up outside the box, by name.
4. **`pickable: false`** — it drew and none of it can be pointed at.
5. **`datasets`** — what each data set was, with its dimensions, so an `encode`
   can be checked against the names that actually arrived.

`chart.offered` is the reduction a written option was _handed_; it is not a claim
that the option used any of it. What it used is `drawn.series`.

The status may still be `loading` immediately after a call — the rows are read
and the picture drawn over the frames that follow. Ask again.

## Habits that pay

1. Say the picture in one sentence first. If it needs two, it is two charts, and
   two boxes side by side beat one box with two things in it.
2. Reach for an assembled chart plus `extra` before a custom one. Axes, grid,
   legend and palette come out consistent with every other chart on the canvas,
   and consistency is most of what makes a canvas readable.
3. Name every data set for what it holds, and give the ones a person will click
   a `key`.
4. Compute on the shortest route to the database, then chart the result. A chart
   is a picture of a question already answered, not a way of asking it.
5. `label` the box. "custom: sankey" is what the title bar says otherwise.
6. Read `unresolved` before reporting that the chart is done.
