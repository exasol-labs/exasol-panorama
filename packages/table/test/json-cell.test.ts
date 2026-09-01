import { describe, expect, it } from 'vitest';
import type { JsonColumnView } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { PresentedCell } from '@panorama/table';
import {
  arrayText,
  isFollowable,
  jsonColumnSpecs,
  physicalColumnSpecs,
  presentCell,
} from '@panorama/table';
import { jsonFamilyRoot, jsonFamilyTables, jsonFamilyTags } from '@panorama/test-support';
import { relationSchema } from '@panorama/test-support';

/**
 * Four kinds of nothing, told apart.
 *
 * This is what the feature is for. A document distinguishes a property that held
 * `null`, one that held an empty string, and one that was not there; SQL has one
 * NULL for all three, and the source writes the difference into booleans beside
 * the value. Every assertion here is one of those three drawn from the fixture's
 * rows, so what is checked is a real row of a real family rather than a
 * hand-made `JsonColumnView`.
 */

const INT = dataType('decimal', 'DECIMAL(19,0)', { precision: 19, scale: 0 });
const TEXT = dataType('varchar', 'VARCHAR(2000000)', { size: 2_000_000 });
const ID_TYPE = dataType('varchar', 'VARCHAR(64)', { size: 64 });

const root = jsonFamilyRoot();
const specs = jsonColumnSpecs(relationSchema(root), { siblings: jsonFamilyTables() });

/** Reads a row of the fixture the way the cache would. */
const read = (row: number) => (index: number) =>
  (root.valueFor?.(root.columns[index]?.type as never, index, row) ?? null) as never;

const cellOf = (property: string, row: number): PresentedCell => {
  const spec = specs?.find((one) => one.name === property);
  expect(spec?.json, `${property} is not a presented column`).toBeDefined();
  return presentCell(spec?.json as JsonColumnView, read(row));
};

describe('telling the kinds of nothing apart', () => {
  /**
   * The pair the whole feature exists for. These two rows differ in one boolean
   * three columns away from the one being drawn, and today both draw as a dash.
   */
  it('separates an explicit null from a property that was never there', () => {
    expect(cellOf('note', 0)).toEqual({ state: 'null' });
    expect(cellOf('note', 1)).toEqual({ state: 'missing' });
  });

  it('separates a present empty string from both of them', () => {
    expect(cellOf('empty_text', 0)).toEqual({ state: 'empty' });
    expect(cellOf('empty_text', 1)).toEqual({ state: 'missing' });
    // And an ordinary string in the same column is still a value.
    expect(cellOf('empty_text', 2)).toMatchObject({ state: 'value', value: 'text' });
  });

  it('reads a plain value, with the type it was stored as', () => {
    expect(cellOf('name', 0)).toEqual({ state: 'value', value: 'Ada', type: TEXT });
  });

  /** Row 3 has nothing but a name: every branch and every mask unset. */
  it('calls a row with no branch and no mask missing, throughout', () => {
    for (const property of ['empty_text', 'note', 'value', 'created_at', 'profile', 'tags']) {
      expect(cellOf(property, 3).state, property).toBe('missing');
    }
  });
});

describe('collapsing a variant', () => {
  it('takes whichever branch this row used, and says which it was', () => {
    expect(cellOf('value', 0)).toEqual({ state: 'value', value: 42, type: INT });
    expect(cellOf('value', 1)).toEqual({
      state: 'value',
      value: 'forty-two',
      type: TEXT,
      branch: 'string',
    });
  });

  /**
   * The branch is named on the alternates and not on the primary, because the
   * primary is the one the column is *named* after — labelling it would be
   * telling the reader something the header already says.
   */
  it('names the branch only where it is not the one the column is named for', () => {
    expect(cellOf('value', 0)).not.toHaveProperty('branch');
    expect(cellOf('value', 1)).toHaveProperty('branch', 'string');
  });
});

describe('nested properties', () => {
  it('reads an object as the key that opens it, and its absence as missing', () => {
    expect(cellOf('profile', 0)).toEqual({ state: 'object', key: 'p0' });
    expect(cellOf('profile', 1)).toEqual({ state: 'missing' });
  });

  /**
   * A list that is there and empty is not a list that is not there, and the
   * marker is `0` for the first and NULL for the second — which is exactly why
   * this reads the marker instead of testing it for truth.
   */
  it('separates an empty list from a missing one', () => {
    expect(cellOf('tags', 0)).toEqual({ state: 'array', length: 3 });
    expect(cellOf('tags', 1)).toEqual({ state: 'array', length: 0 });
    expect(cellOf('tags', 2)).toEqual({ state: 'missing' });
  });

  it('says how many, in words a cell has room for', () => {
    expect(arrayText(0)).toBe('empty');
    expect(arrayText(1)).toBe('1 item');
    expect(arrayText(12)).toBe('12 items');
  });

  it('offers a link only where there is something to open', () => {
    const tags = specs?.find((one) => one.name === 'tags')?.json as JsonColumnView;
    expect(isFollowable(tags, cellOf('tags', 0))).toBe(true);
    // An empty list opens an empty table, which is not worth a click.
    expect(isFollowable(tags, cellOf('tags', 1))).toBe(false);
    expect(isFollowable(tags, cellOf('tags', 2))).toBe(false);
    const name = specs?.find((one) => one.name === 'name')?.json as JsonColumnView;
    expect(isFollowable(name, cellOf('name', 0))).toBe(false);
  });
});

describe('a cell that has not arrived', () => {
  /**
   * Distinct from missing, and the distinction is not pedantry: drawing an
   * unfetched cell as an absent property is a statement about the document that
   * the next frame contradicts.
   */
  it('is pending rather than missing, whichever column is the one still coming', () => {
    const json: JsonColumnView = {
      kind: 'scalar',
      branches: [{ index: 0, type: TEXT }],
      nullMask: 1,
    };
    // The value has not arrived.
    expect(presentCell(json, () => undefined)).toEqual({ state: 'pending' });
    // The value is in and empty, but the mask that would explain it is not.
    expect(presentCell(json, (index) => (index === 0 ? null : undefined))).toEqual({
      state: 'pending',
    });
    // Both in: now it can be answered.
    expect(presentCell(json, () => null)).toEqual({ state: 'missing' });
  });

  it('still reads a value that is in, whatever else is missing', () => {
    const json: JsonColumnView = {
      kind: 'variant',
      branches: [
        { index: 0, type: INT },
        { index: 1, type: TEXT, branch: 'string' },
      ],
      nullMask: 2,
    };
    // The first branch has not arrived and the second has a value: at most one
    // branch is ever populated, so this is the answer and waiting would be wrong.
    expect(presentCell(json, (index) => (index === 1 ? 'here' : undefined))).toMatchObject({
      state: 'value',
      value: 'here',
    });
  });
});

describe('the columns a family is drawn with', () => {
  it('is nothing at all for an ordinary table', () => {
    expect(
      jsonColumnSpecs({
        schema: 'S',
        table: 'ORDERS',
        columns: [
          { name: 'ID', type: INT },
          { name: 'CUSTOMER', type: TEXT },
        ],
      }),
    ).toBeNull();
  });

  it('draws one column per property, in the document order', () => {
    expect(specs?.filter((spec) => spec.visible !== false).map((spec) => spec.name)).toEqual([
      'mongo_id',
      'name',
      'empty_text',
      'note',
      'value',
      'created_at',
      'profile',
      'tags',
      'items',
    ]);
  });

  /**
   * Kept and hidden rather than dropped: they are how the document is stored, so
   * not the first thing to show and exactly what somebody debugging one wants
   * next.
   *
   * It carries a reading instruction too, and that is not decoration. With the
   * properties drawn, a column's position in the table is no longer its position
   * in the result set, so a caller that assumed the two were the same would read
   * the wrong cell. Every column of a document table names the index it reads.
   */
  it('keeps the structural columns, hidden, and self-describing', () => {
    const id = specs?.find((spec) => spec.name === '_id');
    expect(id).toMatchObject({ visible: false });
    expect(id?.json).toEqual({ kind: 'scalar', branches: [{ index: 0, type: ID_TYPE }] });
    // And its own type, which no property could have supplied.
    expect(id?.type).toEqual(ID_TYPE);
  });

  /** Except `_pos`, which in a list is the order of the list. */
  it('shows _pos, because in an array table it is the document talking', () => {
    const tags = jsonColumnSpecs(relationSchema(jsonFamilyTags()), {
      siblings: jsonFamilyTables(),
    });
    expect(tags?.find((spec) => spec.name === '_pos')).toMatchObject({ visible: true });
    expect(tags?.find((spec) => spec.name === '_parent')).toMatchObject({ visible: false });
  });

  it('gives a property the type of the branch it is named for', () => {
    expect(specs?.find((spec) => spec.name === 'value')?.type).toEqual(INT);
  });

  it('points a nested property at the table its rows are in', () => {
    expect(specs?.find((spec) => spec.name === 'profile')?.json?.follow).toEqual({
      table: 'PEOPLE_profile',
      column: '_id',
      valueFrom: 10,
    });
    // An array runs the other way: the child names its parent, and the value to
    // match comes from the row's own key rather than from the cell that was
    // clicked, which holds a length.
    expect(specs?.find((spec) => spec.name === 'tags')?.json?.follow).toEqual({
      table: 'PEOPLE_tags_arr',
      column: '_parent',
      valueFrom: 0,
    });
  });

  /**
   * A cell that reads as a link and opens an empty table is worse than one that
   * does not offer. `items` is in this schema and `profile` is not.
   */
  it('offers no link where the child table is not in the schema', () => {
    const partial = jsonColumnSpecs(relationSchema(root), {
      siblings: ['PEOPLE', 'PEOPLE_items_arr'],
    });
    expect(partial?.find((spec) => spec.name === 'profile')?.json?.follow).toBeUndefined();
    expect(partial?.find((spec) => spec.name === 'items')?.json?.follow).toMatchObject({
      table: 'PEOPLE_items_arr',
    });
  });

  /**
   * A guard rather than a case the loaders produce: the contract gives a table
   * with a nested array an `_id` of its own. But `valueFrom` has to be an index
   * of something, and offering a link whose filter reads a column that is not
   * there would open a table filtered on nothing at all.
   */
  it('offers no link out of an array in a table with no key to match on', () => {
    const orphan = jsonColumnSpecs(
      {
        schema: 'S',
        table: 'PEOPLE_tags_arr',
        columns: [
          { name: '_parent', type: TEXT },
          { name: '_pos', type: INT },
          { name: 'nested|array', type: INT },
        ],
      },
      { siblings: ['PEOPLE_tags_arr', 'PEOPLE_tags_arr_nested_arr'] },
    );
    expect(orphan?.find((spec) => spec.name === 'nested')?.json).toMatchObject({ kind: 'array' });
    expect(orphan?.find((spec) => spec.name === 'nested')?.json?.follow).toBeUndefined();
  });

  it('describes the physical columns too, which is what the toggle goes back to', () => {
    const physical = physicalColumnSpecs(relationSchema(root));
    expect(physical).toHaveLength(root.columns.length);
    expect(physical.map((spec) => spec.name)).toContain('note|n');
    expect(physical.every((spec) => spec.json === undefined)).toBe(true);
  });
});
