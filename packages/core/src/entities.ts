import type { ColumnDataType } from './data-types.js';
import type { ConnectionId, EntityId } from './ids.js';

/**
 * Document entities.
 *
 * Rows and cells are deliberately *not* entities: they are ephemeral
 * projections of result-set data. If they were entities the conceptual model
 * would scale with row count, which is exactly what Panorama must avoid.
 */

export interface TableSource {
  readonly connectionId: ConnectionId;
  readonly schema: string;
  readonly table: string;
}

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
}

/** Stage 1 has a single entity kind; the union exists so later kinds slot in. */
export type Entity = TableEntity;

export type EntityType = Entity['type'];

export const isTableEntity = (entity: Entity): entity is TableEntity => entity.type === 'table';

/** Fully-qualified display name, e.g. `SALES.ORDERS`. */
export const tableDisplayName = (entity: TableEntity): string =>
  `${entity.source.schema}.${entity.source.table}`;

/** Total width of the visible columns, in world units. */
export const visibleColumnsWidth = (entity: TableEntity): number =>
  entity.columns.reduce((total, column) => (column.visible ? total + column.width : total), 0);

export const findColumn = (entity: TableEntity, columnId: EntityId): TableColumnView | undefined =>
  entity.columns.find((column) => column.id === columnId);
