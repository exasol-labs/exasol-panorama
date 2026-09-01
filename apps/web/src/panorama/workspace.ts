import type {
  EntityId,
  QueryStep,
  TableColumnSpec,
  TableColumnView,
  TableEntity,
} from '@panorama/core';
import type { Binding, BindingId } from '@panorama/core';
import type { ChartColumnHint, ChartSource, ChartSpec, ColumnDataType } from '@panorama/core';
import {
  AUTO_ANCHOR,
  DERIVED_TABLE,
  derivedFromOf,
  defaultChartSpec,
  describeChartSpec,
  isChartSpecDrawable,
  isChartTable,
  PanoramaCore,
  buildTableColumns,
  buildTableEntity,
  composeQuery,
  derivedTreeOf,
  findColumn,
  isQueryTable,
  isSelectionTable,
  isTableEntity,
  tableContentWidth,
  tableDisplayName,
} from '@panorama/core';
import type {
  ConnectionId,
  EntityActionId,
  Placement,
  PlacementAnchor,
  Rect,
  Size2,
} from '@panorama/core';
import {
  PRIMARY_FRAME,
  dataSourcesOf,
  filterSourcesOf,
  findFreePlacement,
  replacePlaceholders,
  rightEdgeAnchor,
  selectedMarksOf,
} from '@panorama/core';
import type { DocumentSurface } from '@panorama/mcp';
import type { CellValue, RowFilter, SchemaInfo, TableInfo, TableSchema } from '@panorama/table';
import {
  DEFAULT_BLOCK_SIZE,
  formatCell,
  jsonColumnSpecs,
  physicalColumnSpecs,
  withSemantics,
} from '@panorama/table';
import type {
  ChartMetrics,
  SummaryPanelView,
  TableViewModel,
  TableViewProvider,
} from '@panorama/renderer';
import type { ForeignKeyFollow, InteractionHost, TableViewState } from '@panorama/renderer';
import type {
  ExasolCredentials,
  SemanticIndex,
  WrapperSurface,
  WrapperView,
} from '@panorama/exasol';
import {
  filterPredicate,
  indexSemanticFields,
  qualifiedName,
  semanticColumnsFor,
  wrapperFor,
  wrapperKey,
} from '@panorama/exasol';
import type { ChartMark, ChartSurface, ChartTheme } from '@panorama/chart';
import type { ChartExportFormat, ChartFigure, FileFormatDescriptor } from '@panorama/export';
import {
  CHART_EXPORT_FORMATS,
  abandon,
  chartFigureToPdf,
  chartFigureToSvg,
  figureLayout,
} from '@panorama/export';
import { DEFAULT_CHART_THEME } from '@panorama/chart';
import { isNumericType } from '@panorama/table';
import type { ByteSink, ExportFormat } from '@panorama/export';
import { describeFormat, exportFileName } from '@panorama/export';
import type { ChartGeometry, ChartReport, ChartView } from './chart-pictures.js';
import { ChartPictures } from './chart-pictures.js';
import type { ColumnSummaryState } from './column-summaries.js';
import { ColumnSummaries } from './column-summaries.js';
import type { ExportJob } from './export-jobs.js';
import { ExportJobs } from './export-jobs.js';
import type { CompiledStatement, DataWorkerClient, TableOpenSpec } from '@panorama/worker';
import { TableView } from './table-view.js';
import { DEMO_SCHEMA } from './demo.js';

/**
 * The composition root on the render thread.
 *
 * Owns Panorama Core and one `TableView` per open table, and satisfies the
 * two interfaces the renderer and the interaction controller depend on. It is
 * the only place that knows both halves exist.
 */

export interface WorkspaceOptions {
  readonly client: DataWorkerClient;
  readonly core?: PanoramaCore;
  readonly connectionId?: ConnectionId;
  readonly blockSize?: number;
  readonly maxBytes?: number;
  readonly clock?: () => number;
  /**
   * How long `ensureRows` waits for a window of rows. Generous by default,
   * because the wait is for a database.
   */
  readonly rowWaitMs?: number;
  /** Called when cached data changed and a redraw is worthwhile. */
  readonly onDataChanged?: () => void;
  /**
   * Where a database socket should be opened, when that is not the database's own
   * URL — the desktop application's shell, which owns TLS so that a certificate
   * this machine does not know can be a question rather than a refusal.
   *
   * A function rather than a value because the answer arrives from the shell a
   * moment after the page loads, and asking for it at the moment of connecting is
   * simpler than a value that has to be set before anybody can type a URL.
   */
  readonly databaseSocket?: () => string | undefined;
  /**
   * Supplies a schema without asking the database. The built-in demo relations
   * use this, so following one of their foreign keys works with no connection.
   */
  readonly resolveSchema?: (schema: string, table: string) => TableSchema | undefined;
  /**
   * Lays charts out. Supplied rather than constructed, so the workspace depends
   * on the interface and never on whichever library is behind it.
   */
  readonly chartSurface?: ChartSurface;
  readonly chartTheme?: ChartTheme;
  /**
   * Turns an SVG into PNG bytes.
   *
   * Supplied by the shell because rasterising is the browser's job — it has the
   * fonts and the decoder — and the workspace should not know that a `<canvas>`
   * exists any more than it knows that a save dialog does.
   */
  readonly rasteriseSvg?: (
    svg: string,
    size: { readonly width: number; readonly height: number },
  ) => Promise<Uint8Array>;
  /**
   * Opens the file the export will be written to, or returns `null` when the
   * user dismissed the dialog.
   *
   * Supplied by the shell rather than done here: a save dialog is conventional
   * UI, it needs the click's own user activation, and which of the two ways to
   * offer a download a browser supports is a fact about the browser.
   */
  readonly openExportSink?: (request: ExportSinkRequest) => Promise<ByteSink | null>;
}

/** The result of opening a SQL editor: the new box and the line to it. */
export interface QueryTableOpened {
  readonly tableId: EntityId;
  readonly bindingId: BindingId;
}

/**
 * A file name for a chart, from what it is a chart of.
 *
 * Sanitised the same way a table's export name is: a name the operating system
 * will accept, and one the user recognises.
 */
const chartFileStem = (entity: TableEntity): string =>
  tableDisplayName(entity)
    .replace(/[^\w.-]+/gu, '_')
    .replace(/^_+|_+$/gu, '') || 'chart';

/**
 * A predicate as one comparable string.
 *
 * So that a frame in which the selection has not changed does not reopen a result
 * set. Order matters and is kept: the values arrive in the order they were picked
 * out, and re-filtering because two clicks happened in the other order would be
 * work for nothing.
 */
const filterKey = (filter: RowFilter): string =>
  `${filter.column}:${filter.values.map((value) => `${typeof value}\u0000${String(value)}`).join('\u0001')}`;

/** One column a chart may be set up against. */
export interface ChartColumnChoice extends ChartColumnHint {
  readonly type: string;
}

/**
 * What a column offers a chart: whether it can be measured, and whether it looks
 * like a measurement rather than an identifier.
 */
const chartColumnHint = (column: TableColumnView): ChartColumnHint => {
  const type = column.sourceColumn.type;
  const numeric = isNumericType(type);
  return {
    name: column.sourceColumn.name,
    numeric,
    // Decimal places, or a floating-point type: either says quantity rather
    // than key.
    ...(numeric && (type.kind === 'double' || (type.scale ?? 0) > 0) ? { measure: true } : {}),
  };
};

/**
 * A chart box is sized for a picture with its controls beside it: wide enough
 * that the preview beside the form is a chart rather than a sliver.
 */
const CHART_WIDTH = 620;
const CHART_HEIGHT = 360;

/** What the shell needs to open a save dialog. */
export interface ExportSinkRequest {
  readonly tableId: EntityId;
  readonly tableName: string;
  readonly fileName: string;
  /**
   * What the dialog should suggest. Narrowed to the parts a file dialog needs, so
   * that a table's formats and a chart's can both be offered through it without
   * the shell having to know which family it is looking at.
   */
  readonly format: FileFormatDescriptor;
}

/** A chart's whole export family, greyed out together. */
const CHART_EXPORT_ACTIONS_IDS: readonly EntityActionId[] = Object.freeze([
  'export',
  'export-svg',
  'export-png',
  'export-pdf',
]);

/** Which picture format each of a chart's format buttons asks for. */
const CHART_FORMAT_BY_ACTION: Partial<Record<EntityActionId, ChartExportFormat>> = Object.freeze({
  'export-svg': 'svg',
  'export-png': 'png',
  'export-pdf': 'pdf',
});

const NO_ACTIONS: readonly EntityActionId[] = Object.freeze([]);

/**
 * The whole export family, greyed out together.
 *
 * A table with no rows behind it cannot write a file in any format, so the
 * disclosure goes inert along with the three formats it would have revealed —
 * rather than opening onto three dead buttons.
 */
const EXPORT_ACTIONS: readonly EntityActionId[] = Object.freeze([
  'export',
  'export-csv',
  'export-xlsx',
  'export-parquet',
]);

/** The format each halo button asks for. */
const FORMAT_BY_ACTION: Readonly<Partial<Record<EntityActionId, ExportFormat>>> = Object.freeze({
  'export-csv': 'csv',
  'export-xlsx': 'xlsx',
  'export-parquet': 'parquet',
});

/** Comfortable for a few lines of SQL; the result may be wider. */
const EDITOR_WIDTH = 520;
const EDITOR_HEIGHT = 260;
const MAX_QUERY_WIDTH = 1_200;
/** A query's width is unknown when its blocks are sized, so assume a wide one. */
const QUERY_BLOCK_COLUMNS = 12;
/** Stands in for a schema name in a query result's label. */
const QUERY_SCHEMA_LABEL = 'QUERY';

/** Longest statement a connector will spell out before trailing off. */
const SQL_SUMMARY_LENGTH = 90;

/**
 * A statement as one line, for a connector's label. SQL is written across
 * several lines; a label is a single run of text.
 */
const summariseSql = (sql: string): string => {
  const flat = sql.replace(/\s+/gu, ' ').trim();
  return flat.length <= SQL_SUMMARY_LENGTH ? flat : `${flat.slice(0, SQL_SUMMARY_LENGTH - 1)}…`;
};

/**
 * True when there is an engine behind this table to send SQL to.
 *
 * A chart runs no SQL of its own — it reads rows through whatever it was opened
 * on — so a chart of a sample table is fine where a query on one is not.
 */
const canRunSql = (entity: TableEntity): boolean =>
  entity.source.kind !== 'relation' || entity.source.schema !== DEMO_SCHEMA;

/**
 * The statement a fresh editor starts with: the whole of its input, ready to
 * have a `WHERE` added.
 *
 * A stored relation is named outright, because it has a name and seeing it is
 * useful. A query box has no name to show, so it is referred to as
 * `derived_table` — one short line rather than the whole of the statement it
 * runs, which by the third level of refinement is a wall of parentheses with the
 * user's own clause lost somewhere inside it. The levels are put back together
 * when the query runs.
 */
const defaultQueryFor = (base: TableEntity, wrapper?: WrapperView): string =>
  base.source.kind === 'relation'
    ? `SELECT *\nFROM ${qualifiedName(...surfaceFor(base.source, wrapper))}`
    : `SELECT *\nFROM ${DERIVED_TABLE}`;

/**
 * Which surface a statement on a relation should read: the document, or the
 * columns storing it.
 *
 * A JSON table family loaded with a wrapper package publishes a *view* of each
 * document root whose columns are the properties — the same ones the box beside
 * the editor is already showing. Writing against the source table instead means a
 * statement whose columns are `location|object` and `faults|array`, which is the
 * opposite of what is on screen, and it gives up the dotted paths and array
 * selectors that are the whole point of the wrapper.
 *
 * So where there is a wrapper, that is the surface. Where there is not — an
 * ordinary table, or a *child* of a family, which the package does not publish a
 * view for — it is the relation itself, which is what the box is showing either
 * way.
 */
const surfaceFor = (
  source: { readonly schema: string; readonly table: string },
  wrapper: WrapperView | undefined,
): readonly [string, string] =>
  wrapper === undefined ? [source.schema, source.table] : [wrapper.schema, wrapper.view];

export interface OpenTableRequest {
  readonly schema: string;
  readonly table: string;
  readonly position?: { x: number; y: number };
  /** Supplied when the caller already knows the schema, skipping a round trip. */
  readonly knownSchema?: TableSchema;
  /** Restricts the result set; set when following a foreign key. */
  readonly filter?: RowFilter;
  /**
   * The edge the table should end up beside, when it belongs next to something.
   * Ignored if `position` is given, and defaulting to the corner of the view —
   * where the explorer is — when neither is.
   */
  readonly anchor?: PlacementAnchor;
}

/** The result of following a foreign key: the new table and the line to it. */
export interface FollowedForeignKey {
  readonly tableId: EntityId;
  readonly bindingId: BindingId;
}

const TABLE_GRID_STEP = 48;

/**
 * A stand-in viewport for when there is no camera to ask — headless, or before
 * the first frame — but an anchor still says where "beside" is.
 *
 * Generous enough that the spots near the anchor all count as being inside it,
 * so the search is decided by distance from the edge rather than by a view that
 * does not exist.
 */
const neighbourhoodOf = (source: Rect, size: Size2, anchor?: PlacementAnchor): Rect => {
  const left = anchor?.x ?? source.x;
  return {
    x: left - LINKED_TABLE_GAP,
    y: Math.min(source.y, anchor?.top ?? source.y) - size.height,
    width: LINKED_TABLE_GAP + size.width * 3,
    height: Math.max(source.height, size.height) * 3,
  };
};

/**
 * Gap between a table and the one opened by following a key from it. Wide
 * enough that the connector — and its label — are legible between them.
 */
/**
 * The connection id before there is a connection, and after there is not.
 *
 * A real one is a number the database gave us; this stands for "nobody", and is
 * the answer to whether there is a database behind these tables.
 */
const PENDING_CONNECTION = 'connection:pending' as ConnectionId;

/**
 * How long to wait for a window of rows, and how often to look.
 *
 * Generous, because the wait is for a database: an agent asking for a preview of
 * a statement it just ran would rather wait a second than be told the rows are
 * not there yet.
 */
const ROW_WAIT_MS = 8_000;
const ROW_POLL_MS = 25;

const LINKED_TABLE_GAP = 220;

/** A followed table is sized to its rows, within these bounds. */
const MIN_LINKED_ROWS = 3;
const MAX_LINKED_ROWS = 22;

/** Target cells per block, so a very wide table does not fetch huge blocks. */
const TARGET_CELLS_PER_BLOCK = 65_536;
const MIN_BLOCK_SIZE = 32;

/**
 * Rows per block for a given row width. A four-column table gets the default
 * 256; a five-thousand-column one gets 32, keeping a single block — which is
 * pinned while visible — to a predictable size.
 */
export const blockSizeForColumns = (columnCount: number, maximum: number): number => {
  if (columnCount <= 0) return maximum;
  const rows = Math.floor(TARGET_CELLS_PER_BLOCK / columnCount);
  return Math.max(MIN_BLOCK_SIZE, Math.min(maximum, rows));
};

export class Workspace implements TableViewProvider, InteractionHost {
  readonly core: PanoramaCore;
  readonly #client: DataWorkerClient;
  readonly #views = new Map<EntityId, TableView>();
  /**
   * A schema's tables, once asked for.
   *
   * Only ever populated for a schema holding a document family, and only to know
   * whether a nested property's child table is really there before offering to
   * open it. See `#siblingsOf`.
   */
  readonly #schemaTables = new Map<string, readonly TableInfo[]>();
  /**
   * The JSON wrapper packages on the connection, once they have been asked for.
   *
   * `null` until then, which is not the same as "none": a statement seeded before
   * the answer arrives would read the source table, so the surface is fetched as
   * part of connecting rather than lazily on the first `sql` press. It costs a
   * round trip per installed package and only connections that have one pay.
   */
  #wrappers: WrapperSurface | null = null;
  /**
   * What the semantic layer says the columns of each published object mean.
   *
   * `null` until it has been asked for. Read on connect so a box opened straight
   * afterwards is drawn with the names a model gave it, and read *again* on
   * demand if that ever fails or is skipped — the same rule the worker follows
   * for compiling, and for the same reason: a box that quietly loses its display
   * names because two pieces of code ran in the wrong order would be a hard thing
   * to notice and a harder one to explain.
   */
  #semantics: SemanticIndex | null = null;
  /** Exports in flight; they outlive the tables and panels that started them. */
  readonly #exports: ExportJobs;
  /**
   * Statements as they are being typed, by table.
   *
   * Session state, not document state: committing every keystroke would fill
   * history with one entry per character. A draft becomes a command when it is
   * run.
   */
  readonly #drafts = new Map<EntityId, string>();
  /** Exports, live and finished, newest last. */
  /** Exports the user stopped, so their failure reads as a cancellation. */
  /**
   * Column summaries, by column-view id.
   *
   * Cached because a summary costs a query and a selection is toggled freely:
   * clicking a column off and on again should not ask the database twice. Keyed
   * by the *column view*, so a table opened twice has a summary each — they are
   * showing different statements as far as anyone knows.
   */
  /** Statistics for the columns somebody has picked out. */
  readonly #summaries: ColumnSummaries;
  /** Chart specifications as they are being set up, by chart id. */
  readonly #chartDrafts = new Map<EntityId, ChartSpec>();
  /** The numbers each chart is drawing, or how far it has got towards them. */
  /** What each chart reduced to, drew, and has under the pointer. */
  readonly #pictures: ChartPictures;
  /** The database this session reached, as it described itself. */
  #reached: {
    readonly url: string;
    readonly database?: string;
    readonly version?: string;
    readonly sessionId?: number;
  } | null = null;
  /** The same geometry with the pointer and the selection applied to it. */
  /** The predicate each drill-down table is currently showing. */
  readonly #rowFilters = new Map<EntityId, string>();
  /** The filled-in statement each scoped query box last ran, to notice a change. */
  readonly #scopedBy = new Map<EntityId, string>();
  readonly #options: WorkspaceOptions;
  readonly #clock: () => number;
  #connectionId: ConnectionId;
  #opened = 0;
  /**
   * Where the camera is looking, in world units.
   *
   * Set once the renderer exists, which is after this is constructed — hence a
   * property rather than an option. A function rather than a value because the
   * answer changes with every pan and zoom, and placement wants the answer at
   * the moment a table is opened.
   */
  viewport: (() => Rect | null) | null = null;

  constructor(options: WorkspaceOptions) {
    this.#options = options;
    this.#client = options.client;
    this.core = options.core ?? new PanoramaCore();
    this.#clock = options.clock ?? ((): number => performance.now());
    this.#connectionId = options.connectionId ?? PENDING_CONNECTION;
    this.#exports = new ExportJobs(options.client);
    this.#pictures = new ChartPictures({
      reduce: (tableId, spec, sources) =>
        options.client.chartData(tableId, spec, Object.fromEntries(sources)),
      ...(options.chartSurface === undefined ? {} : { surface: options.chartSurface }),
      theme: () => this.chartTheme,
      session: () => this.core.session,
      // What makes an answer stale is the draft the form is holding, and the
      // drafts are this object's.
      stillWanted: (tableId, spec) => this.chartDraft(tableId) === spec,
      ...(options.onDataChanged === undefined ? {} : { onChange: options.onDataChanged }),
    });
    this.#summaries = new ColumnSummaries({
      summarise: (tableId, column) => options.client.summariseColumn(tableId, column),
      // A presented column reads its several physical columns by index; the
      // names live on the schema the result set was opened with.
      columnAt: (tableId, index) => this.#views.get(tableId)?.schema?.columns[index]?.name,
      ...(options.onDataChanged === undefined ? {} : { onChange: options.onDataChanged }),
    });
  }

  get connectionId(): ConnectionId {
    return this.#connectionId;
  }

  set connectionId(value: ConnectionId) {
    this.#connectionId = value;
  }

  get openTableCount(): number {
    return this.#views.size;
  }

  viewOfTable(tableId: EntityId): TableView | undefined {
    return this.#views.get(tableId);
  }

  /**
   * Opens the database connection. Credentials pass straight through to the
   * data worker and are never retained here.
   */
  async connect(request: {
    url: string;
    credentials: ExasolCredentials;
  }): Promise<{ connectionId: string }> {
    const result = await this.#client.connect(
      request.url,
      request.credentials,
      this.#options.databaseSocket?.(),
    );
    this.#connectionId = result.connectionId as ConnectionId;
    // Which database this is, kept so that anything else claiming to reach the
    // same one can be checked against it. The URL and the name the server gave;
    // never the credentials, which went to the worker and stop there.
    this.#reached = {
      url: request.url,
      ...(result.database === undefined ? {} : { database: result.database }),
      ...(result.version === undefined ? {} : { version: result.version }),
      ...(result.sessionId === undefined ? {} : { sessionId: result.sessionId }),
    };
    /**
     * The wrapper packages, before anything can be opened against them.
     *
     * Asked here rather than lazily because the answer decides what a statement
     * *says*: a box seeded before it arrived would read the source table and keep
     * that statement, and the reader would have no way to tell that from a table
     * with no wrapper. Costing a round trip per installed package at connect is
     * the price of the seeded statement being right the first time.
     *
     * A failure costs the wrapper surface and not the connection — a session that
     * cannot read the catalogue's script table can still browse tables.
     */
    this.#wrappers = new Map(
      // Keyed by the module that owns the format, so the two cannot drift.
      (await this.#client.wrapperSurface().catch(() => [])).map((view) => [
        wrapperKey(view.sourceSchema, view.rootTable),
        view,
      ]),
    );
    /**
     * And what the columns of those tables *mean*, on the same terms.
     *
     * Here rather than lazily for the same reason: a box opened before the answer
     * arrived would draw the database's column names and keep them, and nothing
     * would ever go back and say what they were. One failing lookup on a
     * connection with no semantic layer, which is nearly every connection.
     */
    this.#semantics = null;
    await this.#semanticIndex();
    return result;
  }

  /**
   * Which database is behind these tables.
   *
   * Not decoration: a session is one way to reach a database and rarely the
   * fastest, so anything else that reaches one — a driver, a native MCP server —
   * has to be able to establish that it is looking at the *same* database before
   * its answers can be trusted alongside these. A name and a version the server
   * itself reported are the evidence for that; a URL somebody typed is a hint.
   */
  reachedDatabase(): {
    readonly url: string;
    readonly database?: string;
    readonly version?: string;
    readonly sessionId?: number;
  } | null {
    return this.#connectionId === PENDING_CONNECTION ? null : this.#reached;
  }

  async disconnect(): Promise<void> {
    await this.#client.disconnect();
    this.#reached = null;
    // Catalogue state belonging to a session that is over. A reconnect is exactly
    // when a newly published model should be noticed.
    this.#semantics = null;
    // Given up with the connection: the id named a live session, and anything
    // asking whether there is one — the agent interface does — would otherwise
    // be told yes by a number that outlived what it referred to.
    this.#connectionId = PENDING_CONNECTION;
  }

  listSchemas(): Promise<readonly SchemaInfo[]> {
    return this.#client.listSchemas();
  }

  listTables(schema: string): Promise<readonly TableInfo[]> {
    return this.#client.listTables(schema);
  }

  /**
   * The columns a table is drawn with: its own, or the document they encode.
   *
   * Some databases store a nested document as a family of relational tables,
   * spreading one property across a value column per type it had and boolean
   * masks recording what SQL cannot say. Where the column names say that is what
   * this is, the properties are drawn rather than the storage — see
   * `@panorama/json-tables`.
   *
   * The shape test is pure and costs nothing, so it runs first and settles it for
   * every ordinary table without a round trip. Only a table that already looks
   * like a document pays for the catalogue lookup, and it pays for it because a
   * nested property's cell can only offer to open the child table once it knows
   * the child table is there.
   */
  async #columnsFor(schema: TableSchema): Promise<readonly TableColumnSpec[]> {
    if (jsonColumnSpecs(schema) === null)
      return await this.#described(schema, physicalColumnSpecs(schema));
    const siblings = await this.#siblingsOf(schema.schema);
    const comment = siblings.find((table) => table.name === schema.table)?.comment;
    return this.#described(
      schema,
      jsonColumnSpecs(schema, {
        siblings: siblings.map((table) => table.name),
        ...(comment === undefined ? {} : { comment }),
      }) ?? physicalColumnSpecs(schema),
    );
  }

  /**
   * The same columns, with what the semantic layer says they mean.
   *
   * Applied to whichever view was built rather than instead of one of them: the
   * meaning is drawn over the columns and does not decide what they are. Costs a
   * map lookup and returns what it was given on every table nothing describes.
   */
  async #described(
    schema: TableSchema,
    specs: readonly TableColumnSpec[],
  ): Promise<readonly TableColumnSpec[]> {
    const index = await this.#semanticIndex();
    return withSemantics(specs, semanticColumnsFor(index, schema.schema, schema.table));
  }

  /**
   * The semantic index, read once per connection.
   *
   * A connection with no semantic layer costs one failing lookup and remembers
   * that there was none — an empty index is a real answer here, not a missing
   * one, so it is cached like any other.
   */
  async #semanticIndex(): Promise<SemanticIndex> {
    this.#semantics ??= indexSemanticFields(await this.#client.semanticSurface().catch(() => null));
    return this.#semantics;
  }

  /**
   * The schema's tables, remembered for as long as the session lasts.
   *
   * A family opens several tables in a row — the root, then whatever a click
   * follows into — and asking the catalogue the same question each time would be
   * a round trip per click for an answer that does not change while somebody is
   * reading.
   */
  async #siblingsOf(schema: string): Promise<readonly TableInfo[]> {
    const remembered = this.#schemaTables.get(schema);
    if (remembered !== undefined) return remembered;
    // A catalogue that will not answer costs the links out of this table and
    // nothing else. Opening it is what was asked for; knowing which of its
    // properties lead somewhere is an enrichment, and failing the open for want
    // of one would be losing the table to save the arrows.
    const listed = await this.#client.listTables(schema).catch(() => []);
    this.#schemaTables.set(schema, listed);
    return listed;
  }

  /**
   * Opens a table: describe it, create the entity, then open the result set.
   * The entity appears immediately; rows arrive when they arrive.
   */
  async openTable(request: OpenTableRequest): Promise<EntityId> {
    // `describeTable` runs the same `SELECT *` projection the result set will,
    // so the entity's columns always line up with the fetched chunks.
    const schema =
      request.knownSchema ??
      this.#options.resolveSchema?.(request.schema, request.table) ??
      (await this.#client.describeTable(request.schema, request.table));
    const columns = await this.#columnsFor(schema);
    const sized = buildTableEntity(this.core.ids, {
      source: {
        kind: 'relation',
        connectionId: this.#connectionId,
        schema: request.schema,
        table: request.table,
        // Remembered on the source rather than inferred from the columns,
        // because the columns stop saying it the moment somebody switches to
        // the stored view — and that is exactly when the way back is needed.
        ...(columns.some((column) => column.json !== undefined) ? { document: true } : {}),
      },
      columns,
      // A free spot depends on how big the table is, and how big it is depends
      // on its columns — so it is built at the origin and moved once its size
      // is known, before anything has seen it.
      ...(request.position === undefined ? {} : { position: { ...request.position, z: 0 } }),
    });
    const entity = request.position === undefined ? this.#placed(sized, request.anchor) : sized;

    const created = this.core.dispatch({ type: 'CreateTableEntity', entity });
    if (!created.ok) throw new Error(created.error.message);

    await this.#attachView(entity.id, schema.columns.length, {
      schema: request.schema,
      table: request.table,
      ...(request.filter === undefined ? {} : { filter: request.filter }),
    });
    this.core.dispatchSession({ type: 'SetSelection', ids: [entity.id] });
    return entity.id;
  }

  /**
   * Moves a freshly built table to the nearest free space.
   *
   * "Nearest" is measured from the corner of what is on screen — the corner the
   * explorer is next to, the explorer being what was just clicked — unless the
   * caller names an edge to gather along instead, which following a foreign key
   * does. The shell reveals the table afterwards, which does nothing at all when
   * the spot found was already in view, so a table only ever pulls the camera
   * when the view really had no room left.
   */
  #placed(entity: TableEntity, anchor?: PlacementAnchor): TableEntity {
    const viewport =
      this.viewport?.() ??
      // No camera to consult, but an anchor still says where "beside" is: treat
      // the source's own surroundings as the view so that being inside it
      // neither helps nor hinders.
      (anchor === undefined ? null : neighbourhoodOf(entity.transform, entity.transform, anchor));
    if (viewport === null || viewport === undefined) {
      // No camera to consult — headless, or before the first frame. The old
      // diagonal stagger at least never lands two tables on the same spot.
      const offset = this.#opened * TABLE_GRID_STEP;
      this.#opened += 1;
      return this.#movedTo(entity, { x: offset, y: offset });
    }
    const { width, height } = entity.transform;
    return this.#movedTo(
      entity,
      findFreePlacement({
        size: { width, height },
        occupied: this.#occupied(),
        viewport,
        ...(anchor === undefined ? {} : { anchor }),
      }),
    );
  }

  // --- Column summaries -------------------------------------------------

  /** Asks for a summary of every picked-out column, and forgets the rest. */
  syncColumnSummaries(): void {
    this.#summaries.sync(this.core.world, this.core.session.selectedColumns);
  }

  /** The summary of a picked-out column, or its progress towards one. */
  columnSummary(columnId: EntityId): ColumnSummaryState | undefined {
    return this.#summaries.stateOf(columnId);
  }

  /** Every table's rectangle, which is everything a placement has to miss. */
  #occupied(): readonly Rect[] {
    const occupied: Rect[] = [];
    for (const entity of this.core.world.entities.values()) {
      if (isTableEntity(entity)) occupied.push(entity.transform);
    }
    return occupied;
  }

  /**
   * The nearest free spot beside a table, for the things that belong next to it:
   * the table a foreign key was followed to, and the box a statement is written
   * in.
   *
   * Beside rather than anywhere, because the line drawn between them is the
   * point — a long line reads as two unrelated tables. So the anchor is the
   * source's own right edge, and a spot pushed up or down *along* that edge
   * beats one shoved sideways past whatever was already there. It used to be a
   * fixed offset, which put the new table straight on top of anything that
   * happened to be sitting in that spot.
   */
  #besideTable(source: TableEntity, size: Size2): Placement {
    const anchor = rightEdgeAnchor(source.transform, LINKED_TABLE_GAP);
    return findFreePlacement({
      size,
      occupied: this.#occupied(),
      viewport: this.viewport?.() ?? neighbourhoodOf(source.transform, size),
      anchor,
    });
  }

  #movedTo(entity: TableEntity, position: { x: number; y: number }): TableEntity {
    return {
      ...entity,
      transform: { ...entity.transform, x: position.x, y: position.y },
    };
  }

  /**
   * Gives a table entity a live result set. Separated from entity creation
   * because a query table is created without one and gains it only when its
   * statement is run.
   */
  async #attachView(
    tableId: EntityId,
    columnCount: number,
    spec: TableOpenSpec,
  ): Promise<{ view: TableView; schema: TableSchema }> {
    const view = new TableView({
      tableId,
      gateway: this.#client,
      blockSize: blockSizeForColumns(columnCount, this.#options.blockSize ?? DEFAULT_BLOCK_SIZE),
      ...(this.#options.maxBytes === undefined ? {} : { maxBytes: this.#options.maxBytes }),
      ...(this.#options.onDataChanged === undefined
        ? {}
        : { onChange: this.#options.onDataChanged }),
    });
    this.#views.set(tableId, view);

    try {
      return { view, schema: await view.open(spec) };
    } catch (error) {
      // The table stays on the canvas showing its chrome; only its body failed.
      this.#views.delete(tableId);
      await view.close().catch(() => undefined);
      throw error;
    }
  }

  /**
   * Closes a table: releases its result set and removes the entity. Session
   * references are cleared too, so nothing keeps pointing at a table that is
   * gone.
   */
  async closeTable(tableId: EntityId): Promise<void> {
    // The boxes built on this one go with it, furthest first. A box holds one
    // step and the name of its input; with the input gone there is nothing for
    // that name to mean, and a box that can never run again is worse than no box.
    for (const derived of [...derivedTreeOf(this.core.world, tableId)].reverse()) {
      await this.closeTable(derived.id);
    }
    const view = this.#views.get(tableId);
    this.#views.delete(tableId);
    if (view !== undefined) await view.close();
    // Noted before the entity goes: its columns are about to stop existing and
    // a selection may still name them.
    const closing = this.core.world.entities.get(tableId);
    const columns = new Set(
      closing !== undefined && isTableEntity(closing)
        ? closing.columns.map((column) => column.id)
        : [],
    );
    if (this.core.world.entities.has(tableId)) {
      this.core.dispatch({ type: 'RemoveEntities', ids: [tableId] });
    }

    const session = this.core.session;
    if (session.hovered === tableId) {
      this.core.dispatchSession({ type: 'SetHovered', id: null });
    }
    if (session.selection.includes(tableId)) {
      this.core.dispatchSession({
        type: 'SetSelection',
        ids: session.selection.filter((id) => id !== tableId),
      });
    }
    if (session.hoveredAction?.entityId === tableId) {
      this.core.dispatchSession({ type: 'SetHoveredAction', target: null });
    }
    if (session.pressedAction?.entityId === tableId) {
      this.core.dispatchSession({ type: 'SetPressedAction', target: null });
    }
    if (session.expandedAction?.entityId === tableId) {
      this.core.dispatchSession({ type: 'SetExpandedAction', target: null });
    }
    // A closed table's columns cannot stay picked out: nothing would show them,
    // and an agent asking what is selected would be told about columns that are
    // no longer anywhere.
    if (session.selectedColumns.some((id) => columns.has(id))) {
      this.core.dispatchSession({
        type: 'SetSelectedColumns',
        ids: session.selectedColumns.filter((id) => !columns.has(id)),
      });
    }
    // Nor can a closed chart's marks: there is no longer a picture they are in.
    this.#releaseMarks(tableId);
    this.#pictures.forget(tableId);
    this.#chartDrafts.delete(tableId);
    this.#scopedBy.delete(tableId);
  }

  /** The type the filter compares with: the value's own, wherever it came from. */
  #typeOfValue(
    source: TableEntity,
    follow: ForeignKeyFollow,
    clicked: TableColumnView,
  ): ColumnDataType {
    if (follow.valueFrom === undefined) return clicked.sourceColumn.type;
    const view = this.#views.get(source.id)?.schema;
    return view?.columns[follow.valueFrom]?.type ?? clicked.sourceColumn.type;
  }

  /**
   * Follows a foreign key: opens the referenced table showing only the matching
   * rows, and binds it to the table the click came from.
   *
   * The binding is what makes the pair stay connected afterwards — the line
   * re-routes itself as either table is moved or resized, because its geometry
   * is derived rather than stored.
   */
  async followForeignKey(follow: ForeignKeyFollow): Promise<FollowedForeignKey> {
    const source = this.core.world.entities.get(follow.tableId);
    if (source === undefined || !isTableEntity(source)) {
      throw new Error(`No table with id ${follow.tableId}`);
    }
    const column = findColumn(source, follow.columnId);
    if (column === undefined) throw new Error(`No column with id ${follow.columnId}`);

    const { reference } = follow;
    // One value, which is the ordinary case for a key: a filter is a membership
    // predicate so that a chart's selection can be one too.
    //
    // The type is the *value's*, which for a document property is not always the
    // clicked column's: a list's cell holds a length and its elements are found
    // by the parent row's key, so comparing a text key as a number is exactly
    // the mistake available here.
    const filter: RowFilter = {
      column: reference.column,
      values: [follow.value],
      type: this.#typeOfValue(source, follow, column),
    };

    // Beside the source, so the line between them is short and obviously a
    // relationship — but in a *free* spot, not on top of a neighbour. An anchor
    // rather than a position, because how much room the table needs is not known
    // until its columns have been described.
    const tableId = await this.openTable({
      schema: reference.schema,
      table: reference.table,
      anchor: rightEdgeAnchor(source.transform, LINKED_TABLE_GAP),
      filter,
    });

    const binding: Binding = {
      id: this.core.ids.binding(),
      kind: 'connector',
      fromId: follow.tableId,
      toId: tableId,
      from: AUTO_ANCHOR,
      to: AUTO_ANCHOR,
      directed: true,
      label: `${follow.sourceColumn} = ${formatCell(follow.value, column.sourceColumn.type)}`,
      meta: {
        kind: 'foreign-key',
        column: follow.sourceColumn,
        referencedSchema: reference.schema,
        referencedTable: reference.table,
        referencedColumn: reference.column,
        constraint: reference.constraint,
      },
    };
    const created = this.core.dispatch({ type: 'CreateBinding', binding });
    if (!created.ok) throw new Error(created.error.message);

    this.#fitToRows(tableId);
    return { tableId, bindingId: binding.id };
  }

  /**
   * Shrinks a freshly followed table to the rows it actually has. A key that
   * matches one row should not open a window onto twenty empty ones.
   */
  #fitToRows(tableId: EntityId): void {
    const entity = this.core.world.entities.get(tableId);
    const rowCount = this.#views.get(tableId)?.rowCount;
    if (
      entity === undefined ||
      !isTableEntity(entity) ||
      rowCount === null ||
      rowCount === undefined
    ) {
      return;
    }
    const rows = Math.min(MAX_LINKED_ROWS, Math.max(MIN_LINKED_ROWS, rowCount));
    const height = entity.view.headerHeight + rows * entity.view.rowHeight;
    if (height >= entity.transform.height) return;
    this.core.dispatch({
      type: 'ResizeEntity',
      id: tableId,
      width: entity.transform.width,
      height,
    });
  }

  /** Performs a halo action reported by the interaction controller. */
  async performAction(tableId: EntityId, action: EntityActionId): Promise<void> {
    if (action === 'close') {
      await this.closeTable(tableId);
      return;
    }
    // A disclosure rather than a deed: it reveals the formats and does nothing
    // else, and pressing it again folds them away.
    if (action === 'export') {
      const open = this.core.session.expandedAction;
      const same = open?.entityId === tableId && open.action === 'export';
      this.core.dispatchSession({
        type: 'SetExpandedAction',
        target: same ? null : { entityId: tableId, action: 'export' },
      });
      return;
    }
    const format = FORMAT_BY_ACTION[action];
    if (format !== undefined) {
      // The choice has been made, so the choices fold away — before the save
      // dialog opens, so the halo is not left hanging open behind it.
      this.core.dispatchSession({ type: 'SetExpandedAction', target: null });
      await this.exportTable(tableId, format);
      return;
    }
    const picture = CHART_FORMAT_BY_ACTION[action];
    if (picture !== undefined) {
      this.core.dispatchSession({ type: 'SetExpandedAction', target: null });
      await this.exportChart(tableId, picture);
      return;
    }
    if (action === 'edit') {
      // The same button in both directions: it opens the setup, and while the
      // setup is open it goes back to what the box was showing.
      const box = this.core.world.entities.get(tableId);
      if (box === undefined || !isTableEntity(box)) return;
      if (isChartTable(box)) {
        if (box.mode === 'editing') this.showChart(tableId);
        else this.editChart(tableId);
        return;
      }
      if (isQueryTable(box) && box.mode === 'editing') this.showQueryResult(tableId);
      else this.editQuery(tableId);
      return;
    }
    // Always a *new* box, on a query table as much as an ordinary one: refining
    // a query is how the next one is made, so this is not a toggle. Going back
    // to a box's own editor is what the edit button is for.
    if (action === 'json') {
      await this.toggleDocumentView(tableId);
      return;
    }
    if (action === 'sql') await this.openQuery(tableId);
    if (action === 'chart') await this.openChart(tableId);
    if (action === 'rows') await this.openChartRows(tableId);
  }

  /**
   * Switches a document table between its properties and its stored columns.
   *
   * Both views are built from the same schema by the same pair of functions, so
   * neither is a modification of the other and switching cannot half-apply. It is
   * one commit — `SetTableColumns`, the command a query box already uses when its
   * statement changes shape — so it is in the history and undoes like anything
   * else somebody did.
   *
   * Column widths are not carried across, and deliberately: the two views do not
   * have the same columns, so there is nothing to carry. What the reader sees is
   * a table sized to what it is now showing.
   */
  async toggleDocumentView(tableId: EntityId): Promise<void> {
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity)) return;
    // Only where there is a document to switch to. On any other table this
    // would rebuild the same columns with new identities — a commit that changes
    // nothing a reader can see and invalidates every id addressing them.
    if (entity.source.kind !== 'relation' || entity.source.document !== true) return;
    // The schema the result set was opened with. Absent before the first rows
    // are asked for, and there is nothing to switch between until then.
    const schema = this.#views.get(tableId)?.schema;
    if (schema === undefined || schema === null) return;
    const collapsed = entity.columns.some((column) => column.json !== undefined);
    const specs = collapsed
      ? await this.#described(schema, physicalColumnSpecs(schema))
      : await this.#columnsFor(schema);
    const columns = buildTableColumns(this.core.ids, specs);
    const applied = this.core.dispatch({ type: 'SetTableColumns', tableId, columns });
    if (!applied.ok) throw new Error(applied.error.message);
    this.#resizeToColumns(tableId, columns);
  }

  /**
   * Halo actions a table cannot perform.
   *
   * The demo relations are generated in the browser, so there is no engine to
   * send SQL to. The button is greyed out rather than hidden, so the capability
   * is discoverable before there is a connection to use it with.
   */
  disabledActionsFor(table: TableEntity | EntityId): readonly EntityActionId[] {
    const entity = typeof table === 'string' ? this.core.world.entities.get(table) : table;
    if (entity === undefined || !isTableEntity(entity)) return NO_ACTIONS;
    const disabled: EntityActionId[] = [];
    if (isChartTable(entity)) {
      // A chart's formats need a picture, which needs the rows to have arrived
      // and the layout to have been asked for at least once.
      if (this.chartFigure(entity) === null) disabled.push(...CHART_EXPORT_ACTIONS_IDS);
      return disabled.length === 0 ? NO_ACTIONS : disabled;
    }
    const hasRows = this.#views.has(entity.id);
    // Nothing to go back to: a statement being written for the first time has
    // no result behind it.
    if (isQueryTable(entity) && entity.mode === 'editing' && !hasRows) disabled.push('edit');
    // Nothing to write to a file either. The usual case is that unrun
    // statement; the other is a table whose body failed to open, which keeps
    // its chrome on the canvas but has no result set behind it.
    if (!hasRows) disabled.push(...EXPORT_ACTIONS);
    // No engine to send SQL to: the demo relations are generated in the browser.
    if (!canRunSql(entity)) disabled.push('sql');
    return disabled.length === 0 ? NO_ACTIONS : disabled;
  }

  // --- Export -----------------------------------------------------------

  /**
   * Writes a table to a file.
   *
   * The shell is asked for the destination first, because a save dialog needs
   * the user activation of the click that got here and cannot be opened after
   * anything is awaited. Only then is the worker asked to encode: there is no
   * point reading a billion rows towards a file the user decided not to save.
   *
   * What happens after that — progress, cancellation, what became of it — is the
   * export's own business and lives in `ExportJobs`. This method's job is to say
   * *which* table, under what name, and to a sink somebody chose.
   */
  async exportTable(tableId: EntityId, format: ExportFormat): Promise<void> {
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity)) {
      throw new Error(`No table with id ${tableId}`);
    }
    if (!this.#views.has(tableId)) {
      throw new Error(`${tableDisplayName(entity)} has no rows to export yet`);
    }
    const openSink = this.#options.openExportSink;
    if (openSink === undefined) throw new Error('This build cannot save files');

    const tableName = tableDisplayName(entity);
    const fileName = exportFileName(tableName, format);
    const sink = await openSink({
      tableId,
      tableName,
      fileName,
      format: describeFormat(format),
    });
    // `null` is the user closing the dialog, which is not a failure and needs
    // no notice: they know they did it.
    if (sink === null) return;

    await this.#exports.start({
      tableId,
      tableName,
      fileName,
      format,
      sink,
      totalRows: this.#views.get(tableId)?.rowCount ?? null,
    });
  }

  /** Every export this session has started, oldest first. */
  exportJobs(): readonly ExportJob[] {
    return this.#exports.all();
  }

  subscribeExports(listener: () => void): () => void {
    return this.#exports.subscribe(listener);
  }

  cancelExport(id: number): void {
    this.#exports.cancel(id);
  }

  dismissExport(id: number): void {
    this.#exports.dismiss(id);
  }

  /**
   * Opens a SQL editor connected to a table.
   *
   * The box starts as an editor rather than a result: it has no statement worth
   * running yet, and a table shaped by a query nobody has written would have no
   * columns to show. Toggling it back later reveals the same editor.
   */
  async openQuery(baseTableId: EntityId): Promise<QueryTableOpened> {
    const base = this.core.world.entities.get(baseTableId);
    if (base === undefined || !isTableEntity(base)) {
      throw new Error(`No table with id ${baseTableId}`);
    }
    if (!canRunSql(base)) throw new Error(`${tableDisplayName(base)} is not backed by a database`);

    const sql = defaultQueryFor(base, this.wrapperFor(base));
    const entity = buildTableEntity(this.core.ids, {
      source: {
        kind: 'query',
        connectionId: this.#connectionId,
        sql,
        label: `${tableDisplayName(base)} · SQL`,
        // What `derived_table` means in this box, and what a change to that
        // table has to refresh.
        derivedFrom: baseTableId,
      },
      mode: 'editing',
      // No columns yet, so the editor is sized for text rather than for data.
      columns: [],
      size: { width: EDITOR_WIDTH, height: EDITOR_HEIGHT },
      position: {
        ...this.#besideTable(base, { width: EDITOR_WIDTH, height: EDITOR_HEIGHT }),
        z: 0,
      },
    });
    const created = this.core.dispatch({ type: 'CreateTableEntity', entity });
    if (!created.ok) throw new Error(created.error.message);

    const binding: Binding = {
      id: this.core.ids.binding(),
      kind: 'connector',
      fromId: baseTableId,
      toId: entity.id,
      from: AUTO_ANCHOR,
      to: AUTO_ANCHOR,
      directed: true,
      // The label is what the marker reveals on demand, so it is the statement
      // rather than the word "SQL" — which the mark already says.
      label: summariseSql(sql),
      meta: { kind: 'query' },
    };
    const boundTo = this.core.dispatch({ type: 'CreateBinding', binding });
    if (!boundTo.ok) throw new Error(boundTo.error.message);

    this.#drafts.set(entity.id, sql);
    this.core.dispatchSession({ type: 'SetSelection', ids: [entity.id] });
    return { tableId: entity.id, bindingId: binding.id };
  }

  // --- Charts ------------------------------------------------------------

  /**
   * Opens a chart of a table.
   *
   * Starts in setup rather than showing something, because a chart of columns
   * nobody chose is a chart of nothing — but the setup starts already filled in
   * with a guess, so the first thing the user sees is a picture and the controls
   * that made it.
   */
  async openChart(baseTableId: EntityId): Promise<QueryTableOpened> {
    const base = this.core.world.entities.get(baseTableId);
    if (base === undefined || !isTableEntity(base)) {
      throw new Error(`No table with id ${baseTableId}`);
    }
    if (isChartTable(base)) throw new Error('A chart cannot be charted');
    const spec = defaultChartSpec(base.columns.map((column) => chartColumnHint(column)));
    const entity = buildTableEntity(this.core.ids, {
      source: {
        kind: 'chart',
        connectionId: this.#connectionId,
        spec,
        label: `${tableDisplayName(base)} · Chart`,
        derivedFrom: baseTableId,
      },
      mode: 'editing',
      // A chart draws; it has no columns to list.
      columns: [],
      size: { width: CHART_WIDTH, height: CHART_HEIGHT },
      position: {
        ...this.#besideTable(base, { width: CHART_WIDTH, height: CHART_HEIGHT }),
        z: 0,
      },
    });
    const created = this.core.dispatch({ type: 'CreateTableEntity', entity });
    if (!created.ok) throw new Error(created.error.message);

    const binding: Binding = {
      id: this.core.ids.binding(),
      kind: 'connector',
      fromId: baseTableId,
      toId: entity.id,
      from: AUTO_ANCHOR,
      to: AUTO_ANCHOR,
      directed: true,
      label: describeChartSpec(spec),
      meta: { kind: 'chart' },
    };
    const bound = this.core.dispatch({ type: 'CreateBinding', binding });
    if (!bound.ok) throw new Error(bound.error.message);

    this.#chartDrafts.set(entity.id, spec);
    this.core.dispatchSession({ type: 'SetSelection', ids: [entity.id] });
    // Started straight away, so the controls have something to be the controls
    // of — but not waited for: opening a box must not block on a database.
    void this.#pictures.load(
      entity.id,
      baseTableId,
      spec,
      dataSourcesOf(this.core.world, entity.id),
    );
    return { tableId: entity.id, bindingId: binding.id };
  }

  /**
   * Opens a table of the rows behind what has been picked out of a chart.
   *
   * Empty to begin with, which is the honest answer to "the rows behind nothing":
   * a filter over no values matches none. It fills in as marks are picked out and
   * empties again as they are let go of, so the table is a running answer to
   * "which rows is that bar made of" rather than a snapshot of one.
   *
   * One per chart. Pressing the button again brings the existing one back into
   * the selection rather than opening a second identical table beside it.
   */
  async openChartRows(chartId: EntityId): Promise<EntityId> {
    const chart = this.core.world.entities.get(chartId);
    if (chart === undefined || !isTableEntity(chart) || !isChartTable(chart)) {
      throw new Error(`No chart with id ${chartId}`);
    }
    const existing = this.#rowsTableOf(chartId);
    if (existing !== null) {
      this.core.dispatchSession({ type: 'SetSelection', ids: [existing] });
      return existing;
    }
    const base = this.core.world.entities.get(chart.source.derivedFrom);
    if (base === undefined || !isTableEntity(base) || base.source.kind !== 'relation') {
      // A chart of a written query has no stored relation to drill into; the
      // statement would have to be filtered, which is a different feature.
      throw new Error('Only a chart of a stored table can show its rows');
    }

    const tableId = await this.openTable({
      schema: base.source.schema,
      table: base.source.table,
      anchor: rightEdgeAnchor(chart.transform, LINKED_TABLE_GAP),
      // Nothing picked out yet, so nothing to show yet.
      filter: this.#selectionFilter(chartId),
    });
    const marked = this.core.dispatch({
      type: 'SetTableSource',
      tableId,
      source: { ...base.source, selectionOf: chartId },
    });
    if (!marked.ok) throw new Error(marked.error.message);

    const binding: Binding = {
      id: this.core.ids.binding(),
      kind: 'connector',
      fromId: chartId,
      toId: tableId,
      from: AUTO_ANCHOR,
      to: AUTO_ANCHOR,
      directed: true,
      label: 'rows behind the selection',
      meta: { kind: 'rows' },
    };
    const bound = this.core.dispatch({ type: 'CreateBinding', binding });
    if (!bound.ok) throw new Error(bound.error.message);
    return tableId;
  }

  /** The table showing this chart's selection, if one is open. */
  #rowsTableOf(chartId: EntityId): EntityId | null {
    for (const entity of this.core.world.entities.values()) {
      if (!isTableEntity(entity) || !isSelectionTable(entity)) continue;
      if (entity.source.selectionOf === chartId) return entity.id;
    }
    return null;
  }

  /**
   * The predicate for whatever is picked out of a chart.
   *
   * By the category's own value rather than its label: a label is for reading and
   * cannot be compared against a numeric column. Marks of different series over
   * the same category are one value, not two — the rows behind "Sweden" are the
   * same rows whichever measure was clicked.
   */
  #selectionFilter(chartId: EntityId): RowFilter {
    const chart = this.core.world.entities.get(chartId);
    // No chart, and therefore nothing to filter by. A predicate naming no column
    // would be nonsense; an empty one is the truth.
    if (chart === undefined || !isTableEntity(chart) || !isChartTable(chart)) {
      return { column: '', values: [] };
    }
    // Asked of the picture rather than worked out from the specification, so that
    // a cell of a written heatmap answers the same way a bar of an assembled chart
    // does: each mark says which data set it came from, and each data set says
    // which column its rows are found by.
    let column = '';
    const values: CellValue[] = [];
    for (const mark of selectedMarksOf(this.core.session, chartId)) {
      const key = this.#pictures.keyFor(chartId, mark);
      if (key === null) continue;
      // The first key column wins, and marks from a data set keyed by another
      // column are left out: `x AND y` is two predicates and a row filter is one.
      if (column === '') column = key.column;
      if (key.column !== column) continue;
      // A category is one value however many of its marks were picked: the rows
      // behind "Sweden" are the same rows whichever measure was clicked.
      if (values.includes(key.value)) continue;
      values.push(key.value);
    }
    if (column === '') return { column: '', values: [] };
    const type = this.#columnType(chartId, column);
    return { column, values, ...(type === undefined ? {} : { type }) };
  }

  /** The declared type of a charted column, so the literal is formed right. */
  #columnType(chartId: EntityId, name: string): ColumnDataType | undefined {
    const chart = this.core.world.entities.get(chartId);
    if (chart === undefined || !isTableEntity(chart) || !isChartTable(chart)) return undefined;
    const base = this.core.world.entities.get(chart.source.derivedFrom);
    if (base === undefined || !isTableEntity(base)) return undefined;
    return base.columns.find((column) => column.sourceColumn.name === name)?.sourceColumn.type;
  }

  /**
   * Keeps every drill-down table showing the rows its chart's selection names.
   *
   * Derived from the selection every frame rather than fired from whatever
   * changed it — the same reason column summaries are: one place decides what
   * each table should be showing, and no new gesture can bypass it.
   */
  syncChartRows(): void {
    for (const entity of this.core.world.entities.values()) {
      if (!isTableEntity(entity) || !isSelectionTable(entity)) continue;
      const chartId = entity.source.selectionOf;
      const wanted = this.#selectionFilter(chartId);
      const key = filterKey(wanted);
      if (this.#rowFilters.get(entity.id) === key) continue;
      this.#rowFilters.set(entity.id, key);
      void this.#refilter(entity.id, entity.source, wanted);
    }
  }

  /** Reopens a drill-down table's rows under a new predicate. */
  async #refilter(
    tableId: EntityId,
    source: { readonly schema: string; readonly table: string },
    filter: RowFilter,
  ): Promise<void> {
    const existing = this.#views.get(tableId);
    if (existing !== undefined) {
      this.#views.delete(tableId);
      await existing.close().catch(() => undefined);
    }
    try {
      await this.#attachView(tableId, this.#columnCountOf(tableId), {
        schema: source.schema,
        table: source.table,
        filter,
      });
      this.#fitToRows(tableId);
    } catch {
      // The table keeps its chrome and shows nothing, which is what a failed
      // body always does here. The next selection will try again.
    }
    this.#options.onDataChanged?.();
  }

  #columnCountOf(tableId: EntityId): number {
    const entity = this.core.world.entities.get(tableId);
    return entity !== undefined && isTableEntity(entity) ? entity.columns.length : 1;
  }

  /** Charts currently showing their setup, in document order. */
  editingCharts(): readonly EntityId[] {
    const editing: EntityId[] = [];
    for (const entity of this.core.world.entities.values()) {
      if (isTableEntity(entity) && isChartTable(entity) && entity.mode === 'editing') {
        editing.push(entity.id);
      }
    }
    return editing;
  }

  /** The specification as it is currently being set up. */
  chartDraft(tableId: EntityId): ChartSpec | null {
    const draft = this.#chartDrafts.get(tableId);
    if (draft !== undefined) return draft;
    const entity = this.core.world.entities.get(tableId);
    return entity !== undefined && isTableEntity(entity) && isChartTable(entity)
      ? entity.source.spec
      : null;
  }

  /**
   * Records a change to a control and redraws.
   *
   * Not a command: turning a dial should not leave a history entry per notch, the
   * same split that keeps typing a query out of the DAG. The picture updates as
   * the controls move, which is the whole point of having them side by side.
   */
  setChartDraft(tableId: EntityId, spec: ChartSpec): void {
    this.#chartDrafts.set(tableId, spec);
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity) || !isChartTable(entity)) return;
    // Whatever was picked out was picked out of a different picture: the third
    // bar of a chart sorted by size is not the third bar of one sorted by name,
    // and keeping the position would silently move the choice to another
    // category.
    this.#releaseMarks(tableId);
    void this.#pictures.load(
      tableId,
      entity.source.derivedFrom,
      spec,
      dataSourcesOf(this.core.world, tableId),
    );
  }

  /** Lets go of the marks picked out in one chart, and of the pointer's. */
  #releaseMarks(tableId: EntityId): void {
    const session = this.core.session;
    if (session.selectedMarks.some((mark) => mark.entityId === tableId)) {
      this.core.dispatchSession({
        type: 'SetSelectedMarks',
        targets: session.selectedMarks.filter((mark) => mark.entityId !== tableId),
      });
    }
    if (session.hoveredMark?.entityId === tableId) {
      this.core.dispatchSession({ type: 'SetHoveredMark', target: null });
    }
  }

  /** The columns a chart has to choose between: its base table's. */
  chartColumns(tableId: EntityId): readonly ChartColumnChoice[] {
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity) || !isChartTable(entity)) return [];
    const base = this.core.world.entities.get(entity.source.derivedFrom);
    if (base === undefined || !isTableEntity(base)) return [];
    return base.columns.map((column) => ({
      ...chartColumnHint(column),
      type: column.sourceColumn.type.name,
    }));
  }

  /** How charts look here. The shell may override it; most will not. */
  get chartTheme(): ChartTheme {
    return this.#options.chartTheme ?? DEFAULT_CHART_THEME;
  }

  /**
   * What a picked mark stands for, in the terms the rows behind it are found by.
   *
   * The agent-facing half of identity: a mark is a series and a data index, and
   * what anybody wants from one is "the rows behind Sweden".
   */
  markMeaning(
    tableId: EntityId,
    mark: { readonly series: number; readonly data: number },
  ): {
    readonly frame: string;
    readonly row: number;
    readonly column: string;
    readonly value: CellValue;
  } | null {
    const key = this.#pictures.keyFor(tableId, mark);
    if (key === null) return null;
    const stamped = mark as ChartMark;
    return {
      frame: stamped.frame ?? PRIMARY_FRAME,
      row: stamped.row ?? mark.data,
      column: key.column,
      value: key.value,
    };
  }

  /**
   * What a chart is drawing, or how far it has got towards it.
   *
   * With each data set it holds and the box that supplied it, because a data set
   * that arrived empty and a data set nobody asked for look the same in a picture
   * and read very differently in an answer.
   */
  chartState(tableId: EntityId): ChartReport | undefined {
    const state = this.#pictures.stateOf(tableId);
    if (state?.status !== 'ready') return state;
    const sources = dataSourcesOf(this.core.world, tableId);
    return {
      ...state,
      frames: state.frames.map((frame) => {
        const from = sources.get(frame.name);
        return {
          name: frame.name,
          ...(from === undefined ? {} : { from }),
          dimensions: frame.dimensions,
          ...(frame.key === undefined ? {} : { key: frame.key }),
          ...(frame.missing === undefined ? {} : { missing: frame.missing }),
          ...(frame.window === undefined ? {} : { window: frame.window }),
          ...(frame.scanned === undefined ? {} : { scanned: frame.scanned }),
          rows: frame.rows.length,
          read: frame.read,
          basis: frame.basis,
        };
      }),
    };
  }

  /**
   * Commits the setup and switches the box to showing the chart.
   *
   * One command for the whole specification: what the user did was set this chart
   * up, and history should say that once.
   */
  showChart(tableId: EntityId): void {
    const spec = this.chartDraft(tableId);
    if (spec === null) throw new Error(`No chart with id ${tableId}`);
    if (!isChartSpecDrawable(spec)) throw new Error('Choose a column to chart');
    const committed = this.core.dispatch({ type: 'SetChartSpec', tableId, spec });
    if (!committed.ok) throw new Error(committed.error.message);
    const shown = this.core.dispatch({ type: 'SetTableMode', tableId, mode: 'result' });
    if (!shown.ok) throw new Error(shown.error.message);
    for (const binding of this.core.world.bindings.values()) {
      if (binding.toId !== tableId || binding.meta?.['kind'] !== 'chart') continue;
      this.core.dispatch({
        type: 'SetBindingLabel',
        bindingId: binding.id,
        label: describeChartSpec(spec),
      });
    }
  }

  /** Reopens the setup of a chart that is showing one. */
  editChart(tableId: EntityId): void {
    const changed = this.core.dispatch({ type: 'SetTableMode', tableId, mode: 'editing' });
    if (!changed.ok) throw new Error(changed.error.message);
  }

  /**
   * Writes a chart to a file.
   *
   * Small, synchronous work on geometry that is already in hand, so there is no
   * worker, no streaming and no progress to report: by the time the save dialog
   * has been answered the bytes exist. What reaches the file is the *box* — title,
   * chart, and the line saying what it was drawn from — because a picture without
   * those is one nobody can place afterwards.
   */
  async exportChart(tableId: EntityId, format: ChartExportFormat): Promise<void> {
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity) || !isChartTable(entity)) {
      throw new Error(`No chart with id ${tableId}`);
    }
    const figure = this.chartFigure(entity);
    if (figure === null) throw new Error('There is no chart to export yet');
    const descriptor = CHART_EXPORT_FORMATS[format];
    const open = this.#options.openExportSink;
    if (open === undefined) throw new Error('This build cannot save files');
    const sink = await open({
      tableId,
      tableName: tableDisplayName(entity),
      fileName: `${chartFileStem(entity)}${descriptor.extension}`,
      format: descriptor,
    });
    // Dismissed, which is not a failure: nothing was asked for after all.
    if (sink === null) return;
    try {
      await sink.write(await this.#encodeChart(figure, format));
      await sink.close();
    } catch (error) {
      await abandon(sink, error);
      throw error;
    }
  }

  /** The piece of a chart at a point in the box's own coordinates. */
  chartMarkAt(
    tableId: EntityId,
    localX: number,
    localY: number,
  ): { readonly series: number; readonly data: number } | null {
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity)) return null;
    return this.#pictures.markAt(entity, localX, localY);
  }

  /** The figure a chart would be exported as, or `null` before it has drawn. */
  chartFigure(entity: TableEntity & { readonly source: ChartSource }): ChartFigure | null {
    return this.#pictures.figure(entity);
  }

  async #encodeChart(figure: ChartFigure, format: ChartExportFormat): Promise<Uint8Array> {
    if (format === 'pdf') return chartFigureToPdf(figure);
    const inner = this.#options.chartSurface?.toSvg();
    if (inner === null || inner === undefined) {
      throw new Error('There is no chart to export yet');
    }
    const svg = chartFigureToSvg(figure, inner);
    if (format === 'svg') return new TextEncoder().encode(svg);
    // A PNG is that SVG, rasterised by whatever can rasterise — which is the
    // browser, and therefore the shell's business rather than the workspace's.
    const rasterise = this.#options.rasteriseSvg;
    if (rasterise === undefined) throw new Error('This build cannot write a PNG');
    return rasterise(svg, figureLayout(figure));
  }

  /** Query boxes currently showing their editor, in document order. */
  editingQueryTables(): readonly EntityId[] {
    const editing: EntityId[] = [];
    for (const entity of this.core.world.entities.values()) {
      if (isTableEntity(entity) && isQueryTable(entity) && entity.mode === 'editing') {
        editing.push(entity.id);
      }
    }
    return editing;
  }

  /** True once a query box has run at least once and has rows to go back to. */
  hasQueryResult(tableId: EntityId): boolean {
    return this.#views.has(tableId);
  }

  /** The statement as it is currently being typed. */
  queryDraft(tableId: EntityId): string {
    const existing = this.#drafts.get(tableId);
    if (existing !== undefined) return existing;
    const entity = this.core.world.entities.get(tableId);
    return entity !== undefined && isTableEntity(entity) && isQueryTable(entity)
      ? entity.source.sql
      : '';
  }

  /**
   * Records a keystroke. Deliberately *not* a command: a query written one
   * character at a time would otherwise leave one history entry per character.
   */
  setQueryDraft(tableId: EntityId, sql: string): void {
    this.#drafts.set(tableId, sql);
  }

  /**
   * Runs the draft and turns the box into its result.
   *
   * The columns are not known until the statement has run, so the entity is
   * reshaped from the result set the query produced — this is the one kind of
   * table whose schema is discovered rather than described.
   *
   * Everything built on top of this box is then run again. A box holds one step
   * and a reference to its input, so changing this step changes what the steps
   * above it read: leaving them as they were would leave them showing rows that
   * no longer come from anywhere.
   */
  async runQuery(tableId: EntityId, sql?: string): Promise<void> {
    const statement = (sql ?? this.queryDraft(tableId)).trim();
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity) || !isQueryTable(entity)) {
      throw new Error(`No query table with id ${tableId}`);
    }
    if (statement === '') throw new Error('Enter a statement to run');

    const committed = this.core.dispatch({ type: 'SetTableQuery', tableId, sql: statement });
    if (!committed.ok) throw new Error(committed.error.message);
    this.#drafts.set(tableId, statement);

    // The box as the commit above left it. Built rather than read back, because
    // reading it back would need a check for something that cannot have happened.
    await this.#executeQuery({ ...entity, source: { ...entity.source, sql: statement } });
    await this.#refreshDerived(tableId);
  }

  /**
   * The statement a box actually sends: its own step, with every step behind it.
   *
   * Exposed so that the composed SQL can be seen — by a test, by an agent asking
   * what a box runs, and by anyone wondering what `derived_table` stood for.
   */
  /**
   * What a box's statement should read from: a name where there is one.
   *
   * The same choice `defaultQueryFor` makes when it seeds an editor, asked as a
   * question — because anything else writing a statement for this box, an agent
   * included, has to make it too, and `derived_table` where a relation has a
   * name is a step of indirection for nothing.
   */
  readsFrom(tableId: EntityId): string {
    const entity = this.core.world.entities.get(tableId);
    const parentId =
      entity !== undefined && isTableEntity(entity) ? derivedFromOf(entity) : undefined;
    const parent = parentId === undefined ? undefined : this.core.world.entities.get(parentId);
    if (parent === undefined || !isTableEntity(parent) || parent.source.kind !== 'relation') {
      return DERIVED_TABLE;
    }
    // The same surface `defaultQueryFor` seeds, because an agent writing a
    // statement for this box has to make the same choice and the two disagreeing
    // would be worse than either answer.
    return qualifiedName(...surfaceFor(parent.source, this.wrapperFor(parent)));
  }

  /**
   * The physical SQL a box's statement compiled to, where it had to be compiled.
   *
   * A canvas built for looking at things should be able to show what a semantic
   * statement became: the reader wrote — or was seeded with — the model's own
   * vocabulary, and what ran is a join over real tables. `null` for every box
   * that ran its statement as written, which is almost all of them.
   */
  compiledStatement(tableId: EntityId): CompiledStatement | null {
    return this.#views.get(tableId)?.compiled ?? null;
  }

  /**
   * The wrapper view for a box's relation, where its package publishes one.
   *
   * Read from the surface the connection already holds, so this is a lookup rather
   * than a round trip — which is what lets it be asked wherever a statement is
   * written without any of those call sites becoming asynchronous.
   */
  wrapperFor(entity: TableEntity): WrapperView | undefined {
    if (entity.source.kind !== 'relation') return undefined;
    return wrapperFor(this.#wrappers, entity.source.schema, entity.source.table);
  }

  /**
   * The document surface a box's statement should be written against.
   *
   * For an agent, which cannot see that the box's columns are properties rather
   * than stored columns and would otherwise have to infer from `readsFrom` that
   * the syntax changed. `null` for every ordinary table, and for a box built on a
   * query rather than a relation.
   */
  documentSurface(tableId: EntityId): DocumentSurface | null {
    const entity = this.core.world.entities.get(tableId);
    const base =
      entity !== undefined && isTableEntity(entity) ? (derivedFromOf(entity) ?? tableId) : tableId;
    const relation = this.core.world.entities.get(base);
    if (relation === undefined || !isTableEntity(relation)) return null;
    const wrapper = this.wrapperFor(relation);
    if (wrapper === undefined || relation.source.kind !== 'relation') return null;
    return {
      view: qualifiedName(wrapper.schema, wrapper.view),
      stored: qualifiedName(relation.source.schema, relation.source.table),
      paths: wrapper.preprocessor !== undefined,
    };
  }

  /**
   * Renames a box, so a canvas of them can be told apart.
   *
   * A command like any other, because a name is authored content: it belongs in
   * history beside the statement it titles.
   */
  setTableLabel(tableId: EntityId, label: string): void {
    const applied = this.core.dispatch({ type: 'SetTableLabel', tableId, label });
    if (!applied.ok) throw new Error(applied.error.message);
  }

  /**
   * Waits for a window of rows to be in the cache.
   *
   * A table is a window onto a result set and the rows behind it arrive when
   * something asks for them — which, on a canvas, is the frame loop as it draws.
   * Anything that is not the frame loop has to ask, and then wait: that is what
   * this is. It is the difference between reading a result and reading whatever
   * the renderer happened to have fetched.
   */
  async ensureRows(tableId: EntityId, from: number, count: number): Promise<boolean> {
    const view = this.#views.get(tableId);
    if (view === undefined || count <= 0) return false;
    const first = Math.max(0, Math.trunc(from));
    if (view.controller.isRangeLoaded(first, count)) return true;
    // Asked for as a viewport, which is the one way blocks are requested: the
    // frame loop will set its own back the moment it draws, and the blocks
    // already in flight land in the cache either way.
    view.controller.setViewport({
      firstVisibleRow: first,
      visibleRowCount: count,
      velocityY: 0,
    });
    const deadline = Date.now() + (this.#options.rowWaitMs ?? ROW_WAIT_MS);
    while (Date.now() < deadline) {
      if (view.controller.isRangeLoaded(first, count)) return true;
      await new Promise((resolve) => setTimeout(resolve, ROW_POLL_MS));
    }
    return view.controller.isRangeLoaded(first, count);
  }

  /**
   * What the canvas drew of a chart, for whoever cannot look at it.
   *
   * The real numbers, from the layout the renderer last asked for: measured with
   * the real glyph atlas, at the size the box really is.
   */
  chartGeometry(tableId: EntityId): ChartGeometry | null {
    return this.#pictures.geometry(tableId);
  }

  composedQuery(tableId: EntityId): string {
    // A name, not a statement: the reference is swapped for an identifier so it
    // stays valid wherever the user put it.
    const composed = composeQuery(
      this.core.world,
      tableId,
      (source) => qualifiedName(source.schema, source.table),
      // Each step's own placeholders filled in from its own arrows, before the
      // steps are joined: the box that left a `{{name}}` is the box whose arrows
      // say what fills it.
      (step) => this.#filled(step.id, step.source.sql),
    );
    if (!composed.ok) throw new Error(composed.error.message);
    return composed.value;
  }

  /**
   * A statement with its `{{name}}`s filled in from what is picked out.
   *
   * The predicate is built the same way the drill-down table's is — the chart says
   * which column its marks stand for and what they are worth — so a cell picked
   * out means the same thing whether it opens a table of its own or narrows one
   * somewhere else on the canvas.
   *
   * Nothing picked is `1 = 1` rather than `1 = 0`: a knob at rest shows the data,
   * and a statement that hid everything until somebody clicked would look broken.
   * A name no arrow answers to is left as it was, so the database refuses it and
   * the box says why.
   */
  #filled(tableId: EntityId, sql: string): string {
    const sources = filterSourcesOf(this.core.world, tableId);
    if (sources.size === 0) return sql;
    return replacePlaceholders(sql, (name) => {
      const from = sources.get(name);
      if (from === undefined) return null;
      const filter = this.#selectionFilter(from);
      return filter.column === '' || filter.values.length === 0 ? '1 = 1' : filterPredicate(filter);
    });
  }

  /** What each of a box's `{{name}}`s is filled in with, and by which box. */
  filtersOf(tableId: EntityId): readonly {
    readonly name: string;
    readonly from: EntityId;
    readonly picked: number;
    readonly predicate: string;
  }[] {
    return [...filterSourcesOf(this.core.world, tableId)].map(([name, from]) => {
      const filter = this.#selectionFilter(from);
      return {
        name,
        from,
        picked: filter.values.length,
        predicate:
          filter.column === '' || filter.values.length === 0 ? '1 = 1' : filterPredicate(filter),
      };
    });
  }

  /**
   * Sends the composed statement and reshapes the box around what came back.
   *
   * Takes the box rather than its id: every caller has already established that
   * it is one, and a second check here would be a check nothing can fail.
   */
  async #executeQuery(box: QueryStep): Promise<void> {
    const tableId = box.id;
    const statement = this.composedQuery(tableId);

    // A previous result set for this box is replaced, not accumulated.
    const existing = this.#views.get(tableId);
    if (existing !== undefined) {
      this.#views.delete(tableId);
      await existing.close().catch(() => undefined);
    }

    const spec: TableOpenSpec = {
      // A statement has no schema or table of its own; these only label the
      // result set, and the statement itself decides what it reads.
      schema: QUERY_SCHEMA_LABEL,
      table: box.source.label,
      sql: statement,
    };
    // A query's shape is only knowable from the result it produced.
    const { schema } = await this.#attachView(tableId, QUERY_BLOCK_COLUMNS, spec);
    const columns = buildTableColumns(
      this.core.ids,
      schema.columns.map((column) => ({ name: column.name, type: column.type })),
    );
    const reshaped = this.core.dispatch({ type: 'SetTableColumns', tableId, columns });
    if (!reshaped.ok) throw new Error(reshaped.error.message);

    const shown = this.core.dispatch({ type: 'SetTableMode', tableId, mode: 'result' });
    if (!shown.ok) throw new Error(shown.error.message);
    this.#resizeToColumns(tableId, columns);
    this.#fitToRows(tableId);
    this.#retitleQueryBinding(tableId, box.source.sql);
  }

  /**
   * Runs everything built on top of a box again, nearest first.
   *
   * Only the boxes that have a result: one still being written has nothing to
   * bring up to date. A step that no longer works against the new shape — a
   * column it named has gone — is reported by name rather than silently left
   * showing the old rows, and the others are still refreshed.
   */
  async #refreshDerived(tableId: EntityId): Promise<void> {
    const failures: string[] = [];
    for (const derived of derivedTreeOf(this.core.world, tableId)) {
      // A chart is refreshed by re-reading its rows; a query box by running its
      // statement again. Both are things built on the table that changed.
      const refresh = isChartTable(derived)
        ? this.#pictures.load(
            derived.id,
            derived.source.derivedFrom,
            derived.source.spec,
            dataSourcesOf(this.core.world, derived.id),
          )
        : isQueryTable(derived) && this.#views.has(derived.id)
          ? this.#executeQuery(derived)
          : null;
      if (refresh === null) continue;
      try {
        await refresh;
      } catch (error) {
        failures.push(
          `${tableDisplayName(derived)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (failures.length > 0) {
      throw new Error(
        `Could not refresh ${failures.length === 1 ? 'a view' : 'views'} built on this one — ${failures.join('; ')}`,
      );
    }
  }

  /**
   * Keeps the line's label in step with the statement behind it. A connector
   * that describes a query the box no longer runs is worse than no label.
   */
  #retitleQueryBinding(tableId: EntityId, statement: string): void {
    for (const binding of this.core.world.bindings.values()) {
      if (binding.toId !== tableId || binding.meta?.['kind'] !== 'query') continue;
      this.core.dispatch({
        type: 'SetBindingLabel',
        bindingId: binding.id,
        label: summariseSql(statement),
      });
    }
  }

  /** Turns a result back into its editor so the statement can be refined. */
  editQuery(tableId: EntityId): void {
    const changed = this.core.dispatch({ type: 'SetTableMode', tableId, mode: 'editing' });
    if (!changed.ok) throw new Error(changed.error.message);
  }

  /**
   * Leaves the editor without running anything, which is what abandoning an
   * edit means. Only possible once there is a result to go back to.
   */
  showQueryResult(tableId: EntityId): void {
    if (!this.hasQueryResult(tableId)) return;
    const changed = this.core.dispatch({ type: 'SetTableMode', tableId, mode: 'result' });
    if (!changed.ok) throw new Error(changed.error.message);
  }

  /** Widens a query box to its new columns, without ever shrinking below the editor. */
  #resizeToColumns(tableId: EntityId, columns: readonly TableColumnView[]): void {
    const entity = this.core.world.entities.get(tableId);
    if (entity === undefined || !isTableEntity(entity)) return;
    const width = Math.min(MAX_QUERY_WIDTH, Math.max(EDITOR_WIDTH, tableContentWidth(columns)));
    if (width === entity.transform.width) return;
    this.core.dispatch({
      type: 'ResizeEntity',
      id: tableId,
      width,
      height: entity.transform.height,
    });
  }

  /** Reopens every result set after a reconnect. */
  async reopenAll(): Promise<void> {
    await Promise.all([...this.#views.values()].map(async (view) => view.reopen()));
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#views.keys()];
    for (const id of ids) await this.closeTable(id);
  }

  /** Advances every open table by one frame. */
  update(deltaMs: number): void {
    const now = this.#clock();
    for (const [tableId, view] of this.#views) {
      const entity = this.core.world.entities.get(tableId);
      if (entity === undefined || !isTableEntity(entity)) continue;
      view.update(entity, deltaMs, now);
    }
    // Derived every frame from the selection rather than fired from whatever
    // changed it, which is the same reason bindings are: there is one place that
    // decides what should be loaded, and it cannot be bypassed by a new gesture.
    this.syncColumnSummaries();
    this.syncChartRows();
    this.syncChartSources();
    this.syncFilteredQueries();
  }

  /**
   * Re-runs a query box when what scopes it has changed.
   *
   * The same shape as everything else in this tick: the arrows and the selection
   * are state anything can change, so the decision to re-run is made in one place
   * from what is true now. What is compared is the *filled-in* statement, so
   * picking a second mark in the same category re-runs nothing.
   */
  syncFilteredQueries(): void {
    for (const entity of this.core.world.entities.values()) {
      if (!isTableEntity(entity) || !isQueryTable(entity)) continue;
      if (filterSourcesOf(this.core.world, entity.id).size === 0) continue;
      // Only a box that has already run: filling in a placeholder is not a reason
      // to run a statement nobody has run yet.
      if (!this.#views.has(entity.id)) continue;
      const statement = this.composedQuery(entity.id);
      if (this.#scopedBy.get(entity.id) === statement) continue;
      this.#scopedBy.set(entity.id, statement);
      void this.#refreshDerived(entity.id).catch(() => undefined);
      void this.#executeQuery(entity).catch(() => undefined);
    }
  }

  /**
   * Keeps every chart reading the boxes its arrows say it reads.
   *
   * A data binding is document state, so it can be drawn or cut by a pointer, by
   * an agent, or by an undo — and each of those should change what the picture is
   * made of. Derived here rather than fired from whichever of them it was, for the
   * same reason the drill-down tables are: one place decides what should be
   * loaded.
   */
  syncChartSources(): void {
    for (const entity of this.core.world.entities.values()) {
      if (!isTableEntity(entity) || !isChartTable(entity)) continue;
      const sources = dataSourcesOf(this.core.world, entity.id);
      if (this.#pictures.readsFrom(entity.id, sources)) continue;
      // The draft where the controls are holding one, and the committed
      // specification otherwise: the same pair `setChartDraft` works on.
      const spec = this.chartDraft(entity.id) ?? entity.source.spec;
      void this.#pictures.load(entity.id, entity.source.derivedFrom, spec, sources);
    }
  }

  // --- TableViewProvider -------------------------------------------------

  viewFor(entity: TableEntity): TableViewModel | null {
    const view = this.#views.get(entity.id);
    if (view === undefined) return null;
    return {
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
      rowCount: view.rowCount,
      data: { cell: (row, column): ReturnType<TableView['cell']> => view.cell(row, column) },
    };
  }

  /**
   * Lays this box's chart out for the body it has to fill.
   *
   * Cached by size and specification, because laying a chart out is real work and
   * a frame in which nothing changed should cost nothing. Everything the box has
   * to admit about the rows it read — that it read only the first twenty
   * thousand, that it gathered the long tail of categories into one — is passed
   * alongside as a note, because a picture cannot say that about itself.
   */
  chartFor(
    entity: TableEntity,
    width: number,
    height: number,
    metrics: ChartMetrics,
  ): ChartView | undefined {
    if (!isChartTable(entity)) return undefined;
    // The draft, so every control redraws the picture the moment it moves. The
    // committed specification is what a *closed* box draws, and while the box is
    // open the draft is the closer truth.
    const spec = this.chartDraft(entity.id) ?? entity.source.spec;
    return this.#pictures.view(entity.id, spec, width, height, metrics);
  }

  /**
   * What became of this box's statement, for the line under its editor.
   *
   * Only the provenance, not the SQL: a compiled statement is several hundred
   * characters of joins and `SUM`s, and the foot of an editor is a place for one
   * sentence. The SQL itself is on the box for anyone who asks — see
   * `compiledStatement` — and goes to an agent in full.
   */
  statementNoteFor(entity: TableEntity): string | undefined {
    return this.compiledStatement(entity.id)?.provenance;
  }

  columnSummariesFor(entity: TableEntity): ReadonlyMap<EntityId, SummaryPanelView> | undefined {
    return this.#summaries.viewsFor(entity);
  }

  // --- InteractionHost ---------------------------------------------------

  viewOf(tableId: EntityId): TableViewState | null {
    const view = this.#views.get(tableId);
    if (view === undefined) return null;
    const entity = this.core.world.entities.get(tableId);
    return {
      // Hit testing can happen before the first frame, so the layout is
      // refreshed here rather than only during `update`.
      layout: entity === undefined ? view.layout : view.layoutFor(entity),
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
      rowCount: view.rowCount,
    };
  }

  cellAt(tableId: EntityId, row: number, columnIndex: number): CellValue | undefined {
    return this.#views.get(tableId)?.cell(row, columnIndex);
  }

  scrollBy(tableId: EntityId, deltaX: number, deltaY: number): void {
    this.#views.get(tableId)?.scrollBy(deltaX, deltaY, this.#clock());
  }

  scrollToFraction(tableId: EntityId, axis: 'vertical' | 'horizontal', fraction: number): void {
    const view = this.#views.get(tableId);
    const entity = this.core.world.entities.get(tableId);
    if (view === undefined || entity === undefined || !isTableEntity(entity)) return;
    view.scrollToFraction(axis, fraction, entity);
  }

  /** Aggregated data-side metrics for the performance overlay. */
  dataMetrics(): {
    cacheBlocks: number;
    cacheBytes: number;
    cacheEvictions: number;
    fetchesPending: number;
  } {
    let cacheBlocks = 0;
    let cacheBytes = 0;
    let cacheEvictions = 0;
    let fetchesPending = 0;
    for (const view of this.#views.values()) {
      const status = view.controller.status();
      cacheBlocks += status.cache.loadedBlocks;
      cacheBytes += status.cache.bytes;
      cacheEvictions += status.cache.evictions;
      fetchesPending += status.pendingBlocks;
    }
    return { cacheBlocks, cacheBytes, cacheEvictions, fetchesPending };
  }
}
