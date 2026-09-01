import { describe, expect, it } from 'vitest';
import {
  childTableName,
  encodeSegment,
  familyRootOf,
  parentTableOf,
  tablePathOf,
} from '@panorama/json-tables';
import { jsonFamilyTables } from '@panorama/test-support';

/**
 * The naming rules, against the family both loaders would produce.
 *
 * These are what following a property into its child table rests on, and they
 * rest on nothing but the names — which is deliberate: `exasol-json-tables`
 * declares real foreign keys and `exasol-mongodb-vs` is a virtual schema and
 * cannot declare any, so the catalogue is an answer for one of them and silence
 * for the other.
 */

const family = jsonFamilyTables();

describe('naming a child table', () => {
  it('appends the property, and marks an array', () => {
    expect(childTableName('PEOPLE', 'profile', 'object')).toBe('PEOPLE_profile');
    expect(childTableName('PEOPLE', 'tags', 'array')).toBe('PEOPLE_tags_arr');
  });

  /**
   * The rule is recursive because the parent's name already carries the path, so
   * an array inside an array needs no special case — which is why the doubled
   * `_arr` in `PEOPLE_items_arr_flags_arr` falls out rather than being spelled.
   */
  it('nests by appending to the parent, whatever the depth', () => {
    const items = childTableName('PEOPLE', 'items', 'array');
    expect(childTableName(items, 'flags', 'array')).toBe('PEOPLE_items_arr_flags_arr');
    expect(family).toContain('PEOPLE_items_arr_flags_arr');
  });

  /** The element of an array is stored under `value`, without the underscore. */
  it('names a nested array under an element by its stored segment', () => {
    expect(childTableName('PEOPLE_tags_arr', '_value', 'array')).toBe('PEOPLE_tags_arr_value_arr');
    expect(childTableName('PEOPLE_tags_arr', 'value', 'array')).toBe('PEOPLE_tags_arr_value_arr');
  });

  /**
   * A JSON key may hold a dot or a bracket, and those are the path separators:
   * `{"a.b": 1}` and `{"a": {"b": 1}}` are different documents and must not
   * become one table.
   */
  it('encodes anything that would be read as a separator', () => {
    expect(encodeSegment('plain_name-1')).toBe('plain_name-1');
    expect(encodeSegment('a.b')).toBe('a%2Eb');
    expect(encodeSegment('has space')).toBe('has%20space');
    expect(encodeSegment('items[]')).toBe('items%5B%5D');
    // Multi-byte, one escape per byte, as the loader's own encoder does.
    expect(encodeSegment('kø')).toBe('k%C3%B8');
  });
});

describe('finding the way back up', () => {
  it('reads the parent of every table in the family', () => {
    expect(parentTableOf('PEOPLE', family)).toBeNull();
    expect(parentTableOf('PEOPLE_profile', family)).toBe('PEOPLE');
    expect(parentTableOf('PEOPLE_tags_arr', family)).toBe('PEOPLE');
    expect(parentTableOf('PEOPLE_items_arr', family)).toBe('PEOPLE');
  });

  /**
   * The one that would be wrong if it took the first prefix rather than the
   * longest: `PEOPLE_items_arr_flags_arr` starts with `PEOPLE` too, and hanging
   * it off the root would flatten a level of the document away.
   */
  it('takes the longest prefix, so a nested table hangs off its own parent', () => {
    expect(parentTableOf('PEOPLE_items_arr_flags_arr', family)).toBe('PEOPLE_items_arr');
    expect(familyRootOf('PEOPLE_items_arr_flags_arr', family)).toBe('PEOPLE');
    expect(familyRootOf('PEOPLE', family)).toBe('PEOPLE');
    // And whichever order they arrive in: a catalogue is not sorted for us.
    expect(parentTableOf('PEOPLE_items_arr_flags_arr', [...family].reverse())).toBe(
      'PEOPLE_items_arr',
    );
  });

  it('is nothing where the apparent parent is not there', () => {
    // A table whose name merely looks like a child. Nothing in this schema is
    // called `ORDERS`, so `ORDERS_ARCHIVE` is a table, not a document branch.
    expect(parentTableOf('ORDERS_ARCHIVE', ['ORDERS_ARCHIVE', 'PEOPLE'])).toBeNull();
    expect(familyRootOf('ORDERS_ARCHIVE', ['ORDERS_ARCHIVE'])).toBe('ORDERS_ARCHIVE');
  });

  /**
   * The same string the loader would have written in the provenance comment,
   * derived from names — which is the answer for a virtual schema, where there
   * is no comment to read.
   */
  it('reconstructs the document path a comment would have carried', () => {
    expect(tablePathOf('PEOPLE', family)).toBe('root');
    expect(tablePathOf('PEOPLE_profile', family)).toBe('profile');
    expect(tablePathOf('PEOPLE_tags_arr', family)).toBe('tags[]');
    expect(tablePathOf('PEOPLE_items_arr_flags_arr', family)).toBe('items[].flags[]');
  });
});
