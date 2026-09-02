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
 * The metadata table a `exasol-json-tables` wrapper package publishes.
 *
 * Named here because finding the packages means asking which schemas contain a
 * table by this name — the wrapper's schemas are free parameters of the
 * generator, so there is no convention to rely on and this is the only fixed
 * point.
 */
export const WRAPPER_ROOTS_TABLE = '__JVS_ROOTS';

/** Every helper schema on the connection, whatever its package was named. */
export const wrapperHelperSchemaQuery = (): string =>
  'SELECT TABLE_SCHEMA FROM SYS.EXA_ALL_TABLES' +
  ` WHERE TABLE_NAME = ${quoteLiteral(WRAPPER_ROOTS_TABLE)}` +
  ' ORDER BY TABLE_SCHEMA';

/**
 * What one package wraps: the source it reads and the view it publishes.
 *
 * The wrapper's own record, which is why this is asked rather than derived from
 * the schema names. `PUBLIC_VIEW` is an ordinary view and can be selected from
 * with no preprocessor at all; the preprocessor is only what rewrites the dotted
 * paths and array selectors written against it.
 */
export const wrapperRootsQuery = (helperSchema: string): string =>
  'SELECT ROOT_TABLE, SOURCE_SCHEMA, PUBLIC_SCHEMA, PUBLIC_VIEW' +
  ` FROM ${qualifiedName(helperSchema, WRAPPER_ROOTS_TABLE)}`;

/**
 * Escapes a value for the middle of a `LIKE` pattern.
 *
 * `_` matches any character in SQL, and wrapper schemas are full of underscores —
 * so an unescaped `LIKE '%JSON_VIEW%'` matches `JSONXVIEW` too. It also matched
 * twenty of this instance's thirty-two preprocessors, because `JSON_VIEW` is a
 * prefix of `JSON_VIEW_ACCESS` and the rest. Both are why the pattern below
 * matches a *configuration entry* rather than a bare name.
 */
const likeLiteral = (value: string): string =>
  value.replaceAll('\\', '\\\\').replaceAll('_', '\\_').replaceAll('%', '\\%');

/**
 * The preprocessors that serve a wrapper schema, found by what they say they serve.
 *
 * A generated preprocessor carries its configuration in its own source, so this
 * reads that rather than guessing from a name — and a name would be a guess,
 * since the generator takes the preprocessor's schema and script name as free
 * parameters too.
 *
 * Both halves of the match matter. `['<schema>'] = true` is the entry in
 * `allowed_json_schemas`, which is what actually gates the rewriting, and looking
 * for the entry rather than the bare name is what stops `JSON_VIEW` matching
 * every package whose name begins with it. Naming the *helper* schema as well
 * rules out a preprocessor generated against a helper that is no longer the one
 * this wrapper reports — which is the shape a genuinely stale one has.
 *
 * Several may still qualify, and on a real instance several do: a package
 * regenerated into a new preprocessor schema leaves the old one installed and
 * both remain correct for that wrapper. So this returns them all, ordered, and
 * the caller picks deterministically.
 */
export const wrapperPreprocessorQuery = (publicSchema: string, helperSchema: string): string =>
  'SELECT SCRIPT_SCHEMA, SCRIPT_NAME FROM SYS.EXA_ALL_SCRIPTS' +
  " WHERE SCRIPT_TYPE = 'PREPROCESSOR'" +
  ` AND SCRIPT_TEXT LIKE ${quoteLiteral(`%['${likeLiteral(publicSchema)}'] = true%`)} ESCAPE '\\'` +
  ` AND SCRIPT_TEXT LIKE ${quoteLiteral(`%${likeLiteral(helperSchema)}%`)} ESCAPE '\\'` +
  ' ORDER BY SCRIPT_SCHEMA, SCRIPT_NAME';

/**
 * Where `exasol-semantic-views` publishes what it knows.
 *
 * Two schemas and both fixed, unlike the JSON wrapper's — the installer creates
 * them by these names and the docs address them by these names, so this is a
 * contract rather than a convention worth second-guessing. Reading
 * `PRODUCT_VERSION` is therefore the whole of the detection: the query either
 * answers or the layer is not installed here, which is the ordinary case.
 */
export const SEMANTIC_CATALOG_SCHEMA = 'SEMANTIC_CATALOG';
export const SEMANTIC_AGENT_SCHEMA = 'SEMANTIC_AGENT';
export const SEMANTIC_ADMIN_SCHEMA = 'SEMANTIC_ADMIN';

/**
 * Turns semantic SQL into physical SQL, and returns it rather than running it.
 *
 * The layer's own answer for a tool that cannot set a session preprocessor,
 * which is exactly Panorama's position: Exasol allows one preprocessor per
 * session and the JSON wrapper machinery already uses that slot.
 *
 * It is also the only correct answer for a box, for a reason that has nothing to
 * do with the slot. Panorama derives further queries from a statement — column
 * statistics, a histogram, the frequency bars — by wrapping it as
 * `(statement) AS "panorama_source"`. Under the preprocessor those get rewritten
 * a second time: measured against a live instance, `SELECT COUNT(*)` over a
 * three-row statement came back **1**, and the summary and frequency queries
 * failed outright. Compiling first means everything derived is derived from
 * ordinary SQL the database handles normally.
 *
 * Nine columns come back; see `compileSemanticSql` for what is read from them.
 */
export const compileSemanticQuery = (statement: string): string =>
  `EXECUTE SCRIPT ${qualifiedName(SEMANTIC_ADMIN_SCHEMA, 'COMPILE_SQL')}` +
  `(${quoteLiteral(statement)})`;

/** Which build of the semantic layer is installed, if any. */
export const semanticVersionQuery = (): string =>
  `SELECT DISPLAY_VERSION FROM ${quoteIdentifier(SEMANTIC_CATALOG_SCHEMA)}."PRODUCT_VERSION"`;

/**
 * The models, published and not.
 *
 * Drafts are read too and marked as drafts rather than filtered out in SQL: a
 * draft is a real thing to show in an explorer, and it is *this* module's
 * business to know which schema each model would publish to — because a draft
 * whose published schema happens to name a real schema must not be allowed to
 * describe it. See `indexSemanticFields`.
 *
 * `UPDATED_AT` is the one currency signal available. Publishing a model stamps
 * it, so where two published models claim the same object the newer one is the
 * one whose `CREATE OR REPLACE VIEW` ran last — which is the view that is
 * actually there.
 */
export const semanticModelsQuery = (): string =>
  'SELECT MODEL_ID, MODEL_NAME, PUBLISHED_SCHEMA, DESCRIPTION, STATUS, UPDATED_AT' +
  ` FROM ${quoteIdentifier(SEMANTIC_CATALOG_SCHEMA)}."MODELS"` +
  ' ORDER BY UPDATED_AT, MODEL_ID';

/**
 * Every field of every semantic object, by the physical name it is published as.
 *
 * `SQL_OBJECT_NAME` and `SQL_COLUMN_NAME` are the upper-cased names the publish
 * step actually creates the view and its columns with — the lower-case
 * `OBJECT_NAME` and `COLUMN_NAME` beside them are the model author's spelling
 * and would match nothing in the catalogue. Verified against a published model:
 * the view's columns are exactly the `SQL_COLUMN_NAME`s.
 *
 * The model is identified rather than joined here, so that which models count is
 * decided once, in one place, against the models that were read.
 */
export const semanticFieldsQuery = (): string =>
  'SELECT MODEL_ID, SQL_OBJECT_NAME, SQL_COLUMN_NAME, FIELD_KIND, DISPLAY_NAME' +
  ', DESCRIPTION, FORMAT_HINT, UNIT_HINT, IS_CERTIFIED, SENSITIVITY_LABEL, FIELD_ID' +
  ` FROM ${quoteIdentifier(SEMANTIC_AGENT_SCHEMA)}."FIELDS_FOR_AGENT"` +
  ' ORDER BY MODEL_ID, SQL_OBJECT_NAME, ORDINAL_POSITION';

/**
 * What each metric is and how it combines.
 *
 * `FIELDS_FOR_AGENT` says a field is a metric; it does not say whether the metric
 * is a sum, an average, or something that cannot be aggregated at all. That is
 * here, and it is the difference between a chart editor that offers `sum` on a
 * margin percentage and one that knows better.
 */
export const semanticMetricsQuery = (): string =>
  'SELECT MODEL_ID, METRIC_ID, METRIC_KIND, AGGREGATION_FUNCTION' +
  ` FROM ${quoteIdentifier(SEMANTIC_CATALOG_SCHEMA)}."METRICS"`;

/**
 * The metric × dimension pairs the model says are **not** safe.
 *
 * Only the invalid ones. The matrix is exhaustive per model, so a pair missing
 * from it is a pair the model has nothing to say about — a metric and a dimension
 * from two different objects, say — and reading the valid rows as well would be
 * to carry a row per pair to learn nothing. What a chart editor needs is exactly
 * the list of pairings to refuse, with the model's reason for refusing.
 *
 * This is the correctness half of the semantic layer rather than the decoration:
 * `total_freight` by `product_category` is freight charged on an order header
 * attributed across that order's lines, which multiplies it. Panorama would draw
 * that today, and it would look entirely plausible.
 */
export const semanticInvalidPairsQuery = (): string =>
  'SELECT MODEL_ID, METRIC_ID, DIMENSION_ID, REASON_CODE, RELATIONSHIP_PATH' +
  ` FROM ${quoteIdentifier(SEMANTIC_CATALOG_SCHEMA)}."METRIC_DIMENSION_MATRIX"` +
  ' WHERE IS_VALID = FALSE';

/**
 * The marker that says a script is a JSON-tables compiler, and what it serves.
 *
 * `exasol-json-tables` now installs `COMPILE_SQL` — text in, physical SQL out,
 * no session state — which is the same answer `exasol-semantic-views` gives, and
 * the one that removes Exasol's single-preprocessor slot from the picture
 * entirely. Installed with no `--wrapper-schema` it serves *every* package on the
 * database, so one statement may span two of them: a thing one session
 * preprocessor cannot express and which this integration had written off.
 *
 * Found by a marker in the script body rather than by name, because the name is
 * a free parameter of the installer **and** because `SEMANTIC_ADMIN.COMPILE_SQL`
 * is a different compiler for a different language that happens to share it.
 * `ALLOWED_SCHEMAS_JSON` is a generated identifier rather than prose, so it does
 * not move when somebody rewrites a comment — and the same line carries the list
 * of wrapper schemas the script was built for, which is what decides whether it
 * can compile a given statement at all.
 */
export const WRAPPER_COMPILER_MARKER = 'ALLOWED_SCHEMAS_JSON';

export const wrapperCompilerQuery = (): string =>
  'SELECT SCRIPT_SCHEMA, SCRIPT_NAME' +
  `, REGEXP_SUBSTR(SCRIPT_TEXT, ${quoteLiteral(`${WRAPPER_COMPILER_MARKER} = [^`)} || CHR(10) || ']*')` +
  ' FROM SYS.EXA_ALL_SCRIPTS' +
  ` WHERE SCRIPT_TEXT LIKE ${quoteLiteral(`%${WRAPPER_COMPILER_MARKER}%`)}` +
  ' ORDER BY SCRIPT_SCHEMA, SCRIPT_NAME';

/** Compiles one JSON-tables statement into physical SQL. */
export const compileWrapperQuery = (schema: string, script: string, statement: string): string =>
  `EXECUTE SCRIPT ${qualifiedName(schema, script)}(${quoteLiteral(statement)})`;

/**
 * Points the session's SQL preprocessor at one script, or at none.
 *
 * Session state, and the reason it is set per statement rather than once: Exasol
 * allows one preprocessor per session, so a canvas with boxes from two wrapper
 * packages cannot have both — but the setting is cheap to change (about two
 * milliseconds) and a statement can carry its own. See `openResultSet`.
 */
export const setPreprocessorStatement = (script: string | null): string =>
  `ALTER SESSION SET SQL_PREPROCESSOR_SCRIPT = ${script ?? 'null'}`;

/**
 * Whether a statement names a schema, quoted or not, as a whole word.
 *
 * Exasol folds an unquoted identifier to upper case, so both spellings have to be
 * looked for; and the boundary check is what stops `JSON_VIEW` matching a
 * statement that only mentions `JSON_VIEW_ARCHIVE`.
 *
 * Here rather than beside either caller because both the JSON wrapper and the
 * semantic layer ask exactly this question of a statement, and two copies of a
 * regular expression this fiddly would drift.
 */
export const statementNamesSchema = (statement: string, schema: string): boolean => {
  const quoted = `"${schema}"`;
  if (statement.includes(quoted)) return true;
  const bare = new RegExp(`(^|[^A-Z0-9_$"])${escapeForRegExp(schema)}\\s*\\.`, 'u');
  return bare.test(statement.toUpperCase());
};

const escapeForRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');

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
