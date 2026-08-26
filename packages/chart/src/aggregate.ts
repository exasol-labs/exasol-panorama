import type { ChartSpec } from '@panorama/core';
import { DEFAULT_CHART_CATEGORIES, isBrokenDown } from '@panorama/core';
import type { CellValue, ResultChunk } from '@panorama/table';
import { cellValue } from '@panorama/table';
import type { ChartData, ChartSeries } from './draw-list.js';

/**
 * Reduces rows to the few dozen numbers a chart actually draws.
 *
 * Done where the rows already are — in the worker, next to the result set —
 * because a chart of ten billion rows is still a few dozen numbers, and sending
 * the rows across to discover that would be sending the whole table to draw a
 * picture of it.
 *
 * One pass, and no sort of the rows themselves: categories are collected in the
 * order they appear and ranked at the end. A pass that had to sort would be a
 * pass that had to hold everything.
 */

/** The label an unset value takes. Not the empty string, which reads as a gap. */
export const NULL_CATEGORY = '(null)';

/** One measure's running figures for one category. */
interface Measure {
  total: number;
  count: number;
  min: number;
  max: number;
}

interface Bucket {
  readonly key: string;
  /** What the key was before it was a label, for anything that has to compare it. */
  readonly value: CellValue;
  /** One per measured column, in the order the specification names them. */
  readonly measures: readonly Measure[];
  rows: number;
}

/** A measured column and where to find it in the chunks. */
interface Plan {
  readonly name: string;
  readonly column: number;
}

const label = (value: CellValue): string =>
  value === null ? NULL_CATEGORY : typeof value === 'string' ? value : String(value);

/**
 * The value of one measure for one category.
 *
 * Never asked about a row count — that needs no measure at all, so it is answered
 * from the bucket directly rather than passing a measure nobody looks at.
 */
const reduce = (measure: Measure, spec: ChartSpec): number | null => {
  // No numbers to reduce is a gap in the series, not a zero: a category nobody
  // reported a figure for has not reported nought.
  if (measure.count === 0) return null;
  switch (spec.aggregate) {
    case 'sum':
      return settled(measure.total, spec);
    case 'average':
      return settled(measure.total / measure.count, spec);
    case 'min':
      return settled(measure.min, spec);
    default:
      return settled(measure.max, spec);
  }
};

/**
 * A figure without the noise floating-point addition leaves behind.
 *
 * Adding a few hundred two-decimal amounts in binary gives 3483.7700000000004,
 * and that reaches an axis label and a chart somebody quotes from. The last three
 * digits of a double are not information about the data, so they are dropped:
 * twelve significant digits keeps every figure any of this could honestly have
 * measured and loses the artefact.
 *
 * `precision` is the explicit form, for a figure that should be read to a stated
 * number of decimals — the label on a chart of money wants two, whatever the sum
 * came out as.
 */
const settled = (value: number, spec: ChartSpec): number => {
  const places = spec.precision;
  if (places !== undefined && Number.isFinite(places)) {
    const factor = 10 ** Math.max(0, Math.min(12, Math.trunc(places)));
    return Math.round(value * factor) / factor;
  }
  return Number.isFinite(value) ? Number(value.toPrecision(12)) : value;
};

/**
 * Puts the categories in the order asked for.
 *
 * Which matters twice over: it is the order they are drawn in, and it decides
 * which ones survive the limit. Keeping the natural order is the only truthful
 * choice for rows that arrived sorted — a query with an `ORDER BY` has said
 * something, and re-sorting throws it away — so it takes them as they came, first
 * seen first.
 */
const order = (buckets: readonly Bucket[], spec: ChartSpec): readonly Bucket[] => {
  switch (spec.sort ?? 'size') {
    case 'name':
      // Keys are a map's keys, so no two are equal and there is no tie to break.
      return [...buckets].sort((a, b) => (a.key < b.key ? -1 : 1));
    case 'natural':
      return buckets;
    default:
      return [...buckets].sort((a, b) => weight(b, spec) - weight(a, spec));
  }
};

/** How big a bucket is, for ranking which categories are worth drawing. */
const weight = (bucket: Bucket, spec: ChartSpec): number =>
  spec.aggregate === 'count'
    ? bucket.rows
    : bucket.measures.reduce((total, measure) => total + Math.abs(measure.total), 0);

export interface ChartAggregateInput {
  readonly spec: ChartSpec;
  readonly columns: readonly string[];
  readonly chunks: readonly ResultChunk[];
  /** Total rows in the result set, so the chart can say what it did not read. */
  readonly totalRows: number | null;
}

/**
 * The reduction, when the series are a column's values rather than the columns.
 *
 * A cross-tabulation: one bucket per pair, and the pairs turned inside out at the
 * end into the same shape every other chart gets — a list of categories and a
 * series per distinct value of the second column. Which means a grouped bar
 * chart, a stacked one and a heatmap are all the same numbers, laid out
 * differently, and nothing downstream needs a second code path.
 *
 * One measure, because two measures broken down two ways is a cube.
 */
const crossTabulate = (input: ChartAggregateInput): ChartData => {
  const { spec, columns, chunks } = input;
  const categoryIndex = columns.indexOf(spec.category);
  const breakdownIndex = columns.indexOf(spec.breakdown as string);
  const counting = spec.aggregate === 'count';
  const measureIndex = counting ? -1 : columns.indexOf(spec.values[0] ?? '');

  /** Category order, breakdown order, and a figure per pair. */
  const categories = new Map<string, CellValue>();
  const series = new Map<string, number>();
  const cells = new Map<string, Measure>();
  const weights = new Map<string, number>();
  let rows = 0;

  for (const chunk of chunks) {
    const categoryColumn = chunk.columns[categoryIndex];
    const breakdownColumn = chunk.columns[breakdownIndex];
    const measureColumn = measureIndex < 0 ? undefined : chunk.columns[measureIndex];
    for (let row = 0; row < chunk.rowCount; row += 1) {
      rows += 1;
      const value = categoryColumn === undefined ? null : cellValue(categoryColumn, row);
      const category = label(value);
      if (!categories.has(category)) categories.set(category, value);
      const name =
        breakdownColumn === undefined ? NULL_CATEGORY : label(cellValue(breakdownColumn, row));
      if (!series.has(name)) series.set(name, series.size);
      const key = `${category}\u0000${name}`;
      let cell = cells.get(key);
      if (cell === undefined) {
        cell = { total: 0, count: 0, min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY };
        cells.set(key, cell);
      }
      if (counting) {
        // Counting rows needs no measure: the count *is* the figure. Which is
        // not the same as a measure column that is missing — that is a gap, and
        // reporting it as one row apiece would be inventing data.
        cell.total += 1;
        cell.count += 1;
        cell.min = Math.min(cell.min, 1);
        cell.max = Math.max(cell.max, 1);
      } else if (measureColumn !== undefined) {
        const raw = cellValue(measureColumn, row);
        if (raw !== null) {
          const numeric = Number(raw);
          if (Number.isFinite(numeric)) {
            cell.total += numeric;
            cell.count += 1;
            cell.min = Math.min(cell.min, numeric);
            cell.max = Math.max(cell.max, numeric);
          }
        }
      }
      weights.set(category, (weights.get(category) ?? 0) + Math.abs(cell.total));
    }
  }

  const ordered = [...categories.keys()];
  const ranked =
    (spec.sort ?? 'size') === 'name'
      ? [...ordered].sort((a, b) => (a < b ? -1 : 1))
      : (spec.sort ?? 'size') === 'natural'
        ? ordered
        : [...ordered].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0));
  const limit = Math.max(1, spec.categoryLimit ?? DEFAULT_CHART_CATEGORIES);
  const kept = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  const measure = counting ? { ...spec, aggregate: 'sum' as const } : spec;

  const total = input.totalRows;
  return {
    categories: kept,
    values: kept.map((category) => categories.get(category) ?? null),
    series: [...series.keys()].map((name) => ({
      name,
      // A pair nothing was reported for is a gap, not a nought — which is what
      // makes an empty cell in a heatmap tell the truth.
      values: kept.map((category) => {
        const cell = cells.get(`${category}\u0000${name}`);
        return cell === undefined ? null : reduce(cell, measure);
      }),
    })),
    rows,
    basis: total === null || rows < total ? 'sampled' : 'exact',
    ...(rest.length === 0 ? {} : { gathered: rest.length }),
  };
};

export const aggregateChart = (input: ChartAggregateInput): ChartData => {
  const { spec, columns, chunks } = input;
  if (isBrokenDown(spec)) return crossTabulate(input);
  const categoryIndex = columns.indexOf(spec.category);
  const plans: readonly Plan[] =
    spec.aggregate === 'count'
      ? []
      : spec.values.map((name) => ({ name, column: columns.indexOf(name) }));

  const buckets = new Map<string, Bucket>();
  let rows = 0;
  for (const chunk of chunks) {
    const categoryColumn = chunk.columns[categoryIndex];
    // Resolved once per chunk rather than once per row: the shape of a chunk does
    // not change between its rows.
    const measureColumns = plans.map((plan) => chunk.columns[plan.column]);
    for (let row = 0; row < chunk.rowCount; row += 1) {
      rows += 1;
      const key =
        categoryColumn === undefined ? NULL_CATEGORY : label(cellValue(categoryColumn, row));
      let bucket = buckets.get(key);
      if (bucket === undefined) {
        bucket = {
          key,
          value: categoryColumn === undefined ? null : cellValue(categoryColumn, row),
          measures: plans.map(() => ({
            total: 0,
            count: 0,
            min: Number.POSITIVE_INFINITY,
            max: Number.NEGATIVE_INFINITY,
          })),
          rows: 0,
        };
        buckets.set(key, bucket);
      }
      bucket.rows += 1;
      // Walked rather than indexed, so every measure is one that exists.
      bucket.measures.forEach((measure, slot) => {
        const column = measureColumns[slot];
        if (column === undefined) return;
        const cell = cellValue(column, row);
        // Checked before converting: `Number(null)` is nought, and counting a
        // missing figure as nought understates every average that meets one.
        if (cell === null) return;
        const value = Number(cell);
        if (!Number.isFinite(value)) return;
        measure.total += value;
        measure.count += 1;
        measure.min = Math.min(measure.min, value);
        measure.max = Math.max(measure.max, value);
      });
    }
  }

  const limit = Math.max(1, spec.categoryLimit ?? DEFAULT_CHART_CATEGORIES);
  const ranked = order([...buckets.values()], spec);
  const kept = ranked.slice(0, limit);
  const rest = ranked.slice(limit);
  const series: ChartSeries[] =
    spec.aggregate === 'count'
      ? [
          {
            name: 'rows',
            values: kept.map((bucket) => bucket.rows),
          },
        ]
      : plans.map((plan, slot) => ({
          name: plan.name,
          // The bucket was built from `plans`, so it has a measure per plan.
          values: kept.map((bucket) => reduce(bucket.measures[slot] as Measure, spec)),
        }));

  const total = input.totalRows;
  return {
    categories: kept.map((bucket) => bucket.key),
    values: kept.map((bucket) => bucket.value),
    series,
    rows,
    // Which rows these were is part of the answer, exactly as it is for a column
    // summary: a chart of the first twenty thousand rows of a billion is useful
    // and misleading depending entirely on whether it says so.
    basis: total === null || rows < total ? 'sampled' : 'exact',
    ...(rest.length === 0 ? {} : { gathered: rest.length }),
  };
};
