import type { ColumnDataType, ForeignKeyReference } from '@panorama/core';

export type { ForeignKeyReference };

/** One column of a result set, in result order. */
export interface TableColumnSchema {
  readonly name: string;
  readonly type: ColumnDataType;
  /**
   * Set only for *single-column* foreign keys. A cell can follow one of those
   * to exactly the matching rows; one column of a composite key cannot, so
   * composites are deliberately left unset rather than offering a link that
   * would show the wrong rows.
   */
  readonly foreignKey?: ForeignKeyReference;
}

/** Metadata describing a relation or an open result set. */
export interface TableSchema {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly TableColumnSchema[];
}

export interface SchemaInfo {
  readonly name: string;
  /**
   * A virtual schema: its contents live in another system, and Exasol reaches
   * them through an adapter rather than holding them.
   *
   * Worth carrying because it changes what the rows *are* rather than how they
   * look. A query against one is pushed down to somewhere else, its tables have
   * no row count in the catalogue because nothing here counted them, and its
   * cost is somebody else's network. Absent where the database did not say.
   */
  readonly virtual?: boolean;
}

export interface TableInfo {
  readonly schema: string;
  readonly name: string;
  /** `TABLE` or `VIEW`; databases may report other kinds. */
  readonly kind: string;
  readonly comment?: string;
  /**
   * Rows, as the database's own catalogue reports them — absent where it has no
   * figure. It has none for a view, whose row count exists only once the view
   * has been run, and none for a table whose statistics have never been
   * gathered. Absent is not zero.
   */
  readonly rowCount?: number;
  /**
   * A relation in a virtual schema, which is why it has no row count: reading it
   * federates out to whatever system holds it. See `SchemaInfo.virtual`.
   */
  readonly virtual?: boolean;
}

export const columnIndexByName = (schema: TableSchema, name: string): number =>
  schema.columns.findIndex((column) => column.name === name);

export const foreignKeyOf = (
  schema: TableSchema,
  columnIndex: number,
): ForeignKeyReference | null => schema.columns[columnIndex]?.foreignKey ?? null;
