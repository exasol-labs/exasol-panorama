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
/**
 * The predicate for a membership filter.
 *
 * `= x` for one value rather than `IN (x)`, because that is what a person reading
 * the statement expects to see and what an optimiser is likeliest to recognise.
 * Null is spelled out separately: SQL's `IN` does not match it, so a selection
 * that includes the missing category has to say `IS NULL` as well.
 *
 * No values at all is `1 = 0`. A filter over nothing matches nothing, and saying
 * so in the statement is clearer than an empty `IN ()` that half the parsers in
 * the world reject.
 */
export const filterPredicate = (filter: RowFilter): string => {
  const column = quoteIdentifier(filter.column);
  const present = filter.values.filter((value) => value !== null);
  const hasNull = present.length < filter.values.length;
  const parts: string[] = [];
  if (present.length === 1) {
    parts.push(`${column} = ${filterLiteral(present[0] as CellValue, filter.type)}`);
  } else if (present.length > 1) {
    const list = present.map((value) => filterLiteral(value, filter.type)).join(', ');
    parts.push(`${column} IN (${list})`);
  }
  if (hasNull) parts.push(`${column} IS NULL`);
  if (parts.length === 0) return '1 = 0';
  return parts.length === 1 ? (parts[0] as string) : `(${parts.join(' OR ')})`;
};

export const selectWhere = (schema: string, table: string, filter: RowFilter): string =>
  `SELECT * FROM ${qualifiedName(schema, table)} WHERE ${filterPredicate(filter)}`;

/** The same predicate over a statement's result rather than a stored relation. */
export const selectWhereFrom = (statement: string, filter: RowFilter): string =>
  `SELECT * FROM ${subquery(statement)} WHERE ${filterPredicate(filter)}`;

/**
 * A projection-only query used to read column metadata without moving rows.
 *
 * `LIMIT 0` rather than `WHERE 1 = 0`, and the difference is the difference
 * between opening a virtual schema's tables and not being able to. A predicate
 * on a virtual table is *pushed down* to its adapter, and a literal-only one is
 * a predicate most adapters have never been asked to render:
 *
 *     E-VSCL-2: Unable to render unknown SQL predicate type 'literal_bool'
 *     F-UDF-CL-RUST-9001: filter contains an operation that was not advertised
 *
 * — the first from Exasol's own Lua virtual-schema framework, the second from a
 * Rust adapter, both against a live instance. Since this is the *first* statement
 * Panorama runs when opening any table, the whole box failed before a single row
 * was asked for.
 *
 * A limit is not a predicate. It is applied to the result rather than pushed into
 * the source, so there is nothing for an adapter to render and nothing for it to
 * have advertised — and on an ordinary table it costs exactly what the false
 * predicate did, which is nothing.
 */
export const describeQuery = (schema: string, table: string): string =>
  `SELECT * FROM ${qualifiedName(schema, table)} LIMIT 0`;

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

/**
 * Describing one column, in SQL a database will recognise.
 *
 * Two queries, both unremarkable: counts and extremes, then a distribution.
 * Deliberately plain — `COUNT`, `MIN`, `MAX`, `AVG`, `GROUP BY`, `FLOOR` and
 * arithmetic and nothing else. A column summary is the kind of feature that
 * tempts one into a database's own statistics functions, and the moment it does
 * it stops working anywhere else and starts being untestable without a live
 * instance of exactly the right version.
 *
 * It aggregates the *statement*, not the table, so a followed key or a written
 * query is summarised as it is shown rather than as it would be unfiltered. And
 * it reads one column: a columnar engine then never touches the other four
 * thousand, which is the whole reason to ask the database instead of the rows
 * that happen to be on screen.
 */
/**
 * A number as SQL sees it. `String` would sometimes produce `1e-7`, which is a
 * literal some parsers accept and others do not; a fixed expansion is a literal
 * every one of them does.
 */
export const numberLiteral = (value: number): string => {
  if (!Number.isFinite(value)) return '0';
  if (Number.isInteger(value) && Math.abs(value) < 1e15) return String(value);
  // `toFixed` gives up at 1e21 and returns exponent notation — the one thing
  // this function exists to avoid. A double that large has no fraction left to
  // lose, so it is expanded as the integer it already is.
  if (Math.abs(value) >= 1e21) return BigInt(Math.trunc(value)).toString();
  return value.toFixed(12).replace(/0+$/u, '').replace(/\.$/u, '');
};

const subquery = (statement: string): string => `(${statement}) AS "panorama_source"`;

/**
 * The counts, the extremes and the numeric statistics, in one pass.
 *
 * `STDDEV` rather than `STDDEV_POP`, because these rows are a population only in
 * the trivial sense: what somebody comparing two columns wants is the sample
 * deviation, and it is what `ColumnSummaryBuilder` computes for the sources that
 * have to read the rows themselves. The two paths must not disagree about what
 * the same word means.
 *
 * The non-numeric columns are still selected, as nulls of the right type, so the
 * result has one shape and the reader has one set of indices rather than a layout
 * that depends on the column.
 */
export const summaryAggregateQuery = (
  statement: string,
  column: string,
  numeric: boolean,
): string => {
  const quoted = quoteIdentifier(column);
  const numbers = numeric
    ? `, AVG(${quoted}), SUM(${quoted}), STDDEV(${quoted})`
    : ', CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE), CAST(NULL AS DOUBLE)';
  return (
    `SELECT COUNT(*), COUNT(${quoted}), COUNT(DISTINCT ${quoted})` +
    `, MIN(${quoted}), MAX(${quoted})${numbers}` +
    ` FROM ${subquery(statement)}`
  );
};

/** The most frequent values, which for few enough values is every value. */
export const summaryFrequencyQuery = (statement: string, column: string, limit: number): string => {
  const quoted = quoteIdentifier(column);
  return (
    `SELECT ${quoted}, COUNT(*) FROM ${subquery(statement)}` +
    ` WHERE ${quoted} IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT ${Math.trunc(limit)}`
  );
};

/**
 * Rows per equal slice of a numeric column's range.
 *
 * The range comes from the aggregate query rather than from a second `MIN`/`MAX`,
 * so the bins are cut against the same numbers the panel reports. Bins are
 * counted by their index, which keeps the arithmetic to one subtraction and one
 * division and the result to at most one row per bin.
 */
export const summaryHistogramQuery = (
  statement: string,
  column: string,
  low: number,
  high: number,
  bins: number,
): string => {
  const quoted = quoteIdentifier(column);
  const width = (high - low) / bins;
  const index =
    `LEAST(${Math.trunc(bins) - 1},` +
    ` FLOOR((${quoted} - ${numberLiteral(low)}) / ${numberLiteral(width)}))`;
  return (
    `SELECT ${index}, COUNT(*) FROM ${subquery(statement)}` +
    ` WHERE ${quoted} IS NOT NULL GROUP BY 1 ORDER BY 1`
  );
};
