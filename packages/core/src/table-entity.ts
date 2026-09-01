import type { ColumnDataType, ForeignKeyReference } from './data-types.js';
import type {
  TableColumnView,
  TableEntity,
  TableMode,
  TableSource,
  TableViewSettings,
} from './entities.js';
import { clamp, type Size2, type Vec3 } from './geometry.js';
import type { EntityId, IdFactory } from './ids.js';
import type { JsonColumnView } from './json-column.js';

/** Layout defaults for a freshly opened table. Deliberately conventional. */
export const DEFAULT_TABLE_VIEW: TableViewSettings = Object.freeze({
  rowHeight: 24,
  headerHeight: 72,
  horizontalOffset: 0,
});

/** Width of the result-position gutter on the left of every table. */
export const ROW_NUMBER_GUTTER_WIDTH = 64;

export const MIN_ESTIMATED_COLUMN_WIDTH = 72;
export const MAX_ESTIMATED_COLUMN_WIDTH = 320;

/** Approximate width of one character at the default table font size. */
const AVERAGE_CHAR_WIDTH = 7.5;
const CELL_PADDING = 20;

const TYPICAL_VALUE_WIDTH: Readonly<Record<ColumnDataType['kind'], number>> = Object.freeze({
  decimal: 12,
  double: 14,
  varchar: 18,
  char: 8,
  boolean: 5,
  date: 10,
  timestamp: 23,
  interval: 14,
  geometry: 24,
  hashtype: 32,
  unknown: 12,
});

/**
 * Picks a sensible initial column width from the header text and the declared
 * type. Real value widths are unknown until data arrives, and Stage 1
 * deliberately does not re-measure columns while scrolling — jumping layout is
 * worse than a slightly wrong width.
 */
export const estimateColumnWidth = (name: string, type: ColumnDataType): number => {
  const declared = type.kind === 'varchar' || type.kind === 'char' ? (type.size ?? 0) : 0;
  const valueChars = Math.min(TYPICAL_VALUE_WIDTH[type.kind], declared || Number.POSITIVE_INFINITY);
  const headerChars = Math.max(name.length, type.name.length);
  const chars = Math.max(headerChars, valueChars);
  return clamp(
    Math.round(chars * AVERAGE_CHAR_WIDTH + CELL_PADDING),
    MIN_ESTIMATED_COLUMN_WIDTH,
    MAX_ESTIMATED_COLUMN_WIDTH,
  );
};

export interface TableColumnSpec {
  readonly name: string;
  readonly type: ColumnDataType;
  readonly width?: number;
  readonly visible?: boolean;
  readonly foreignKey?: ForeignKeyReference;
  /** Set where this column presents several; see `JsonColumnView`. */
  readonly json?: JsonColumnView;
}

export interface TableEntitySpec {
  readonly source: TableSource;
  readonly mode?: TableMode;
  readonly id?: EntityId;
  readonly columns: readonly TableColumnSpec[];
  readonly position?: Vec3;
  readonly size?: Size2;
  readonly view?: Partial<TableViewSettings>;
  /** Number of rows the default height should accommodate. */
  readonly preferredVisibleRows?: number;
}

const DEFAULT_VISIBLE_ROWS = 22;
const DEFAULT_MAX_WIDTH = 1100;

/**
 * Builds a `TableEntity` with stable identifiers for the table and every
 * column view. Column identity is a *view* identity: it survives resizing and
 * reordering and is what commands address.
 */
/**
 * Builds the column views for a table. Separate from `buildTableEntity`
 * because a query table replaces its columns whenever its statement changes,
 * and must produce them exactly the same way.
 */
export const buildTableColumns = (
  ids: IdFactory,
  specs: readonly TableColumnSpec[],
): TableColumnView[] =>
  specs.map((column) => ({
    id: ids.entity('column'),
    sourceColumn: {
      name: column.name,
      type: column.type,
      ...(column.foreignKey === undefined ? {} : { foreignKey: column.foreignKey }),
    },
    width: column.width ?? estimateColumnWidth(column.name, column.type),
    visible: column.visible ?? true,
    ...(column.json === undefined ? {} : { json: column.json }),
  }));

/** Width at which every visible column is fully shown, gutter included. */
export const tableContentWidth = (columns: readonly TableColumnView[]): number =>
  ROW_NUMBER_GUTTER_WIDTH +
  columns.reduce((total, column) => (column.visible ? total + column.width : total), 0);

export const buildTableEntity = (ids: IdFactory, spec: TableEntitySpec): TableEntity => {
  const view: TableViewSettings = { ...DEFAULT_TABLE_VIEW, ...spec.view };
  const columns = buildTableColumns(ids, spec.columns);
  const contentWidth = tableContentWidth(columns);
  const rows = spec.preferredVisibleRows ?? DEFAULT_VISIBLE_ROWS;

  const size: Size2 = spec.size ?? {
    width: Math.min(contentWidth, DEFAULT_MAX_WIDTH),
    height: view.headerHeight + rows * view.rowHeight,
  };
  const position: Vec3 = spec.position ?? { x: 0, y: 0, z: 0 };

  return {
    id: spec.id ?? ids.entity('table'),
    type: 'table',
    source: spec.source,
    mode: spec.mode ?? 'result',
    transform: {
      x: position.x,
      y: position.y,
      z: position.z,
      width: size.width,
      height: size.height,
    },
    columns,
    view,
  };
};
