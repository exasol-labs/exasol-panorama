import type { JsonColumnView, TableColumnSpec } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { JsonFamilyTable, JsonProperty } from '@panorama/json-tables';
import {
  childTableName,
  isLoadedFamily,
  readFamilyTable,
  readableContract,
} from '@panorama/json-tables';
import type { TableSchema } from './schema.js';

/**
 * A document family, as columns to draw.
 *
 * The join between somebody else's storage contract and Panorama's own column
 * model, and the only place the two meet. What comes out is ordinary
 * `TableColumnSpec`s — so the table that gets built is an ordinary table, and
 * everything downstream works on it without knowing why its columns are the
 * shape they are.
 *
 * The result set is untouched. `SELECT *` still fetches every physical column and
 * the cache still holds them; what changes is how many columns are *drawn* and
 * which indices each one reads.
 */

/** What a family table needs to know about its neighbours to link to them. */
export interface JsonViewContext {
  /** The other tables in the schema, which is where a nested property leads. */
  readonly siblings: readonly string[];
  /** The table's own comment, where the catalogue had one. */
  readonly comment?: string;
}

/**
 * The columns to draw for a table, or `null` where it is not a document.
 *
 * `null` is the ordinary answer and the cheap one: reading the column names is
 * pure and settles it for every relational table there has ever been, so nothing
 * else here runs unless the shape says it should.
 */
export const jsonColumnSpecs = (
  schema: TableSchema,
  context: JsonViewContext = { siblings: [] },
): readonly TableColumnSpec[] | null => {
  // A contract this build does not know is one to leave alone. Parsing it would
  // not fail — it would succeed and draw the wrong document — so the answer is
  // the same `null` a relational table gets, and the caller shows the storage.
  if (!readableContract(context.comment)) return null;
  const family = readFamilyTable(schema.columns, { known: isLoadedFamily(context.comment) });
  if (family === null) return null;
  // In the order the columns physically arrive, which is the order the loader
  // wrote them and therefore the document's own. It matters for `_pos`: in a
  // table of array elements the position is the *first* column and the most
  // important one, and appending the structural columns after the properties
  // would put the list's order at the far right of the list.
  return [
    ...family.properties.map(
      (property) =>
        [firstIndex(property), propertySpec(property, schema.table, family, context)] as const,
    ),
    ...structuralSpecs(family, schema).map(([index, spec]) => [index, spec] as const),
  ]
    .sort((left, right) => left[0] - right[0])
    .map(([, spec]) => spec);
};

/** Where a property's leftmost column sits, which is where the property sits. */
const firstIndex = (property: JsonProperty): number =>
  Math.min(
    ...[
      ...property.branches.map((branch) => branch.index),
      property.nullMask,
      property.emptyMask,
      property.objectLink,
      property.arrayCount,
    ].filter((index): index is number => index !== undefined),
  );

/**
 * A hidden column per structural one, kept rather than dropped.
 *
 * `_id`, `_parent` and `_pos` are how the document is stored, so they are not the
 * first thing anybody wants to see — and they are exactly what somebody debugging
 * a family wants next. Hidden is the honest middle: they are in the table, in
 * their real positions, and one command away.
 *
 * `_pos` is the exception among them and is left showing: in a table of array
 * elements it is the *order of the list*, which is the document's own information
 * and the only thing distinguishing the second element from the third.
 */
const structuralSpecs = (
  family: JsonFamilyTable,
  schema: TableSchema,
): readonly (readonly [number, TableColumnSpec])[] =>
  family.structural.map((column) => [
    column.index,
    {
      name: column.name,
      // Its own type, read from the schema. Nothing else knows it: a structural
      // column belongs to no property, so there is no branch to take it from.
      type: schema.columns[column.index]?.type ?? UNKNOWN,
      visible: column.name === '_pos',
      /*
       * A reading instruction even here, where there is nothing to collapse.
       *
       * Because the alternative is worse: with the properties drawn, a column's
       * position in the table is no longer its position in the result set — nine
       * columns over thirteen — and anything that assumed the two were the same
       * reads the wrong cell. Giving *every* column of a document table the index
       * it reads makes the table self-describing, so nothing downstream has to
       * know whether this one was collapsed. One branch and no masks, so it is an
       * ordinary column everywhere it matters.
       */
      json: {
        kind: 'scalar' as const,
        branches: [{ index: column.index, type: schema.columns[column.index]?.type ?? UNKNOWN }],
      },
    },
  ]);

const UNKNOWN = dataType('unknown', '');

const propertySpec = (
  property: JsonProperty,
  table: string,
  family: JsonFamilyTable,
  context: JsonViewContext,
): TableColumnSpec => ({
  name: property.name,
  // The strongest branch's type. A property that was `null` in every row has no
  // branch at all and therefore no type — which is true, and better than naming
  // one it never held.
  type: property.branches[0]?.type ?? UNKNOWN,
  json: jsonView(property, table, family, context),
});

const jsonView = (
  property: JsonProperty,
  table: string,
  family: JsonFamilyTable,
  context: JsonViewContext,
): JsonColumnView => {
  const follow = followFor(property, table, family, context);
  return {
    kind: property.kind,
    branches: property.branches.map((branch) => ({
      index: branch.index,
      type: branch.type,
      ...(branch.branch === undefined ? {} : { branch: branch.branch }),
    })),
    ...(property.nullMask === undefined ? {} : { nullMask: property.nullMask }),
    ...(property.emptyMask === undefined ? {} : { emptyMask: property.emptyMask }),
    ...(property.arrayCount === undefined ? {} : { arrayCount: property.arrayCount }),
    ...(property.objectLink === undefined ? {} : { objectLink: property.objectLink }),
    ...(follow === undefined ? {} : { follow }),
  };
};

/**
 * Where a nested property's cell leads, when there is somewhere for it to lead.
 *
 * Two shapes, and they run in opposite directions. An **object** cell holds the
 * child row's own key, so the filter matches the child's `_id` against the value
 * that was clicked. An **array** cell holds a *length* — no key at all — and what
 * identifies its elements is the parent row's key, so the filter matches the
 * child's `_parent` against a value read from a different column of the same row.
 *
 * `undefined` unless the child table is actually in the schema. A cell that reads
 * as a link and opens an empty table is worse than one that does not offer.
 */
const followFor = (
  property: JsonProperty,
  table: string,
  family: JsonFamilyTable,
  context: JsonViewContext,
) => {
  const kind = property.objectLink !== undefined ? 'object' : ('array' as const);
  if (property.objectLink === undefined && property.arrayCount === undefined) return undefined;
  const child = childTableName(table, property.name, kind === 'object' ? 'object' : 'array');
  if (!context.siblings.includes(child)) return undefined;
  if (kind === 'object') {
    return { table: child, column: '_id', valueFrom: property.objectLink as number };
  }
  // An array's elements are found by the parent's key, and a table with no key
  // has no way to say which of its rows an element belongs to.
  if (family.rowKey === undefined) return undefined;
  return { table: child, column: '_parent', valueFrom: family.rowKey.index };
};

/**
 * The columns of a table as they physically are.
 *
 * What the toggle switches back to, and what every non-document table has always
 * had. Written out rather than left implicit so that the two views are produced
 * the same way and can be swapped without either knowing about the other.
 */
export const physicalColumnSpecs = (schema: TableSchema): readonly TableColumnSpec[] =>
  schema.columns.map((column) => ({
    name: column.name,
    type: column.type,
    ...(column.foreignKey === undefined ? {} : { foreignKey: column.foreignKey }),
  }));
