import type { ChartFrameSpec, ChartSpec, ChartWindowSpec } from '@panorama/core';
import {
  DEFAULT_FRAME_ROWS,
  DEFAULT_RESAMPLE_POINTS,
  MAX_FRAME_ROWS,
  MAX_RESAMPLE_POINTS,
  PRIMARY_FRAME,
  chartFramesOf,
  isBrokenDown,
} from '@panorama/core';
import type { CellValue, ResultChunk } from '@panorama/table';
import { cellValue } from '@panorama/table';
import type { ChartAggregateInput } from './aggregate.js';
import { aggregateChart } from './aggregate.js';
import type { ChartData } from './draw-list.js';

/**
 * Named data sets, as a chart reads them.
 *
 * One shape for every kind: a name, the columns it has, and rows of values. A
 * reduction and a projection of raw rows are the same thing here, which is the
 * whole point — a heatmap, a matrix, a scatter sized by a fourth column and a
 * graph's edge list are all "a table with named columns", and nothing downstream
 * needs a second code path for any of them.
 *
 * Built where the rows already are, in the worker, for the same reason the
 * reduction is: a data set is a few dozen or a few thousand values, and sending
 * the rows across to find that out would be sending the table to draw a picture
 * of it.
 */

export interface ChartFrame {
  readonly name: string;
  /**
   * Columns it was asked to read that the relation has not got.
   *
   * A data set builds the shape it was asked for either way — the dimension is
   * there and every value in it is nothing — because which column was missing is
   * an answer and a data set that silently lost a column is not. Reported as an
   * unresolved channel, beside the ones a written option names.
   */
  readonly missing?: readonly string[];
  /**
   * Which part of the relation this is, where it is a part.
   *
   * Reported because a picture cannot say "this is the first of March to the
   * eighth of a hundred years of it", and what it means depends entirely on that.
   */
  readonly window?: ChartWindowSpec;
  /** Rows walked to find the ones it kept, for a window that had to look. */
  readonly scanned?: number;
  readonly dimensions: readonly string[];
  readonly rows: readonly (readonly CellValue[])[];
  /**
   * The column a drawn mark can be traced back to the relation by, where there is
   * one, and the value of it for each row.
   *
   * Kept beside the rows rather than looked up in them, because the two are not
   * the same thing: a category's *label* is what a chart writes on an axis and a
   * category's *value* is what a predicate compares against, and `String(7)`
   * makes a perfectly good label that cannot be compared with a number. This is
   * the value.
   */
  readonly key?: string;
  readonly keys?: readonly CellValue[];
  /** Rows read to build it, and whether that was all of them. */
  readonly read: number;
  readonly of: number | null;
  readonly basis: 'exact' | 'sampled';
}

/** Everything the reduction reads, plus the specification that shapes it. */
export interface ChartFrameInput {
  readonly spec: ChartSpec;
  readonly columns: readonly string[];
  readonly chunks: readonly ResultChunk[];
  readonly totalRows: number | null;
  /** The window these rows were read for, where they were read for one. */
  readonly window?: ChartWindowSpec;
  /** Rows walked to find them, which a value window can exceed what it kept. */
  readonly scanned?: number;
}

/**
 * The chart's own reduction, as a data set.
 *
 * Long where a second grouping column makes it a cross-tabulation, because a
 * matrix reads `[x, y, value]` triples and there is no arrangement of columns
 * that is one; wide otherwise, a column per measure. This is the shape a written
 * option has always been handed — it is stated here rather than in the adapter so
 * that the adapter has nothing to decide.
 */
export const reductionFrame = (spec: ChartSpec, data: ChartData): ChartFrame => {
  const category = spec.category === '' ? 'category' : spec.category;
  if (isBrokenDown(spec)) {
    const measure = spec.aggregate === 'count' ? 'rows' : (spec.values[0] ?? 'value');
    return {
      name: PRIMARY_FRAME,
      dimensions: [category, spec.breakdown as string, measure],
      rows: data.series.flatMap((series) =>
        data.categories.map((name, index): readonly CellValue[] => [
          name,
          series.name,
          series.values[index] ?? null,
        ]),
      ),
      // From what the specification said, not from the label above: a chart with
      // no category chosen has a column called `category` in its data set and no
      // column of that name in the relation, so there is nothing to trace by.
      ...(spec.category === '' ? {} : { key: spec.category }),
      // One per row, in the same order: a triple's row is a category and a
      // breakdown, and the category is what the rows behind it are found by.
      keys: data.series.flatMap(() => data.values.map((value) => value)),
      read: data.rows,
      of: null,
      basis: data.basis,
    };
  }
  return {
    name: PRIMARY_FRAME,
    dimensions: [category, ...data.series.map((series) => series.name)],
    rows: data.categories.map((name, index): readonly CellValue[] => [
      name,
      ...data.series.map((series) => series.values[index] ?? null),
    ]),
    ...(spec.category === '' ? {} : { key: spec.category }),
    keys: [...data.values],
    read: data.rows,
    of: null,
    basis: data.basis,
  };
};

/** What a window did, for a data set that was read through one. */
const windowReport = (input: ChartFrameInput): { window?: ChartWindowSpec; scanned?: number } =>
  input.window === undefined
    ? {}
    : { window: input.window, ...(input.scanned === undefined ? {} : { scanned: input.scanned }) };

/** A reduction of the same rows under another name and another grouping. */
const groupFrame = (
  frame: Extract<ChartFrameSpec, { kind: 'group' }>,
  input: ChartFrameInput,
): ChartFrame => {
  // The chart's own reducer, asked a different question of the same rows: one
  // implementation of grouping, so a data set and the chart it sits beside can
  // never disagree about what a sum is.
  //
  // Built from the data set's own fields rather than spread over the chart's. A
  // data set is its own question, and inheriting the chart's `breakdown` made a
  // one-dimensional marginal beside a cross-tabulated matrix inexpressible: the
  // marginal came back as triples of a breakdown nobody had asked it for, and
  // there was no way to say "not that one".
  const aggregate: ChartAggregateInput = {
    spec: {
      type: input.spec.type,
      category: frame.category,
      values: frame.values,
      aggregate: frame.aggregate,
      ...(frame.breakdown === undefined || frame.breakdown === ''
        ? {}
        : { breakdown: frame.breakdown }),
      ...(frame.sort === undefined ? {} : { sort: frame.sort }),
      ...(frame.categoryLimit === undefined ? {} : { categoryLimit: frame.categoryLimit }),
      // Its own, or the chart's: how a figure should be read is a property of the
      // figure, so a data set that says nothing about it follows the chart.
      ...((frame.precision ?? input.spec.precision) === undefined
        ? {}
        : { precision: frame.precision ?? input.spec.precision }),
    },
    columns: input.columns,
    chunks: input.chunks,
    totalRows: input.totalRows,
  };
  const reduced = reductionFrame(aggregate.spec, aggregateChart(aggregate));
  return {
    ...reduced,
    name: frame.name,
    ...missingColumns(
      [
        frame.category,
        ...frame.values,
        ...(frame.breakdown === undefined ? [] : [frame.breakdown]),
      ],
      input.columns,
    ),
  };
};

/** The columns a data set asked for that the relation has not got. */
const missingColumns = (
  asked: readonly string[],
  columns: readonly string[],
): { missing?: readonly string[] } => {
  const absent = asked.filter((name) => name !== '' && !columns.includes(name));
  return absent.length === 0 ? {} : { missing: absent };
};

/** Rows as they are, projected to the columns named and bounded. */
const rowsFrame = (
  frame: Extract<ChartFrameSpec, { kind: 'rows' }>,
  input: ChartFrameInput,
): ChartFrame => {
  const limit = Math.min(
    MAX_FRAME_ROWS,
    Math.max(1, Math.trunc(frame.rowLimit ?? DEFAULT_FRAME_ROWS)),
  );
  const indexes = frame.columns.map((name) => input.columns.indexOf(name));
  const rows: (readonly CellValue[])[] = [];
  let read = 0;
  for (const chunk of input.chunks) {
    const vectors = indexes.map((index) => (index < 0 ? undefined : chunk.columns[index]));
    for (let row = 0; row < chunk.rowCount; row += 1) {
      read += 1;
      if (rows.length >= limit) continue;
      // A column the relation has not got reads as nothing rather than as a
      // missing row: the shape of the data set is what was asked for, and which
      // column was absent is the resolution report's answer to give.
      rows.push(vectors.map((vector) => (vector === undefined ? null : cellValue(vector, row))));
    }
  }
  const total = input.totalRows;
  const keyAt = frame.key === undefined ? -1 : frame.columns.indexOf(frame.key);
  return {
    name: frame.name,
    ...windowReport(input),
    ...missingColumns(frame.columns, input.columns),
    dimensions: frame.columns,
    rows,
    ...(frame.key === undefined || keyAt < 0
      ? {}
      : { key: frame.key, keys: rows.map((row) => row[keyAt] ?? null) }),
    read,
    of: total,
    // Two ways to be a sample: the rows behind it were not all read, or more of
    // them arrived than this data set carries.
    basis: (total !== null && read < total) || rows.length < read ? 'sampled' : 'exact',
  };
};

/**
 * A long series, reduced to the points a box can draw.
 *
 * Buckets along the axis, in the order the rows arrived — no sort, because a sort
 * is a pass that has to hold everything, and a series worth resampling is one that
 * does not fit. Which is also why the rows are taken as ordered: a statement that
 * means to draw a line over time says `ORDER BY` in it, and one that does not gets
 * a picture of the order it was given.
 *
 * `extremes` emits the lowest and the highest of each bucket, in the order they
 * occurred, so a spike survives; `mean` emits one averaged point; `lttb` keeps the
 * point in each bucket that makes the largest triangle with its neighbours, which
 * is the shape-preserving choice for a line somebody will read.
 */
const resampleFrame = (
  frame: Extract<ChartFrameSpec, { kind: 'resample' }>,
  input: ChartFrameInput,
): ChartFrame => {
  const points = Math.min(
    MAX_RESAMPLE_POINTS,
    Math.max(2, Math.trunc(frame.points ?? DEFAULT_RESAMPLE_POINTS)),
  );
  const method = frame.method ?? 'extremes';
  const xAt = input.columns.indexOf(frame.x);
  const valueAt = frame.values.map((name) => input.columns.indexOf(name));
  // Read once into flat arrays: what follows walks them several times, and a
  // bucketing that re-read the chunks would pay for the indirection every pass.
  const xs: CellValue[] = [];
  const ys: (number | null)[][] = frame.values.map(() => []);
  for (const chunk of input.chunks) {
    const xVector = xAt < 0 ? undefined : chunk.columns[xAt];
    const vectors = valueAt.map((index) => (index < 0 ? undefined : chunk.columns[index]));
    for (let row = 0; row < chunk.rowCount; row += 1) {
      xs.push(xVector === undefined ? null : cellValue(xVector, row));
      vectors.forEach((vector, slot) => {
        const value = vector === undefined ? null : cellValue(vector, row);
        const numeric = value === null ? null : Number(value);
        (ys[slot] as (number | null)[]).push(
          numeric === null || !Number.isFinite(numeric) ? null : numeric,
        );
      });
    }
  }

  const read = xs.length;
  const rows: (readonly CellValue[])[] = [];
  const keys: CellValue[] = [];
  const emit = (index: number): void => {
    rows.push([xs[index] ?? null, ...ys.map((series) => series[index] ?? null)]);
    keys.push(xs[index] ?? null);
  };
  // A series that already fits is drawn as it is: resampling something that needs
  // no resampling would only lose points.
  if (read <= points) {
    for (let index = 0; index < read; index += 1) emit(index);
  } else if (method === 'mean') {
    const size = read / points;
    for (let bucket = 0; bucket < points; bucket += 1) {
      const start = Math.floor(bucket * size);
      const end = Math.min(read, Math.floor((bucket + 1) * size));
      const averaged = ys.map((series) => {
        let total = 0;
        let count = 0;
        for (let index = start; index < end; index += 1) {
          const value = series[index];
          if (value === null || value === undefined) continue;
          total += value;
          count += 1;
        }
        // A bucket with no figures is a gap, not a nought.
        return count === 0 ? null : total / count;
      });
      // The middle of the bucket, which is where the average belongs.
      const middle = Math.min(read - 1, Math.floor((start + end) / 2));
      rows.push([xs[middle] ?? null, ...averaged]);
      keys.push(xs[middle] ?? null);
    }
  } else if (method === 'lttb') {
    // Largest-triangle-three-buckets, on the first measure: the shape of a line
    // is the shape of one series, and applying it per series would give each its
    // own x values.
    const first = (ys[0] ?? []) as (number | null)[];
    const size = (read - 2) / (points - 2);
    emit(0);
    let anchor = 0;
    for (let bucket = 0; bucket < points - 2; bucket += 1) {
      const start = Math.floor((bucket + 1) * size) + 1;
      const end = Math.min(read - 1, Math.floor((bucket + 2) * size) + 1);
      const nextStart = end;
      const nextEnd = Math.min(read, Math.floor((bucket + 3) * size) + 1);
      let averageX = 0;
      let averageY = 0;
      let counted = 0;
      for (let index = nextStart; index < nextEnd; index += 1) {
        const value = first[index];
        if (value === null || value === undefined) continue;
        averageX += index;
        averageY += value;
        counted += 1;
      }
      if (counted > 0) {
        averageX /= counted;
        averageY /= counted;
      }
      const anchorY = first[anchor] ?? 0;
      let best = start;
      let bestArea = -1;
      for (let index = start; index < end; index += 1) {
        const value = first[index];
        if (value === null || value === undefined) continue;
        const area = Math.abs(
          (anchor - averageX) * (value - anchorY) - (anchor - index) * (averageY - anchorY),
        );
        if (area > bestArea) {
          bestArea = area;
          best = index;
        }
      }
      emit(best);
      anchor = best;
    }
    emit(read - 1);
  } else {
    const size = read / Math.max(1, Math.floor(points / 2));
    for (let bucket = 0; bucket * size < read; bucket += 1) {
      const start = Math.floor(bucket * size);
      const end = Math.min(read, Math.floor((bucket + 1) * size));
      const first = (ys[0] ?? []) as (number | null)[];
      let lowest = -1;
      let highest = -1;
      for (let index = start; index < end; index += 1) {
        const value = first[index];
        if (value === null || value === undefined) continue;
        if (lowest < 0 || value < (first[lowest] as number)) lowest = index;
        if (highest < 0 || value > (first[highest] as number)) highest = index;
      }
      if (lowest < 0) {
        // Nothing measurable in the bucket: the axis still happened, so one point
        // stands for it rather than the gap being closed up.
        if (start < read) emit(start);
        continue;
      }
      // In the order they occurred, so a line drawn through them goes the way the
      // data went.
      for (const index of lowest <= highest ? [lowest, highest] : [highest, lowest]) {
        if (rows.length === 0 || keys[keys.length - 1] !== xs[index]) emit(index);
      }
    }
  }

  const total = input.totalRows;
  return {
    name: frame.name,
    ...windowReport(input),
    ...missingColumns([frame.x, ...frame.values], input.columns),
    dimensions: [frame.x, ...frame.values],
    rows,
    ...(frame.key === undefined || frame.key !== frame.x ? {} : { key: frame.key, keys }),
    read,
    of: total,
    // A resampling is a sample of the rows it read even when it read them all,
    // and the picture should say so rather than implying every point is there.
    basis: rows.length < read || (total !== null && read < total) ? 'sampled' : 'exact',
  };
};

/** One number: a column reduced over every row that was read. */
const scalarFrame = (
  frame: Extract<ChartFrameSpec, { kind: 'scalar' }>,
  input: ChartFrameInput,
): ChartFrame => {
  const index = input.columns.indexOf(frame.column);
  let count = 0;
  let total = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let rows = 0;
  for (const chunk of input.chunks) {
    const vector = index < 0 ? undefined : chunk.columns[index];
    for (let row = 0; row < chunk.rowCount; row += 1) {
      rows += 1;
      if (vector === undefined) continue;
      const value = cellValue(vector, row);
      // Checked before converting: `Number(null)` is nought, and counting a
      // missing figure as nought understates every average that meets one.
      if (value === null) continue;
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) continue;
      count += 1;
      total += numeric;
      min = Math.min(min, numeric);
      max = Math.max(max, numeric);
    }
  }
  const value = ((): CellValue => {
    if (frame.aggregate === 'count') return rows;
    // Nothing to reduce is not nought. A threshold nobody could compute should
    // read as absent, and a `markLine` at zero is a line somebody will believe.
    if (count === 0) return null;
    switch (frame.aggregate) {
      case 'sum':
        return total;
      case 'average':
        return total / count;
      case 'min':
        return min;
      default:
        return max;
    }
  })();
  return {
    name: frame.name,
    ...missingColumns([frame.column], input.columns),
    dimensions: [frame.column],
    rows: [[value]],
    read: rows,
    of: input.totalRows,
    basis: input.totalRows !== null && rows < input.totalRows ? 'sampled' : 'exact',
  };
};

/** One data set, built from the rows of whichever box supplies it. */
export const buildFrame = (frame: ChartFrameSpec, input: ChartFrameInput): ChartFrame =>
  frame.kind === 'group'
    ? groupFrame(frame, input)
    : frame.kind === 'rows'
      ? rowsFrame(frame, input)
      : frame.kind === 'resample'
        ? resampleFrame(frame, input)
        : scalarFrame(frame, input);

/**
 * Every data set a chart was given: its own reduction first, then the ones it
 * named.
 *
 * The reduction is always there, whatever else was asked for. A written option is
 * free to ignore it, and a chart the controls produced has nothing else — so this
 * one function answers for both, and the order puts the one thing that is always
 * present where an option that says nothing about data sets will find it.
 */
export const buildFrames = (input: ChartFrameInput, data: ChartData): readonly ChartFrame[] => [
  reductionFrame(input.spec, data),
  ...chartFramesOf(input.spec).map((frame) => buildFrame(frame, input)),
];

/** The one number a scalar data set carries, or `null` when it has none. */
export const frameScalar = (frame: ChartFrame): CellValue =>
  frame.rows.length === 1 && frame.rows[0]?.length === 1 ? (frame.rows[0][0] as CellValue) : null;
