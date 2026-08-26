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
const CHART_SPEC_SCHEMA: Record<string, unknown> = {
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
      describe: 'The connector: {id, kind, fromId, toId, from, to, directed}',
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
      'The database, through this canvas session. Called with no schema it lists the schemas; with one it lists that schema\'s tables and views, with the row counts and comments the catalogue holds.\n\nIf a Model Context Protocol server that speaks to Exasol natively is available to you, explore the catalogue with that instead: it reaches the engine directly, it is faster, and it is where a semantic layer would be. Check first that it is the same database — compare it against "overview"\'s "database", which reports the URL this session connected to and the name and version the server gave at login. This tool is here for when it is the only way in, and for confirming that what you are about to put on the canvas is what the canvas can see.',
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
      'Writes and runs a statement on a query box, and answers with the shape of the result and the first few rows.\n\nRead from whatever the box\'s "readsFrom" says: a box built on a stored relation reads that relation by name, and only a box built on another query or chart reads "derived_table" — which stands for that box and is composed into one statement when the query runs. Writing "derived_table" where the relation has a name works, but says less.\n\nA box holds one statement, so running another replaces it — the old one is still in the history, but the box is showing the new one. Pass newBox to run this as a *sibling* instead: a fresh box beside the same parent, leaving this one as it was, which is what to do when a result is worth keeping. Pass label to name whichever box it ends up in.',
    args: {
      ...TABLE_ID,
      sql: { kind: 'string', describe: 'The statement to run' },
      preview: {
        kind: 'integer',
        describe: `Rows to return with the result, up to ${MAX_ROWS}. Five by default; 0 for none.`,
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
      'Sets up a chart and shows it. type: bar, line, area, scatter, pie — or custom. category is the column to group by; values are the columns to measure; aggregate is sum, average, min, max or count. breakdown groups by a second column instead of by several measures — claim type by decile — which is the only way to get a cross-tabulation, and reaches a custom chart as [category, breakdown, value] triples for a heatmap. Optional: sort, orientation, curve, scale, legend, stacked, showPoints, showValues, showGrid, hole, rowLimit, categoryLimit, and extra for raw ECharts options as JSON, merged over the settings above.\n\ntype "custom" is the whole of ECharts: extra becomes the entire option rather than an addition to one, so any series type the library draws — radar, sankey, heatmap, treemap, graph, gauge, boxplot, candlestick and the rest — is available, configured however it likes. The reduced rows arrive as dataset.source with a header row of [category, ...values], so a series can read them through encode or dimensions, or ignore them and carry its own data. Nothing of Panorama\'s is merged on top except a transparent background, the canvas palette and font, and three settings that cannot be honoured: animation and tooltips are off (the geometry is read back once per change, and a tooltip is a DOM overlay this seam has no room for) and the font family is the canvas\'s (there is one glyph atlas). Hover and selection need a series index to attach a mark to, so an exotic series may draw beautifully and pick nothing.\n\nThe picture is reduced and drawn over the frames that follow, so the status here may still be "loading". The answer also says what the canvas made of it — the rectangle it was laid out for, how many shapes and labels it drew, what it covers, and any label that ended up outside the box — which is the only way to iterate on a layout from here. Ask "chart" or "entity" again to see it settle.',
    args: {
      ...TABLE_ID,
      spec: { kind: 'object', describe: 'The chart specification', schema: CHART_SPEC_SCHEMA },
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
