import { describe, expect, it } from 'vitest';
import type { JsonColumnView } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { ColumnSummary } from '@panorama/table';
import { jsonColumnSummary, worthBreakingDown } from '@panorama/table';

/**
 * What is in a property, out of what was said about each of its columns.
 *
 * The interesting number is `missing`, and it is the only one here that is not
 * counted: nothing in the storage can say "this property was absent", so it is
 * what is left when every branch and every mask has been accounted for. Which
 * makes it exactly the number an arithmetic slip would quietly get wrong, and
 * most of what these tests are about.
 */

const INT = dataType('decimal', 'DECIMAL(19,0)', { precision: 19, scale: 0 });
const TEXT = dataType('varchar', 'VARCHAR(2000000)', { size: 2_000_000 });
const BOOL = dataType('boolean', 'BOOLEAN');

/** A summary as a source would report it: how many rows, how many of them null. */
const said = (rows: number, nulls: number, extra: Partial<ColumnSummary> = {}): ColumnSummary => ({
  column: 'c',
  rows,
  nulls,
  basis: 'exact',
  distinct: null,
  ...extra,
});

const variant: JsonColumnView = {
  kind: 'variant',
  branches: [
    { index: 0, type: INT },
    { index: 1, type: TEXT, branch: 'string' },
  ],
  nullMask: 2,
  emptyMask: 3,
};

describe('breaking a property down', () => {
  it('counts each branch, each mask, and works out the rest', () => {
    const summary = jsonColumnSummary(
      variant,
      {
        byIndex: new Map([
          // 100 rows: 60 integers, 18 strings, 12 explicit nulls, 4 empty
          // strings — and therefore 6 rows where the property was not there.
          [0, said(100, 40)],
          [1, said(100, 82)],
          [2, said(100, 88)],
          [3, said(100, 96)],
        ]),
      },
      'value',
    );
    expect(summary).toMatchObject({
      rows: 100,
      explicitNulls: 12,
      emptyStrings: 4,
      missing: 6,
    });
    expect(summary.branches).toEqual([
      { name: 'value', count: 60, primary: true },
      { name: 'string', count: 18 },
    ]);
  });

  /**
   * A mask is `TRUE` or NULL and never `FALSE` in either loader's output, so the
   * non-null count is the count of trues — but a source that reports its named
   * values is more trustworthy than that inference, so it wins where it is there.
   */
  it('prefers what the source said about a mask to what can be inferred', () => {
    const json: JsonColumnView = {
      kind: 'scalar',
      branches: [{ index: 0, type: TEXT }],
      nullMask: 1,
    };
    const withNames = jsonColumnSummary(
      json,
      {
        byIndex: new Map([
          [0, said(10, 10)],
          // Ten non-nulls, of which the source says seven are true. A family
          // would not produce this, and if one does the count is seven.
          [
            1,
            said(10, 0, {
              frequencies: [
                { value: true, count: 7 },
                { value: false, count: 3 },
              ],
            }),
          ],
        ]),
      },
      'note',
    );
    expect(withNames.explicitNulls).toBe(7);
    expect(withNames.missing).toBe(3);
  });

  it('counts a nested value as the branch it is', () => {
    const json: JsonColumnView = {
      kind: 'variant',
      branches: [{ index: 0, type: INT }],
      objectLink: 1,
      arrayCount: 2,
    };
    const summary = jsonColumnSummary(
      json,
      {
        byIndex: new Map([
          [0, said(10, 6)],
          [1, said(10, 7)],
          [2, said(10, 8)],
        ]),
      },
      'thing',
    );
    expect(summary.branches).toEqual([
      { name: 'thing', count: 4, primary: true },
      { name: 'object', count: 3 },
      { name: 'array', count: 2 },
    ]);
    expect(summary.missing).toBe(1);
  });

  /**
   * A column that could not be summarised counts as nothing rather than failing
   * the breakdown, which leaves `missing` larger than it is. Overstating what is
   * absent is the safe direction: it is visibly odd, where a silently dropped
   * branch is not.
   */
  it('survives a column nothing could be said about', () => {
    const summary = jsonColumnSummary(
      variant,
      {
        byIndex: new Map([
          [0, said(50, 20)],
          [1, null],
          [2, said(50, 50)],
          [3, said(50, 50)],
        ]),
      },
      'value',
    );
    expect(summary.branches.map((branch) => branch.count)).toEqual([30, 0]);
    expect(summary.missing).toBe(20);
  });

  /** A source that double-counts should not produce a negative absence. */
  it('never reports a negative number of absent properties', () => {
    const summary = jsonColumnSummary(
      variant,
      {
        byIndex: new Map([
          [0, said(10, 0)],
          [1, said(10, 0)],
          [2, said(10, 0)],
          [3, said(10, 0)],
        ]),
      },
      'value',
    );
    expect(summary.missing).toBe(0);
  });

  it('carries the named branch its own distribution, for the panel underneath', () => {
    const summary = jsonColumnSummary(
      variant,
      {
        byIndex: new Map([
          [0, said(10, 2, { min: 1, max: 9, sum: 40 })],
          [1, said(10, 10)],
          [2, said(10, 10)],
          [3, said(10, 10)],
        ]),
      },
      'value',
    );
    expect(summary.dominant).toMatchObject({ min: 1, max: 9, sum: 40 });
  });

  it('has no distribution to carry for a property with no value column at all', () => {
    // Null in every row the loader saw: a mask and nothing else.
    const json: JsonColumnView = { kind: 'scalar', branches: [], nullMask: 0 };
    const summary = jsonColumnSummary(json, { byIndex: new Map([[0, said(5, 0)]]) }, 'note');
    expect(summary.dominant).toBeUndefined();
    expect(summary).toMatchObject({ rows: 5, explicitNulls: 5, missing: 0, branches: [] });
  });
});

describe('deciding whether a breakdown is worth drawing', () => {
  it('is worth it wherever a single distribution could not say it', () => {
    expect(worthBreakingDown(variant)).toBe(true);
    expect(worthBreakingDown({ kind: 'array', branches: [], arrayCount: 0 })).toBe(true);
    expect(worthBreakingDown({ kind: 'object', branches: [], objectLink: 0 })).toBe(true);
    expect(
      worthBreakingDown({ kind: 'scalar', branches: [{ index: 0, type: BOOL }], nullMask: 1 }),
    ).toBe(true);
  });

  /**
   * A property with one branch and no masks is an ordinary column with a nicer
   * name. It gets the panel it has always had, and a breakdown of one bar saying
   * the same thing twice would be noise.
   */
  it('is not worth it for a property that is an ordinary column', () => {
    expect(worthBreakingDown({ kind: 'scalar', branches: [{ index: 0, type: TEXT }] })).toBe(false);
  });
});
