import { describe, expect, it } from 'vitest';
import type { EntityId, TableColumnView } from '@panorama/core';
import { ROW_NUMBER_GUTTER_WIDTH, dataType } from '@panorama/core';
import {
  columnAtOffset,
  columnEdgeAtOffset,
  computeColumnLayout,
  computeColumnWindow,
  maxScrollLeft,
  tableChromeMetrics,
} from '@panorama/table';
import { makeTable, testIds } from './fixtures.js';

const column = (index: number, width: number, visible = true): TableColumnView => ({
  id: `column:${index}` as EntityId,
  sourceColumn: { name: `C${index}`, type: dataType('varchar', 'VARCHAR(10)') },
  width,
  visible,
});

describe('computeColumnLayout', () => {
  it('accumulates offsets and skips hidden columns', () => {
    const layout = computeColumnLayout([column(0, 100), column(1, 50, false), column(2, 25)]);
    expect(layout.totalWidth).toBe(125);
    expect(
      layout.placements.map((placement) => [placement.index, placement.sourceIndex, placement.x]),
    ).toEqual([
      [0, 0, 0],
      [1, 2, 100],
    ]);
  });

  it('handles no columns', () => {
    expect(computeColumnLayout([])).toEqual({ placements: [], totalWidth: 0 });
  });
});

describe('computeColumnWindow', () => {
  const layout = computeColumnLayout(
    Array.from({ length: 1_000 }, (_, index) => column(index, 100)),
  );

  it('finds the columns intersecting the viewport', () => {
    const window = computeColumnWindow(layout, 10_000, 350, 0);
    expect(window.first).toBe(100);
    expect(window.count).toBe(4);
    expect(window.placements[0]?.x).toBe(10_000);
  });

  it('adds a buffer on each side', () => {
    const window = computeColumnWindow(layout, 10_000, 350, 2);
    expect(window.first).toBe(98);
    expect(window.count).toBe(8);
  });

  it('clamps the buffer at the ends', () => {
    expect(computeColumnWindow(layout, 0, 350, 2).first).toBe(0);
    const last = computeColumnWindow(layout, 99_900, 350, 2);
    expect(last.first + last.count).toBe(1_000);
  });

  it('returns nothing for empty layouts or zero width', () => {
    expect(computeColumnWindow(computeColumnLayout([]), 0, 100)).toEqual({
      first: 0,
      count: 0,
      placements: [],
    });
    expect(computeColumnWindow(layout, 0, 0).count).toBe(0);
  });

  it('treats negative scroll as zero', () => {
    expect(computeColumnWindow(layout, -500, 350, 0).first).toBe(0);
  });

  it('handles a viewport wider than the content', () => {
    const narrow = computeColumnLayout([column(0, 40), column(1, 40)]);
    const window = computeColumnWindow(narrow, 0, 1_000, 0);
    expect(window.count).toBe(2);
    expect(maxScrollLeft(narrow, 1_000)).toBe(0);
  });
});

describe('hit testing', () => {
  const layout = computeColumnLayout([column(0, 100), column(1, 80), column(2, 60)]);

  it('finds the column under an offset', () => {
    expect(columnAtOffset(layout, 0)?.index).toBe(0);
    expect(columnAtOffset(layout, 99.9)?.index).toBe(0);
    expect(columnAtOffset(layout, 100)?.index).toBe(1);
    expect(columnAtOffset(layout, 239.9)?.index).toBe(2);
    expect(columnAtOffset(layout, 240)).toBeNull();
    expect(columnAtOffset(layout, -1)).toBeNull();
    expect(columnAtOffset(computeColumnLayout([]), 0)).toBeNull();
  });

  it('finds the resize edge of a column', () => {
    expect(columnEdgeAtOffset(layout, 100)?.index).toBe(0);
    expect(columnEdgeAtOffset(layout, 102, 4)?.index).toBe(0);
    expect(columnEdgeAtOffset(layout, 178, 4)?.index).toBe(1);
    expect(columnEdgeAtOffset(layout, 50, 4)).toBeNull();
    expect(columnEdgeAtOffset(layout, 1_000, 4)).toBeNull();
  });

  it('stops scanning once past the offset', () => {
    const wide = computeColumnLayout(Array.from({ length: 500 }, (_, index) => column(index, 100)));
    expect(columnEdgeAtOffset(wide, 100)?.index).toBe(0);
  });
});

describe('tableChromeMetrics', () => {
  it('derives the body area from the entity transform', () => {
    const table = makeTable(testIds(), { size: { width: 800, height: 400 } });
    const metrics = tableChromeMetrics(table);
    expect(metrics.gutterWidth).toBe(ROW_NUMBER_GUTTER_WIDTH);
    expect(metrics.bodyWidth).toBe(800 - ROW_NUMBER_GUTTER_WIDTH);
    expect(metrics.bodyHeight).toBe(400 - table.view.headerHeight);
  });

  it('never reports a negative body', () => {
    const table = makeTable(testIds(), { size: { width: 200, height: 100 } });
    const metrics = tableChromeMetrics(table, 400);
    expect(metrics.bodyWidth).toBe(0);
  });
});
