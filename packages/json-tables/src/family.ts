import type { ColumnDataType } from '@panorama/core';
import type { ColumnMarker } from './contract.js';
import { VALUE_COLUMN, isContractMarker, parseColumnName } from './contract.js';

/**
 * A table's physical columns, read as the document they encode.
 *
 * The grouping is the whole of it: several physical columns are one property, and
 * which one holds this row's value depends on the row. So what comes out is a
 * list of properties, each naming the columns it is spread across — and nothing
 * about how to draw them, which is somebody else's business.
 *
 * Deliberately independent of Panorama's own column model. What this reads is a
 * list of names and types, which is what both a live result set and a manifest
 * can produce, and what a test can write down.
 */

/** What a property holds, across all the rows. */
export type JsonPropertyKind =
  /** One scalar type, or none at all where every row was `null`. */
  | 'scalar'
  /** Several types across rows — the tagged union both loaders emit. */
  | 'variant'
  /** A nested document, in a child table. */
  | 'object'
  /** An ordered list, in a child table, one row per element. */
  | 'array';

/** One of the physical columns a property's value may arrive in. */
export interface JsonBranch {
  /** Index into the physical result set, which is what reads a cell. */
  readonly index: number;
  readonly column: string;
  readonly type: ColumnDataType;
  /**
   * The contract's name for this type, absent on the primary branch.
   *
   * Kept as the contract spelled it rather than derived from the SQL type: the
   * two are not the same question. `VARCHAR(50)` is the SQL type of a
   * `decimal128` branch and of an `extended_json` one, and which of those a value
   * came from is a fact about the document.
   */
  readonly branch?: string;
}

export interface JsonProperty {
  /** What to call it: the property's own name, as the document had it. */
  readonly name: string;
  readonly kind: JsonPropertyKind;
  /**
   * Where a value may be, in the order the contract prefers.
   *
   * Empty for a property every row of which was explicitly `null` — the loader
   * writes the mask and no value column at all, which is honest and leaves a
   * property with nothing but its absence to report.
   */
  readonly branches: readonly JsonBranch[];
  /** `TRUE` here means the property was present and `null`. */
  readonly nullMask?: number;
  /** `TRUE` here means a string was present and empty. */
  readonly emptyMask?: number;
  /** The child object row's `_id`. */
  readonly objectLink?: number;
  /** How many elements the array has; the elements are in the child table. */
  readonly arrayCount?: number;
}

/** A column that exists to store the document rather than to be part of it. */
export interface JsonStructuralColumn {
  readonly name: string;
  readonly index: number;
}

export interface JsonFamilyTable {
  readonly properties: readonly JsonProperty[];
  /** `_id`, `_parent`, `_pos`, and the retained source document. */
  readonly structural: readonly JsonStructuralColumn[];
  /** `_id`, where the table has one — what a child row is followed by. */
  readonly rowKey?: JsonStructuralColumn;
  /** `_parent`, where this table is a child. */
  readonly parentKey?: JsonStructuralColumn;
}

/** The least a reader needs to know about a column: what it is called and its type. */
export interface NamedColumn {
  readonly name: string;
  readonly type: ColumnDataType;
}

/**
 * The presented name of a property.
 *
 * `_value` is the value of a scalar array element — the row *is* the value — and
 * calling the column `value` in a table of tags reads better than the underscore
 * the storage needs. `exasol-json-tables` makes the same substitution in its own
 * wrapper (`physical_segment_name`), and the two cannot collide: a JSON property
 * genuinely called `value` inside an array is stored as `_value` by the loader.
 */
const presentedName = (property: string): string =>
  property === VALUE_COLUMN ? 'value' : property;

interface Building {
  readonly property: string;
  /** First appearance of any of the property's columns, which orders the result. */
  readonly at: number;
  branches: JsonBranch[];
  nullMask?: number;
  emptyMask?: number;
  objectLink?: number;
  arrayCount?: number;
  marked: boolean;
}

const kindOf = (built: Building): JsonPropertyKind => {
  const nested =
    (built.objectLink === undefined ? 0 : 1) + (built.arrayCount === undefined ? 0 : 1);
  // A property that is sometimes a number and sometimes a list is a variant as
  // much as one that is sometimes a number and sometimes a string: what varies
  // is the type, and the fact that one of the types needs a second table to hold
  // it does not make it a different question.
  if (built.branches.length + nested > 1) return 'variant';
  if (built.objectLink !== undefined) return 'object';
  if (built.arrayCount !== undefined) return 'array';
  return 'scalar';
};

/**
 * Reads a table's columns as a document, or reports that they are not one.
 *
 * `null` means there is nothing here to collapse, and that is the detection:
 * every ordinary relational table in the world reaches this and comes back
 * `null`, because none of them has a `|n` or a `|object` in it.
 *
 * `known` is for the one case shape cannot settle. A family root whose every
 * property happened to be a plain scalar — no nulls, no nesting, no variants —
 * is *identical* to an ordinary table apart from its `_id`, and should be read as
 * a family only when something else already said so, which is what the loader's
 * provenance comment is for. Without that, a table with an `_id` is just a table
 * with an `_id`.
 */
export const readFamilyTable = (
  columns: readonly NamedColumn[],
  options: { readonly known?: boolean } = {},
): JsonFamilyTable | null => {
  const structural: JsonStructuralColumn[] = [];
  const building = new Map<string, Building>();

  columns.forEach((column, index) => {
    const parsed = parseColumnName(column.name);
    if (parsed === null) {
      structural.push({ name: column.name, index });
      return;
    }
    const found = building.get(parsed.property);
    const built: Building = found ?? {
      property: parsed.property,
      at: index,
      branches: [],
      marked: false,
    };
    if (found === undefined) building.set(parsed.property, built);
    if (isContractMarker(parsed.marker)) built.marked = true;
    place(built, parsed.marker, { index, column: column.name, type: column.type }, parsed.branch);
  });

  const anyMarked = [...building.values()].some((built) => built.marked);
  // Nothing but ordinary columns, and nothing that said otherwise.
  if (!anyMarked && options.known !== true) return null;
  // Told it is a family, but there is not even an `_id` to hide: whatever this
  // is, reading it as a document would add nothing and claim something.
  if (!anyMarked && structural.length === 0) return null;

  const properties = [...building.values()]
    .sort((left, right) => left.at - right.at)
    .map((built): JsonProperty => ({
      name: presentedName(built.property),
      kind: kindOf(built),
      branches: built.branches,
      ...(built.nullMask === undefined ? {} : { nullMask: built.nullMask }),
      ...(built.emptyMask === undefined ? {} : { emptyMask: built.emptyMask }),
      ...(built.objectLink === undefined ? {} : { objectLink: built.objectLink }),
      ...(built.arrayCount === undefined ? {} : { arrayCount: built.arrayCount }),
    }));

  const named = (name: string): JsonStructuralColumn | undefined =>
    structural.find((column) => column.name === name);
  const rowKey = named('_id');
  const parentKey = named('_parent');
  return {
    properties,
    structural,
    ...(rowKey === undefined ? {} : { rowKey }),
    ...(parentKey === undefined ? {} : { parentKey }),
  };
};

/** Files one column under the property it belongs to. */
const place = (
  built: Building,
  marker: ColumnMarker,
  column: { index: number; column: string; type: ColumnDataType },
  branch: string | undefined,
): void => {
  switch (marker) {
    case 'primary':
      // First, always: the contract puts the strongest-evidence branch on the
      // bare name, and reading a value means trying that one before the rest.
      built.branches.unshift({ index: column.index, column: column.column, type: column.type });
      return;
    case 'alternate':
      built.branches.push({
        index: column.index,
        column: column.column,
        type: column.type,
        ...(branch === undefined ? {} : { branch }),
      });
      return;
    case 'nullMask':
      built.nullMask = column.index;
      return;
    case 'emptyMask':
      built.emptyMask = column.index;
      return;
    case 'object':
      built.objectLink = column.index;
      return;
    default:
      built.arrayCount = column.index;
  }
};

/**
 * The type to present a property as: its strongest branch, where it has one.
 *
 * `undefined` for a property with no value column at all — one that was `null` in
 * every row the loader saw. There is no type to give it, and inventing one would
 * be a claim about data that does not exist.
 */
export const presentedType = (property: JsonProperty): ColumnDataType | undefined =>
  property.branches[0]?.type;
