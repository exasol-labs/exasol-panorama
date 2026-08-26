import { describe, expect, it } from 'vitest';
import type { ChartDrawList, ChartMark, ChartPolygon } from '@panorama/chart';
import { chartMarkAt, emphasiseChart, sameChartMark } from '@panorama/chart';

const BLUE = [0.2, 0.4, 1, 1] as const;

/** A quad, optionally belonging to a mark. */
const quad = (x: number, y: number, size: number, mark?: ChartMark): ChartPolygon => ({
  corners: [x, y, x + size, y, x + size, y + size, x, y + size],
  color: BLUE,
  ...(mark === undefined ? {} : { mark }),
});

const list = (polygons: readonly ChartPolygon[]): ChartDrawList => ({ polygons, texts: [] });

describe('naming the same mark twice', () => {
  it('is the same mark when it is the same series and value', () => {
    expect(sameChartMark({ series: 0, data: 2 }, { series: 0, data: 2 })).toBe(true);
    expect(sameChartMark({ series: 1, data: 2 }, { series: 0, data: 2 })).toBe(false);
    expect(sameChartMark({ series: 0, data: 1 }, { series: 0, data: 2 })).toBe(false);
  });

  it('is nothing when either is nothing', () => {
    expect(sameChartMark(null, null)).toBe(true);
    expect(sameChartMark(undefined, undefined)).toBe(true);
    expect(sameChartMark({ series: 0, data: 0 }, null)).toBe(false);
    expect(sameChartMark(null, { series: 0, data: 0 })).toBe(false);
    expect(sameChartMark(undefined, { series: 0, data: 0 })).toBe(false);
    expect(sameChartMark({ series: 0, data: 0 }, undefined)).toBe(false);
  });
});

describe('the mark under a point', () => {
  const marked = list([
    quad(0, 0, 10, { series: 0, data: 0 }),
    quad(20, 0, 10, { series: 0, data: 1 }),
  ]);

  it('finds the mark a point lands in', () => {
    expect(chartMarkAt(marked, 5, 5)).toEqual({ series: 0, data: 0 });
    expect(chartMarkAt(marked, 25, 5)).toEqual({ series: 0, data: 1 });
  });

  it('finds nothing between the marks, or outside them all', () => {
    expect(chartMarkAt(marked, 15, 5)).toBeNull();
    expect(chartMarkAt(marked, 5, 50)).toBeNull();
    expect(chartMarkAt(list([]), 0, 0)).toBeNull();
  });

  it('ignores the chart furniture, which is not a mark', () => {
    // Axes, grid lines and the legend's frame carry no mark, and pointing at a
    // grid line is not pointing at a value.
    expect(chartMarkAt(list([quad(0, 0, 100)]), 50, 50)).toBeNull();
  });

  it('takes the one drawn last, which is the one on top', () => {
    const stacked = list([
      quad(0, 0, 20, { series: 0, data: 0 }),
      quad(5, 5, 5, { series: 1, data: 3 }),
    ]);
    expect(chartMarkAt(stacked, 7, 7)).toEqual({ series: 1, data: 3 });
  });

  it('finds a mark inside a triangle written as a quad', () => {
    // A repeated last corner is how the batch takes a triangle, and a pie is
    // made of them.
    const triangle: ChartPolygon = {
      corners: [0, 0, 10, 0, 5, 10, 5, 10],
      color: BLUE,
      mark: { series: 0, data: 7 },
    };
    expect(chartMarkAt(list([triangle]), 5, 4)).toEqual({ series: 0, data: 7 });
    expect(chartMarkAt(list([triangle]), 0, 9)).toBeNull();
  });
});

describe('applying the pointer and the selection', () => {
  const drawn: ChartDrawList = {
    polygons: [
      quad(0, 0, 10, { series: 0, data: 0 }),
      quad(20, 0, 10, { series: 0, data: 1 }),
      quad(40, 0, 10),
    ],
    texts: [
      {
        x: 0,
        y: 20,
        width: 10,
        height: 12,
        text: 'a',
        color: BLUE,
        align: 'left',
        fontSize: 10,
        mark: { series: 0, data: 0 },
      },
    ],
  };

  it('leaves the geometry exactly as it was when nothing is happening', () => {
    // Not a copy: a frame in which the pointer is nowhere should cost nothing.
    expect(emphasiseChart(drawn, {})).toBe(drawn);
    expect(emphasiseChart(drawn, { hovered: null, selected: [] })).toBe(drawn);
  });

  it('lifts the mark under the pointer, and only that one', () => {
    const lit = emphasiseChart(drawn, { hovered: { series: 0, data: 0 } });
    expect(lit.polygons[0]?.color[0]).toBeGreaterThan(BLUE[0]);
    expect(lit.polygons[1]?.color).toEqual(BLUE);
    // Its label goes with it: a mark is the whole of what a mark is.
    expect(lit.texts[0]?.color[0]).toBeGreaterThan(BLUE[0]);
  });

  it('leaves the furniture alone whatever the pointer is doing', () => {
    const lit = emphasiseChart(drawn, { hovered: { series: 0, data: 0 } });
    expect(lit.polygons[2]?.color).toBe(BLUE);
  });

  it('fades what was not picked out, which is what says "these ones"', () => {
    const picked = emphasiseChart(drawn, { selected: [{ series: 0, data: 1 }] });
    expect(picked.polygons[1]?.color).toEqual(BLUE);
    expect(picked.polygons[0]?.color[3]).toBeLessThan(1);
    // Still not the furniture: the axes are not competing for attention.
    expect(picked.polygons[2]?.color).toBe(BLUE);
  });

  it('keeps every mark picked out, not just the last', () => {
    const picked = emphasiseChart(drawn, {
      selected: [
        { series: 0, data: 0 },
        { series: 0, data: 1 },
      ],
    });
    expect(picked.polygons[0]?.color).toEqual(BLUE);
    expect(picked.polygons[1]?.color).toEqual(BLUE);
  });

  it('lifts a picked mark the pointer is over, rather than fading it', () => {
    const both = emphasiseChart(drawn, {
      hovered: { series: 0, data: 1 },
      selected: [{ series: 0, data: 1 }],
    });
    expect(both.polygons[1]?.color[0]).toBeGreaterThan(BLUE[0]);
    expect(both.polygons[1]?.color[3]).toBe(1);
  });

  it('does not lift a mark the selection has faded out', () => {
    // Pointing at something that has been set aside should not undo setting it
    // aside; the fade is the answer to "which ones did I choose".
    const both = emphasiseChart(drawn, {
      hovered: { series: 0, data: 0 },
      selected: [{ series: 0, data: 1 }],
    });
    expect(both.polygons[0]?.color[3]).toBeLessThan(1);
  });

  it('moves nothing, so pointing at a chart cannot make it jump', () => {
    const lit = emphasiseChart(drawn, { hovered: { series: 0, data: 0 } });
    expect(lit.polygons.map((polygon) => polygon.corners)).toEqual(
      drawn.polygons.map((polygon) => polygon.corners),
    );
    expect(lit.texts[0]?.x).toBe(drawn.texts[0]?.x);
  });
});
