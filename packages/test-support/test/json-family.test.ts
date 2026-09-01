import { describe, expect, it } from 'vitest';
import {
  jsonFamilyFlags,
  jsonFamilyItems,
  jsonFamilyProfile,
  jsonFamilyRoot,
  jsonFamilyTables,
  jsonFamilyTags,
} from '@panorama/test-support';
import type { RelationShape } from '@panorama/test-support';

/**
 * The fixture is data, and data can be wrong.
 *
 * Everything downstream — the four cell states, the collapse, the follow, the
 * probe's screenshots — is asserted against these rows, so a mistake here is a
 * mistake that every one of those tests agrees with. What is checked is that the
 * rows say what the comments beside them claim: that row 0's `note` really is an
 * explicit null and row 1's really is missing, because those two differ only in a
 * boolean three columns away and are otherwise identical.
 */

const cell = (shape: RelationShape, row: number, column: string): unknown => {
  const index = shape.columns.findIndex((one) => one.name === column);
  expect(index, `${shape.table} has no column ${column}`).toBeGreaterThanOrEqual(0);
  const type = shape.columns[index]?.type;
  return shape.valueFor?.(type as never, index, row) ?? null;
};

describe('the JSON family fixture', () => {
  const root = jsonFamilyRoot();

  it('holds every state the contract can express, and holds them apart', () => {
    // Explicitly null: no value, and the mask says the property was there.
    expect(cell(root, 0, 'note')).toBeNull();
    expect(cell(root, 0, 'note|n')).toBe(true);
    // Missing: no value, and no mask either. The pair above is the only thing
    // that separates these two rows, which is the whole point of the feature.
    expect(cell(root, 1, 'note')).toBeNull();
    expect(cell(root, 1, 'note|n')).toBeNull();
    // A present empty string, which Exasol stores as NULL.
    expect(cell(root, 0, 'empty_text')).toBeNull();
    expect(cell(root, 0, 'empty_text|empty')).toBe(true);
    // An ordinary string in the same column, so the mask is not merely always on.
    expect(cell(root, 2, 'empty_text')).toBe('text');
    expect(cell(root, 2, 'empty_text|empty')).toBeNull();
  });

  it('puts a variant on one branch at a time, which is the tagged-union rule', () => {
    expect(cell(root, 0, 'value')).toBe(42);
    expect(cell(root, 0, 'value|string')).toBeNull();
    expect(cell(root, 1, 'value')).toBeNull();
    expect(cell(root, 1, 'value|string')).toBe('forty-two');
    // And neither branch where the property was absent.
    expect(cell(root, 3, 'value')).toBeNull();
    expect(cell(root, 3, 'value|string')).toBeNull();
  });

  it('distinguishes an empty array from a missing one', () => {
    expect(cell(root, 0, 'tags|array')).toBe(3);
    // Zero elements: the property was there and the list was empty.
    expect(cell(root, 1, 'tags|array')).toBe(0);
    // No marker at all: there was no such property.
    expect(cell(root, 2, 'tags|array')).toBeNull();
  });

  it('has children whose keys actually match their parents', () => {
    // A link that pointed at nothing would make every follow test pass vacuously.
    const profile = jsonFamilyProfile();
    expect(cell(root, 0, 'profile|object')).toBe(cell(profile, 0, '_id'));
    const tags = jsonFamilyTags();
    expect(cell(tags, 0, '_parent')).toBe(cell(root, 0, '_id'));
    // Three tag rows for the parent that says it has three.
    const parents = [0, 1, 2, 3].map((row) => cell(tags, row, '_parent'));
    expect(parents.filter((parent) => parent === 'r0')).toHaveLength(3);
    // And the nested array hangs off the array element, not off the root.
    const items = jsonFamilyItems();
    expect(cell(jsonFamilyFlags(), 0, '_parent')).toBe(cell(items, 0, '_id'));
    expect(cell(items, 0, 'flags|array')).toBe(2);
  });

  it('names its tables the way the contract does', () => {
    expect(jsonFamilyTables()).toEqual([
      'PEOPLE',
      'PEOPLE_items_arr',
      'PEOPLE_items_arr_flags_arr',
      'PEOPLE_profile',
      'PEOPLE_tags_arr',
    ]);
  });
});
