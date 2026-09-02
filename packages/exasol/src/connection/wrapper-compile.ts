import type { ExasolValue } from '../protocol/messages.js';
import {
  compileWrapperQuery,
  statementNamesSchema,
  wrapperCompilerQuery,
} from '../protocol/sql.js';
import type { QueryRows } from './json-wrapper.js';

/**
 * Compiling JSON-tables SQL instead of setting a session preprocessor.
 *
 * The wrapper surface's dotted paths and array selectors were, until recently,
 * only reachable through a Lua **session** preprocessor — and Exasol allows one
 * per session, which is why Panorama sets it per statement and why finding the
 * right one meant grepping generated Lua out of `EXA_ALL_SCRIPTS`.
 *
 * `exasol-json-tables` now ships `COMPILE_SQL`: the same rewriter reached as an
 * ordinary script, text in and physical SQL out. Where it is installed this is
 * the better path, and for three reasons that are independent of each other.
 *
 * **No session state**, so nothing contends for the slot and nothing has to be
 * set and unset around each statement.
 *
 * **No Lua to grep.** The preprocessor was found by matching a configuration
 * entry inside somebody else's generated script — a technique that once matched
 * twenty of one instance's thirty-two preprocessors — and a compiler is found by
 * a generated identifier that also states what it serves.
 *
 * **One statement may span two packages.** Installed with no `--wrapper-schema`
 * the script serves every package on the database, which one preprocessor per
 * session cannot do. This integration had written that off as a thing the
 * database could not express; it now can.
 *
 * Absent is an ordinary state, not a broken one: where no compiler is installed
 * the per-statement preprocessor still does the work.
 */

/** A compiler script, and the wrapper schemas it was built to serve. */
export interface WrapperCompiler {
  readonly schema: string;
  readonly script: string;
  /**
   * The packages this script can rewrite for.
   *
   * Carried because a compiler installed for one package cannot compile another's
   * statement, and finding that out by asking it costs a round trip and produces
   * an error where the preprocessor would have worked.
   */
  readonly serves: readonly string[];
}

/** What the compiler made of a statement. */
export interface WrapperCompilation {
  readonly status: 'ok' | 'error';
  /** The physical SQL to run. Present only when the status is `ok`. */
  readonly sql?: string;
  /** `JVS-PATH-ERROR` and the like. */
  readonly code?: string;
  readonly message?: string;
  /** True where the statement actually named a package; see `PLAN_JSON`. */
  readonly rewritten?: boolean;
  /** The packages the statement reached, for the provenance line. */
  readonly packages: readonly string[];
  /** The contract version the compiler was generated against. */
  readonly contractVersion?: number;
}

const text = (value: ExasolValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

const parsed = (raw: string | null): Record<string, unknown> | undefined => {
  if (raw === null) return undefined;
  try {
    const object: unknown = JSON.parse(raw);
    return typeof object === 'object' && object !== null
      ? (object as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The wrapper schemas a compiler line names.
 *
 * The line is Lua — `ALLOWED_SCHEMAS_JSON = '["A","B"]'` — so the JSON is the
 * part between the first quote and the last. Read leniently: a script whose
 * generated shape has moved on is a script this does not recognise, which is the
 * same answer as no compiler and leaves the preprocessor doing the work.
 */
const servedSchemas = (line: string | null): readonly string[] => {
  if (line === null) return [];
  const opens = line.indexOf("'");
  const closes = line.lastIndexOf("'");
  if (opens < 0 || closes <= opens) return [];
  try {
    const listed: unknown = JSON.parse(line.slice(opens + 1, closes));
    return Array.isArray(listed)
      ? listed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    return [];
  }
};

/**
 * Every JSON-tables compiler installed, with what each one serves.
 *
 * One query, and it names both halves — which is the whole improvement over
 * finding a preprocessor. A script that names no schemas is skipped: it can
 * compile nothing, so offering it would only turn a working preprocessor path
 * into a refusal.
 */
export const readWrapperCompilers = async (
  query: QueryRows,
): Promise<readonly WrapperCompiler[]> => {
  const rows = await query(wrapperCompilerQuery()).catch(() => []);
  const found: WrapperCompiler[] = [];
  for (let row = 0; row < (rows[0]?.length ?? 0); row += 1) {
    const schema = text(rows[0]?.[row]);
    const script = text(rows[1]?.[row]);
    const serves = servedSchemas(text(rows[2]?.[row]));
    if (schema === null || script === null || serves.length === 0) continue;
    found.push({ schema, script, serves });
  }
  return found;
};

/**
 * The compiler that can rewrite this statement, where one can.
 *
 * Matched on the wrapper schema the statement names, the same way a preprocessor
 * is. Where more than one qualifies the **widest** wins, for the reason the
 * preprocessor choice has: a script serving every package is the one that can
 * also compile a statement spanning two of them, and choosing it means a canvas
 * never switches between compilers it did not need to.
 */
export const compilerForStatement = (
  compilers: readonly WrapperCompiler[],
  statement: string,
): WrapperCompiler | undefined =>
  [...compilers]
    .filter((compiler) => compiler.serves.some((schema) => statementNamesSchema(statement, schema)))
    .sort(
      (left, right) =>
        right.serves.length - left.serves.length ||
        `${left.schema}.${left.script}`.localeCompare(`${right.schema}.${right.script}`),
    )[0];

/**
 * Compiles one statement, and reports a refusal as a refusal.
 *
 * Seven columns — status, code, message, the original SQL, the generated SQL, the
 * plan, and the clarification. Read by position, which is the order the project
 * documents them in.
 *
 * A call that fails outright is an `error` rather than a throw, for the same
 * reason the semantic compiler's is: the caller is on its way to running a
 * statement and needs a sentence to show.
 */
export const compileWrapperSql = async (
  query: QueryRows,
  compiler: WrapperCompiler,
  statement: string,
): Promise<WrapperCompilation> => {
  const columns = await query(
    compileWrapperQuery(compiler.schema, compiler.script, statement),
  ).catch((error: unknown) => error);
  if (!Array.isArray(columns)) {
    return { status: 'error', packages: [], message: messageOf(columns) };
  }
  const rows = columns as ReadonlyArray<readonly ExasolValue[]>;
  const plan = parsed(text(rows[5]?.[0]));
  const referenced = plan?.['referencedPackages'];
  const packages = Array.isArray(referenced)
    ? referenced
        .map((entry) =>
          typeof entry === 'object' && entry !== null
            ? (entry as Record<string, unknown>)['publicSchema']
            : undefined,
        )
        .filter((schema): schema is string => typeof schema === 'string')
    : [];
  const version = plan?.['contractVersion'];
  const detail = {
    packages,
    ...(plan?.['rewritten'] === undefined ? {} : { rewritten: plan['rewritten'] === true }),
    ...(typeof version === 'number' ? { contractVersion: version } : {}),
  };
  const sql = text(rows[4]?.[0]);
  if (String(text(rows[0]?.[0])) !== 'OK' || sql === null) {
    const code = text(rows[1]?.[0]);
    // The clarification carries the same message with the offending path, and is
    // the better sentence where there is one.
    const clarification = parsed(text(rows[6]?.[0]));
    const said = clarification?.['message'] ?? text(rows[2]?.[0]);
    return {
      status: 'error',
      ...detail,
      ...(code === null ? {} : { code }),
      ...(typeof said === 'string' ? { message: said } : {}),
    };
  }
  return { status: 'ok', sql, ...detail };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** The one line a box can show about what its statement was compiled against. */
export const wrapperProvenance = (compiled: WrapperCompilation): string | undefined => {
  if (compiled.packages.length === 0) return undefined;
  const version =
    compiled.contractVersion === undefined ? [] : [`contract v${compiled.contractVersion}`];
  return ['exasol-json-tables', ...compiled.packages, ...version].join(' · ');
};
