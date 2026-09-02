import { describe, expect, it } from 'vitest';
import type { SemanticColumnView } from '@panorama/core';
import type { ExasolValue, SemanticSurface } from '@panorama/exasol';
import {
  EMPTY_SEMANTIC_INDEX,
  indexSemanticFields,
  readSemanticSurface,
  semanticColumnsFor,
  semanticFieldsQuery,
  semanticModelsQuery,
  semanticObjectKey,
  semanticRefusal,
  semanticVersionQuery,
} from '@panorama/exasol';

/**
 * Reading what a database's columns *mean*.
 *
 * `exasol-semantic-views` publishes it as ordinary views, so this is three plain
 * queries and the awkward part is not the reading — it is deciding **which model
 * describes which view**. Every case below was taken from a live instance: six
 * models sharing three published schemas, four of them claiming `SEMANTIC_SALES`
 * with only one published, and metrics whose author never set a display name.
 */

/** A query and its answer, column-oriented, as the driver hands them over. */
const answering = (
  answers: readonly (readonly [string, readonly (readonly ExasolValue[])[]])[],
): { query: (sql: string) => Promise<readonly (readonly ExasolValue[])[]>; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    query: async (sql) => {
      asked.push(sql);
      for (const [pattern, columns] of answers) if (sql.includes(pattern)) return columns;
      throw new Error(`object not found: ${sql}`);
    },
  };
};

/** `MODELS`, in the six columns the query asks for. */
const models = (
  rows: readonly (readonly [number, string, string, string | null, string])[],
): readonly (readonly ExasolValue[])[] => [
  rows.map((row) => row[0]),
  rows.map((row) => row[1]),
  rows.map((row) => row[2]),
  rows.map((row) => row[3]),
  rows.map((row) => row[4]),
  rows.map(() => '2026-09-01 12:00:00'),
];

/** One `FIELDS_FOR_AGENT` row, with the awkward parts defaulted away. */
interface FieldRow {
  readonly model: number;
  readonly field?: number;
  readonly object: string;
  readonly column: string;
  readonly kind?: string;
  readonly displayName?: string | null;
  readonly description?: string | null;
  readonly format?: string | null;
  readonly unit?: string | null;
  readonly certified?: ExasolValue;
  readonly sensitivity?: string | null;
}

const fields = (rows: readonly FieldRow[]): readonly (readonly ExasolValue[])[] => [
  rows.map((row) => row.model),
  rows.map((row) => row.object),
  rows.map((row) => row.column),
  rows.map((row) => row.kind ?? 'DIMENSION'),
  rows.map((row) => row.displayName ?? null),
  rows.map((row) => row.description ?? null),
  rows.map((row) => row.format ?? null),
  rows.map((row) => row.unit ?? null),
  rows.map((row) => row.certified ?? null),
  rows.map((row) => row.sensitivity ?? null),
  rows.map((row, index) => row.field ?? index + 1),
];

/** `METRICS`, in the four columns the query asks for. */
const metrics = (
  rows: readonly (readonly [number, number, string | null, string | null])[],
): readonly (readonly ExasolValue[])[] => [
  rows.map((row) => row[0]),
  rows.map((row) => row[1]),
  rows.map((row) => row[2]),
  rows.map((row) => row[3]),
];

/** The refused pairings, in the five columns the query asks for. */
const refusals = (
  rows: readonly (readonly [number, number, number, string | null, string | null])[],
): readonly (readonly ExasolValue[])[] => [
  rows.map((row) => row[0]),
  rows.map((row) => row[1]),
  rows.map((row) => row[2]),
  rows.map((row) => row[3]),
  rows.map((row) => row[4]),
];

const SALES_FIELDS: readonly FieldRow[] = [
  {
    model: 1,
    field: 1,
    object: 'SALES',
    column: 'TOTAL_REVENUE',
    kind: 'METRIC',
    displayName: 'Total Revenue',
    description: 'Net recognized revenue excluding tax',
    format: 'currency',
    certified: true,
  },
  {
    model: 1,
    field: 2,
    object: 'SALES',
    column: 'CUSTOMER_REGION',
    displayName: 'Customer Region',
  },
];

const surfaceFrom = async (
  modelRows: readonly (readonly ExasolValue[])[],
  fieldRows: readonly (readonly ExasolValue[])[],
  extra: {
    metricRows?: readonly (readonly ExasolValue[])[];
    refusalRows?: readonly (readonly ExasolValue[])[];
  } = {},
): Promise<SemanticSurface> => {
  const { query } = answering([
    ['PRODUCT_VERSION', [['0.1+dev']]],
    ['"MODELS"', modelRows],
    ['FIELDS_FOR_AGENT', fieldRows],
    ['"METRICS"', extra.metricRows ?? metrics([])],
    ['METRIC_DIMENSION_MATRIX', extra.refusalRows ?? refusals([])],
  ]);
  const surface = await readSemanticSurface(query);
  if (surface === null) throw new Error('expected a surface');
  return surface;
};

describe('the queries it asks', () => {
  /**
   * The lower-case `OBJECT_NAME` and `COLUMN_NAME` sitting beside these are the
   * model author's spelling; the publish step upper-cases both when it creates
   * the view, so those two would match nothing the catalogue ever returns.
   */
  it('asks for the names the views are actually created with', () => {
    const sql = semanticFieldsQuery();
    expect(sql).toContain('SQL_OBJECT_NAME');
    expect(sql).toContain('SQL_COLUMN_NAME');
    expect(sql).toContain('"SEMANTIC_AGENT"."FIELDS_FOR_AGENT"');
  });

  it('orders models by when they were last published', () => {
    expect(semanticModelsQuery()).toContain('ORDER BY UPDATED_AT, MODEL_ID');
  });

  it('detects the layer by asking it which build it is', () => {
    expect(semanticVersionQuery()).toBe(
      'SELECT DISPLAY_VERSION FROM "SEMANTIC_CATALOG"."PRODUCT_VERSION"',
    );
  });
});

describe('reading the surface', () => {
  /**
   * The ordinary answer. Nearly every connection has no semantic layer, and the
   * cost of finding that out has to be one failing lookup rather than three.
   */
  it('reports no layer, after one query, where there is none', async () => {
    const { query, asked } = answering([]);
    expect(await readSemanticSurface(query)).toBeNull();
    expect(asked).toHaveLength(1);
  });

  /** An empty `PRODUCT_VERSION` is a half-finished install, not a version. */
  it('reports no layer where the version view answers with nothing', async () => {
    const { query } = answering([['PRODUCT_VERSION', [[]]]]);
    expect(await readSemanticSurface(query)).toBeNull();
  });

  it('reads models and fields once the layer answers', async () => {
    const surface = await surfaceFrom(
      models([[1, 'sales', 'SEMANTIC_SALES', 'The sales model', 'PUBLISHED']]),
      fields(SALES_FIELDS),
    );
    expect(surface.version).toBe('0.1+dev');
    expect(surface.models).toEqual([
      {
        id: 1,
        name: 'sales',
        publishedSchema: 'SEMANTIC_SALES',
        published: true,
        description: 'The sales model',
      },
    ]);
    expect(surface.fields[0]).toEqual({
      modelId: 1,
      fieldId: 1,
      object: 'SALES',
      column: 'TOTAL_REVENUE',
      kind: 'metric',
      displayName: 'Total Revenue',
      description: 'Net recognized revenue excluding tax',
      format: 'currency',
      certified: true,
    });
    // Absent rather than null: a field the author said nothing about should read
    // as one nothing was said about, not one described as `null`.
    expect(surface.fields[1]).not.toHaveProperty('description');
    expect(surface.fields[1]).not.toHaveProperty('certified');
  });

  /**
   * The rest of what a field can carry, and the flag as a flag: a driver that
   * reads `'false'` as true because it is a non-empty string is a whole class of
   * bug, and only `true` is true here.
   */
  it('reads the unit, the sensitivity and the certification as they arrive', async () => {
    const surface = await surfaceFrom(
      models([[1, 'sales', 'SEMANTIC_SALES', null, 'PUBLISHED']]),
      fields([
        {
          model: 1,
          object: 'SALES',
          column: 'WEIGHT',
          kind: 'METRIC',
          unit: 'kg',
          sensitivity: 'INTERNAL',
          certified: 'true',
        },
        { model: 1, object: 'SALES', column: 'COUNT', kind: 'METRIC', certified: 1 },
        { model: 1, object: 'SALES', column: 'DRAFTED', kind: 'METRIC', certified: 'false' },
      ]),
    );
    expect(surface.fields[0]).toMatchObject({
      unit: 'kg',
      sensitivity: 'INTERNAL',
      certified: true,
    });
    expect(surface.fields[1]?.certified).toBe(true);
    expect(surface.fields[2]).not.toHaveProperty('certified');
  });

  /**
   * The layer is there and this user may not read its catalogue. That costs the
   * meanings and must not cost the connection: browsing tables cannot depend on
   * a grant somebody else controls.
   */
  it('survives a catalogue it is not allowed to read', async () => {
    const { query } = answering([['PRODUCT_VERSION', [['0.1']]]]);
    expect(await readSemanticSurface(query)).toEqual({
      version: '0.1',
      models: [],
      fields: [],
      metrics: [],
      invalidPairs: [],
    });
  });

  it('skips rows the catalogue could not fill in', async () => {
    const surface = await surfaceFrom(
      models([
        [1, 'sales', 'SEMANTIC_SALES', null, 'PUBLISHED'],
        [Number.NaN, 'broken', 'X', null, 'PUBLISHED'],
      ]),
      fields([
        ...SALES_FIELDS,
        // A field kind this build has never heard of. Calling it a dimension
        // would put it on a chart's category axis on the strength of a guess.
        { model: 1, object: 'SALES', column: 'MYSTERY', kind: 'HIERARCHY' },
      ]),
    );
    expect(surface.models).toHaveLength(1);
    expect(surface.models[0]).not.toHaveProperty('description');
    expect(surface.fields.map((field) => field.column)).toEqual([
      'TOTAL_REVENUE',
      'CUSTOMER_REGION',
    ]);
  });
});

describe('how a metric combines, and what it may not be paired with', () => {
  it('takes the aggregation from the metric, not from the field', async () => {
    const index = indexSemanticFields(
      await surfaceFrom(
        models([[1, 'sales', 'SEMANTIC_SALES', null, 'PUBLISHED']]),
        fields(SALES_FIELDS),
        {
          metricRows: metrics([
            [1, 1, 'SIMPLE', 'SUM'],
            // A ratio declares none, which is the fact worth carrying.
            [1, 9, 'RATIO', null],
            [1, Number.NaN, 'SIMPLE', 'SUM'],
          ]),
        },
      ),
    );
    const columns = semanticColumnsFor(index, 'SEMANTIC_SALES', 'SALES');
    expect(columns?.get('TOTAL_REVENUE')).toMatchObject({
      metricKind: 'SIMPLE',
      aggregation: 'SUM',
    });
    // Nothing was said about this one, so nothing is claimed about it.
    expect(columns?.get('CUSTOMER_REGION')).not.toHaveProperty('aggregation');
  });

  it('reads the refusals, and only the refusals it can explain', async () => {
    const surface = await surfaceFrom(
      models([[1, 'sales', 'SEMANTIC_SALES', null, 'PUBLISHED']]),
      fields(SALES_FIELDS),
      {
        refusalRows: refusals([
          [1, 1, 2, 'ONE_TO_MANY_ATTRIBUTION_UNSUPPORTED', 'order_line_to_order (rejected)'],
          [1, 1, 3, 'NO_SAFE_JOIN_PATH', null],
          // A refusal with no reason cannot be shown to anybody, so it is not
          // carried; and a row the catalogue could not fill in is skipped.
          [1, 1, 4, null, null],
          [Number.NaN, 1, 5, 'X', null],
        ]),
      },
    );
    expect(surface.invalidPairs).toEqual([
      {
        modelId: 1,
        metricId: 1,
        dimensionId: 2,
        code: 'ONE_TO_MANY_ATTRIBUTION_UNSUPPORTED',
        path: 'order_line_to_order (rejected)',
      },
      { modelId: 1, metricId: 1, dimensionId: 3, code: 'NO_SAFE_JOIN_PATH' },
    ]);

    const index = indexSemanticFields(surface);
    const columns = semanticColumnsFor(index, 'SEMANTIC_SALES', 'SALES');
    const revenue = columns?.get('TOTAL_REVENUE');
    const region = columns?.get('CUSTOMER_REGION');
    expect(semanticRefusal(index, revenue, region)).toEqual({
      code: 'ONE_TO_MANY_ATTRIBUTION_UNSUPPORTED',
      path: 'order_line_to_order (rejected)',
    });
    // The pairing only means anything one way round, and only within a model.
    expect(semanticRefusal(index, region, revenue)).toBeUndefined();
    expect(semanticRefusal(index, revenue, undefined)).toBeUndefined();
    expect(
      semanticRefusal(index, { ...(revenue as SemanticColumnView), modelId: 99 }, region),
    ).toBeUndefined();
  });
});

describe('deciding which model describes a view', () => {
  it('has nothing to say about a connection with no layer', () => {
    expect(indexSemanticFields(null)).toBe(EMPTY_SEMANTIC_INDEX);
    expect(semanticColumnsFor(EMPTY_SEMANTIC_INDEX, 'SEMANTIC_SALES', 'SALES')).toBeUndefined();
  });

  it('describes a published object, naming the model that vouches for it', async () => {
    const index = indexSemanticFields(
      await surfaceFrom(
        models([[1, 'sales', 'SEMANTIC_SALES', null, 'PUBLISHED']]),
        fields(SALES_FIELDS),
      ),
    );
    const columns = semanticColumnsFor(index, 'SEMANTIC_SALES', 'SALES');
    expect(columns?.get('TOTAL_REVENUE')).toEqual({
      kind: 'metric',
      model: 'sales',
      modelId: 1,
      fieldId: 1,
      displayName: 'Total Revenue',
      description: 'Net recognized revenue excluding tax',
      format: 'currency',
      certified: true,
    });
    expect(semanticObjectKey('SEMANTIC_SALES', 'SALES')).toBe('SEMANTIC_SALES.SALES');
  });

  /**
   * Taken from the instance: `sales` is published to `SEMANTIC_SALES`, and three
   * *drafts* name the same schema. A draft's published schema is a schema it
   * intends to use — its fields describe views it has never written.
   */
  it('lets no draft describe a schema it has never published to', async () => {
    const index = indexSemanticFields(
      await surfaceFrom(
        models([
          [1, 'sales', 'SEMANTIC_SALES', null, 'PUBLISHED'],
          [13, 'sales_osi_import', 'SEMANTIC_SALES', null, 'DRAFT'],
        ]),
        fields([
          ...SALES_FIELDS,
          {
            model: 13,
            object: 'SALES',
            column: 'TOTAL_REVENUE',
            kind: 'METRIC',
            displayName: 'Imported Revenue',
          },
        ]),
      ),
    );
    expect(
      semanticColumnsFor(index, 'SEMANTIC_SALES', 'SALES')?.get('TOTAL_REVENUE'),
    ).toMatchObject({ displayName: 'Total Revenue', model: 'sales' });
  });

  /**
   * Two published models claiming one object is a race the database has already
   * settled: publishing is `CREATE OR REPLACE VIEW`, so the view that is there is
   * the one published last. The newer model takes the object **whole** — half of
   * one model's meanings mixed with half of another's would describe a view that
   * never existed.
   */
  it('gives a contested object to the model that published it last, entire', async () => {
    const index = indexSemanticFields(
      await surfaceFrom(
        models([
          [1, 'older', 'SEMANTIC_SALES', null, 'PUBLISHED'],
          [2, 'newer', 'SEMANTIC_SALES', null, 'PUBLISHED'],
        ]),
        fields([
          { model: 1, object: 'SALES', column: 'REGION', displayName: 'Old Region' },
          { model: 1, object: 'SALES', column: 'GONE', displayName: 'Dropped' },
          { model: 1, object: 'ORDERS', column: 'STATUS', displayName: 'Old Status' },
          { model: 2, object: 'SALES', column: 'REGION', displayName: 'New Region' },
        ]),
      ),
    );
    const sales = semanticColumnsFor(index, 'SEMANTIC_SALES', 'SALES');
    expect(sales?.get('REGION')?.displayName).toBe('New Region');
    expect(sales?.has('GONE')).toBe(false);
    // ...and only that object: the older model still owns the one nobody else
    // claimed.
    expect(semanticColumnsFor(index, 'SEMANTIC_SALES', 'ORDERS')?.get('STATUS')?.model).toBe(
      'older',
    );
  });

  it('is untroubled by a published model with no fields at all', async () => {
    const index = indexSemanticFields(
      await surfaceFrom(models([[9, 'empty', 'SEMANTIC_EMPTY', null, 'PUBLISHED']]), fields([])),
    );
    expect(semanticColumnsFor(index, 'SEMANTIC_EMPTY', 'ANYTHING')).toBeUndefined();
  });
});
