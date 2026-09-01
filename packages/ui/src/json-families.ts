import { isLoadedFamily, parentTableOf, tablePathOf } from '@panorama/json-tables';
import type { TableListing } from './types.js';

/**
 * A document family, as one entry in the explorer rather than five.
 *
 * A nested document is stored as a table per object and array, so a schema
 * holding three documents lists fifteen tables — and
 * `PEOPLE_items_arr_flags_arr` sitting between `PEOPLE_items_arr` and
 * `PEOPLE_profile` in a flat alphabetical list tells the reader nothing about
 * which document any of them belongs to. Nested, the same fifteen rows say what
 * they are: three documents, each with its own shape under it.
 *
 * The explorer has only what the catalogue reports — names, kinds, counts,
 * comments — and no columns, so the shape test that settles it everywhere else
 * is not available here. What is available is names and evidence, and this is
 * careful about the difference.
 */

/** The `_arr` a child table's name ends in when its property is a list. */
const ARRAY_MARK = '_arr';

/**
 * Whether a table is *evidently* part of a family, on its own.
 *
 * Two signals, and both have to be hard to produce by accident, because the cost
 * of being wrong is a schema drawn as a document tree it has nothing to do with.
 *
 * A provenance comment settles it outright — that is `exasol-json-tables` saying
 * so. Failing that, a name ending in `_arr` whose parent is a table in the same
 * schema: that suffix is the contract's array marker and is not a thing people
 * name tables. A name like `ORDERS_ARCHIVE` beside an `ORDERS` matches neither,
 * and stays where it is.
 */
const isEvidently = (table: TableListing, names: readonly string[]): boolean =>
  isLoadedFamily(table.comment) ||
  (table.name.endsWith(ARRAY_MARK) && parentTableOf(table.name, names) !== null);

/**
 * The roots of every family in a list of tables.
 *
 * A root is what the evidence leads up to. One evident child is enough to
 * establish its whole family: once `PEOPLE_tags_arr` has said `PEOPLE` holds a
 * document, `PEOPLE_profile` is part of that document too, and requiring
 * evidence from every table separately would nest the arrays and leave the
 * objects behind — which reads as a bug rather than as caution.
 */
export const familyRootsIn = (tables: readonly TableListing[]): ReadonlySet<string> => {
  const names = tables.map((table) => table.name);
  const roots = new Set<string>();
  for (const table of tables) {
    if (!isEvidently(table, names)) continue;
    let current = table.name;
    for (;;) {
      const parent = parentTableOf(current, names);
      if (parent === null) break;
      current = parent;
    }
    roots.add(current);
  }
  return roots;
};

/** One row of the explorer: a table, how deep it sits, and what to call it. */
export interface RelationNode {
  readonly table: TableListing;
  /** Zero for a root or an ordinary table. */
  readonly depth: number;
  /**
   * What to show.
   *
   * A root keeps its own name. A child is shown by the *property* it is —
   * `flags`, not `PEOPLE_items_arr_flags_arr` — because the path is already
   * drawn by where the row sits, and repeating it in every name is what made the
   * flat list unreadable. The full name is still in the row's tooltip.
   */
  readonly label: string;
  /** `object` or `array` for a child, absent for a root. */
  readonly nesting?: 'object' | 'array';
}

/**
 * The tables of a schema, with each family gathered under its root.
 *
 * Order is depth-first from each root, so a document reads top to bottom in the
 * order it nests. Everything that is not part of a family keeps the position the
 * caller gave it, because for those the caller's ordering — tables, then views,
 * then the rest — is still the right one.
 */
export const nestRelations = (tables: readonly TableListing[]): readonly RelationNode[] => {
  const roots = familyRootsIn(tables);
  if (roots.size === 0) return tables.map((table) => ({ table, depth: 0, label: table.name }));

  const names = tables.map((table) => table.name);
  const children = new Map<string, TableListing[]>();
  const loose: TableListing[] = [];
  for (const table of tables) {
    const parent = parentTableOf(table.name, names);
    // Part of a family only if the chain actually reaches a root that something
    // vouched for. A table whose name merely looks like a child is left alone.
    if (parent !== null && reachesRoot(table.name, names, roots)) {
      children.set(parent, [...(children.get(parent) ?? []), table]);
    } else {
      loose.push(table);
    }
  }

  const nodes: RelationNode[] = [];
  const walk = (table: TableListing, depth: number): void => {
    const parent = depth === 0 ? null : parentTableOf(table.name, names);
    const tail = parent === null ? table.name : table.name.slice(parent.length + 1);
    const array = tail.endsWith(ARRAY_MARK);
    nodes.push({
      table,
      depth,
      label: depth === 0 ? table.name : array ? tail.slice(0, -ARRAY_MARK.length) : tail,
      ...(depth === 0 ? {} : { nesting: array ? ('array' as const) : ('object' as const) }),
    });
    for (const child of children.get(table.name) ?? []) walk(child, depth + 1);
  };
  for (const table of loose) walk(table, 0);
  return nodes;
};

const reachesRoot = (
  table: string,
  names: readonly string[],
  roots: ReadonlySet<string>,
): boolean => {
  let current = table;
  for (;;) {
    const parent = parentTableOf(current, names);
    if (parent === null) return roots.has(current);
    current = parent;
  }
};

/** Where a table sits in its document, for a row's tooltip. */
export const documentPathOf = (
  table: TableListing,
  tables: readonly TableListing[],
): string | undefined => {
  const path = tablePathOf(
    table.name,
    tables.map((one) => one.name),
  );
  return path === 'root' ? undefined : path;
};
