import type { ChartSpec } from './chart-spec.js';
import type { ColumnDataType, ForeignKeyReference } from './data-types.js';
import type { ConnectionId, EntityId } from './ids.js';

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
