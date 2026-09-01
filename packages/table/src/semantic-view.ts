import type { SemanticColumnView, TableColumnSpec } from '@panorama/core';

/**
 * A table's columns, with what a semantic layer says they mean.
 *
 * The join between somebody else's catalogue and Panorama's own column model,
 * and the only place the two meet — the same role `json-view.ts` plays one layer
 * down, and deliberately the same shape. What comes out is ordinary
 * `TableColumnSpec`s with one more optional field on some of them, so everything
 * downstream works on them without knowing why.
 *
 * It composes rather than replaces: the specs handed in may already be the
 * document view of a family or the plain physical columns, and this adds meaning
 * to whichever of them the layer recognises. Nothing is dropped and nothing is
 * reordered — a column the model says nothing about comes back exactly as it
 * arrived, which is every column of every table on almost every connection.
 */

/**
 * What a relation's columns mean, by the name the database calls them.
 *
 * Not exported: whoever reads the catalogue owns this name — see
 * `SemanticColumns` in `@panorama/exasol` — and two exported spellings of the
 * same map would suggest they were different maps.
 */
type SemanticColumns = ReadonlyMap<string, SemanticColumnView>;

/**
 * The specs with meanings attached, by column name.
 *
 * The names in the map are the layer's `SQL_COLUMN_NAME` — the upper-cased name
 * its publish step creates the view's columns with. A box reading the published
 * view gets exactly those back, so the first lookup is exact.
 *
 * The second is upper-cased, and it is not defensive padding. A statement that
 * has been through `COMPILE_SQL` returns the *compiler's* aliases, which are the
 * model author's own lower-case spelling — `customer_region` where the view says
 * `CUSTOMER_REGION`. One field, two spellings, and a box whose rows are compiled
 * would otherwise lose every display name it had before it was run.
 *
 * Returns the array it was given when there is nothing to add, so the common case
 * allocates nothing.
 */
export const withSemantics = (
  specs: readonly TableColumnSpec[],
  columns: SemanticColumns | undefined,
): readonly TableColumnSpec[] => {
  if (columns === undefined || columns.size === 0) return specs;
  let matched = false;
  const described = specs.map((spec) => {
    const semantic = columns.get(spec.name) ?? columns.get(spec.name.toUpperCase());
    if (semantic === undefined) return spec;
    matched = true;
    return { ...spec, semantic };
  });
  return matched ? described : specs;
};
