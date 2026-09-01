import { describe, expect, it } from 'vitest';
import type { ExasolValue } from '@panorama/exasol';
import {
  compileSemanticQuery,
  compileSemanticSql,
  compilesSemantically,
  semanticProvenance,
  semanticSchemas,
  statementNamesSchema,
} from '@panorama/exasol';

/**
 * Turning semantic SQL into SQL the database will run.
 *
 * A published semantic object is a stub view of `SEMANTIC_GUARD()` calls, so a
 * statement reading one has to be rewritten before it means anything. Panorama
 * compiles rather than setting the layer's session preprocessor, and the reason
 * is measured: under the preprocessor, `SELECT COUNT(*)` over a three-row
 * statement came back **1** and the summary and frequency queries failed
 * outright, because Panorama derives those by wrapping the statement in a
 * subquery and the preprocessor rewrites the wrapper too.
 *
 * What is checked here is the reading of the nine columns that come back, and —
 * as much — that a refusal survives as a refusal, in the layer's own words.
 */

/** The nine columns `COMPILE_SQL` answers with, one row. */
const answer = (values: {
  status?: ExasolValue;
  code?: ExasolValue;
  message?: ExasolValue;
  sql?: ExasolValue;
  plan?: ExasolValue;
  clarification?: ExasolValue;
}): readonly (readonly ExasolValue[])[] => [
  [values.status ?? 'OK'],
  [values.code ?? null],
  [values.message ?? null],
  ['the original'],
  [values.sql ?? null],
  [values.plan ?? null],
  [values.clarification ?? null],
  [1],
  [null],
];

const answering =
  (columns: readonly (readonly ExasolValue[])[] | Error) =>
  async (): Promise<readonly (readonly ExasolValue[])[]> => {
    if (columns instanceof Error) throw columns;
    return columns;
  };

const PLAN = JSON.stringify({
  model: 'sales',
  object: 'SALES',
  metrics: ['total_revenue'],
  dimensions: ['customer_region'],
  relationship_paths: ['order_line_to_order > order_to_customer'],
  selected_materialization: {
    physical_schema: 'MART',
    physical_object: 'SALES_REVENUE_BY_REGION',
  },
  warnings: [],
});

describe('the script it calls', () => {
  it('passes the statement as a literal, quotes doubled', () => {
    expect(compileSemanticQuery("SELECT 'a' FROM X")).toBe(
      `EXECUTE SCRIPT "SEMANTIC_ADMIN"."COMPILE_SQL"('SELECT ''a'' FROM X')`,
    );
  });
});

describe('compiling', () => {
  it('hands back the physical SQL and what it says about it', async () => {
    const result = await compileSemanticSql(
      answering(answer({ sql: 'SELECT 1 FROM "MART"."ORDER_LINES"', plan: PLAN })),
      'SELECT total_revenue FROM SEMANTIC_SALES.SALES',
    );
    expect(result.status).toBe('ok');
    expect(result.sql).toBe('SELECT 1 FROM "MART"."ORDER_LINES"');
    expect(result.plan).toEqual({
      model: 'sales',
      object: 'SALES',
      metrics: ['total_revenue'],
      dimensions: ['customer_region'],
      paths: ['order_line_to_order > order_to_customer'],
      materialization: 'MART.SALES_REVENUE_BY_REGION',
      warnings: [],
    });
  });

  /**
   * Not a failure — a negotiation. The layer names the field it did not know,
   * the object it actually belongs to, and what else would have worked, and those
   * are better words than any Panorama could write about somebody else's model.
   */
  it('carries a refusal through in the layer’s own words', async () => {
    const result = await compileSemanticSql(
      answering(
        answer({
          status: 'NEEDS_CLARIFICATION',
          code: 'SEMANTIC_QUERY_020',
          message: 'Unknown semantic field: total_freight.',
          clarification: JSON.stringify({
            field: 'total_freight',
            available_in_objects: ['ORDER_HEADER'],
            clarification_question:
              'total_freight belongs to semantic view ORDER_HEADER. Query that view, or choose a field of SALES.',
          }),
        }),
      ),
      'SELECT total_freight FROM SEMANTIC_SALES.SALES',
    );
    expect(result.status).toBe('clarify');
    expect(result.code).toBe('SEMANTIC_QUERY_020');
    expect(result.question).toContain('Query that view');
    expect(result.sql).toBeUndefined();
  });

  it('reports an outright error as one', async () => {
    const result = await compileSemanticSql(
      answering(answer({ status: 'ERROR', code: 'SEMANTIC_QUERY_050', message: 'LIMIT must be…' })),
      'SELECT * FROM SEMANTIC_SALES.SALES LIMIT 0',
    );
    expect(result).toEqual({
      status: 'error',
      code: 'SEMANTIC_QUERY_050',
      message: 'LIMIT must be…',
    });
  });

  /**
   * The caller is on its way to running a statement and needs a sentence to
   * show, not an exception to translate — so a compiler that is not installed,
   * or not granted, is an error like any other refusal.
   */
  it('turns a failing call into an error rather than throwing', async () => {
    const result = await compileSemanticSql(
      answering(new Error('object COMPILE_SQL not found')),
      'SELECT 1',
    );
    expect(result).toEqual({ status: 'error', message: 'object COMPILE_SQL not found' });
  });

  it('refuses to run an OK with no SQL behind it', async () => {
    const result = await compileSemanticSql(answering(answer({ status: 'OK' })), 'SELECT 1');
    expect(result.status).toBe('error');
  });

  it('treats a status it has never heard of as an error', async () => {
    const result = await compileSemanticSql(
      answering(answer({ status: 'DEFERRED', sql: 'SELECT 1' })),
      'SELECT 1',
    );
    expect(result.status).toBe('error');
  });

  /** A plan it cannot read costs the provenance line; the rows are the point. */
  it('runs the statement even when the plan is unreadable', async () => {
    const result = await compileSemanticSql(
      answering(answer({ sql: 'SELECT 1', plan: 'not json at all' })),
      'SELECT 1',
    );
    expect(result.status).toBe('ok');
    expect(result.plan).toBeUndefined();
  });

  it('survives a plan that is json but not an object', async () => {
    const result = await compileSemanticSql(
      answering(answer({ sql: 'SELECT 1', plan: '42' })),
      'x',
    );
    expect(result.plan).toBeUndefined();
  });
});

describe('the provenance line', () => {
  const plan = {
    model: 'sales',
    metrics: [],
    dimensions: [],
    paths: ['order_line_to_order > order_to_customer'],
    materialization: 'MART.SALES_REVENUE_BY_REGION',
    warnings: [],
  };

  it('says who answered, which joins it took, and what it read', () => {
    expect(semanticProvenance(plan)).toBe(
      'sales · via order_line_to_order → order_to_customer · from MART.SALES_REVENUE_BY_REGION',
    );
  });

  it('counts the paths where naming them all would be a join graph', () => {
    const { materialization: _read, ...base } = plan;
    expect(semanticProvenance({ ...base, paths: ['a', 'b', 'c'] })).toBe(
      'sales · 3 join paths · from the base tables',
    );
  });

  it('says nothing it has not been told', () => {
    expect(semanticProvenance(undefined)).toBeUndefined();
    expect(semanticProvenance({ metrics: [], dimensions: [], paths: [], warnings: [] })).toBe(
      'from the base tables',
    );
  });

  it('admits a warning rather than drawing a clean line over one', () => {
    expect(semanticProvenance({ ...plan, warnings: ['stale statistics'] })).toContain('1 warning');
    expect(semanticProvenance({ ...plan, warnings: ['a', 'b'] })).toContain('2 warnings');
  });
});

describe('deciding whether a statement needs compiling', () => {
  const index = new Map([
    ['SEMANTIC_SALES.SALES', new Map()],
    ['SEMANTIC_SALES.ORDER_HEADER', new Map()],
    ['SEMANTIC_SALES_DBX.SALES_DBX', new Map()],
  ]);

  it('knows the published schemas it describes, once each', () => {
    expect(semanticSchemas(index)).toEqual(['SEMANTIC_SALES', 'SEMANTIC_SALES_DBX']);
  });

  it('is decided by what the FROM names, quoted or not', () => {
    expect(compilesSemantically(index, 'SELECT * FROM "SEMANTIC_SALES"."SALES"')).toBe(true);
    expect(compilesSemantically(index, 'select total_revenue from semantic_sales.sales')).toBe(
      true,
    );
    expect(compilesSemantically(index, 'SELECT * FROM MART.ORDER_LINES')).toBe(false);
    expect(compilesSemantically(new Map(), 'SELECT * FROM SEMANTIC_SALES.SALES')).toBe(false);
  });

  /**
   * `SEMANTIC_SALES` is a prefix of `SEMANTIC_SALES_DBX`, so the boundary check
   * is doing real work here rather than guarding a hypothetical.
   */
  it('is not fooled by a schema whose name is a prefix of another', () => {
    expect(statementNamesSchema('SELECT * FROM SEMANTIC_SALES_ARCHIVE.X', 'SEMANTIC_SALES')).toBe(
      false,
    );
    expect(compilesSemantically(index, 'SELECT * FROM SEMANTIC_SALES_DBX.SALES_DBX')).toBe(true);
  });
});
