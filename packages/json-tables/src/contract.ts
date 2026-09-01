/**
 * The column-name grammar two other projects agreed on.
 *
 * `exasol-json-tables` and `exasol-mongodb-vs` both represent a nested document
 * as a family of ordinary relational tables, and they emit the *same* physical
 * shape: one table per object or array, structural columns joining them, and a
 * small set of `|`-suffixed markers carrying everything SQL has no type for —
 * which of a property's several types this row used, whether its `null` was
 * written down or merely absent, whether a string was present and empty.
 *
 * That shape is the whole reason those projects exist, and it is invisible in
 * Panorama without this: `note` and `note|n` are two columns of a table, and the
 * distinction between a missing property and an explicit `null` is a boolean
 * sitting in the second one that nobody reads.
 *
 * This module is the parser and nothing else — no policy, no presentation, and
 * no dependency but the type vocabulary. It mirrors `parse_column_name` in
 * `exasol-json-tables`' `python/exasol_json_tables/wrapper_schema_support.py`
 * deliberately and in the same order, because that function is the contract's
 * own reading of itself.
 */

/**
 * The row-joining columns, which belong to the storage rather than the document.
 *
 * `_id` identifies a root, object or nested-array parent row; `_parent` points an
 * array element at the row that owns it; `_pos` is its zero-based position, which
 * is what makes an array ordered rather than a set.
 */
export const STRUCTURAL_COLUMNS: readonly string[] = Object.freeze(['_id', '_parent', '_pos']);

/**
 * The value of a scalar array element.
 *
 * Named apart from the structural three because it *is* the document: a row of
 * `PEOPLE_tags_arr` is one tag, and `_value` is the tag. It takes the same
 * markers as any other property — `_value|n`, `_value|empty`, `_value|object`,
 * `_value|array` — which is why it is a property name here and not a keyword.
 */
export const VALUE_COLUMN = '_value';

/**
 * The raw source document, where the loader kept one.
 *
 * `exasol-mongodb-vs` names it, and a family loaded from MongoDB may carry the
 * original alongside the columns derived from it. Not part of the document's
 * shape, so it is offered rather than presented.
 */
export const SOURCE_DOCUMENT_COLUMN = '__mongodb_source_json';

/** What a `|` suffix says about a column. */
export type ColumnMarker =
  /** The property itself, on the branch with the strongest evidence. */
  | 'primary'
  /** One of the property's other types; at most one branch holds a value. */
  | 'alternate'
  /** `TRUE` where the property was present and explicitly `null`. */
  | 'nullMask'
  /** `TRUE` where a string was present and empty, which SQL stores as NULL. */
  | 'emptyMask'
  /** The `_id` of the child object table's row, or `TRUE` on a polymorphic element. */
  | 'object'
  /** The array's length; the elements are rows of the child array table. */
  | 'array';

export const NULL_SUFFIX = '|n';
export const EMPTY_SUFFIX = '|empty';
export const OBJECT_SUFFIX = '|object';
export const ARRAY_SUFFIX = '|array';

/**
 * The scalar branch names either project will suffix a column with.
 *
 * A **closed** set, and that is the point rather than a detail. Any column name
 * containing a `|` could be read as a variant branch, and a table with a column
 * genuinely called `a|b` would then be reported as a document family and drawn as
 * one — a wrong picture presented as a right one, over data that has nothing to
 * do with JSON. Restricting alternates to names the two loaders actually emit is
 * what makes recognising a family by shape safe.
 *
 * The union of `variant_suffix` in `exasol-mongodb-vs`'
 * `crates/mongodb-vs/src/model.rs` and `SimpleType`'s `Display` in
 * `exasol-json-tables`' `crates/json_tables_core/src/contract.rs`. Aliases are
 * included as both spell them: `bool` and `boolean`, `int` and `int32`.
 */
export const BRANCH_NAMES: readonly string[] = Object.freeze([
  'string',
  'bool',
  'boolean',
  'int',
  'int32',
  'long',
  'int64',
  'integer',
  'number',
  'double',
  'non_finite_double',
  'objectid',
  'object_id',
  'decimal128',
  'date',
  'datetime',
  'timestamp_time',
  'timestamp_increment',
  'extended_json',
]);

const BRANCHES: ReadonlySet<string> = new Set(BRANCH_NAMES);

export interface ParsedColumn {
  /** The property this column belongs to, which several columns may share. */
  readonly property: string;
  readonly marker: ColumnMarker;
  /** The branch's name, for an alternate. */
  readonly branch?: string;
}

/**
 * What one column is, or `null` where it is not part of the document.
 *
 * `null` for the structural columns and for the retained source document: they
 * are how the family is stored and how it got here, not what it says.
 *
 * The order of the tests is the contract's own. It matters in one place: a
 * property called `n` would give a column `n|n`, and reading the suffix first
 * gets that right where splitting on the first `|` would not.
 */
export const parseColumnName = (name: string): ParsedColumn | null => {
  if (STRUCTURAL_COLUMNS.includes(name) || name === SOURCE_DOCUMENT_COLUMN) return null;
  for (const [suffix, marker] of [
    [NULL_SUFFIX, 'nullMask'],
    [EMPTY_SUFFIX, 'emptyMask'],
    [OBJECT_SUFFIX, 'object'],
    [ARRAY_SUFFIX, 'array'],
  ] as const) {
    if (name.length > suffix.length && name.endsWith(suffix)) {
      return { property: name.slice(0, -suffix.length), marker };
    }
  }
  const cut = name.lastIndexOf('|');
  if (cut > 0 && cut < name.length - 1) {
    const branch = name.slice(cut + 1);
    // Only a branch this contract actually emits. Anything else is a column with
    // a `|` in its name, and it keeps that name.
    if (BRANCHES.has(branch.toLowerCase())) {
      return { property: name.slice(0, cut), marker: 'alternate', branch };
    }
  }
  return { property: name, marker: 'primary' };
};

/** True for a column that only exists because the document had to be stored. */
export const isStructuralColumn = (name: string): boolean => parseColumnName(name) === null;

/**
 * True for a marker that could not appear on an ordinary relational column.
 *
 * What recognising a family by shape rests on. A `primary` says nothing — every
 * column in every table is one — so a family is a table carrying at least one of
 * the others.
 */
export const isContractMarker = (marker: ColumnMarker): boolean => marker !== 'primary';
