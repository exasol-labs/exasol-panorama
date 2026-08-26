import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import type { CellValue } from '@panorama/table';
import {
  ColumnSummaryBuilder,
  HISTOGRAM_BINS,
  MAX_NAMED_VALUES,
  MAX_TRACKED_DISTINCT,
  binNumbers,
  compareValues,
  isNumericType,
  isOrderedType,
  summaryChart,
} from '@panorama/table';

const DECIMAL = dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 });
const DOUBLE = dataType('double', 'DOUBLE');
const VARCHAR = dataType('varchar', 'VARCHAR(64)', { size: 64 });
const BOOLEAN = dataType('boolean', 'BOOLEAN');
const DATE = dataType('date', 'DATE');
const TIMESTAMP = dataType('timestamp', 'TIMESTAMP');

const summarise = (
  values: readonly CellValue[],
  type = VARCHAR,
  basis: 'exact' | 'sampled' = 'exact',
): ReturnType<ColumnSummaryBuilder['finish']> => {
  const builder = new ColumnSummaryBuilder('C', type);
  for (const value of values) builder.add(value);
  return builder.finish(basis);
};

describe('which types get which treatment', () => {
  it('takes a mean of numbers and of nothing else', () => {
    expect(isNumericType(DECIMAL)).toBe(true);
    expect(isNumericType(DOUBLE)).toBe(true);
    expect(isNumericType(VARCHAR)).toBe(false);
    expect(isNumericType(DATE)).toBe(false);
  });

  it('reads dates, numbers and booleans as series and text by popularity', () => {
    expect(isOrderedType(DATE)).toBe(true);
    expect(isOrderedType(TIMESTAMP)).toBe(true);
    expect(isOrderedType(BOOLEAN)).toBe(true);
    expect(isOrderedType(DOUBLE)).toBe(true);
    expect(isOrderedType(VARCHAR)).toBe(false);
  });
});

describe('a total order over cell values', () => {
  it('compares numbers as numbers', () => {
    expect(compareValues(2, 10)).toBeLessThan(0);
    expect(compareValues(10, 2)).toBeGreaterThan(0);
  });

  it('compares digits sent as text as numbers, which is what they are', () => {
    // A DECIMAL(36,0) arrives as a string and must not sort like one: '10' comes
    // after '2', not before it.
    expect(compareValues('10', '2')).toBeGreaterThan(0);
  });

  it('compares text as text', () => {
    expect(compareValues('apple', 'banana')).toBeLessThan(0);
    expect(compareValues('banana', 'apple')).toBeGreaterThan(0);
    expect(compareValues('apple', 'apple')).toBe(0);
  });

  it('puts false before true, whichever side it is on', () => {
    expect(compareValues(false, true)).toBeLessThan(0);
    expect(compareValues(true, false)).toBeGreaterThan(0);
    expect(compareValues(true, 'true')).toBeGreaterThan(0);
  });

  it('puts null at the end of a series rather than under the letter n', () => {
    // A grouped query returns a null group, so a date column with gaps gets a
    // bar for them. It belongs at the end of the series, not spelled out and
    // sorted among the dates.
    expect(compareValues(null, 'a')).toBeGreaterThan(0);
    expect(compareValues('a', null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });
});

describe('cutting numbers into ranges', () => {
  it('has nothing to say about no values', () => {
    expect(binNumbers([])).toEqual([]);
  });

  it('draws one bar when every value is the same', () => {
    // Not twenty-four empty bars and one full one: the truthful picture of a
    // constant column is a single bar.
    expect(binNumbers([5, 5, 5])).toEqual([{ from: 5, to: 5, count: 3 }]);
  });

  it('spreads values over equal ranges and keeps the empty ones', () => {
    const bins = binNumbers([0, 0, 10], 4);
    expect(bins).toHaveLength(4);
    expect(bins.map((bin) => bin.count)).toEqual([2, 0, 0, 1]);
    expect(bins[0]?.from).toBe(0);
    expect(bins[3]?.to).toBe(10);
  });

  it('finds the span whichever order the values arrive in', () => {
    const bins = binNumbers([10, 0, 5], 2);
    expect(bins[0]?.from).toBe(0);
    expect(bins.at(-1)?.to).toBe(10);
    expect(bins.map((bin) => bin.count)).toEqual([1, 2]);
  });

  it('puts the largest value in the last range rather than past the end', () => {
    const bins = binNumbers([1, 2, 3], HISTOGRAM_BINS);
    expect(bins).toHaveLength(HISTOGRAM_BINS);
    expect(bins.at(-1)?.count).toBe(1);
    expect(bins.reduce((total, bin) => total + bin.count, 0)).toBe(3);
  });
});

describe('summarising a column value by value', () => {
  it('counts rows and nulls apart', () => {
    const summary = summarise([null, 'a', null]);
    expect(summary.rows).toBe(3);
    expect(summary.nulls).toBe(2);
    expect(summary.column).toBe('C');
  });

  it('says nothing about the shape of a column that is entirely null', () => {
    const summary = summarise([null, null]);
    expect(summary.distinct).toBe(0);
    expect(summary.min).toBeUndefined();
    expect(summary.frequencies).toBeUndefined();
    expect(summary.bins).toBeUndefined();
    expect(summaryChart(summary).kind).toBe('none');
  });

  it('names every value when there are few enough of them', () => {
    const summary = summarise(['a', 'b', 'b']);
    expect(summary.frequenciesComplete).toBe(true);
    // Text reads biggest bar first: nobody wants country names alphabetised.
    expect(summary.frequencies).toEqual([
      { value: 'b', count: 2 },
      { value: 'a', count: 1 },
    ]);
    expect(summaryChart(summary).kind).toBe('frequency');
  });

  it('reads a named set of numbers as a series instead', () => {
    const summary = summarise([3, 1, 1, 2], DOUBLE);
    expect(summary.frequencies?.map((entry) => entry.value)).toEqual([1, 2, 3]);
  });

  it('bins a numeric column with more values than can be named', () => {
    const values = Array.from({ length: MAX_NAMED_VALUES + 1 }, (_, index) => index);
    const summary = summarise(values, DOUBLE);
    expect(summary.frequencies).toBeUndefined();
    expect(summary.bins).toHaveLength(HISTOGRAM_BINS);
    expect(summaryChart(summary).kind).toBe('histogram');
    expect(summary.mean).toBeCloseTo((MAX_NAMED_VALUES + 0) / 2);
  });

  it('names only the top few of a text column with too many values', () => {
    const values = [
      ...Array.from({ length: MAX_NAMED_VALUES + 4 }, (_, index) => `v${index}`),
      'v0',
    ];
    const summary = summarise(values);
    expect(summary.frequenciesComplete).toBe(false);
    expect(summary.frequencies).toHaveLength(MAX_NAMED_VALUES);
    expect(summary.frequencies?.[0]).toEqual({ value: 'v0', count: 2 });
  });

  it('reports the extremes for every type that can be ordered', () => {
    expect(summarise(['pear', 'apple', 'fig']).min).toBe('apple');
    expect(summarise(['pear', 'apple', 'fig']).max).toBe('pear');
  });

  it('takes a mean only of the numbers it could read', () => {
    // A DECIMAL too wide for a double arrives as text; the ones that parse are
    // still worth averaging, and the rest are left out rather than counted as 0.
    const summary = summarise([2, 4, 'not a number'], DOUBLE);
    expect(summary.mean).toBe(3);
  });

  it('has no mean for a column with no numbers in it at all', () => {
    expect(summarise([null], DOUBLE).mean).toBeUndefined();
    expect(summarise(['a']).mean).toBeUndefined();
  });

  it('gives up the distinct count rather than reporting the part that fit', () => {
    const builder = new ColumnSummaryBuilder('C', VARCHAR);
    for (let index = 0; index < MAX_TRACKED_DISTINCT + 5; index += 1) {
      builder.add(`v${index}`);
    }
    const summary = builder.finish('exact');
    // Absent knowledge, not a count of ten thousand.
    expect(summary.distinct).toBeNull();
    expect(summary.frequenciesComplete).toBe(false);
  });

  it('still bins an overflowing numeric column', () => {
    const builder = new ColumnSummaryBuilder('C', DOUBLE);
    for (let index = 0; index < MAX_TRACKED_DISTINCT + 5; index += 1) builder.add(index);
    const summary = builder.finish('exact');
    expect(summary.distinct).toBeNull();
    expect(summary.bins).toHaveLength(HISTOGRAM_BINS);
  });

  it('carries the basis through, because which rows these were is the answer', () => {
    expect(summarise(['a'], VARCHAR, 'sampled').basis).toBe('sampled');
    expect(summarise(['a']).basis).toBe('exact');
  });

  it('reads a shape of none from a summary carrying no chart', () => {
    const summary = { ...summarise(['a']), frequencies: [], bins: [] };
    expect(summaryChart(summary).kind).toBe('none');
  });
});
