import type { ColumnDataType } from '@panorama/core';
import type { CellValue, RowFilter } from '@panorama/table';

/**
 * SQL construction helpers.
 *
 * Metadata queries are the only place Panorama builds SQL in Stage 1, and even
 * there every identifier and literal goes through these functions: schema and
 * table names arrive from user input.
 */

export const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

export const quoteLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export const qualifiedName = (schema: string, table: string): string =>
  `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;

/** `SELECT * FROM "schema"."table"` — the Stage 1 table-browsing query. */
export const selectAll = (schema: string, table: string): string =>
  `SELECT * FROM ${qualifiedName(schema, table)}`;

const NUMERIC_TEXT = /^-?\d+(\.\d+)?$/;

/**
 * Renders a filter value as a SQL literal.
 *
 * Numbers go in bare, everything else is quoted with doubled apostrophes.
 * Exasol treats a backslash as an ordinary character inside a string literal —
 * verified against a live instance — so doubling the quote is the whole of the
 * escaping rule.
 */
export const filterLiteral = (value: CellValue, type?: ColumnDataType): string => {
  if (value === null) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : quoteLiteral(String(value));
  }
  // High-precision decimals arrive as strings to keep their digits; compare
  // them numerically when the column says they are numbers.
  const numeric = type?.kind === 'decimal' || type?.kind === 'double';
  return numeric && NUMERIC_TEXT.test(value) ? value : quoteLiteral(value);
};

/**
 * `SELECT * FROM "schema"."table" WHERE "column" = value` — the query behind
 * following a foreign key.
 */
export const selectWhere = (schema: string, table: string, filter: RowFilter): string => {
  const column = quoteIdentifier(filter.column);
  const predicate =
    filter.value === null
      ? `${column} IS NULL`
      : `${column} = ${filterLiteral(filter.value, filter.type)}`;
  return `SELECT * FROM ${qualifiedName(schema, table)} WHERE ${predicate}`;
};

/** A projection-only query used to read column metadata without moving rows. */
export const describeQuery = (schema: string, table: string): string =>
  `SELECT * FROM ${qualifiedName(schema, table)} WHERE 1 = 0`;

/**
 * Single-column foreign keys declared on a table.
 *
 * Composite keys are excluded in SQL rather than in TypeScript: a constraint
 * spanning several columns cannot be followed from one cell.
 */
export const foreignKeyQuery = (schema: string, table: string): string =>
  'SELECT COLUMN_NAME, REFERENCED_SCHEMA, REFERENCED_TABLE, REFERENCED_COLUMN, CONSTRAINT_NAME' +
  ' FROM SYS.EXA_ALL_CONSTRAINT_COLUMNS' +
  " WHERE CONSTRAINT_TYPE = 'FOREIGN KEY'" +
  ` AND CONSTRAINT_SCHEMA = ${quoteLiteral(schema)}` +
  ` AND CONSTRAINT_TABLE = ${quoteLiteral(table)}` +
  ' AND CONSTRAINT_NAME IN (' +
  '  SELECT CONSTRAINT_NAME FROM SYS.EXA_ALL_CONSTRAINT_COLUMNS' +
  "  WHERE CONSTRAINT_TYPE = 'FOREIGN KEY'" +
  `  AND CONSTRAINT_SCHEMA = ${quoteLiteral(schema)}` +
  `  AND CONSTRAINT_TABLE = ${quoteLiteral(table)}` +
  '  GROUP BY CONSTRAINT_NAME HAVING COUNT(*) = 1)';
