import type { TableSchema } from '@panorama/table';
import type { RelationShape } from '@panorama/test-support';
import {
  countryRelation,
  factRelation,
  largeStringRelation,
  nullHeavyRelation,
  relationSchema,
  tallRelation,
  typeCoverageRelation,
  wideRelation,
} from '@panorama/test-support';

/**
 * Built-in synthetic relations.
 *
 * They make the table browser demonstrable with no database, and they are the
 * pathological shapes Stage 1 has to survive: billions of rows, thousands of
 * columns, long strings, mostly NULL, and full type coverage. The registry is
 * shared by the data worker (which serves the rows) and the shell (which
 * already knows their schemas, so no metadata round trip is needed).
 */

export const DEMO_SCHEMA = 'PANORAMA_DEMO';

const SMALL_FACT = { ...factRelation(100), table: 'SAMPLE_100' } satisfies RelationShape;

export const DEMO_RELATIONS: Readonly<Record<string, RelationShape>> = Object.freeze({
  SAMPLE_100: SMALL_FACT,
  COUNTRIES: countryRelation(),
  SALES: factRelation(2_830_000_000),
  VERY_TALL: tallRelation(10_000_000_000),
  VERY_WIDE: wideRelation(5_000),
  LARGE_STRINGS: largeStringRelation(100_000),
  MOSTLY_NULL: nullHeavyRelation(1_000_000),
  TYPE_COVERAGE: typeCoverageRelation(10_000),
});

export interface DemoTable {
  readonly name: string;
  readonly rowCount: number;
  readonly columnCount: number;
}

export const demoTables = (): readonly DemoTable[] =>
  Object.entries(DEMO_RELATIONS).map(([name, shape]) => ({
    name,
    rowCount: shape.rowCount,
    columnCount: shape.columns.length,
  }));

export const demoRelation = (table: string): RelationShape | undefined => DEMO_RELATIONS[table];

export const demoSchema = (table: string): TableSchema | undefined => {
  const shape = demoRelation(table);
  if (shape === undefined) return undefined;
  const base = relationSchema(shape);
  return {
    ...base,
    schema: DEMO_SCHEMA,
    table,
    // The generators declare their keys against their own schema name; point
    // them at the demo schema so following one resolves inside the registry.
    columns: base.columns.map((column) =>
      column.foreignKey === undefined
        ? column
        : { ...column, foreignKey: { ...column.foreignKey, schema: DEMO_SCHEMA } },
    ),
  };
};
