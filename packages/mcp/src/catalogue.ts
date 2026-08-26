import type { ArgsSpec } from './schema.js';
import { AgentError, jsonSchema } from './schema.js';

/**
 * What an agent can ask for: the names, the arguments and the words.
 *
 * Separated from the doing of it because the two halves run in different
 * processes. The development server offers this list to the agent, and it must
 * be able to do that before — and whether or not — a page is attached, so
 * nothing here may reach for the application, or for anything that would drag
 * the application in behind it. That is why this file imports no workspace
 * package: it is loaded by the server\'s own configuration, where a `.ts` import
 * from another package cannot be followed.
 *
 * `operations.ts` holds a handler per name, and a test insists the two lists
 * name exactly the same tools. That test is the seam: without it a tool could
 * exist and do nothing, and the disagreement would only ever show up as a
 * puzzled agent.
 */

export interface AgentToolSpec {
  readonly name: string;
  /** Told to the agent, and the only documentation it gets. */
  readonly describe: string;
  readonly args: ArgsSpec;
  /** True for anything that changes the document, the history or the session. */
  readonly writes?: true;
  /**
   * True where the server answers it and the page never sees it.
   *
   * One tool is like this: the skill, which is a file beside the server rather
   * than anything in the document. It is also the one tool worth having before a
   * page is open at all, which is the other reason it is not forwarded.
   */
  readonly answeredByServer?: true;
}

/** Rows read in one go, so a table cannot be asked for a million cells. */
export const MAX_ROWS = 200;

/**
 * Columns named in one answer.
 *
 * A five-thousand-column table exists — there is one in the sample data — and a
 * list of five thousand names is not a description of it. `verbose` lists them
 * all for whoever genuinely needs that.
 */
export const MAX_COLUMNS = 60;

/** Actions in the halo\'s vocabulary, so an agent presses what a person presses. */
const NO_ARGS: ArgsSpec = {};

const TABLE_ID: ArgsSpec = {
  tableId: { kind: 'string', describe: 'Entity id of the table, from "entities"' },
};

/**
 * The way to ask for everything.
 *
 * Off by default because an answer is read by something with a finite amount of
 * room to think in: column ids, pixel widths, scroll offsets and the composed
 * form of a whole chain are worth having exactly when somebody asks for them.
 */
const VERBOSE: ArgsSpec = {
  verbose: {
    kind: 'boolean',
    describe:
      'Everything: column ids and widths, connectors, scroll position, and the composed statement a query would send. Off by default.',
    optional: true,
  },
};

/** The chart types, named here so the schema can list them without importing. */
const CHART_TYPE_NAMES: readonly string[] = ['bar', 'line', 'area', 'scatter', 'pie', 'custom'];

/** The chart specification, described where an agent will read it. */
/**
 * The chart specification, as JSON Schema.
 *
 * Exported because `readChartSpec` reads its property names to decide what a
 * specification may contain: the schema an agent is given and the check it is
 * judged by are then one list, and a field cannot be documented without being
 * accepted or accepted without being documented.
 */
export const CHART_SPEC_SCHEMA: Record<string, unknown> = {
  type: 'object',
  description: 'The chart specification.',
  properties: {
    type: { type: 'string', enum: [...CHART_TYPE_NAMES] },
    category: { type: 'string', description: 'Column to group by. Optional for a custom chart.' },
    breakdown: {
      type: 'string',
      description:
        'A second column to group by, which makes the series its distinct values rather than the measured columns — a cross-tabulation. Measures one column at a time. A custom chart gets the same numbers as [category, breakdown, value] triples, which is what a heatmap reads.',
    },
    values: {
      type: 'array',
      items: { type: 'string' },
      description: 'Columns to measure. Empty when the aggregate is count.',
    },
    aggregate: { type: 'string', enum: ['sum', 'average', 'count', 'min', 'max'] },
    sort: { type: 'string', enum: ['size', 'name', 'natural'] },
    orientation: { type: 'string', enum: ['vertical', 'horizontal'] },
    curve: { type: 'string', enum: ['straight', 'smooth', 'stepped'] },
    scale: { type: 'string', enum: ['linear', 'log'] },
    legend: { type: 'string', enum: ['auto', 'always', 'never'] },
    stacked: { type: 'boolean' },
    showPoints: { type: 'boolean' },
    showValues: { type: 'boolean' },
    showGrid: { type: 'boolean' },
    hole: { type: 'boolean' },
    rowLimit: { type: 'integer' },
    categoryLimit: { type: 'integer' },
    extra: {
      type: 'string',
      description:
        'An ECharts option as a JSON *string*, not an object. Merged over the settings above, or the whole chart when type is custom.',
    },
    precision: {
      type: 'integer',
      description:
        'Decimal places the measured figures are read to — two for money, whatever the addition came out as. Left out, figures carry twelve significant digits: enough for anything this could have measured, and short of the noise binary addition leaves behind, which is what put 3483.7700000000004 on a label.',
    },
    frames: {
      type: 'array',
      description:
        'Data sets of your own, beyond the reduction every chart is given as "primary". Each is read by name from the option in extra: as dataset.source through datasetId, or — for a scalar — as {"$param": "name"} anywhere a number belongs. All of them read the rows of the box this chart was opened on. This is how a heatmap, a matrix, a scatter sized by a fourth column or a reference line at a computed base rate becomes a chart that stays true when the query changes, rather than an array typed into extra.',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'What the option refers to it by; not "primary"' },
          from: {
            type: 'string',
            description:
              "The box whose rows it reads, when that is not the box this chart was opened on. Give it and the arrow is drawn for you — a data binding labelled with this name, which is what makes a panel of several aggregations, a graph of nodes and edges, or a tree of parents possible in one chart. Left out, it reads the chart's own box.",
          },
          kind: {
            type: 'string',
            enum: ['group', 'rows', 'scalar'],
            description:
              "group: one row per category, as the chart's own reduction is — its own question entirely, so it does not take the chart's breakdown unless it names one. rows: the rows as they are, projected to the columns named — the shape a heatmap, a scatter with a size channel, a graph's edges or a tree's parents needs. scalar: one number, for a threshold or a reference line.",
          },
          columns: {
            type: 'array',
            items: { type: 'string' },
            description: 'kind rows: the columns to read, in the order wanted.',
          },
          key: {
            type: 'string',
            description:
              'kind rows: which of those columns says what a drawn mark stands for. Give it and picking a mark out means something — the rows behind it can be opened, and "session" reports the value each picked mark carries. Left out, a mark can be hovered and picked and traced back to nothing. One column, because a row filter is one predicate: a matrix cell drills down on the axis named here.',
          },
          category: { type: 'string', description: 'kind group: the column to group by.' },
          breakdown: { type: 'string', description: 'kind group: a second column to group by.' },
          values: {
            type: 'array',
            items: { type: 'string' },
            description: 'kind group: the columns to measure.',
          },
          column: { type: 'string', description: 'kind scalar: the column to reduce.' },
          aggregate: { type: 'string', enum: ['sum', 'average', 'count', 'min', 'max'] },
          sort: { type: 'string', enum: ['size', 'name', 'natural'] },
          categoryLimit: { type: 'integer' },
          rowLimit: {
            type: 'integer',
            description:
              'kind rows: rows carried, 5000 by default and 20000 at most. The limit is the layout, not the database: every row becomes elements to lay out and walk.',
          },
          precision: {
            type: 'integer',
            description: 'kind group: decimal places its figures are read to; see spec.precision.',
          },
          x: {
            type: 'string',
            description: 'kind resample: the column along the axis, usually a time.',
          },
          method: {
            type: 'string',
            enum: ['extremes', 'mean', 'lttb'],
            description:
              'kind resample: extremes keeps the highest and lowest of each bucket, which is the honest default for a series — a mean hides the spike that was the reason to look. mean is for a trend; lttb keeps the points that make the shape.',
          },
          points: {
            type: 'integer',
            description:
              "kind resample: points to carry, 600 by default and 4000 at most. A box's width in pixels is a good number: more points than pixels is waste that the layout pays for.",
          },
          window: {
            type: 'object',
            description:
              'Which part of the relation this data set reads — kind rows or resample. {by: "position", from, count} is a row offset and a count, right when the relation is already in the order the axis is in (say ORDER BY in the statement behind it). {by: "value", column, from, to} is a range along a column, which is what survives a change of scope: position four billion means nothing after a filter, and a range of dates means the same thing. A range read stops as soon as the column passes the upper bound, so on an ordered relation it reads the range rather than scanning everything; on an unordered one it is a bounded scan and the answer says it sampled. Left out, the data set reads the beginning.',
            properties: {
              by: { type: 'string', enum: ['position', 'value'] },
              from: { type: 'string' },
              to: { type: 'string' },
              count: { type: 'integer' },
              column: { type: 'string' },
            },
            required: ['by'],
          },
        },
        required: ['name', 'kind'],
        additionalProperties: false,
      },
    },
  },
  required: ['type'],
  additionalProperties: false,
};

export const AGENT_ACTIONS: readonly string[] = [
  'close',
  'edit',
  'sql',
  'chart',
  'rows',
  'export-csv',
  'export-xlsx',
  'export-parquet',
  'export-svg',
  'export-png',
  'export-pdf',
];

export const COMMAND_FIELDS: Readonly<Record<string, ArgsSpec>> = {
  MoveEntities: {
    ids: { kind: 'string-array', describe: 'Entities to move' },
    position: { kind: 'vec3', describe: 'Absolute world position of the first entity' },
  },
  ResizeEntity: {
    id: { kind: 'string', describe: 'Entity to resize' },
    width: { kind: 'number', describe: 'New width in world units' },
    height: { kind: 'number', describe: 'New height in world units' },
    position: {
      kind: 'vec3',
      describe: 'New position, when resizing from a top or left edge',
      optional: true,
    },
  },
  ResizeColumn: {
    tableId: { kind: 'string', describe: 'Table the column belongs to' },
    columnId: { kind: 'string', describe: 'Column view id, from "entity"' },
    width: { kind: 'number', describe: 'New column width' },
  },
  ReorderColumns: {
    tableId: { kind: 'string', describe: 'Table to reorder' },
    columnIds: {
      kind: 'string-array',
      describe: 'Every column view id, in the order wanted',
    },
  },
  SetColumnVisibility: {
    tableId: { kind: 'string', describe: 'Table the column belongs to' },
    columnId: { kind: 'string', describe: 'Column view id' },
    visible: { kind: 'boolean', describe: 'Whether the column is shown' },
  },
  SetTableQuery: {
    tableId: { kind: 'string', describe: 'Query table to rewrite' },
    sql: {
      kind: 'string',
      describe:
        'The statement. Read the box\'s "readsFrom" — a relation\'s own name where it has one, and "derived_table" only where this box was built on another query or chart.',
    },
  },
  SetChartSpec: {
    tableId: { kind: 'string', describe: 'Chart to set up' },
    spec: {
      kind: 'object',
      describe: 'Chart specification; see the "chart" tool',
      schema: CHART_SPEC_SCHEMA,
    },
  },
  SetTableLabel: {
    tableId: { kind: 'string', describe: 'Box to rename; not a stored relation' },
    label: { kind: 'string', describe: 'What the box should be called' },
  },
  SetTableMode: {
    tableId: { kind: 'string', describe: 'Table to switch' },
    mode: { kind: 'string', describe: 'Which face to show', enum: ['result', 'editing'] },
  },
  RemoveEntities: {
    ids: { kind: 'string-array', describe: 'Entities to remove' },
  },
  CreateBinding: {
    binding: {
      kind: 'object',
      describe:
        'The connector: {id, fromId, toId}. Optionally directed, label, and from/to as {mode: "fixed", x, y} where an end should stay put; left out, each end slides around its box to face the other.',
    },
  },
  SetBindingLabel: {
    bindingId: { kind: 'string', describe: 'Binding to retitle' },
    label: { kind: 'string', describe: 'What the line should say' },
  },
  RemoveBindings: {
    ids: { kind: 'string-array', describe: 'Bindings to remove' },
  },
};

/** Commands that exist but cannot be sent, and what to use instead. */
export const COMMAND_INSTEAD: Readonly<Record<string, string>> = {
  CreateTableEntity: 'open_table, or the "sql", "chart" and "rows" actions',
  SetTableColumns: "query, which sets a table's columns from what the statement returned",
  SetTableSource: 'the "rows" action, which is the one thing that retargets a table',
};

export const COMMAND_TYPES: readonly string[] = Object.keys(COMMAND_FIELDS);

/** The command vocabulary, spelled out for whoever is choosing between them. */
export const describeCommands = (): string =>
  Object.entries(COMMAND_FIELDS)
    .map(([type, spec]) => {
      const args = Object.entries(spec)
        .map(([name, field]) => `${name}${field.optional === true ? '?' : ''}`)
        .join(', ');
      return `${type}(${args})`;
    })
    .join('\n');

/**
 * Every tool, in the order they are worth reading in: what the application is,
 * then what is in it, then how to change it.
 */
export const AGENT_TOOLS: readonly AgentToolSpec[] = [
  {
    /**
     * First, and a tool rather than a prompt or a resource.
     *
     * The page it returns was offered as both of those, which is what the
     * protocol has for exactly this — and an agent whose client shows it only
     * tools could not see it at all. A door nobody can open is not a door, so the
     * page is a tool as well: the same text, reachable by the one mechanism every
     * client surfaces.
     */
    name: 'skill',
    describe:
      'Read this first. The whole interface on one page: the boxes on the canvas, the command and history model, charts and their named data sets, what a picked mark means, cross-filtering, and which feedback to read before believing a picture. Answered by the server, so it works before anything is open — and it is the same text as the prompt "panorama" and the resource "panorama://skill", for a client that shows those.',
    args: NO_ARGS,
    answeredByServer: true,
  },
  {
    name: 'overview',
    describe:
      'The state of the whole application in one answer: what is open, what is being edited, where the history stands, what is selected, and the frame and cache figures. Start here.',
    args: NO_ARGS,
  },
  {
    name: 'entities',
    describe:
      'Every box on the canvas: what it reads, where it is, how big it is, how many rows it has and what it was derived from.',
    args: NO_ARGS,
  },
  {
    name: 'entity',
    describe: `One box: what it reads, how many rows it has, and its columns with their types — the first ${MAX_COLUMNS} of them, with a count when there are more. A query box also says what to write after FROM. Pass verbose for every column with its id and width, the connectors, the scroll position and the composed statement.`,
    args: { ...TABLE_ID, ...VERBOSE },
  },
  {
    name: 'rows',
    describe: `Cells from a table, as it has them. Only rows that have been fetched are returned; a table is a window onto a result set, and what is outside the window has not arrived rather than being empty. At most ${MAX_ROWS} rows in one answer.`,
    args: {
      ...TABLE_ID,
      from: { kind: 'integer', describe: 'First row, counting from 0', optional: true },
      limit: { kind: 'integer', describe: `How many rows, up to ${MAX_ROWS}`, optional: true },
    },
  },
  {
    name: 'history',
    describe:
      'The commit graph. Panorama has no undo stack: undo moves a head around an immutable graph and committing from an inner commit branches rather than discarding anything. Every commit is listed with its parent, its children and what it did, and the path to the head is marked.',
    args: NO_ARGS,
  },
  {
    name: 'session',
    describe:
      'What is selected, activated, dragged and pointed at. Session state is never in history — selecting something is not an edit.',
    args: NO_ARGS,
  },
  {
    name: 'catalogue',
    describe:
      'The database, through this canvas session. Called with no schema it lists the schemas; with one it lists that schema\'s tables and views, with the row counts and comments the catalogue holds.\n\nExplore the catalogue on the shortest route you have. If "overview"\'s "database" names localhost or 127.0.0.1 the engine is on this machine — an Exasol Personal instance — and the local `exasol` command-line tool is the fastest way to read it, by a distance. Failing that, a Model Context Protocol server that speaks to Exasol natively reaches the engine directly and is where a semantic layer would be. Either way, check first that it is the same database — compare it against "overview"\'s "database", which reports the URL this session connected to and the name and version the server gave at login. This tool is here for when it is the only way in, and for confirming that what you are about to put on the canvas is what the canvas can see.',
    args: {
      schema: {
        kind: 'string',
        describe: 'Schema to list, or omit for all schemas',
        optional: true,
      },
    },
  },
  {
    name: 'label',
    describe:
      'Renames a box. A query or chart box is titled by what it was made from, which is right for the first one and useless for the seventh — a canvas where every box says "RAW.CLAIMS · SQL" is one you have to read the statements to navigate. A stored relation cannot be renamed: it has a name, and it is the relation\'s.',
    args: {
      ...TABLE_ID,
      label: { kind: 'string', describe: 'What the box should be called' },
    },
    writes: true,
  },
  {
    name: 'dispatch',
    describe: `Applies a document command — the one way persistent state ever changes, for a pointer, a keystroke and an agent alike. On success a commit is appended, so an agent's edits are in the same history as everyone else's and undo works on them. The commands:\n${describeCommands()}`,
    args: {
      command: { kind: 'object', describe: 'One command, as {type, ...fields}', optional: true },
      commands: {
        kind: 'object-array',
        describe:
          'Several commands, applied in order, each its own commit. Use this to move a dozen boxes in one call rather than a dozen.',
        optional: true,
      },
    },
    writes: true,
  },
  {
    name: 'session_dispatch',
    describe:
      'Changes session state: SetSelection(ids), SetHovered(id?), SetFocusedTable(id?), SetSelectedColumns(ids), SetSelectedMarks(targets), EndDrag(). Nothing here is recorded in history. Picking chart marks out is what fills a drill-down table.',
    args: {
      command: { kind: 'object', describe: 'The session command, as {type, ...fields}' },
    },
    writes: true,
  },
  {
    name: 'checkout',
    describe:
      'Moves the history head. "undo" and "redo" step to the parent or the newest child; a commit id goes straight there, which is how a branch is reached. Nothing is ever destroyed by moving.',
    args: {
      to: {
        kind: 'string',
        describe: 'A commit id, or "undo" or "redo"',
      },
    },
    writes: true,
  },
  {
    name: 'open_table',
    describe:
      'Opens a stored relation onto the canvas, placed in the nearest free space, with its columns and a live result set behind it. The way a table comes into being: an entity cannot be assembled by hand because its columns come from the database.',
    args: {
      schema: { kind: 'string', describe: 'Schema the relation is in' },
      table: { kind: 'string', describe: 'Relation name' },
    },
    writes: true,
  },
  {
    name: 'action',
    describe: `Performs one of the actions a box offers, in the same vocabulary as its halo: ${AGENT_ACTIONS.join(', ')}. "sql" derives a new query box from this one, "chart" opens a chart of it, "rows" opens the rows behind a chart's selection, "close" removes it, and the export actions write a file.`,
    args: {
      ...TABLE_ID,
      action: { kind: 'string', describe: 'Which action', enum: AGENT_ACTIONS },
    },
    writes: true,
  },
  {
    name: 'query',
    describe:
      'Writes and runs a statement on a query box, and answers with the shape of the result and the first few rows.\n\nA box is where a person reads a result, not where heavy work belongs: this runs through the browser and a cache sized for drawing. Compute on the shortest route you have — the local `exasol` CLI where the engine is on this machine, a native Exasol server otherwise — and put a statement here when its result is something somebody should see, be able to move, and derive from.\n\nRead from whatever the box\'s "readsFrom" says: a box built on a stored relation reads that relation by name, and only a box built on another query or chart reads "derived_table" — which stands for that box and is composed into one statement when the query runs. Writing "derived_table" where the relation has a name works, but says less.\n\nA box holds one statement, so running another replaces it — the old one is still in the history, but the box is showing the new one. Pass newBox to run this as a *sibling* instead: a fresh box beside the same parent, leaving this one as it was, which is what to do when a result is worth keeping. Pass label to name whichever box it ends up in.\n\nA statement may leave a predicate to a chart: write {{name}} where a condition belongs — WHERE {{picked}} — and pass filters [{name: "picked", from: chartId} ] to say which chart decides it. Whatever is picked out in that chart becomes the predicate, and picking something else re-runs this box and everything built on it: cross-filtering, with the arrow on the canvas showing what scopes what. Nothing picked is 1 = 1, so the box shows the data until somebody chooses. A {{name}} nothing answers for is left in the statement, which the database refuses — better than a query that quietly ran unfiltered.',
    args: {
      ...TABLE_ID,
      sql: { kind: 'string', describe: 'The statement to run' },
      preview: {
        kind: 'integer',
        describe: `Rows to return with the result, up to ${MAX_ROWS}. Five by default; 0 for none.`,
        optional: true,
      },
      filters: {
        kind: 'object-array',
        describe:
          'Which chart fills in each {{name}} in the statement, as [{name, from}]. The arrow is drawn for you, so it is on the canvas and in the history; cut it to stop the chart scoping this box.',
        optional: true,
      },
      newBox: {
        kind: 'boolean',
        describe:
          'Run in a new box beside the same parent rather than in this one, leaving this one alone.',
        optional: true,
      },
      label: {
        kind: 'string',
        describe: 'A name for the box, so it can be told apart',
        optional: true,
      },
      ...VERBOSE,
    },
    writes: true,
  },
  {
    name: 'chart',
    describe:
      'Sets up a chart and shows it. type: bar, line, area, scatter, pie — or custom. category is the column to group by; values are the columns to measure; aggregate is sum, average, min, max or count. breakdown groups by a second column instead of by several measures — claim type by decile — which is the only way to get a cross-tabulation, and reaches a custom chart as [category, breakdown, value] triples for a heatmap. Optional: sort, orientation, curve, scale, legend, stacked, showPoints, showValues, showGrid, hole, rowLimit, categoryLimit, and extra for raw ECharts options as JSON, merged over the settings above.\n\ntype "custom" is the whole of ECharts: extra becomes the entire option rather than an addition to one, so any series type the library draws — radar, sankey, heatmap, treemap, graph, gauge, boxplot, candlestick and the rest — is available, configured however it likes. The data arrives as ECharts data sets, each with its columns declared and an id to read it by. The reduction is always there as \"primary\" — [category, ...values], or [category, breakdown, value] triples where a breakdown makes it a cross-tabulation. Name your own in spec.frames for anything that shape cannot express: kind \"rows\" projects the rows as they are, which is what a heatmap, a scatter sized by a fourth column, a graph\'s edge list or a tree\'s parent list needs; kind \"group\" is another grouping of the same rows, for a marginal beside a matrix; kind \"scalar\" is one number, read as {\"$param\": \"name\"} anywhere in the option — a markLine at a computed base rate rather than at a literal that goes stale. Read one with datasetId and encode: frames [{name: \"m\", kind: \"rows\", columns: [\"BAND\", \"TYPE\", \"PCT\"]}] with extra {\"series\":[{\"type\":\"heatmap\",\"datasetId\":\"m\",\"encode\":{\"x\":\"BAND\",\"y\":\"TYPE\",\"value\":\"PCT\"}}]}. visualMap and symbolSize then read real dimensions, so nothing has to be typed into the option as an array. Every data set reads the rows of the box this chart was opened on unless its "from" names another.\n\nA series longer than the screen is two things: kind \"resample\", which reduces it to a few hundred points where the rows are, and a window, which says which part of the relation it reads. Move the window along with pan {frame, pages} — one commit, so it undoes — and the chart keeps the picture it had until the next window arrives. Nothing of Panorama\'s is merged on top except a transparent background, the canvas palette and font, and three settings that cannot be honoured: animation and tooltips are off (the geometry is read back once per change, and a tooltip is drawn by the canvas rather than by the library) and the font family is the canvas\'s (there is one glyph atlas). Hovering and picking work for any series the library links back to its rows, which is most of them: a mark is found in the geometry rather than per series type, and a data set with a key says what a picked mark stands for. The known exception is a calendar heatmap, whose cells are drawn by the calendar component and carry no row anywhere in the display list — a correct picture that is inert. \"drawn.pickable\" says which you have, so it is measurable rather than a caveat to remember.\n\nThe picture is reduced and drawn over the frames that follow, so the status here may still be "loading". The answer also says what the canvas made of it, in two halves. The *shape*: the rectangle it was laid out for, how many shapes and labels it drew, what it covers, and any label that ended up outside the box. And the *source*: which data sets it was given with their dimensions, what each series read and through which channels, how many marks each drew, and — first among them — "unresolved", where a channel naming a column its data set has not got is spelled out. A series with no marks and an unresolved channel is the failure that otherwise looks like success. Ask "chart" or "entity" again to see it settle.\n\nFor a written option, "chart.offered" is what the reduction produced and handed over as a data set; it is not a claim that the option used any of it. What it used is in "drawn.series".',
    args: {
      ...TABLE_ID,
      spec: {
        kind: 'object',
        describe: 'The chart specification. Omit only when panning a window.',
        schema: CHART_SPEC_SCHEMA,
        optional: true,
      },
      pan: {
        kind: 'object',
        describe:
          "Moves a data set's window along, as {frame, pages}: pages 1 is the next windowful, -1 the last. Only a position window moves this way — what comes after a range of values is a question about the data, so name the next range instead. A commit, so it undoes like anything else.",
        optional: true,
        schema: {
          type: 'object',
          properties: {
            frame: { type: 'string', description: 'The data set whose window moves' },
            pages: { type: 'number', description: 'Windows to move by; 1 is the next one' },
          },
          required: ['frame', 'pages'],
        },
      },
      label: { kind: 'string', describe: 'A name for the box', optional: true },
      ...VERBOSE,
    },
    writes: true,
  },
];

export const toolNamed = (name: string): AgentToolSpec => {
  const found = AGENT_TOOLS.find((tool) => tool.name === name);
  if (found === undefined) {
    throw new AgentError(
      `There is no tool called ${name}. There is: ${AGENT_TOOLS.map((tool) => tool.name).join(', ')}.`,
    );
  }
  return found;
};

/** The tool list an MCP client sees. */
export const toolDefinitions = (): readonly Record<string, unknown>[] =>
  AGENT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.describe,
    inputSchema: jsonSchema(tool.args),
    ...(tool.writes === true ? {} : { annotations: { readOnlyHint: true } }),
  }));
