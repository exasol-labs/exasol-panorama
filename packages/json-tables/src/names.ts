/**
 * How a family's tables are named, and how to get from one to the next.
 *
 * A document's nesting is carried in the table names: the root is the stem, and
 * every child appends its property to its parent's name — with `_arr` where the
 * property is an array. So `items[].flags[]` under `PEOPLE` is
 * `PEOPLE_items_arr_flags_arr`, and the rule that produces it is recursive and
 * one line long.
 *
 * Derived from names rather than from the catalogue, and deliberately. The two
 * loaders differ exactly here: `exasol-json-tables` declares real foreign keys
 * between parent and child, and `exasol-mongodb-vs` is a virtual schema, which in
 * Exasol cannot carry a constraint at all. Names are the one thing both have, so
 * following a property into its child table works the same either way.
 *
 * Mirrors `table_raw_name` and `encode_path_component` in `exasol-json-tables`'
 * `crates/json_tables_core/src/contract.rs`.
 */

const SAFE = /^[0-9A-Za-z_-]$/u;

/**
 * A property name as it appears inside a table name.
 *
 * Percent-encoded, because a JSON key may hold a dot or a bracket and those are
 * the separators — `{"a.b": 1}` and `{"a": {"b": 1}}` are different documents and
 * must not become the same table.
 */
export const encodeSegment = (name: string): string =>
  [...name]
    .map((character) =>
      SAFE.test(character)
        ? character
        : [...new TextEncoder().encode(character)]
            .map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`)
            .join(''),
    )
    .join('');

/**
 * The segment name a property contributes, which is not always its own.
 *
 * `_value` is stored under `value`: the underscore marks it as the element of an
 * array rather than a named property, and the table names do not need the mark.
 * The same substitution as `physical_segment_name` in the loader's wrapper.
 */
export const segmentFor = (property: string): string =>
  encodeSegment(property === '_value' || property === 'value' ? 'value' : property);

/** The table holding a property's nested rows, given the table it hangs off. */
export const childTableName = (
  parentTable: string,
  property: string,
  kind: 'object' | 'array',
): string => `${parentTable}_${segmentFor(property)}${kind === 'array' ? '_arr' : ''}`;

/**
 * The table this one hangs off, out of the tables beside it.
 *
 * The **longest** sibling that is a prefix of this name, which is what makes the
 * nesting right rather than merely plausible: `PEOPLE_items_arr_flags_arr` has
 * both `PEOPLE` and `PEOPLE_items_arr` as prefixes, and only the longer one is
 * its parent.
 *
 * `null` for a root, and for a table whose apparent prefix is not actually there —
 * a table called `ORDERS_ARCHIVE` in a schema with no `ORDERS` is not a child of
 * anything, and neither is one in a schema that happens to contain `ORDERS` but
 * where nothing else about either says family. The caller decides that; this
 * answers only the naming question.
 */
export const parentTableOf = (table: string, siblings: readonly string[]): string | null => {
  let best: string | null = null;
  for (const sibling of siblings) {
    if (sibling === table || !table.startsWith(`${sibling}_`)) continue;
    if (best === null || sibling.length > best.length) best = sibling;
  }
  return best;
};

/** The root of the family a table belongs to, following the names up. */
export const familyRootOf = (table: string, siblings: readonly string[]): string => {
  let current = table;
  for (;;) {
    const parent = parentTableOf(current, siblings);
    if (parent === null) return current;
    current = parent;
  }
};

/**
 * How the loader would describe where a table sits, from its name alone.
 *
 * The provenance comment carries this outright, and where it does that is the
 * better answer — this is what to say when there is no comment, which is every
 * table `exasol-mongodb-vs` exposes. `root` for a stem, and otherwise the
 * segments with `[]` on each array level, as `TablePath`'s own `Display` writes
 * them.
 */
export const tablePathOf = (table: string, siblings: readonly string[]): string => {
  const segments: string[] = [];
  let current = table;
  for (;;) {
    const parent = parentTableOf(current, siblings);
    if (parent === null) break;
    const tail = current.slice(parent.length + 1);
    segments.unshift(tail.endsWith('_arr') ? `${tail.slice(0, -'_arr'.length)}[]` : tail);
    current = parent;
  }
  return segments.length === 0 ? 'root' : segments.join('.');
};
