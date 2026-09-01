import type { ChartSpec } from './chart-spec.js';
import type { ColumnDataType, ForeignKeyReference } from './data-types.js';
import type { ConnectionId, EntityId } from './ids.js';
import type { JsonColumnView } from './json-column.js';
import type { SemanticColumnView } from './semantic-column.js';

/**
 * Document entities.
 *
 * Rows and cells are deliberately *not* entities: they are ephemeral
 * projections of result-set data. If they were entities the conceptual model
 * would scale with row count, which is exactly what Panorama must avoid.
 */

/** A table that shows a stored relation. */
export interface RelationSource {
  readonly kind: 'relation';
  readonly connectionId: ConnectionId;
  readonly schema: string;
  readonly table: string;
  /**
   * True where this relation stores a document rather than a row.
   *
   * A fact about the relation and not about how it is being shown, which is why
   * it lives here and does not change when the view is toggled: the table holds
   * a document family either way, and what the toggle picks is whether to draw
   * the document or the columns it was spread across. Something has to remember
   * it, or the way back from the raw view would be a button nobody could offer.
   */
  readonly document?: boolean;
  /**
   * Set when this table shows the rows behind a chart's selection.
   *
   * Still a stored relation — it has a schema and a name — but one whose rows
   * follow what somebody has picked out of a picture. Naming the chart here is
   * what lets the table be re-filtered as the selection changes, closed when the
   * chart closes, and drawn on the end of a line from it.
   */
  readonly selectionOf?: EntityId;
}

/**
 * A table whose rows come from a statement the user wrote.
 *
 * The SQL is document state: it is authored content, like a column width, and
 * belongs in history. The text *being typed* is not — that lives in session
 * state until it is run, so a query costs one commit rather than one per
 * keystroke.
 */
export interface QuerySource {
  readonly kind: 'query';
  readonly connectionId: ConnectionId;
  /**
   * One step, not the whole pipeline. The table it reads is referred to by name
   * — `derived_table` — and the steps are joined into one statement when the
   * query is run, so a refinement of a refinement stays as short as what the
   * user actually wrote.
   */
  readonly sql: string;
  /** Shown in the title, e.g. `SALES.ORDERS · SQL`. */
  readonly label: string;
  /**
   * The table this query refines: what `derived_table` means in its statement.
   *
   * Held here rather than read off the connector, so that the dependency is
   * document state in the same record as the statement that depends on it. The
   * connector is the drawing of this fact, not the fact.
   */
  readonly derivedFrom?: EntityId;
}

/**
 * A table that draws its rows instead of listing them.
 *
 * Shaped like a query source on purpose: it holds one step — what to draw — and
 * a reference to what it draws, so the chart follows the table it was opened on
 * rather than a copy of it. Which means it is refreshed and closed by the same
 * machinery, and reached by the same connector.
 */
export interface ChartSource {
  readonly kind: 'chart';
  readonly connectionId: ConnectionId;
  readonly spec: ChartSpec;
  /** Shown in the title, e.g. `SALES.ORDERS · Chart`. */
  readonly label: string;
  /** The table being charted. A chart is always of something. */
  readonly derivedFrom: EntityId;
}

export type TableSource = RelationSource | QuerySource | ChartSource;

/**
 * A table that has something to configure is either being configured or showing
 * the result of it: a statement being written, or a chart being set up.
 */
export type TableMode = 'result' | 'editing';

export interface EntityTransform {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly width: number;
  readonly height: number;
}

export interface TableColumnView {
  readonly id: EntityId;
  readonly sourceColumn: {
    readonly name: string;
    readonly type: ColumnDataType;
    /**
     * Present for single-column foreign keys. It makes the column's cells
     * followable: the renderer marks them as links and a click opens the rows
     * they point at.
     */
    readonly foreignKey?: ForeignKeyReference;
  };
  readonly width: number;
  readonly visible: boolean;
  /**
   * The other result-set columns this one presents, for a table holding a
   * document rather than a row.
   *
   * Absent for every ordinary column. Where it is set, `sourceColumn` names the
   * *property* and carries the type of its strongest branch — so a chart, an
   * export, the statistics panel and an agent's answer all read something
   * sensible without knowing any of this exists.
   */
  readonly json?: JsonColumnView;
  /**
   * What this column means, where a semantic layer says so.
   *
   * Absent for every ordinary column. Where it is set, `sourceColumn` still
   * carries the database's own name and type — the meaning is drawn *over* the
   * column rather than in place of it, so a statement written against the box
   * still names something the database will recognise.
   */
  readonly semantic?: SemanticColumnView;
}

export interface TableViewSettings {
  readonly rowHeight: number;
  readonly headerHeight: number;
  readonly horizontalOffset: number;
}

export interface TableEntity {
  readonly id: EntityId;
  readonly type: 'table';
  readonly source: TableSource;
  readonly transform: EntityTransform;
  readonly columns: readonly TableColumnView[];
  readonly view: TableViewSettings;
  /** Only ever `editing` for a query source. */
  readonly mode: TableMode;
}

/** Stage 1 has a single entity kind; the union exists so later kinds slot in. */
export type Entity = TableEntity;

export type EntityType = Entity['type'];

export const isTableEntity = (entity: Entity): entity is TableEntity => entity.type === 'table';

/** Fully-qualified display name, e.g. `SALES.ORDERS`. */
export const tableDisplayName = (entity: TableEntity): string =>
  entity.source.kind === 'relation'
    ? `${entity.source.schema}.${entity.source.table}`
    : entity.source.label;

export const isQueryTable = (
  entity: TableEntity,
): entity is TableEntity & {
  readonly source: QuerySource;
} => entity.source.kind === 'query';

export const isChartTable = (
  entity: TableEntity,
): entity is TableEntity & {
  readonly source: ChartSource;
} => entity.source.kind === 'chart';

/**
 * A table with something to configure before it can show anything.
 *
 * A statement to write or a chart to set up: both start in `editing`, both have
 * a box the user fills in, and both then switch to showing what came of it.
 */
export const isConfigurableTable = (
  entity: TableEntity,
): entity is TableEntity & {
  readonly source: QuerySource | ChartSource;
} => isQueryTable(entity) || isChartTable(entity);

/**
 * The table this one was built on, where it was built on one.
 *
 * One function for queries and charts alike, so that everything which follows
 * the chain — closing, refreshing, drawing the line between them — treats them
 * the same. They are the same relationship.
 */
export const derivedFromOf = (entity: TableEntity): EntityId | undefined =>
  entity.source.kind === 'query'
    ? entity.source.derivedFrom
    : entity.source.kind === 'chart'
      ? entity.source.derivedFrom
      : entity.source.selectionOf;

/** True for a table showing the rows behind a chart's selection. */
export const isSelectionTable = (
  entity: TableEntity,
): entity is TableEntity & {
  readonly source: RelationSource & { readonly selectionOf: EntityId };
} => entity.source.kind === 'relation' && entity.source.selectionOf !== undefined;

/** Total width of the visible columns, in world units. */
export const visibleColumnsWidth = (entity: TableEntity): number =>
  entity.columns.reduce((total, column) => (column.visible ? total + column.width : total), 0);

export const findColumn = (entity: TableEntity, columnId: EntityId): TableColumnView | undefined =>
  entity.columns.find((column) => column.id === columnId);
