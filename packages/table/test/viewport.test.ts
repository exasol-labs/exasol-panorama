import { describe, expect, it } from 'vitest';
import type { TableColumnView } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { EntityId } from '@panorama/core';
import {
  DEFAULT_ROW_OVERSCAN,
  clampScrollLeft,
  clampScrollTop,
  computeColumnLayout,
  computeRowWindow,
  computeViewport,
  maxScrollTop,
  sameDataRequirements,
} from '@panorama/table';

const column = (index: number, width: number): TableColumnView => ({
  id: `column:${index}` as EntityId,
  sourceColumn: { name: `C${index}`, type: dataType('varchar', 'VARCHAR(10)') },
  width,
  visible: true,
});

describe('computeRowWindow', () => {
  it('reports the visible rows and the render buffer', () => {
    const window = computeRowWindow({
      scrollTop: 4_300 * 24,
      rowHeight: 24,
      bodyHeight: 34 * 24,
      rowCount: 1_000_000,
      overscan: 12,
    });
    expect(window.firstVisibleRow).toBe(4_300);
    expect(window.visibleRowCount).toBe(34);
    expect(window.firstRenderedRow).toBe(4_288);
    expect(window.renderedRowCount).toBe(34 + 24);
    expect(window.offsetY).toBe(-12 * 24);
  });

  it('adds a row when the viewport is mid-row', () => {
    const window = computeRowWindow({
      scrollTop: 10,
      rowHeight: 24,
      bodyHeight: 48,
      rowCount: 100,
      overscan: 0,
    });
    expect(window.firstVisibleRow).toBe(0);
    expect(window.visibleRowCount).toBe(3);
    expect(window.offsetY).toBe(-10);
  });

  it('clamps against the end of the result set', () => {
    const window = computeRowWindow({
      scrollTop: 90 * 24,
      rowHeight: 24,
      bodyHeight: 20 * 24,
      rowCount: 100,
      overscan: 6,
    });
    expect(window.firstVisibleRow).toBe(90);
    expect(window.visibleRowCount).toBe(10);
    expect(window.renderedRowCount).toBe(100 - 84);
  });

  it('never renders before row zero', () => {
    const window = computeRowWindow({
      scrollTop: 0,
      rowHeight: 24,
      bodyHeight: 240,
      rowCount: 1_000,
    });
    expect(window.firstRenderedRow).toBe(0);
    expect(window.offsetY).toBe(0);
    expect(window.renderedRowCount).toBe(10 + DEFAULT_ROW_OVERSCAN);
  });

  it('handles an unknown row count', () => {
    const window = computeRowWindow({
      scrollTop: 0,
      rowHeight: 20,
      bodyHeight: 200,
      rowCount: null,
      overscan: 2,
    });
    expect(window.visibleRowCount).toBe(10);
    expect(window.renderedRowCount).toBe(12);
  });

  it('returns an empty window for degenerate geometry', () => {
    const empty = {
      firstVisibleRow: 0,
      visibleRowCount: 0,
      firstRenderedRow: 0,
      renderedRowCount: 0,
      offsetY: 0,
    };
    expect(computeRowWindow({ scrollTop: 0, rowHeight: 0, bodyHeight: 10, rowCount: 5 })).toEqual(
      empty,
    );
    expect(computeRowWindow({ scrollTop: 0, rowHeight: 10, bodyHeight: 0, rowCount: 5 })).toEqual(
      empty,
    );
    expect(computeRowWindow({ scrollTop: 0, rowHeight: 10, bodyHeight: 10, rowCount: 0 })).toEqual(
      empty,
    );
  });

  it('treats negative scroll as the top', () => {
    expect(
      computeRowWindow({ scrollTop: -50, rowHeight: 10, bodyHeight: 100, rowCount: 100 })
        .firstVisibleRow,
    ).toBe(0);
  });
});

describe('scroll bounds', () => {
  it('computes the maximum vertical scroll', () => {
    expect(maxScrollTop(100, 24, 240)).toBe(100 * 24 - 240);
    expect(maxScrollTop(5, 24, 240)).toBe(0);
    expect(maxScrollTop(null, 24, 240)).toBe(Number.POSITIVE_INFINITY);
    expect(clampScrollTop(1e9, 100, 24, 240)).toBe(100 * 24 - 240);
    expect(clampScrollTop(-5, 100, 24, 240)).toBe(0);
  });

  it('computes the maximum horizontal scroll', () => {
    const layout = computeColumnLayout([column(0, 100), column(1, 100)]);
    expect(clampScrollLeft(1_000, layout, 120)).toBe(80);
    expect(clampScrollLeft(-10, layout, 120)).toBe(0);
    expect(clampScrollLeft(50, layout, 500)).toBe(0);
  });
});

describe('computeViewport', () => {
  const layout = computeColumnLayout([column(0, 100), column(1, 100), column(2, 100)]);
  const metrics = {
    gutterWidth: 64,
    headerHeight: 48,
    rowHeight: 24,
    bodyWidth: 150,
    bodyHeight: 240,
  };

  it('produces the worker-facing viewport description', () => {
    const { viewport, rows, columns } = computeViewport({
      metrics,
      layout,
      scrollTop: 240,
      scrollLeft: 100,
      rowCount: 10_000,
      velocityY: 800,
      rowOverscan: 4,
      columnOverscan: 0,
    });
    expect(rows.firstVisibleRow).toBe(10);
    expect(columns.first).toBe(1);
    expect(viewport).toEqual({
      firstVisibleRow: 10,
      visibleRowCount: 10,
      firstVisibleColumn: 1,
      visibleColumns: columns.placements.map((placement) => placement.id),
      verticalPixelOffset: 240,
      horizontalPixelOffset: 100,
      velocityY: 800,
    });
  });

  it('falls back to the default row overscan', () => {
    const { rows } = computeViewport({
      metrics,
      layout,
      scrollTop: 2_400,
      scrollLeft: 0,
      rowCount: 10_000,
      velocityY: 0,
    });
    expect(rows.firstRenderedRow).toBe(100 - DEFAULT_ROW_OVERSCAN);
  });
});

describe('sameDataRequirements', () => {
  const base = {
    firstVisibleRow: 10,
    visibleRowCount: 20,
    firstVisibleColumn: 0,
    visibleColumns: ['column:0' as EntityId],
    verticalPixelOffset: 240,
    horizontalPixelOffset: 0,
    velocityY: 100,
  };

  it('ignores sub-row scrolling but notices real changes', () => {
    expect(sameDataRequirements(base, { ...base, verticalPixelOffset: 245 })).toBe(true);
    expect(sameDataRequirements(base, { ...base, velocityY: 900 })).toBe(true);
    expect(sameDataRequirements(base, { ...base, firstVisibleRow: 11 })).toBe(false);
    expect(sameDataRequirements(base, { ...base, visibleRowCount: 21 })).toBe(false);
    expect(sameDataRequirements(base, { ...base, firstVisibleColumn: 1 })).toBe(false);
    expect(sameDataRequirements(base, { ...base, visibleColumns: [] })).toBe(false);
    expect(sameDataRequirements(base, { ...base, velocityY: -100 })).toBe(false);
  });
});
