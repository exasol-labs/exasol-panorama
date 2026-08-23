import type { ColumnDataType } from '@panorama/core';

/** One column of a result set, in result order. */
export interface TableColumnSchema {
  readonly name: string;
  readonly type: ColumnDataType;
}

/** Metadata describing a relation or an open result set. */
export interface TableSchema {
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly TableColumnSchema[];
}

export interface SchemaInfo {
  readonly name: string;
}

export interface TableInfo {
  readonly schema: string;
  readonly name: string;
  /** `TABLE` or `VIEW`; databases may report other kinds. */
  readonly kind: string;
  readonly comment?: string;
}

export const columnIndexByName = (schema: TableSchema, name: string): number =>
  schema.columns.findIndex((column) => column.name === name);
