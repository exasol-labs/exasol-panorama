import type { ExasolValue } from '../protocol/messages.js';
import { compileSemanticQuery, statementNamesSchema } from '../protocol/sql.js';
import type { QueryRows } from './json-wrapper.js';
import type { SemanticIndex } from './semantic-surface.js';

/**
 * Turning semantic SQL into SQL the database will run.
 *
 * A published semantic object is not a table. It is a stub view whose every
 * column is `SEMANTIC_ADMIN.SEMANTIC_GUARD()`, so reading one directly raises
 * `SEMANTIC_SURFACE_001` and says what to do about it. Something has to rewrite
 * the statement, and there are exactly two ways: set the layer's session
 * preprocessor, or call `COMPILE_SQL` and run what comes back.
 *
 * Panorama compiles, for two reasons that are independent of each other.
 *
 * The first is the session slot: Exasol allows one preprocessor per session and
 * the JSON wrapper machinery already uses it, so a canvas with a document box and
 * a semantic box beside it could not have both.
 *
 * The second is the one that settles it, and it was measured rather than
 * reasoned. Panorama derives further queries from a box's statement — the column
 * statistics, the histogram, the frequency bars — by wrapping it as
 * `(statement) AS "panorama_source"`. The preprocessor rewrites that wrapper too:
 * against a live instance, `SELECT COUNT(*)` over a statement returning three
 * rows came back **1**, and the summary and frequency queries failed outright. A
 * wrong count with no error is the worst failure available to us. Compiled SQL is
 * ordinary SQL, so everything derived from it is derived from something the
 * database handles normally.
 */

/** What the compiler made of a statement. */
export type SemanticCompileStatus = 'ok' | 'clarify' | 'error';

/** Where a compiled statement's numbers come from, in the plan's own terms. */
export interface SemanticPlan {
  readonly model?: string;
  readonly object?: string;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  /** `order_line_to_order > order_to_customer` — the joins it proved it needed. */
  readonly paths: readonly string[];
  /** The rollup it chose to read instead of the base tables, where it chose one. */
  readonly materialization?: string;
  readonly warnings: readonly string[];
}

export interface SemanticCompilation {
  readonly status: SemanticCompileStatus;
  /** The physical SQL to run. Present only when the status is `ok`. */
  readonly sql?: string;
  readonly code?: string;
  readonly message?: string;
  /**
   * What the layer asks the reader to decide, where it refused.
   *
   * A `NEEDS_CLARIFICATION` is a negotiation rather than a failure: it names the
   * field it did not recognise, the object the field actually belongs to, and
   * what else would have worked. Carried through as the layer's own words —
   * "total_freight belongs to semantic view ORDER_HEADER. Query that view, or
   * choose a field of SALES." — because they are better than any sentence
   * Panorama could write about somebody else's model.
   */
  readonly question?: string;
  readonly plan?: SemanticPlan;
}

const text = (value: ExasolValue | undefined): string | null =>
  value === null || value === undefined ? null : String(value);

const STATUSES: Readonly<Record<string, SemanticCompileStatus>> = {
  OK: 'ok',
  NEEDS_CLARIFICATION: 'clarify',
  ERROR: 'error',
};

/** JSON from a catalogue column, or nothing when it is absent or malformed. */
const parsed = (value: ExasolValue | undefined): Record<string, unknown> | undefined => {
  const raw = text(value);
  if (raw === null) return undefined;
  try {
    const object: unknown = JSON.parse(raw);
    return typeof object === 'object' && object !== null
      ? (object as Record<string, unknown>)
      : undefined;
  } catch {
    // A plan Panorama cannot read costs the provenance line and nothing else.
    // The statement still compiled, and the rows are the point.
    return undefined;
  }
};

const strings = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

const readPlan = (plan: Record<string, unknown> | undefined): SemanticPlan | undefined => {
  if (plan === undefined) return undefined;
  const chosen = plan['selected_materialization'];
  const materialization =
    typeof chosen === 'object' && chosen !== null
      ? qualified(chosen as Record<string, unknown>)
      : undefined;
  return {
    ...(typeof plan['model'] === 'string' ? { model: plan['model'] } : {}),
    ...(typeof plan['object'] === 'string' ? { object: plan['object'] } : {}),
    metrics: strings(plan['metrics']),
    dimensions: strings(plan['dimensions']),
    paths: strings(plan['relationship_paths']),
    ...(materialization === undefined ? {} : { materialization }),
    warnings: strings(plan['warnings']),
  };
};

const qualified = (materialization: Record<string, unknown>): string | undefined => {
  const schema = materialization['physical_schema'];
  const object = materialization['physical_object'];
  if (typeof object !== 'string') return undefined;
  return typeof schema === 'string' ? `${schema}.${object}` : object;
};

/**
 * Compiles one statement, and reports a refusal as a refusal.
 *
 * Nine columns come back — status, error code, message, the original SQL, the
 * generated SQL, the plan, the clarification, and two run ids. Everything read
 * here is read by position because that is the order the script documents; a
 * column the build has since added or moved is a column this ignores.
 *
 * A compile that itself fails — the script is not there, the user has no grant on
 * it — is reported as an `error`, not thrown. The caller is on its way to running
 * a statement and needs a sentence to show, not an exception to translate.
 */
export const compileSemanticSql = async (
  query: QueryRows,
  statement: string,
): Promise<SemanticCompilation> => {
  const columns = await query(compileSemanticQuery(statement)).catch((error: unknown) => error);
  if (!Array.isArray(columns)) {
    return { status: 'error', message: messageOf(columns) };
  }
  const rows = columns as ReadonlyArray<readonly ExasolValue[]>;
  const status = STATUSES[String(text(rows[0]?.[0]))];
  const sql = text(rows[4]?.[0]);
  const plan = readPlan(parsed(rows[5]?.[0]));
  const clarification = parsed(rows[6]?.[0]);
  const question = clarification?.['clarification_question'];
  const code = text(rows[1]?.[0]);
  const message = text(rows[2]?.[0]);
  const detail = {
    ...(code === null ? {} : { code }),
    ...(message === null ? {} : { message }),
    ...(typeof question === 'string' ? { question } : {}),
    ...(plan === undefined ? {} : { plan }),
  };
  // A status this build does not know, or an `OK` with no SQL behind it, is not
  // something to run on the strength of a guess.
  if (status !== 'ok' || sql === null) {
    return { status: status === 'ok' || status === undefined ? 'error' : status, ...detail };
  }
  return { status: 'ok', sql, ...detail };
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The one line a box can show about where its numbers came from.
 *
 * Panorama already draws a provenance line under a chart for agents; this is the
 * same idea for people, and the material is far better than anything derivable
 * from SQL: which model answered, which joins it proved it needed, and whether it
 * read the base tables or a rollup somebody built for exactly this question.
 *
 * Short on purpose. The plan holds a great deal more and all of it is available
 * to an agent; a line under a box is not where a reader wants a join graph.
 */
export const semanticProvenance = (plan: SemanticPlan | undefined): string | undefined => {
  if (plan === undefined) return undefined;
  const parts: string[] = [];
  if (plan.model !== undefined) parts.push(plan.model);
  if (plan.paths.length === 1) parts.push(`via ${(plan.paths[0] as string).replaceAll('>', '→')}`);
  else if (plan.paths.length > 1) parts.push(`${plan.paths.length} join paths`);
  parts.push(
    plan.materialization === undefined ? 'from the base tables' : `from ${plan.materialization}`,
  );
  if (plan.warnings.length > 0) {
    parts.push(`${plan.warnings.length} warning${plan.warnings.length === 1 ? '' : 's'}`);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
};

/**
 * Whether a statement reads a published semantic object, and so must be compiled.
 *
 * Asked of the statement rather than of the box, for the same reason the wrapper
 * preprocessor is: a query box's statement is text somebody wrote, its own schema
 * is a label, and what decides this is which schema the `FROM` actually names.
 *
 * A scan over a closed set — the published schemas on this connection, which is a
 * handful — and `false` for every ordinary statement, which is almost all of them.
 */
export const compilesSemantically = (index: SemanticIndex, statement: string): boolean => {
  for (const schema of semanticSchemas(index)) {
    if (statementNamesSchema(statement, schema)) return true;
  }
  return false;
};

/** The published schemas the index describes, deduplicated and ordered. */
export const semanticSchemas = (index: SemanticIndex): readonly string[] =>
  [...new Set([...index.keys()].map((key) => key.slice(0, key.lastIndexOf('.'))))].sort();
