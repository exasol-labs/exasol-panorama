import { describe, expect, it } from 'vitest';
import type { ChartFrameSpec, ChartSpec, ChartWindowSpec } from '@panorama/core';
import { MAX_FRAME_ROWS, MAX_RESAMPLE_POINTS } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { CellValue, ResultChunk } from '@panorama/table';
import { buildVector, createResultChunk } from '@panorama/table';
import { aggregateChart, buildFrames, frameScalar, reductionFrame } from '@panorama/chart';
import type { ChartFrame, ChartFrameInput } from '@panorama/chart';

const VARCHAR = dataType('varchar', 'VARCHAR(64)', { size: 64 });
const DOUBLE = dataType('double', 'DOUBLE');

/** Rows as a chunk, given the way a reader would write them down. */
const chunkOf = (
  names: readonly string[],
  values: readonly (readonly CellValue[])[],
): ResultChunk =>
  createResultChunk(
    0,
    values.length,
    names.map((_name, column) =>
      buildVector(
        typeof values[0]?.[column] === 'string' ? VARCHAR : DOUBLE,
        values.map((row) => row[column] ?? null),
      ),
    ),
  );

/**
 * The data sets a chart is given.
 *
 * One shape for every kind — a name, its columns, its rows — because that is what
 * makes a heatmap, a scatter with a size channel, a graph's edges and a tree's
 * parents the same thing to everything downstream. These tests are mostly about
 * the shapes: a reduction is one row per category, a projection is one row per
 * row, and the difference is the whole reason both exist.
 */

const COLUMNS = ['COUNTRY', 'GRADE', 'REVENUE', 'CLAIMS'] as const;

const rows: readonly (readonly CellValue[])[] = [
  ['Sweden', 'A', 10, 3],
  ['Sweden', 'B', 20, 1],
  ['France', 'A', 30, 4],
  ['France', 'B', null, 2],
  ['Poland', 'A', 5, 9],
];

const input = (spec: ChartSpec, totalRows: number | null = rows.length) => ({
  spec,
  columns: [...COLUMNS],
  chunks: [chunkOf([...COLUMNS], rows)],
  totalRows,
});

const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  type: 'bar',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
  ...overrides,
});

const named = (frames: readonly ChartFrame[], name: string): ChartFrame => {
  const found = frames.find((frame) => frame.name === name);
  expect(found, `no data set called ${name}`).toBeDefined();
  return found as ChartFrame;
};

describe('the reduction, as a data set', () => {
  it('is one row per category, a column per measure', () => {
    const built = spec({ values: ['REVENUE', 'CLAIMS'] });
    const frame = reductionFrame(built, aggregateChart(input(built)));
    expect(frame.name).toBe('primary');
    expect(frame.dimensions).toEqual(['COUNTRY', 'REVENUE', 'CLAIMS']);
    expect(frame.rows).toEqual([
      ['France', 30, 6],
      ['Sweden', 30, 4],
      ['Poland', 5, 9],
    ]);
  });

  it('is triples where a second grouping column makes it a cross-tabulation', () => {
    // There is no arrangement of columns that is a triple, which is why a matrix
    // needs this shape and a bar chart does not.
    const built = spec({ breakdown: 'GRADE' });
    const frame = reductionFrame(built, aggregateChart(input(built)));
    expect(frame.dimensions).toEqual(['COUNTRY', 'GRADE', 'REVENUE']);
    expect(frame.rows).toContainEqual(['Sweden', 'A', 10]);
    expect(frame.rows).toContainEqual(['France', 'B', null]);
  });

  it('names the category and the measure when nothing chose them', () => {
    const built = spec({ category: '', values: [], aggregate: 'count', breakdown: 'GRADE' });
    const frame = reductionFrame(built, aggregateChart(input(built)));
    expect(frame.dimensions).toEqual(['category', 'GRADE', 'rows']);
  });
});

describe('a data set of rows as they are', () => {
  const frames = (frame: ChartFrameSpec, totalRows: number | null = rows.length): ChartFrame => {
    const built = spec({ frames: [frame] });
    const source = input(built, totalRows);
    return named(buildFrames(source, aggregateChart(source)), frame.name);
  };

  it('projects the columns named, in the order named', () => {
    const frame = frames({ name: 'points', kind: 'rows', columns: ['CLAIMS', 'COUNTRY'] });
    expect(frame.dimensions).toEqual(['CLAIMS', 'COUNTRY']);
    expect(frame.rows).toEqual([
      [3, 'Sweden'],
      [1, 'Sweden'],
      [4, 'France'],
      [2, 'France'],
      [9, 'Poland'],
    ]);
    expect(frame.basis).toBe('exact');
  });

  it('keeps every row, including the ones a reduction would have folded together', () => {
    // The point of the shape: five rows over three countries stay five rows, so a
    // scatter has five points and a matrix has five cells.
    const frame = frames({ name: 'raw', kind: 'rows', columns: ['COUNTRY', 'GRADE', 'REVENUE'] });
    expect(frame.rows).toHaveLength(5);
  });

  it('reads a column the relation has not got as nothing, rather than dropping the row', () => {
    // Which column was missing is the resolution report's answer to give; the
    // shape of the data set is what was asked for.
    const frame = frames({ name: 'raw', kind: 'rows', columns: ['COUNTRY', 'PROFIT'] });
    expect(frame.rows[0]).toEqual(['Sweden', null]);
    expect(frame.rows).toHaveLength(5);
  });

  it('stops at its limit and says the picture is of a beginning', () => {
    const frame = frames({ name: 'raw', kind: 'rows', columns: ['COUNTRY'], rowLimit: 2 });
    expect(frame.rows).toHaveLength(2);
    expect(frame.read).toBe(5);
    expect(frame.basis).toBe('sampled');
  });

  it('says it is a sample when the rows behind it were not all read', () => {
    const frame = frames({ name: 'raw', kind: 'rows', columns: ['COUNTRY'] }, 1_000);
    expect(frame.basis).toBe('sampled');
    expect(frame.of).toBe(1_000);
  });

  it('will not carry more than the layout can walk, whatever is asked for', () => {
    // The limit is the layout, not the database: every row becomes elements to
    // lay out and geometry to walk, per element, in JavaScript.
    const frame = frames({
      name: 'raw',
      kind: 'rows',
      columns: ['COUNTRY'],
      rowLimit: MAX_FRAME_ROWS * 10,
    });
    expect(frame.rows.length).toBeLessThanOrEqual(MAX_FRAME_ROWS);
  });
});

describe('what a drawn mark can be traced back by', () => {
  it('keys the reduction by its category, with the values and not the labels', () => {
    // A label is for reading and a value is for filtering: `String(7)` names a
    // category perfectly well and cannot be compared against a number.
    const built = spec({ category: 'CLAIMS', values: ['REVENUE'] });
    const frame = reductionFrame(built, aggregateChart(input(built)));
    expect(frame.key).toBe('CLAIMS');
    // Ordered by size, as the chart is; the point is the *type*, not the order.
    expect(frame.keys).toEqual([4, 1, 3, 9, 2]);
    expect(frame.keys?.every((key) => typeof key === 'number')).toBe(true);
    // The labels are strings; the keys are the numbers they came from.
    expect(frame.rows.map((row) => row[0])).toEqual(['4', '1', '3', '9', '2']);
  });

  it('keys a cross-tabulation by its category, once per row', () => {
    const built = spec({ breakdown: 'GRADE' });
    const frame = reductionFrame(built, aggregateChart(input(built)));
    // A triple is a category and a breakdown; the rows behind it are found by the
    // category, and every row has one.
    expect(frame.key).toBe('COUNTRY');
    expect(frame.keys).toHaveLength(frame.rows.length);
    expect(frame.keys?.[0]).toBe(frame.rows[0]?.[0]);
  });

  it('keys a data set of rows by the column it was told to', () => {
    const built = spec({
      frames: [{ name: 'cells', kind: 'rows', columns: ['COUNTRY', 'GRADE'], key: 'GRADE' }],
    });
    const source = input(built);
    const frame = named(buildFrames(source, aggregateChart(source)), 'cells');
    expect(frame.key).toBe('GRADE');
    expect(frame.keys).toEqual(['A', 'B', 'A', 'B', 'A']);
  });

  it('keys nothing where no category was chosen', () => {
    // The data set has a column called `category` and the relation has not, so
    // there is nothing a mark could be traced by.
    const built = spec({ category: '', values: [], aggregate: 'count' });
    const frame = reductionFrame(built, aggregateChart(input(built)));
    expect(frame.dimensions[0]).toBe('category');
    expect(frame.key).toBeUndefined();
  });

  it('keys nothing where the key names a column the data set does not read', () => {
    // Refused at the boundary an agent sends through; guarded here as well,
    // because a specification can also be built in code.
    const built = spec({
      frames: [{ name: 'cells', kind: 'rows', columns: ['COUNTRY'], key: 'GRADE' }],
    });
    const source = input(built);
    const frame = named(buildFrames(source, aggregateChart(source)), 'cells');
    expect(frame.key).toBeUndefined();
    expect(frame.keys).toBeUndefined();
  });

  it('keys nothing where nothing said what identifies a row', () => {
    // A cell that can be picked out and not drilled into. Said rather than
    // guessed at: the first column of a heatmap is not necessarily its subject.
    const built = spec({ frames: [{ name: 'cells', kind: 'rows', columns: ['COUNTRY'] }] });
    const source = input(built);
    const frame = named(buildFrames(source, aggregateChart(source)), 'cells');
    expect(frame.key).toBeUndefined();
    expect(frame.keys).toBeUndefined();
  });

  it('keys a grouping of its own by its own category', () => {
    const built = spec({
      frames: [
        {
          name: 'by_grade',
          kind: 'group',
          category: 'GRADE',
          values: ['CLAIMS'],
          aggregate: 'sum',
        },
      ],
    });
    const source = input(built);
    const frame = named(buildFrames(source, aggregateChart(source)), 'by_grade');
    expect(frame.key).toBe('GRADE');
    expect(frame.keys).toEqual(['A', 'B']);
  });
});

describe('a data set that is a grouping of its own', () => {
  it('answers a different question of the same rows', () => {
    const built = spec({
      frames: [
        {
          name: 'by_grade',
          kind: 'group',
          category: 'GRADE',
          values: ['CLAIMS'],
          aggregate: 'sum',
        },
      ],
    });
    const source = input(built);
    const frames = buildFrames(source, aggregateChart(source));
    // The chart's own reduction is still there, first and unchanged.
    expect(frames[0]?.name).toBe('primary');
    expect(frames[0]?.dimensions).toEqual(['COUNTRY', 'REVENUE']);
    const marginal = named(frames, 'by_grade');
    expect(marginal.dimensions).toEqual(['GRADE', 'CLAIMS']);
    expect(marginal.rows).toEqual([
      ['A', 16],
      ['B', 3],
    ]);
  });

  it('takes an order and a limit of its own', () => {
    const built = spec({
      frames: [
        {
          name: 'top_two',
          kind: 'group',
          category: 'COUNTRY',
          values: ['REVENUE'],
          aggregate: 'sum',
          sort: 'name',
          categoryLimit: 2,
        },
      ],
    });
    const source = input(built);
    const frame = named(buildFrames(source, aggregateChart(source)), 'top_two');
    // Its own question entirely: ordered by name and cut to two, whatever the
    // chart beside it was asked for.
    expect(frame.rows).toEqual([
      ['France', 30],
      ['Poland', 5],
    ]);
  });

  it('can be a cross-tabulation as well, which is what a matrix reads', () => {
    const built = spec({
      frames: [
        {
          name: 'matrix',
          kind: 'group',
          category: 'COUNTRY',
          breakdown: 'GRADE',
          values: ['REVENUE'],
          aggregate: 'sum',
        },
      ],
    });
    const source = input(built);
    const matrix = named(buildFrames(source, aggregateChart(source)), 'matrix');
    expect(matrix.dimensions).toEqual(['COUNTRY', 'GRADE', 'REVENUE']);
    expect(matrix.rows).toContainEqual(['Poland', 'A', 5]);
  });
});

describe('a long series, reduced to fit the pixels', () => {
  /** A series of `count` rows, with a spike put where a mean would hide it. */
  const series = (count: number, spikeAt = -1): ChartFrameInput => {
    const values: (readonly CellValue[])[] = [];
    for (let index = 0; index < count; index += 1) {
      values.push([`t${String(index).padStart(5, '0')}`, index === spikeAt ? 1_000 : index % 7]);
    }
    return {
      spec: spec(),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: count,
    };
  };

  const resampled = (
    count: number,
    overrides: Partial<Extract<ChartFrameSpec, { kind: 'resample' }>> = {},
    spikeAt = -1,
  ): ChartFrame => {
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      points: 20,
      ...overrides,
    };
    const source = { ...series(count, spikeAt), spec: spec({ frames: [frame] }) };
    return named(buildFrames(source, aggregateChart(source)), 'line');
  };

  it('carries a series that already fits exactly as it is', () => {
    const frame = resampled(12);
    expect(frame.dimensions).toEqual(['T', 'V']);
    expect(frame.rows).toHaveLength(12);
    // Nothing was thrown away, so nothing is claimed to have been.
    expect(frame.basis).toBe('exact');
  });

  it('cuts a long one down to the points asked for, and says it sampled', () => {
    const frame = resampled(5_000);
    expect(frame.rows.length).toBeLessThanOrEqual(20);
    expect(frame.read).toBe(5_000);
    expect(frame.basis).toBe('sampled');
  });

  it('keeps the spike, which is the whole reason not to average', () => {
    // A mean of a bucket hides the one point that was the reason to look.
    const extremes = resampled(5_000, {}, 2_500);
    const averaged = resampled(5_000, { method: 'mean' }, 2_500);
    const highest = (frame: ChartFrame): number =>
      Math.max(...frame.rows.map((row) => Number(row[1] ?? 0)));
    expect(highest(extremes)).toBe(1_000);
    expect(highest(averaged)).toBeLessThan(1_000);
  });

  it('keeps the shape when asked for the shape', () => {
    const frame = resampled(5_000, { method: 'lttb' }, 2_500);
    expect(frame.rows.length).toBeLessThanOrEqual(20);
    // The ends of a series are the two points nobody would want dropped.
    expect(frame.rows[0]?.[0]).toBe('t00000');
    expect(frame.rows.at(-1)?.[0]).toBe('t04999');
  });

  it('stands nothing for a bucket beyond the end of the series', () => {
    // The last bucket of a series whose length does not divide by the point
    // budget: there is no row in it, so there is no point to stand for it.
    const values: (readonly CellValue[])[] = Array.from({ length: 7 }, (_, index) => [
      `t${index}`,
      null,
    ]);
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      points: 4,
    };
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    expect(built.rows.length).toBeLessThanOrEqual(7);
    expect(built.rows.every((row) => row[1] === null)).toBe(true);
  });

  it('stands one point for a bucket with nothing measurable in it', () => {
    // The axis still happened. Closing the gap up would draw a line straight
    // through the outage as if the numbers had continued.
    const values: (readonly CellValue[])[] = [];
    for (let index = 0; index < 2_000; index += 1) {
      values.push([`t${String(index).padStart(5, '0')}`, index > 400 && index < 1_600 ? null : 5]);
    }
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      points: 20,
    };
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    expect(built.rows.length).toBeGreaterThan(0);
    // Points across the gap, with nothing measured at them.
    expect(built.rows.some((row) => row[1] === null)).toBe(true);
  });

  it('keeps the shape of a series with gaps in it', () => {
    // The shape-preserving pass has to skip what it cannot measure: a bucket of
    // nulls has no point that makes a triangle, and reading one as nought would
    // draw the line down to the floor and back.
    const values: (readonly CellValue[])[] = [];
    for (let index = 0; index < 3_000; index += 1) {
      values.push([
        `t${String(index).padStart(5, '0')}`,
        index % 500 < 200 ? null : Math.sin(index / 40) * 10,
      ]);
    }
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      method: 'lttb',
      points: 30,
    };
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    expect(built.rows.length).toBeLessThanOrEqual(30);
    expect(built.rows[0]?.[0]).toBe('t00000');
    expect(built.rows.at(-1)?.[0]).toBe('t02999');
  });

  it('draws the axis of a resampling that names no measure', () => {
    // Refused at the boundary an agent sends through; a specification built in
    // code can still say it, and an axis with nothing on it is a picture of the
    // axis rather than a crash.
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: [],
      points: 10,
    };
    const values: (readonly CellValue[])[] = Array.from({ length: 500 }, (_, index) => [
      `t${index}`,
      index,
    ]);
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    for (const method of ['extremes', 'mean', 'lttb'] as const) {
      const built = named(
        buildFrames(
          { ...source, spec: spec({ frames: [{ ...frame, method }] }) },
          aggregateChart(source),
        ),
        'line',
      );
      expect(built.dimensions).toEqual(['T']);
      expect(built.rows.length).toBeGreaterThan(0);
    }
  });

  it('draws the axis of a resampling that names no measure', () => {
    // Refused at the boundary an agent sends through; a specification built in
    // code can still say it, and an axis with nothing on it is a picture of the
    // axis rather than a crash.
    const values: (readonly CellValue[])[] = Array.from({ length: 500 }, (_, index) => [
      `t${index}`,
      index,
    ]);
    for (const method of ['extremes', 'mean', 'lttb'] as const) {
      const frame: ChartFrameSpec = {
        name: 'line',
        kind: 'resample',
        x: 'T',
        values: [],
        method,
        points: 10,
      };
      const source: ChartFrameInput = {
        spec: spec({ frames: [frame] }),
        columns: ['T', 'V'],
        chunks: [chunkOf(['T', 'V'], values)],
        totalRows: values.length,
      };
      const built = named(buildFrames(source, aggregateChart(source)), 'line');
      expect(built.dimensions).toEqual(['T']);
      expect(built.rows.length).toBeGreaterThan(0);
    }
  });

  it('averages a bucket to nothing where it had nothing to average', () => {
    // A gap, not a nought: a mean that read a missing figure as zero would pull
    // the line to the floor wherever the data stopped.
    const values: (readonly CellValue[])[] = Array.from({ length: 2_000 }, (_, index) => [
      `t${String(index).padStart(5, '0')}`,
      index > 500 && index < 1_500 ? null : 8,
    ]);
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      method: 'mean',
      points: 20,
    };
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    expect(built.rows.some((row) => row[1] === null)).toBe(true);
    expect(built.rows.some((row) => row[1] === 8)).toBe(true);
  });

  it('averages a column the relation has not got to nothing, and says which', () => {
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['NOWHERE'],
      rolling: 3,
      points: 100,
    };
    const values: (readonly CellValue[])[] = Array.from({ length: 10 }, (_, index) => [
      `t${index}`,
      index,
    ]);
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    expect(built.dimensions).toEqual(['T', 'NOWHERE', 'NOWHERE_mean3']);
    expect(built.rows.every((row) => row[1] === null && row[2] === null)).toBe(true);
    // And which column it was, rather than a line of nothing with no explanation.
    expect(built.missing).toEqual(['NOWHERE']);
  });

  it('draws nothing along an axis the relation has not got', () => {
    const frame: ChartFrameSpec = { name: 'line', kind: 'resample', x: 'NOWHERE', values: ['V'] };
    const values: (readonly CellValue[])[] = Array.from({ length: 10 }, (_, index) => [
      `t${index}`,
      index,
    ]);
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    // The rows are there and the axis is nothing, which the resolution report
    // names as an unresolved channel rather than this pretending otherwise.
    expect(built.rows.every((row) => row[0] === null)).toBe(true);
  });

  it('averages across the rows as it goes, beside the figures themselves', () => {
    // The thing neither a window nor a bucket answers: a window says which part of
    // the relation to look at and `mean` averages within a bucket, so neither one
    // smooths as it goes.
    const values: (readonly CellValue[])[] = Array.from({ length: 40 }, (_, index) => [
      `t${String(index).padStart(3, '0')}`,
      index % 2 === 0 ? 0 : 10,
    ]);
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      rolling: 4,
      points: 100,
    };
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    // The average is a column of its own, named after what it averages.
    expect(built.dimensions).toEqual(['T', 'V', 'V_mean4']);
    // A saw-tooth of nought and ten averages to five once four rows are in.
    expect(built.rows[0]?.[2]).toBeNull();
    expect(built.rows[3]?.[2]).toBe(5);
    expect(built.rows.at(-1)?.[2]).toBe(5);
    // And the figures themselves are untouched.
    expect(built.rows.map((row) => row[1])).toEqual(values.map((row) => row[1]));
  });

  it('leaves a gap in the average where there was nothing to average', () => {
    const values: (readonly CellValue[])[] = Array.from({ length: 20 }, (_, index) => [
      `t${index}`,
      index < 10 ? null : 4,
    ]);
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      rolling: 3,
      points: 100,
    };
    const source: ChartFrameInput = {
      spec: spec({ frames: [frame] }),
      columns: ['T', 'V'],
      chunks: [chunkOf(['T', 'V'], values)],
      totalRows: values.length,
    };
    const built = named(buildFrames(source, aggregateChart(source)), 'line');
    // Nothing to average is a gap, not a nought — a line that dropped to the
    // floor through an outage would be a picture of an outage that did not happen.
    expect(built.rows[5]?.[2]).toBeNull();
    expect(built.rows.at(-1)?.[2]).toBe(4);
  });

  it('goes the way the data went', () => {
    // Extremes are emitted in the order they occurred, so a line drawn through
    // them travels the way the series did.
    const frame = resampled(2_000);
    const axis = frame.rows.map((row) => String(row[0]));
    expect([...axis].sort()).toEqual(axis);
  });

  it('will not carry more points than a layout can walk', () => {
    const frame = resampled(200_000, { points: MAX_RESAMPLE_POINTS * 10 });
    expect(frame.rows.length).toBeLessThanOrEqual(MAX_RESAMPLE_POINTS);
  });

  it('can be traced back by the column along its axis', () => {
    const frame = resampled(100, { key: 'T' });
    expect(frame.key).toBe('T');
    expect(frame.keys).toHaveLength(frame.rows.length);
    expect(frame.keys?.[0]).toBe(frame.rows[0]?.[0]);
  });

  it('says which part of the relation it read', () => {
    const frame: ChartFrameSpec = {
      name: 'line',
      kind: 'resample',
      x: 'T',
      values: ['V'],
      window: { by: 'position', from: 1_000, count: 500 },
    };
    const source = { ...series(500), spec: spec({ frames: [frame] }) };
    const built = named(
      // As the worker hands it over: the rows, and what the window did to find them.
      buildFrames(
        { ...source, window: frame.window as ChartWindowSpec, scanned: 500 },
        aggregateChart(source),
      ),
      'line',
    );
    // A picture cannot say "this is rows one thousand to fifteen hundred of a
    // billion", so the answer does.
    expect(built.window).toEqual({ by: 'position', from: 1_000, count: 500 });
    expect(built.scanned).toBe(500);
  });
});

describe('a data set that is its own question', () => {
  it("does not inherit the chart's breakdown", () => {
    // The defect this replaces: a marginal beside a cross-tabulated matrix came
    // back as triples of a breakdown nobody had asked it for, and there was no way
    // to say "not that one" — the specification was spread over the chart's.
    const built = spec({
      breakdown: 'GRADE',
      frames: [
        {
          name: 'marginal',
          kind: 'group',
          category: 'COUNTRY',
          values: ['REVENUE'],
          aggregate: 'sum',
        },
      ],
    });
    const source = input(built);
    const frames = buildFrames(source, aggregateChart(source));
    // The chart is a cross-tabulation, as asked.
    expect(frames[0]?.dimensions).toEqual(['COUNTRY', 'GRADE', 'REVENUE']);
    // The marginal is one-dimensional, as asked.
    expect(named(frames, 'marginal').dimensions).toEqual(['COUNTRY', 'REVENUE']);
  });

  it('takes a breakdown of its own where it names one', () => {
    const built = spec({
      frames: [
        {
          name: 'matrix',
          kind: 'group',
          category: 'COUNTRY',
          breakdown: 'GRADE',
          values: ['REVENUE'],
          aggregate: 'sum',
        },
      ],
    });
    const source = input(built);
    expect(named(buildFrames(source, aggregateChart(source)), 'matrix').dimensions).toEqual([
      'COUNTRY',
      'GRADE',
      'REVENUE',
    ]);
  });

  it('names a column it was asked for that the rows have not got', () => {
    // It used to come back as a dimension with nothing in it and no marks drawn: a
    // picture of nothing that said nothing about why.
    const built = spec({
      frames: [
        { name: 'rows', kind: 'rows', columns: ['COUNTRY', 'PROFIT'] },
        {
          name: 'group',
          kind: 'group',
          category: 'NOWHERE',
          values: ['REVENUE'],
          aggregate: 'sum',
        },
        { name: 'total', kind: 'scalar', column: 'MISSING', aggregate: 'sum' },
        { name: 'line', kind: 'resample', x: 'WHEN', values: ['REVENUE'] },
      ],
    });
    const source = input(built);
    const frames = buildFrames(source, aggregateChart(source));
    expect(named(frames, 'rows').missing).toEqual(['PROFIT']);
    expect(named(frames, 'group').missing).toEqual(['NOWHERE']);
    expect(named(frames, 'total').missing).toEqual(['MISSING']);
    expect(named(frames, 'line').missing).toEqual(['WHEN']);
    // And says nothing where nothing is missing.
    expect(frames[0]?.missing).toBeUndefined();
  });
});

describe('a data set that is one number', () => {
  const scalar = (
    aggregate: 'sum' | 'average' | 'min' | 'max' | 'count',
    column = 'REVENUE',
  ): ChartFrame => {
    const built = spec({ frames: [{ name: 'base', kind: 'scalar', column, aggregate }] });
    const source = input(built);
    return named(buildFrames(source, aggregateChart(source)), 'base');
  };

  it('reduces the column every way a chart might need', () => {
    expect(frameScalar(scalar('sum'))).toBe(65);
    expect(frameScalar(scalar('average'))).toBe(65 / 4);
    expect(frameScalar(scalar('min'))).toBe(5);
    expect(frameScalar(scalar('max'))).toBe(30);
    // Counting rows needs no column to be numeric, and counts the missing one.
    expect(frameScalar(scalar('count'))).toBe(5);
  });

  it('skips a missing figure rather than counting it as nought', () => {
    // An average that treats a NULL as zero understates every average that meets
    // one, and a reference line drawn from it is quietly wrong.
    expect(frameScalar(scalar('average'))).not.toBe(65 / 5);
  });

  it('is nothing at all when there was nothing to reduce', () => {
    // Not nought: a threshold nobody could compute must not draw a line at zero
    // that somebody then believes.
    expect(frameScalar(scalar('sum', 'COUNTRY'))).toBeNull();
    expect(frameScalar(scalar('sum', 'MISSING'))).toBeNull();
  });

  it('says it is a sample when it did not see every row', () => {
    const built = spec({
      frames: [{ name: 'base', kind: 'scalar', column: 'REVENUE', aggregate: 'sum' }],
    });
    const source = input(built, 1_000);
    const frame = named(buildFrames(source, aggregateChart(source)), 'base');
    expect(frame.basis).toBe('sampled');
    expect(frame.read).toBe(5);
  });

  it('is nothing to read where a data set is not one number', () => {
    const built = spec({ frames: [{ name: 'raw', kind: 'rows', columns: ['COUNTRY'] }] });
    const source = input(built);
    const frame = named(buildFrames(source, aggregateChart(source)), 'raw');
    // Asking a table of five rows for "the number" has no answer, and inventing
    // its first cell would be worse than saying so.
    expect(frameScalar(frame)).toBeNull();
  });

  it('carries the column it reduced, so a report can name it', () => {
    expect(scalar('sum').dimensions).toEqual(['REVENUE']);
    expect(scalar('sum').rows).toHaveLength(1);
  });
});

describe('the data sets a chart is given', () => {
  it('is the reduction alone when the specification named none', () => {
    const built = spec();
    const source = input(built);
    const frames = buildFrames(source, aggregateChart(source));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.name).toBe('primary');
  });

  it('is the reduction first, then the ones named, in the order named', () => {
    const built = spec({
      frames: [
        { name: 'raw', kind: 'rows', columns: ['COUNTRY'] },
        { name: 'total', kind: 'scalar', column: 'REVENUE', aggregate: 'sum' },
      ],
    });
    const source = input(built);
    expect(buildFrames(source, aggregateChart(source)).map((frame) => frame.name)).toEqual([
      'primary',
      'raw',
      'total',
    ]);
  });
});
