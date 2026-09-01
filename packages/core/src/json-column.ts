import type { ColumnDataType } from './data-types.js';

/**
 * One column that presents several.
 *
 * Some databases hold a document by spreading one property across a handful of
 * ordinary columns: a value column per type it turned out to have, and boolean
 * masks recording the things SQL cannot say — that a `null` was written down
 * rather than merely absent, that a string was present and empty. The
 * arrangement is somebody else's contract and is read in
 * `@panorama/json-tables`; what is here is only what the *document* has to carry
 * so the rest of Panorama can draw it.
 *
 * Which is why this is in core and names no format. A column view with one of
 * these presents a property, and the several physical columns it reads are
 * indices into the result set the table already had. Nothing about the fetch
 * changes: the projection is still `SELECT *`, the cache still holds every
 * physical column, and this is the mapping from what is drawn to what was read.
 *
 * Absent on every ordinary column, which is why nothing else in the model
 * changes.
 */

/**
 * What a property holds across the rows.
 *
 * Named here rather than imported from the module that reads the contract,
 * because core may not depend on it — and because these four are what a
 * *renderer* needs to tell apart, which is a shorter list than what a parser
 * needs to recognise.
 */
export type JsonColumnKind = 'scalar' | 'variant' | 'object' | 'array';

/** One physical column a property's value may arrive in. */
export interface JsonBranchView {
  /** Index into the result set, which is what reads the cell. */
  readonly index: number;
  readonly type: ColumnDataType;
  /**
   * What the source called this type, absent on the branch the property is
   * named after. Shown beside a value when the property has more than one, since
   * that is the fact a collapsed column would otherwise throw away.
   */
  readonly branch?: string;
}

/**
 * Where a cell leads, for a property whose value is a nested document.
 *
 * A parent row and its children are two tables, and opening the children is the
 * same gesture as following a key — so it is expressed as one. `valueFrom` is the
 * column the *filter's* value comes from, which is not always the column that
 * was clicked: an array's cell holds a length, and what identifies its elements
 * is the row's own key.
 */
export interface JsonFollow {
  readonly table: string;
  /** The child column to match on: its own key, or the one naming its parent. */
  readonly column: string;
  readonly valueFrom: number;
}

export interface JsonColumnView {
  readonly kind: JsonColumnKind;
  /**
   * Where a value may be, in the order to look.
   *
   * Empty for a property that was `null` in every row: the source wrote the mask
   * and no value column at all.
   */
  readonly branches: readonly JsonBranchView[];
  /** True here means the property was present and explicitly `null`. */
  readonly nullMask?: number;
  /** True here means a string was present and empty. */
  readonly emptyMask?: number;
  /** How many elements a nested list has. */
  readonly arrayCount?: number;
  /** The key of the nested document's row. */
  readonly objectLink?: number;
  readonly follow?: JsonFollow;
}

/** True where a value's own type is worth showing beside it. */
export const showsBranch = (json: JsonColumnView): boolean => json.branches.length > 1;
