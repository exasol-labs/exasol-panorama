import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { TableRenderInput } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  buildTableDrawList,
  computeScrollbars,
  formatRowCount,
  maxScrollLeftOf,
  maxScrollTopOf,
  tableMetrics,
  tableScrollBounds,
} from '@panorama/renderer';
import { dataView, makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds());
const layout = computeColumnLayout(table.columns);

const input = (overrides: Partial<TableRenderInput> = {}): TableRenderInput => ({
  entity: table,
  layout,
  theme: DEFAULT_TABLE_THEME,
  lod: 'full',
  scrollTop: 0,
  scrollLeft: 0,
  rowCount: 1_000_000,
  data: dataView(),
  ...overrides,
});

describe('formatRowCount', () => {
  it.each([
    [null, '… rows'],
    [0, '0 rows'],
    [1, '1 row'],
    [42, '42 rows'],
    [1_500, '1.50K rows'],
    [15_000, '15.0K rows'],
    [150_000, '150K rows'],
    [2_830_000_000, '2.83B rows'],
    [1.5e12, '1.50T rows'],
  ])('formats %s', (count, expected) => {
    expect(formatRowCount(count)).toBe(expected);
  });
});

describe('buildTableDrawList', () => {
  it('draws the chrome a user expects to recognise', () => {
    const list = buildTableDrawList(input());
    const texts = list.texts.map((run) => run.text);
    expect(texts).toContain('SALES.ORDERS');
    expect(texts.some((value) => value.endsWith('M rows'))).toBe(true);
    expect(texts).toContain('ORDER_ID');
    expect(texts).toContain('DECIMAL(18,0)');
    // Result positions are one-based for display.
    expect(texts).toContain('1');
  });

  it('does work proportional to the visible cells, not the row count', () => {
    const small = buildTableDrawList(input({ rowCount: 100 }));
    const huge = buildTableDrawList(input({ rowCount: 10_000_000_000 }));
    expect(huge.stats.renderedRows).toBe(small.stats.renderedRows);
    expect(huge.quads.length).toBe(small.quads.length);
    expect(huge.stats.renderedRows).toBeLessThan(40);
  });

  it('renders cell values with type-aware alignment and formatting', () => {
    const list = buildTableDrawList(input());
    const revenue = list.texts.find((run) => run.text === '1.50');
    expect(revenue?.align).toBe('right');
    const country = list.texts.find((run) => run.text === 'country-1');
    expect(country?.align).toBe('left');
  });

  it('marks NULLs distinctly', () => {
    const list = buildTableDrawList(input());
    const nulls = list.texts.filter((run) => run.text === '—');
    expect(nulls.length).toBeGreaterThan(0);
    expect(nulls[0]?.color).toBe(DEFAULT_TABLE_THEME.nullText);
  });

  it('draws placeholders instead of text for unloaded rows', () => {
    const list = buildTableDrawList(input({ data: dataView({ holes: (row) => row >= 5 }) }));
    expect(list.stats.placeholderCells).toBeGreaterThan(0);
    expect(list.texts.some((run) => run.text === 'country-1')).toBe(true);
    // No cell text is emitted for rows that have not arrived.
    expect(list.texts.some((run) => run.text === 'country-0' && run.y > 200)).toBe(false);
  });

  it('scrolls vertically without changing the amount of work', () => {
    const top = buildTableDrawList(input({ scrollTop: 0 }));
    const deep = buildTableDrawList(input({ scrollTop: 4_300 * table.view.rowHeight }));
    expect(deep.stats.renderedRows).toBeGreaterThanOrEqual(top.stats.renderedRows - 6);
    expect(deep.texts.some((run) => run.text === '4301')).toBe(true);
  });

  it('scrolls horizontally, keeping the gutter pinned', () => {
    const scrolled = buildTableDrawList(input({ scrollLeft: 150 }));
    const gutterText = scrolled.texts.find((run) => run.text === '1');
    expect(gutterText?.x).toBeLessThan(64);
    expect(scrolled.stats.visibleColumns).toBeGreaterThan(0);
  });

  it('highlights the hovered row and a selected table', () => {
    const plain = buildTableDrawList(input());
    const hovered = buildTableDrawList(input({ hoveredRow: 2, selected: true }));
    expect(
      hovered.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.rowHoverBackground),
    ).toBe(true);
    expect(hovered.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.selectedBorder)).toBe(
      true,
    );
    expect(plain.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.selectedBorder)).toBe(
      false,
    );
  });

  it('drops the type row and grid lines at reduced detail', () => {
    const reduced = buildTableDrawList(input({ lod: 'reduced' }));
    expect(reduced.texts.some((run) => run.text === 'DECIMAL(18,0)')).toBe(false);
    expect(reduced.texts.some((run) => run.text === 'ORDER_ID')).toBe(true);
    expect(reduced.quads.length).toBeLessThan(buildTableDrawList(input()).quads.length);
  });

  it('collapses to a title and an impression when far away', () => {
    const summary = buildTableDrawList(input({ lod: 'summary' }));
    expect(summary.texts.map((run) => run.text)).toContain('SALES.ORDERS');
    expect(summary.texts.some((run) => run.text === 'ORDER_ID')).toBe(false);
    expect(summary.stats.renderedRows).toBe(0);
    expect(summary.quads.length).toBeGreaterThan(0);
  });

  it('shows a vertical scrollbar only when the content overflows', () => {
    const overflowing = buildTableDrawList(input({ rowCount: 1_000_000 }));
    expect(overflowing.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.scrollbar)).toBe(
      true,
    );
    const short = buildTableDrawList(input({ rowCount: 2 }));
    expect(short.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.scrollbar)).toBe(false);
  });

  it('shows a horizontal scrollbar for wide schemas', () => {
    const narrow = makeTable(testIds(), { size: { width: 200, height: 400 } });
    const list = buildTableDrawList(
      input({ entity: narrow, layout: computeColumnLayout(narrow.columns) }),
    );
    const bars = list.quads.filter((quad) => quad.color === DEFAULT_TABLE_THEME.scrollbar);
    expect(bars).toHaveLength(2);
  });

  it('handles a table barely taller than its header', () => {
    const tiny = makeTable(testIds(), { size: { width: 200, height: 96 } });
    const list = buildTableDrawList(
      input({ entity: tiny, layout: computeColumnLayout(tiny.columns) }),
    );
    expect(list.stats.visibleRows).toBe(1);
    expect(list.quads.length).toBeGreaterThan(0);
    expect(list.texts.some((run) => run.text === 'SALES.ORDERS')).toBe(true);
  });

  it('renders nothing but chrome when the body has no height', () => {
    const flat = { ...table, transform: { ...table.transform, height: 72 } };
    const list = buildTableDrawList(
      input({ entity: flat, layout: computeColumnLayout(flat.columns) }),
    );
    expect(list.stats.renderedRows).toBe(0);
    expect(list.texts.some((run) => run.text === 'SALES.ORDERS')).toBe(true);
  });

  it('reports an unknown row count in the title', () => {
    const list = buildTableDrawList(input({ rowCount: null }));
    expect(list.texts.some((run) => run.text === '… rows')).toBe(true);
  });

  it('accepts an explicit row-count label', () => {
    const list = buildTableDrawList(input({ rowCountLabel: 'streaming' }));
    expect(list.texts.some((run) => run.text === 'streaming')).toBe(true);
  });

  it('skips hidden columns entirely', () => {
    const hidden = {
      ...table,
      columns: table.columns.map((column, index) =>
        index === 1 ? { ...column, visible: false } : column,
      ),
    };
    const list = buildTableDrawList(
      input({ entity: hidden, layout: computeColumnLayout(hidden.columns) }),
    );
    expect(list.texts.some((run) => run.text === 'COUNTRY')).toBe(false);
  });
});

describe('tableMetrics', () => {
  it('reserves space so a scrollbar never covers a cell', () => {
    const tall = tableMetrics(table, layout, 1_000_000, DEFAULT_TABLE_THEME);
    expect(tall.verticalScrollbar).toBe(true);
    expect(tall.horizontalScrollbar).toBe(false);
    // The cell area stops where the bar begins.
    expect(tall.gutterWidth + tall.bodyWidth).toBe(
      600 - DEFAULT_TABLE_THEME.scrollbarWidth - DEFAULT_TABLE_THEME.resizeMargin,
    );
    expect(tall.bodyHeight).toBe(400 - table.view.headerHeight);
  });

  it('reports no bars when nothing overflows', () => {
    const short = tableMetrics(table, layout, 2, DEFAULT_TABLE_THEME);
    expect(short.verticalScrollbar).toBe(false);
    expect(short.horizontalScrollbar).toBe(false);
    expect(short.bodyWidth).toBe(600 - short.gutterWidth);
  });

  it('notices that reserving one bar pushes the other axis into overflow', () => {
    // Narrow enough to need a horizontal bar, and with just enough rows that
    // the space that bar reserves is what causes the vertical overflow.
    const narrow = makeTable(testIds(), {
      size: { width: 200, height: 400 },
      view: { rowHeight: 4 },
    });
    const narrowLayout = computeColumnLayout(narrow.columns);
    const bodyHeight = 400 - narrow.view.headerHeight;
    const reserve = DEFAULT_TABLE_THEME.scrollbarWidth + DEFAULT_TABLE_THEME.resizeMargin;
    const rows = (bodyHeight - Math.floor(reserve / 2)) / narrow.view.rowHeight;

    expect(tableMetrics(narrow, narrowLayout, rows, DEFAULT_TABLE_THEME)).toMatchObject({
      horizontalScrollbar: true,
      verticalScrollbar: true,
    });
    // Without the horizontal bar those same rows would have fitted.
    const wideEnough = makeTable(testIds(), {
      size: { width: 2_000, height: 400 },
      view: { rowHeight: 4 },
    });
    expect(
      tableMetrics(wideEnough, computeColumnLayout(wideEnough.columns), rows, DEFAULT_TABLE_THEME),
    ).toMatchObject({ horizontalScrollbar: false, verticalScrollbar: false });
  });

  it('reports scroll limits from the reserved body', () => {
    const metrics = tableMetrics(table, layout, 1_000, DEFAULT_TABLE_THEME);
    expect(maxScrollTopOf(metrics)).toBe(1_000 * 24 - metrics.bodyHeight);
    expect(maxScrollLeftOf(metrics)).toBe(Math.max(0, layout.totalWidth - metrics.bodyWidth));
  });

  it('never reports a negative body', () => {
    const tiny = { ...table, transform: { ...table.transform, width: 10, height: 10 } };
    const metrics = tableMetrics(tiny, layout, 1_000_000, DEFAULT_TABLE_THEME);
    expect(metrics.bodyWidth).toBe(0);
    expect(metrics.bodyHeight).toBe(0);
  });
});

describe('computeScrollbars', () => {
  const metricsFor = (rowCount: number | null, entity = table) =>
    tableMetrics(entity, computeColumnLayout(entity.columns), rowCount, DEFAULT_TABLE_THEME);

  it('sizes thumbs from the visible fraction', () => {
    const metrics = metricsFor(1_000);
    const bars = computeScrollbars(metrics, 0, 0, DEFAULT_TABLE_THEME);
    expect(bars.vertical?.height).toBeCloseTo(
      Math.max(
        DEFAULT_TABLE_THEME.scrollbarMinLength,
        metrics.bodyHeight * (metrics.bodyHeight / metrics.contentHeight),
      ),
    );
    expect(bars.verticalTrack?.height).toBe(metrics.bodyHeight);
  });

  it('never shrinks a thumb below the minimum length', () => {
    const bars = computeScrollbars(metricsFor(100_000_000), 0, 0, DEFAULT_TABLE_THEME);
    expect(bars.vertical?.height).toBe(DEFAULT_TABLE_THEME.scrollbarMinLength);
  });

  it('places the thumb proportionally and clamps at the ends', () => {
    const metrics = metricsFor(1_000);
    const middle = computeScrollbars(metrics, maxScrollTopOf(metrics) / 2, 0, DEFAULT_TABLE_THEME);
    const end = computeScrollbars(metrics, 1e9, 1e9, DEFAULT_TABLE_THEME);
    expect(middle.vertical?.y).toBeGreaterThan(metrics.headerHeight);
    expect(end.vertical?.y).toBeCloseTo(
      metrics.headerHeight + metrics.bodyHeight - (end.vertical?.height ?? 0),
    );
  });

  it('sits the bars just outside the cell area', () => {
    const narrow = makeTable(testIds(), { size: { width: 220, height: 400 } });
    const metrics = metricsFor(1_000, narrow);
    const bars = computeScrollbars(metrics, 0, 0, DEFAULT_TABLE_THEME);
    expect(bars.vertical?.x).toBe(metrics.gutterWidth + metrics.bodyWidth);
    expect(bars.horizontal?.y).toBe(metrics.headerHeight + metrics.bodyHeight);
  });

  it('omits bars when nothing overflows', () => {
    expect(computeScrollbars(metricsFor(2), 0, 0, DEFAULT_TABLE_THEME)).toEqual({
      vertical: null,
      verticalTrack: null,
      horizontal: null,
      horizontalTrack: null,
    });
  });

  it('omits bars when there is no body left', () => {
    const tiny = { ...table, transform: { ...table.transform, width: 10, height: 10 } };
    expect(computeScrollbars(metricsFor(1_000, tiny), 0, 0, DEFAULT_TABLE_THEME)).toEqual({
      vertical: null,
      verticalTrack: null,
      horizontal: null,
      horizontalTrack: null,
    });
  });
});

describe('tableScrollBounds', () => {
  it('reports the maximum scroll offsets from the reserved body', () => {
    const metrics = tableMetrics(table, layout, 1_000, DEFAULT_TABLE_THEME);
    const bounds = tableScrollBounds(table, layout, 1_000, DEFAULT_TABLE_THEME);
    expect(bounds.maxTop).toBe(maxScrollTopOf(metrics));
    expect(bounds.maxLeft).toBe(maxScrollLeftOf(metrics));
  });
});

describe('the action halo', () => {
  const haloOf = (overrides: Partial<TableRenderInput> = {}) =>
    buildTableDrawList(input({ showHalo: true, ...overrides }));

  it('is absent until the table is activated', () => {
    const quiet = buildTableDrawList(input());
    expect(quiet.texts.some((run) => run.text === '×')).toBe(false);
  });

  it('appears above the table when activated', () => {
    const list = haloOf();
    const icon = list.texts.find((run) => run.text === '×');
    expect(icon).toBeDefined();
    // Above the table's top edge: it must not cover any data.
    expect((icon?.y ?? 0) + (icon?.height ?? 0)).toBeLessThanOrEqual(0);
    expect(icon?.align).toBe('center');
  });

  it('draws a border and a face for each button', () => {
    const quiet = buildTableDrawList(input()).quads.length;
    expect(haloOf().quads.length).toBe(quiet + 2);
    expect(haloOf().quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.haloBackground)).toBe(
      true,
    );
  });

  it('highlights on hover and again on press', () => {
    expect(
      haloOf({ hoveredAction: 'close' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloHoverBackground,
      ),
    ).toBe(true);
    expect(
      haloOf({ pressedAction: 'close' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloPressedBackground,
      ),
    ).toBe(true);
    expect(haloOf({ hoveredAction: 'close' }).texts.find((run) => run.text === '×')?.color).toBe(
      DEFAULT_TABLE_THEME.haloHoverIcon,
    );
  });

  it('keeps a constant screen size as the camera zooms out', () => {
    const near = haloOf({ scale: 1 }).texts.find((run) => run.text === '×');
    const far = haloOf({ scale: 0.5 }).texts.find((run) => run.text === '×');
    expect(far?.fontSize).toBeCloseTo((near?.fontSize ?? 0) * 2, 6);
    expect(far?.height).toBeCloseTo((near?.height ?? 0) * 2, 6);
  });

  it('still appears at reduced detail but not at far zoom', () => {
    expect(haloOf({ lod: 'reduced' }).texts.some((run) => run.text === '×')).toBe(true);
    expect(haloOf({ lod: 'summary' }).texts.some((run) => run.text === '×')).toBe(false);
  });

  it('is drawn last, so it layers above the table chrome', () => {
    const list = haloOf();
    const lastQuads = list.quads.slice(-2).map((quad) => quad.color);
    expect(lastQuads).toContain(DEFAULT_TABLE_THEME.haloBackground);
  });
});
