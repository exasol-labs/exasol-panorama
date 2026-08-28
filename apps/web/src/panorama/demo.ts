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
 * Synthetic relations, for the tests and probes rather than for anybody using
 * Panorama.
 *
 * They are the pathological shapes Stage 1 has to survive — billions of rows,
 * thousands of columns, long strings, mostly NULL, full type coverage — and
 * having them means the renderer, the cache, the scheduler and the whole browser
 * probe suite can be driven without a database in the room.
 *
 * **Nothing in the interface offers them.** They were once a panel in the
 * sidebar, and that panel was the first thing somebody saw: an invitation to
 * look at invented data when they had come to look at their own. What is left is
 * the registry, reachable by opening `PANORAMA_DEMO`.`<name>` — which is what the
 * probes do (`scripts/lib/open-sample.mjs`) and what an agent does through
 * `open_table`. A person would have to know the schema name to find them, and
 * nothing tells them it.
 *
 * The registry is shared by the data worker (which serves the rows) and the shell
 * (which already knows their schemas, so no metadata round trip is needed).
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
