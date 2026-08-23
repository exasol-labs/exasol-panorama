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

/** A projection-only query used to read column metadata without moving rows. */
export const describeQuery = (schema: string, table: string): string =>
  `SELECT * FROM ${qualifiedName(schema, table)} WHERE 1 = 0`;
