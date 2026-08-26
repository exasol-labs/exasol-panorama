import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { ResultChunk } from '@panorama/table';
import { buildVector, createResultChunk } from '@panorama/table';
import { NULL_CATEGORY, aggregateChart } from '@panorama/chart';

const VARCHAR = dataType('varchar', 'VARCHAR(64)', { size: 64 });
const DOUBLE = dataType('double', 'DOUBLE');

/** Two columns: a category and a measure, given as rows for readability. */
const chunkOf = (rows: readonly (readonly [string | null, number | null])[]): ResultChunk =>
  createResultChunk(0, rows.length, [
    buildVector(
      VARCHAR,
      rows.map(([category]) => category),
    ),
    buildVector(
      DOUBLE,
      rows.map(([, value]) => value),
    ),
  ]);

const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  type: 'bar',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
  ...overrides,
});

const columns = ['COUNTRY', 'REVENUE'];

const run = (
  rows: readonly (readonly [string | null, number | null])[],
  overrides: Partial<ChartSpec> = {},
  totalRows: number | null = null,
): ReturnType<typeof aggregateChart> =>
  aggregateChart({ spec: spec(overrides), columns, chunks: [chunkOf(rows)], totalRows });

describe('reducing rows to what a chart draws', () => {
  it('sums a measure for each category', () => {
    const data = run([
      ['DE', 10],
      ['US', 3],
      ['DE', 5],
    ]);
    expect(data.categories).toEqual(['DE', 'US']);
    expect(data.series).toEqual([{ name: 'REVENUE', values: [15, 3] }]);
    expect(data.rows).toBe(3);
  });

  it('ranks categories by size, so the biggest bars come first', () => {
    const data = run([
      ['small', 1],
      ['big', 100],
    ]);
    expect(data.categories).toEqual(['big', 'small']);
  });

  it('averages, minimises and maximises on request', () => {
    const rows = [
      ['DE', 10],
      ['DE', 20],
    ] as const;
    expect(run(rows, { aggregate: 'average' }).series[0]?.values).toEqual([15]);
    expect(run(rows, { aggregate: 'min' }).series[0]?.values).toEqual([10]);
    expect(run(rows, { aggregate: 'max' }).series[0]?.values).toEqual([20]);
  });

  it('counts rows without needing a column to count', () => {
    const data = run(
      [
        ['DE', null],
        ['DE', null],
        ['US', null],
      ],
      { aggregate: 'count', values: [] },
    );
    expect(data.series).toEqual([{ name: 'rows', values: [2, 1] }]);
  });

  it('leaves a gap where a category reported no figure at all', () => {
    // Not nought: a category nobody reported a number for has not reported zero.
    const data = run([
      ['DE', 10],
      ['US', null],
    ]);
    expect(data.series[0]?.values).toEqual([10, null]);
  });

  it('labels a category that is not text', () => {
    const data = aggregateChart({
      spec: spec({ category: 'REVENUE', values: ['REVENUE'] }),
      columns,
      chunks: [chunkOf([['DE', 7]])],
      totalRows: 1,
    });
    expect(data.categories).toEqual(['7']);
  });

  it('names the missing category rather than leaving a blank bar', () => {
    const data = run([[null, 5]]);
    expect(data.categories).toEqual([NULL_CATEGORY]);
  });

  it('draws a series per measure', () => {
    const data = aggregateChart({
      spec: spec({ values: ['REVENUE', 'COUNTRY'] }),
      columns,
      chunks: [
        chunkOf([
          ['DE', 2],
          ['DE', 3],
        ]),
      ],
      totalRows: 2,
    });
    expect(data.series.map((series) => series.name)).toEqual(['REVENUE', 'COUNTRY']);
    // Text cannot be summed, so its series is a gap rather than a nonsense zero.
    expect(data.series[1]?.values).toEqual([null]);
  });

  it('orders the categories as asked, which decides which ones survive', () => {
    const rows = [
      ['b', 1],
      ['a', 5],
      ['c', 3],
    ] as const;
    expect(run(rows).categories).toEqual(['a', 'c', 'b']);
    expect(run(rows, { sort: 'name' }).categories).toEqual(['a', 'b', 'c']);
    // As they came: a query with an ORDER BY has said something already.
    expect(run(rows, { sort: 'natural' }).categories).toEqual(['b', 'a', 'c']);
  });

  it('keeps the biggest, the first alphabetically, or the first seen', () => {
    const rows = [
      ['b', 1],
      ['a', 5],
      ['c', 3],
    ] as const;
    expect(run(rows, { categoryLimit: 1 }).categories).toEqual(['a']);
    expect(run(rows, { sort: 'name', categoryLimit: 1 }).categories).toEqual(['a']);
    expect(run(rows, { sort: 'natural', categoryLimit: 1 }).categories).toEqual(['b']);
  });

  it('gathers the categories beyond the limit rather than pretending they are gone', () => {
    const rows = Array.from(
      { length: 8 },
      (_, index) => [`c${index}`, index + 1] as readonly [string, number],
    );
    const data = run(rows, { categoryLimit: 3 });
    expect(data.categories).toHaveLength(3);
    expect(data.gathered).toBe(5);
  });

  it('says nothing about gathering when nothing was left out', () => {
    expect(run([['DE', 1]], { categoryLimit: 3 }).gathered).toBeUndefined();
  });

  it('keeps at least one category however small the limit', () => {
    expect(
      run(
        [
          ['DE', 1],
          ['US', 2],
        ],
        { categoryLimit: 0 },
      ).categories,
    ).toHaveLength(1);
  });

  it('says which rows it read', () => {
    expect(run([['DE', 1]], {}, 1).basis).toBe('exact');
    // Fewer read than there are: a picture of a beginning, and it says so.
    expect(run([['DE', 1]], {}, 5_000).basis).toBe('sampled');
    // A source that cannot say how many rows it has cannot claim to be exact.
    expect(run([['DE', 1]], {}, null).basis).toBe('sampled');
  });

  it('reads across every block it was given', () => {
    const data = aggregateChart({
      spec: spec(),
      columns,
      chunks: [chunkOf([['DE', 1]]), chunkOf([['DE', 2]])],
      totalRows: 2,
    });
    expect(data.series[0]?.values).toEqual([3]);
    expect(data.rows).toBe(2);
  });

  it('ignores a value that is not a number', () => {
    const data = aggregateChart({
      spec: spec(),
      columns,
      chunks: [
        createResultChunk(0, 2, [
          buildVector(VARCHAR, ['DE', 'DE']),
          buildVector(VARCHAR, ['4', 'not a number']),
        ]),
      ],
      totalRows: 2,
    });
    expect(data.series[0]?.values).toEqual([4]);
  });

  it('groups everything together when the category column is not there', () => {
    const data = aggregateChart({
      spec: spec({ category: 'NO_SUCH_COLUMN' }),
      columns,
      chunks: [
        chunkOf([
          ['DE', 1],
          ['US', 2],
        ]),
      ],
      totalRows: 2,
    });
    expect(data.categories).toEqual([NULL_CATEGORY]);
    expect(data.series[0]?.values).toEqual([3]);
  });

  it('gives a gap for a measure column that is not there', () => {
    const data = aggregateChart({
      spec: spec({ values: ['NO_SUCH_COLUMN'] }),
      columns,
      chunks: [chunkOf([['DE', 1]])],
      totalRows: 1,
    });
    expect(data.series[0]?.values).toEqual([null]);
  });

  it('has nothing to draw from no rows', () => {
    const data = aggregateChart({ spec: spec(), columns, chunks: [], totalRows: 0 });
    expect(data.categories).toEqual([]);
    expect(data.rows).toBe(0);
  });

  it('ranks by row count when it is counting them', () => {
    const data = run(
      [
        ['one', null],
        ['many', null],
        ['many', null],
      ],
      { aggregate: 'count', values: [] },
    );
    expect(data.categories).toEqual(['many', 'one']);
  });
});

describe('a cross-tabulation', () => {
  /** Three columns: a category, a second grouping column, and a measure. */
  const crossChunk = (
    rows: readonly (readonly [string | null, string | null, number | null])[],
  ): ResultChunk =>
    createResultChunk(0, rows.length, [
      buildVector(
        VARCHAR,
        rows.map(([category]) => category),
      ),
      buildVector(
        VARCHAR,
        rows.map(([, split]) => split),
      ),
      buildVector(
        DOUBLE,
        rows.map(([, , value]) => value),
      ),
    ]);

  const cross = (
    rows: readonly (readonly [string | null, string | null, number | null])[],
    overrides: Partial<ChartSpec> = {},
  ): ReturnType<typeof aggregateChart> =>
    aggregateChart({
      spec: spec({ breakdown: 'DECILE', ...overrides }),
      columns: ['COUNTRY', 'DECILE', 'REVENUE'],
      chunks: [crossChunk(rows)],
      totalRows: rows.length,
    });

  it('makes the series the values of the second column', () => {
    // The one thing a category against several *columns* cannot express: two
    // columns of data, tabulated against each other.
    const data = cross([
      ['Sweden', 'top', 10],
      ['Sweden', 'bottom', 1],
      ['France', 'top', 20],
      ['France', 'bottom', 2],
      ['Sweden', 'top', 5],
    ]);
    expect(data.categories).toEqual(['Sweden', 'France']);
    expect(data.series).toEqual([
      { name: 'top', values: [15, 20] },
      { name: 'bottom', values: [1, 2] },
    ]);
  });

  it('leaves a pair nobody reported as a gap rather than a nought', () => {
    // Which is what makes an empty cell in a heatmap tell the truth.
    const data = cross([
      ['Sweden', 'top', 10],
      ['France', 'bottom', 2],
    ]);
    expect(data.series).toEqual([
      { name: 'top', values: [10, null] },
      { name: 'bottom', values: [null, 2] },
    ]);
  });

  it('counts rows when that is the measure', () => {
    const data = cross(
      [
        ['Sweden', 'top', null],
        ['Sweden', 'top', null],
        ['France', 'top', null],
      ],
      { aggregate: 'count', values: [] },
    );
    expect(data.series).toEqual([{ name: 'top', values: [2, 1] }]);
  });

  it('averages, and skips a missing figure rather than calling it nought', () => {
    const data = cross(
      [
        ['Sweden', 'top', 10],
        ['Sweden', 'top', null],
        ['Sweden', 'top', 20],
      ],
      { aggregate: 'average' },
    );
    expect(data.series[0]?.values).toEqual([15]);
  });

  it('orders and limits the categories as any other chart does', () => {
    const rows: (readonly [string, string, number])[] = [
      ['small', 'a', 1],
      ['big', 'a', 100],
      ['middle', 'a', 10],
    ];
    expect(cross(rows).categories).toEqual(['big', 'middle', 'small']);
    expect(cross(rows, { sort: 'name' }).categories).toEqual(['big', 'middle', 'small']);
    expect(cross(rows, { sort: 'natural' }).categories).toEqual(['small', 'big', 'middle']);
    const limited = cross(rows, { categoryLimit: 2 });
    expect(limited.categories).toEqual(['big', 'middle']);
    expect(limited.gathered).toBe(1);
  });

  it('says which rows it read, and names a missing value', () => {
    const data = aggregateChart({
      spec: spec({ breakdown: 'DECILE' }),
      columns: ['COUNTRY', 'DECILE', 'REVENUE'],
      chunks: [crossChunk([[null, null, 1]])],
      totalRows: 500,
    });
    expect(data.categories).toEqual([NULL_CATEGORY]);
    expect(data.series[0]?.name).toBe(NULL_CATEGORY);
    expect(data.basis).toBe('sampled');
    expect(data.values).toEqual([null]);
  });

  it('reduces what it can when a column it was told about is not there', () => {
    // A specification can name a column a later result set no longer has, and a
    // chart of nothing at all is more use than a crash.
    const data = aggregateChart({
      spec: spec({ breakdown: 'GONE' }),
      columns: ['COUNTRY', 'DECILE', 'REVENUE'],
      chunks: [crossChunk([['Sweden', 'top', 10]])],
      totalRows: 1,
    });
    expect(data.categories).toEqual(['Sweden']);
    expect(data.series).toEqual([{ name: NULL_CATEGORY, values: [10] }]);
    const noMeasure = aggregateChart({
      spec: spec({ breakdown: 'DECILE', values: ['MISSING'] }),
      columns: ['COUNTRY', 'DECILE', 'REVENUE'],
      chunks: [crossChunk([['Sweden', 'top', 10]])],
      totalRows: 1,
    });
    expect(noMeasure.series[0]?.values).toEqual([null]);
  });

  it('takes the smallest and the largest of a pair', () => {
    const rows: (readonly [string, string, number])[] = [
      ['Sweden', 'top', 10],
      ['Sweden', 'top', 4],
    ];
    expect(cross(rows, { aggregate: 'min' }).series[0]?.values).toEqual([4]);
    expect(cross(rows, { aggregate: 'max' }).series[0]?.values).toEqual([10]);
  });

  it('is not a cross-tabulation when the second column is the first one', () => {
    // Nothing to tabulate against itself, so it reduces the ordinary way.
    const data = cross([['Sweden', 'top', 10]], { breakdown: 'COUNTRY' });
    expect(data.series.map((series) => series.name)).toEqual(['REVENUE']);
  });
});
