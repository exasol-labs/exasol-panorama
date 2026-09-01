import type { ExasolValue } from '../protocol/messages.js';
import {
  wrapperHelperSchemaQuery,
  wrapperPreprocessorQuery,
  wrapperRootsQuery,
} from '../protocol/sql.js';

/**
 * The JSON wrapper surface, as the database describes it.
 *
 * `exasol-json-tables` can install a *wrapper package* over a family of source
 * tables: a schema of views that present the document's properties rather than
 * the columns storing them, and a Lua session preprocessor that rewrites dotted
 * paths and array selectors written against those views. Where one exists, it is
 * the surface a statement should be written against — the view's columns are the
 * ones a document box is already showing, and the source table's are not.
 *
 * Everything here is asked of the catalogue rather than derived from names. The
 * generator takes the source, wrapper, helper and preprocessor schemas as free
 * parameters, so `X_SRC` / `X_VIEW` is one installation's habit and not a
 * contract. The one fixed point is the metadata table the wrapper publishes, and
 * that is what this looks for.
 */

/** What a wrapper package offers for one document root. */
export interface WrapperView {
  /** The source schema and root table it wraps. */
  readonly sourceSchema: string;
  readonly rootTable: string;
  /** The view to select from, which needs no preprocessor to read. */
  readonly schema: string;
  readonly view: string;
  /** Where the package keeps its own metadata; part of matching a preprocessor. */
  readonly helperSchema: string;
  /**
   * The preprocessor that makes the dotted paths work, where one was found.
   *
   * Absent is a usable state, not a broken one: the view still reads, and only
   * the path and array syntax is unavailable. Said rather than guessed at.
   */
  readonly preprocessor?: string;
}

/** Every wrapper on a connection, by the source table it wraps. */
export type WrapperSurface = ReadonlyMap<string, WrapperView>;

/** How a source table is keyed here, and by whoever looks one up. */
export const wrapperKey = (schema: string, table: string): string => `${schema}.${table}`;

/** Runs a metadata query and hands back its columns. */
export type QueryRows = (sql: string) => Promise<ReadonlyArray<readonly ExasolValue[]>>;

const text = (value: ExasolValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

/**
 * Reads every wrapper package installed on the connection.
 *
 * Two round trips plus one per package, run once and remembered: this is
 * catalogue state that does not change while somebody is reading, and a wrapper
 * being installed mid-session is worth a reconnect rather than a poll.
 *
 * A package that cannot be read is skipped rather than fatal. A helper schema
 * the user cannot select from, or one left behind by a half-removed package, is
 * a reason to have no wrapper for those tables — not a reason for the connection
 * to fail.
 */
export const readWrapperSurface = async (query: QueryRows): Promise<WrapperSurface> => {
  const found = new Map<string, WrapperView>();
  const helpers = await query(wrapperHelperSchemaQuery()).catch(() => []);
  const schemas = (helpers[0] ?? []).map(text).filter((name): name is string => name !== null);

  for (const helper of schemas) {
    const roots = await query(wrapperRootsQuery(helper)).catch(() => []);
    const rows = roots[0]?.length ?? 0;
    for (let row = 0; row < rows; row += 1) {
      const rootTable = text(roots[0]?.[row]);
      const sourceSchema = text(roots[1]?.[row]);
      const schema = text(roots[2]?.[row]);
      const view = text(roots[3]?.[row]);
      if (rootTable === null || sourceSchema === null || schema === null || view === null) continue;
      found.set(wrapperKey(sourceSchema, rootTable), {
        sourceSchema,
        rootTable,
        schema,
        view,
        helperSchema: helper,
      });
    }
  }

  // One lookup per wrapper *schema*, not per view: a package publishes many
  // views and one preprocessor serves all of them.
  const candidates = new Map<string, readonly string[]>();
  for (const entry of found.values()) {
    if (candidates.has(entry.schema)) continue;
    candidates.set(entry.schema, await preprocessorsFor(query, entry.schema, entry.helperSchema));
  }
  const chosen = widestPerSchema(candidates);
  return new Map(
    [...found].map(([key, entry]) => {
      const script = chosen.get(entry.schema);
      return [key, script === undefined ? entry : { ...entry, preprocessor: script }];
    }),
  );
};

/**
 * The preprocessors that qualify for a wrapper schema, in catalogue order.
 *
 * Several legitimately do. Regenerating a package into a new preprocessor schema
 * leaves the old one installed and both stay correct for that wrapper — five
 * serve `JSON_VIEW` on the instance this was written against. What the query has
 * already ruled out is the case where choosing would be *wrong*: a preprocessor
 * scoped to a helper schema this wrapper no longer reports.
 */
const preprocessorsFor = async (
  query: QueryRows,
  publicSchema: string,
  helperSchema: string,
): Promise<readonly string[]> => {
  const scripts = await query(wrapperPreprocessorQuery(publicSchema, helperSchema)).catch(() => []);
  const rows = scripts[0]?.length ?? 0;
  const names: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const schema = text(scripts[0]?.[row]);
    const name = text(scripts[1]?.[row]);
    if (schema !== null && name !== null) names.push(`${quote(schema)}.${quote(name)}`);
  }
  return names;
};

/**
 * Picks, for each wrapper schema, the preprocessor that covers the most of them.
 *
 * This is the whole answer to Exasol's one-preprocessor-per-session rule. A
 * *combined* preprocessor is scoped to several wrapper packages at once, and where
 * one is installed it appears as a candidate for every schema it covers — so the
 * script named by the most schemas is the broadest, and choosing it means boxes
 * from different packages need no switching between them at all. Verified on a
 * live instance: one script serving two Mongo-backed packages, dotted paths
 * working on both in one session.
 *
 * How wide a script is comes from which schemas offered it, not from reading its
 * configuration — the counting is over data already collected, and nothing here
 * parses somebody else's generated Lua.
 *
 * Ties go to the first name, so the choice is stable across sessions: a canvas
 * that reopens should not silently start switching where it did not before.
 */
const widestPerSchema = (
  candidates: ReadonlyMap<string, readonly string[]>,
): ReadonlyMap<string, string> => {
  const coverage = new Map<string, number>();
  for (const scripts of candidates.values()) {
    for (const script of scripts) coverage.set(script, (coverage.get(script) ?? 0) + 1);
  }
  const chosen = new Map<string, string>();
  for (const [schema, scripts] of candidates) {
    const best = [...scripts].sort(
      (left, right) =>
        (coverage.get(right) ?? 0) - (coverage.get(left) ?? 0) || left.localeCompare(right),
    )[0];
    if (best !== undefined) chosen.set(schema, best);
  }
  return chosen;
};

/**
 * Quoted, because a script name is an identifier and the setting takes one.
 *
 * `ALTER SESSION SET SQL_PREPROCESSOR_SCRIPT` is not a string parameter — it
 * names a script — so a lower-case or reserved-word name has to survive the
 * round trip as itself.
 */
const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The wrapper for a source table, where there is one. */
export const wrapperFor = (
  surface: WrapperSurface | null,
  schema: string,
  table: string,
): WrapperView | undefined => surface?.get(wrapperKey(schema, table));

/**
 * The wrapper whose *published* schema this is, where a statement reads one.
 *
 * The other direction, and the one a running statement needs: a box's SQL names
 * `"X_VIEW"."orders"`, and what has to be worked out from that is which
 * preprocessor to set. Keyed on the schema alone, since one package's
 * preprocessor serves every view it publishes.
 */
export const preprocessorForSchema = (
  surface: WrapperSurface | null,
  schema: string,
): string | undefined => {
  for (const entry of surface?.values() ?? []) {
    if (entry.schema === schema) return entry.preprocessor;
  }
  return undefined;
};

/**
 * The preprocessor a statement needs, found by which wrapper schema it reads.
 *
 * The statement is the only thing that can be asked. A box's *source* is not
 * enough: a query box's statement is text somebody wrote, its own schema is a
 * label rather than a schema, and what decides whether the dotted paths have to
 * be rewritten is which schema the `FROM` actually names.
 *
 * A scan, but over a closed set — the wrapper schemas installed on this
 * connection, which is a handful — and matched on a word boundary so a schema
 * whose name is a prefix of another is not picked by mistake. `undefined` for
 * every ordinary statement, which is almost all of them.
 *
 * Where a statement names *two* wrapper schemas, the first by name wins and the
 * other is unreachable: Exasol allows one preprocessor per session, so joining
 * two wrapper surfaces in one statement is a thing the database cannot do rather
 * than a thing this chooses badly. It reports that itself, as a scope error
 * naming the schema it would not rewrite.
 */
export const preprocessorForStatement = (
  surface: WrapperSurface | null,
  statement: string,
): string | undefined => {
  const schemas = [...new Set([...(surface?.values() ?? [])].map((entry) => entry.schema))].sort();
  for (const schema of schemas) {
    if (namesSchema(statement, schema)) return preprocessorForSchema(surface, schema);
  }
  return undefined;
};

/**
 * Whether a statement names a schema, quoted or not, as a whole word.
 *
 * Exasol folds an unquoted identifier to upper case, so both spellings have to be
 * looked for; and the boundary check is what stops `JSON_VIEW` matching a
 * statement that only mentions `JSON_VIEW_ARCHIVE`.
 */
const namesSchema = (statement: string, schema: string): boolean => {
  const quoted = `"${schema}"`;
  if (statement.includes(quoted)) return true;
  const bare = new RegExp(`(^|[^A-Z0-9_$"])${escapeForRegExp(schema)}\\s*\\.`, 'u');
  return bare.test(statement.toUpperCase());
};

const escapeForRegExp = (value: string): string => value.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&');
