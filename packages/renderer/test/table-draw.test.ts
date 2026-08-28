import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { TableRenderInput } from '@panorama/renderer';
import { ROW_NUMBER_GUTTER_WIDTH } from '@panorama/core';
import {
  TABLE_ACTIONS,
  DEFAULT_TABLE_THEME,
  buildTableDrawList,
  computeScrollbars,
  formatRowCount,
  maxScrollLeftOf,
  maxScrollTopOf,
  rowNumberGutterWidth,
  rowTextBand,
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

describe('a column header under the pointer', () => {
  const drawWith = (
    hoveredColumn: string | null,
    selectedColumns: readonly string[] = [],
  ): ReturnType<typeof buildTableDrawList> =>
    buildTableDrawList({
      entity: table,
      layout,
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      scrollLeft: 0,
      rowCount: 1_000,
      data: dataView(),
      hoveredColumn: hoveredColumn as never,
      selectedColumns: selectedColumns as never,
    });

  const hints = (list: ReturnType<typeof buildTableDrawList>): number =>
    list.quads.filter((q) => q.color === DEFAULT_TABLE_THEME.columnHoverHeaderBackground).length;

  it('is hinted, on the header only', () => {
    const first = layout.placements[0]?.id as string;
    const list = drawWith(first);
    expect(hints(list)).toBe(1);
    const hint = list.quads.find(
      (q) => q.color === DEFAULT_TABLE_THEME.columnHoverHeaderBackground,
    );
    // The header band, between the title bar and the first row — not the column
    // below it, which is what being *selected* washes over.
    expect(hint?.y).toBe(DEFAULT_TABLE_THEME.titleHeight);
    expect((hint?.y ?? 0) + (hint?.height ?? 0)).toBe(table.view.headerHeight);
  });

  it('is not hinted when nothing is under the pointer', () => {
    expect(hints(drawWith(null))).toBe(0);
  });

  /**
   * The selection is the same hue and a stronger one, so a column that is both
   * pointed at and picked out would otherwise be washed twice and read as a
   * third state that does not exist.
   */
  it('gives way to the selection on a column that is already picked out', () => {
    const first = layout.placements[0]?.id as string;
    const second = layout.placements[1]?.id as string;
    expect(hints(drawWith(first, [first]))).toBe(0);
    // But a neighbour being selected is no reason not to hint this one.
    expect(hints(drawWith(first, [second]))).toBe(1);
  });
});

describe('a column picked out by its header', () => {
  const drawWith = (selectedColumns: readonly string[]): ReturnType<typeof buildTableDrawList> =>
    buildTableDrawList({
      entity: table,
      layout,
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      scrollLeft: 0,
      rowCount: 1_000,
      data: dataView(),
      selectedColumns: selectedColumns as never,
    });

  const washes = (list: ReturnType<typeof buildTableDrawList>): number =>
    list.quads.filter((q) => q.color === DEFAULT_TABLE_THEME.columnSelectedBackground).length;

  it('is washed over the body and marked on the header', () => {
    const first = layout.placements[0]?.id as string;
    const list = drawWith([first]);
    expect(washes(list)).toBe(1);
    expect(
      list.quads.some((q) => q.color === DEFAULT_TABLE_THEME.columnSelectedHeaderBackground),
    ).toBe(true);
    // An edge either side, so two neighbours never read as one wide column.
    expect(
      list.quads.filter((q) => q.color === DEFAULT_TABLE_THEME.columnSelectedBorder),
    ).toHaveLength(2);
  });

  it('is washed rather than repainted, so the values still show', () => {
    const first = layout.placements[0]?.id as string;
    const plain = buildTableDrawList({
      entity: table,
      layout,
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      scrollLeft: 0,
      rowCount: 1_000,
      data: dataView(),
    });
    // Not one glyph fewer: the wash is a quad, and quads go under the text. The
    // panel below the table adds runs of its own, so every plain run must still
    // be there rather than the count merely matching.
    const washed = drawWith([first]);
    for (const run of plain.texts) {
      expect(washed.texts).toContainEqual(run);
    }
    // Translucent, which is what lets the striping through: alpha is the
    // fourth channel of an Rgba tuple.
    expect(DEFAULT_TABLE_THEME.columnSelectedBackground[3]).toBeLessThan(1);
  });

  it('washes each of several columns, and nothing when none is picked out', () => {
    const ids = layout.placements.slice(0, 2).map((placement) => placement.id as string);
    expect(washes(drawWith(ids))).toBe(2);
    expect(washes(drawWith([]))).toBe(0);
    // A column id belonging to some other table colours nothing here.
    expect(washes(drawWith(['column:elsewhere']))).toBe(0);
  });

  it('draws nothing for a column scrolled out of sight', () => {
    const last = layout.placements.at(-1)?.id as string;
    const scrolledAway = buildTableDrawList({
      entity: table,
      layout,
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      // Far past the last column.
      scrollLeft: layout.totalWidth + 1_000,
      rowCount: 1_000,
      data: dataView(),
      selectedColumns: [last] as never,
    });
    expect(washes(scrolledAway)).toBe(0);
  });
});

describe('rowTextBand', () => {
  it('reports the band the glyphs ink, not the whole row', () => {
    const band = rowTextBand(24, 12);
    // Comfortably inside a 24-pixel row: text is centred on a baseline rather
    // than filling its row, which is the slack a scrolling edge spends.
    expect(band.top).toBeGreaterThan(0);
    expect(band.bottom).toBeLessThan(24);
    expect(band.bottom - band.top).toBeCloseTo(12 * (0.78 + 0.24), 6);
  });

  it('grows with the font rather than with the row', () => {
    expect(rowTextBand(24, 16).bottom - rowTextBand(24, 16).top).toBeGreaterThan(
      rowTextBand(24, 12).bottom - rowTextBand(24, 12).top,
    );
  });
});

describe('a partly visible row', () => {
  const rowsOf = (height: number, scrollTop: number): TableRenderInput => ({
    entity: { ...table, transform: { ...table.transform, height } },
    layout,
    theme: DEFAULT_TABLE_THEME,
    lod: 'full',
    scrollTop,
    scrollLeft: 0,
    rowCount: 10_000,
    data: dataView(),
  });

  /**
   * The gutter's own numbers. Picked out by their `x`, which is the row's left
   * padding — a cell's text starts at the gutter's far edge or beyond, and the
   * first column here is numeric and right-aligned too.
   */
  const numbers = (input: TableRenderInput): readonly string[] =>
    buildTableDrawList(input)
      .texts.filter((run) => run.x === DEFAULT_TABLE_THEME.cellPaddingX && run.align === 'right')
      .map((run) => run.text);

  it('keeps its background and loses its text, so no glyph is ever halved', () => {
    // Scrolled by half a row: the rows at both edges are cut in two.
    const halfway = rowsOf(400, 12);
    const list = buildTableDrawList(halfway);
    const shown = numbers(halfway);
    // Every number drawn belongs to a row that is whole.
    const band = rowTextBand(table.view.rowHeight, DEFAULT_TABLE_THEME.fontSize);
    const header = table.view.headerHeight;
    const bodyBottom =
      header + tableMetrics(halfway.entity, layout, 10_000, DEFAULT_TABLE_THEME).bodyHeight;
    for (const run of list.texts) {
      if (!/^\d+$/u.test(run.text) || run.align !== 'right') continue;
      expect(run.y + band.top).toBeGreaterThanOrEqual(header - 0.001);
      expect(run.y + band.bottom).toBeLessThanOrEqual(bodyBottom + 0.001);
    }
    // The rows are still there, striped: only the letters waited.
    expect(list.quads.length).toBeGreaterThan(shown.length);
  });

  it('holds back only the rows it has to', () => {
    const aligned = numbers(rowsOf(400, 24 * 3));
    const halved = numbers(rowsOf(400, 24 * 3 + 12));
    // Halving the rows at the edges costs at most one number at each of them.
    expect(aligned.length - halved.length).toBeGreaterThanOrEqual(0);
    expect(aligned.length - halved.length).toBeLessThanOrEqual(2);
    // The row at the top edge is the one that goes: its number is skipped and
    // the next one leads instead.
    expect(aligned[0]).toBe('4');
    expect(halved[0]).toBe('5');
  });

  it('spends only a few pixels of patience, not a whole row', () => {
    // Three pixels into the row is still short of its lettering, so the number
    // stays — a whole-row rule would have dropped it and left a visible gap.
    expect(numbers(rowsOf(400, 3))[0]).toBe('1');
    expect(numbers(rowsOf(400, 0))[0]).toBe('1');
    // Half a row in is past it.
    expect(numbers(rowsOf(400, 12))[0]).toBe('2');
  });
});

describe('rowNumberGutterWidth', () => {
  const theme = DEFAULT_TABLE_THEME;

  it('leaves the configured width alone for a table whose numbers fit', () => {
    expect(rowNumberGutterWidth(100, theme)).toBe(ROW_NUMBER_GUTTER_WIDTH);
    expect(rowNumberGutterWidth(1, theme)).toBe(ROW_NUMBER_GUTTER_WIDTH);
    expect(rowNumberGutterWidth(0, theme)).toBe(ROW_NUMBER_GUTTER_WIDTH);
  });

  it('widens for a row number the configured width could not hold', () => {
    // Eleven digits at eight pixels each, plus the padding either side.
    expect(rowNumberGutterWidth(10_000_000_000, theme)).toBe(11 * 8 + theme.cellPaddingX * 2);
    expect(rowNumberGutterWidth(1_000_000, theme)).toBe(7 * 8 + theme.cellPaddingX * 2);
    // Wide enough for the widest digit of the fonts the atlas falls through: an
    // eleven-digit number measures about 81 pixels, and this leaves room.
    expect(rowNumberGutterWidth(10_000_000_000, theme) - theme.cellPaddingX * 2).toBeGreaterThan(
      81,
    );
  });

  it('grows with the digits rather than with the rows', () => {
    // A ten-fold table is one digit wider, not ten times the gutter.
    const million = rowNumberGutterWidth(1_000_000, theme);
    const tenMillion = rowNumberGutterWidth(10_000_000, theme);
    expect(tenMillion - million).toBe(8);
  });

  it('keeps the configured width when there is no row count to derive from', () => {
    expect(rowNumberGutterWidth(null, theme)).toBe(ROW_NUMBER_GUTTER_WIDTH);
    expect(rowNumberGutterWidth(null, theme, 40)).toBe(40);
  });

  it('takes whichever is wider: the configured width or what the digits need', () => {
    // A generous configured gutter wins over eleven digits that fit inside it.
    expect(rowNumberGutterWidth(10_000_000_000, theme, 200)).toBe(200);
    // A mean one loses to them.
    expect(rowNumberGutterWidth(10_000_000_000, theme, 40)).toBe(11 * 8 + theme.cellPaddingX * 2);
  });
});

describe('tableMetrics', () => {
  it('sizes the gutter to the row numbers, so none of them is cut short', () => {
    const huge = tableMetrics(table, layout, 10_000_000_000, DEFAULT_TABLE_THEME);
    const small = tableMetrics(table, layout, 100, DEFAULT_TABLE_THEME);
    expect(small.gutterWidth).toBe(ROW_NUMBER_GUTTER_WIDTH);
    expect(huge.gutterWidth).toBeGreaterThan(small.gutterWidth);
    // The room comes out of the cells rather than out of the table.
    expect(huge.width).toBe(small.width);
    expect(huge.gutterWidth + huge.bodyWidth).toBeLessThanOrEqual(huge.width);
  });

  it('gives the row number more room than its digits need', () => {
    const huge = tableMetrics(table, layout, 10_000_000_000, DEFAULT_TABLE_THEME);
    const list = buildTableDrawList({
      entity: table,
      layout,
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      scrollLeft: 0,
      rowCount: 10_000_000_000,
      data: { cell: () => 'x' },
    });
    // The number is drawn in full: an ellipsis here would be a position that
    // reads as a different position.
    const numbers = list.texts.filter((run) => /^\d+$/u.test(run.text));
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers.every((run) => !run.text.includes('…'))).toBe(true);
    expect(numbers[0]?.maxWidth).toBeGreaterThanOrEqual(
      huge.gutterWidth - DEFAULT_TABLE_THEME.cellPaddingX * 2,
    );
  });

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

  it('greys out an action the table cannot perform', () => {
    const list = haloOf({ disabledActions: ['sql'] });
    expect(
      list.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.haloDisabledBackground),
    ).toBe(true);
    expect(
      list.texts.find((run) => run.text === 'SQL')?.color === DEFAULT_TABLE_THEME.haloDisabledIcon,
    ).toBe(true);
    // The button is still laid out and drawn — only inert.
    expect(list.quads.length).toBe(haloOf().quads.length);
  });

  it('will not highlight a disabled button even under the pointer', () => {
    const list = haloOf({ disabledActions: ['sql'], hoveredAction: 'sql', pressedAction: 'sql' });
    expect(list.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.haloAccentBackground)).toBe(
      false,
    );
    expect(
      list.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.haloAccentPressedBackground),
    ).toBe(false);
  });

  /**
   * Rounded like the explorer's rows beside it, and rounded the only way the
   * ordering law allows: all polygons draw before all quads, and the halo draws
   * over tables, so the shape has to be made of quads.
   */
  it('rounds the corners of a button, in the batch that draws over a table', () => {
    const faces = haloOf().quads.filter(
      (quad) => quad.color === DEFAULT_TABLE_THEME.haloBackground,
    );
    const widths = [...new Set(faces.map((strip) => Math.round(strip.width * 1000) / 1000))];
    // Not one rectangle per button any more: the ends are inset to follow an arc,
    // so a button's face is several widths rather than one.
    expect(widths.length).toBeGreaterThan(1);
    const widest = Math.max(...widths);
    const narrowest = Math.min(...widths);
    expect(narrowest).toBeLessThan(widest);
    // And inset by at most the radius on each side — a corner, not a taper.
    expect(widest - narrowest).toBeLessThanOrEqual(DEFAULT_TABLE_THEME.haloCornerRadius * 2);
    // The face still sits inside the border on every side.
    const border = haloOf().quads.filter((quad) => quad.color === DEFAULT_TABLE_THEME.haloBorder);
    expect(Math.max(...border.map((strip) => strip.width))).toBeGreaterThan(widest);
  });

  it('tints an ordinary action with the accent and a destructive one with the warning', () => {
    expect(
      haloOf({ hoveredAction: 'sql' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloAccentBackground,
      ),
    ).toBe(true);
    // Close is the destructive one; it must not borrow the accent.
    expect(
      haloOf({ hoveredAction: 'close' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloAccentBackground,
      ),
    ).toBe(false);
  });

  it('draws a border and a face for each button, and the bars on top', () => {
    const quiet = buildTableDrawList(input()).quads.length;
    // A drawn mark goes in the quads with the button it sits on, because the
    // polygon batch is painted underneath them.
    const bars = TABLE_ACTIONS.filter((spec) => spec.shape === 'bars').length * 3;
    expect(bars).toBe(3);
    /**
     * A button is a rounded rectangle, and a rounded rectangle in the quad batch
     * is a stack of strips (see `rounded.ts`) — so the count is no longer two per
     * button. What is worth pinning is that it stays cheap: a budget rather than
     * an exact figure, so the radius can be tuned without editing an arithmetic
     * expression that says nothing to a reader.
     */
    const halo = haloOf().quads.length - quiet - bars;
    expect(halo / TABLE_ACTIONS.length).toBeLessThanOrEqual(24);
    expect(halo / TABLE_ACTIONS.length).toBeGreaterThan(2);
    expect(haloOf().quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.haloBackground)).toBe(
      true,
    );
    // The bars take the icon colour, and turn white with the rest of a hovered
    // button rather than staying dark on the accent.
    expect(haloOf().quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.haloIcon)).toBe(true);
    expect(
      haloOf({ hoveredAction: 'chart' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloHoverIcon,
      ),
    ).toBe(true);
  });

  it('highlights on hover and again on press', () => {
    expect(
      haloOf({ hoveredAction: 'close' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloDangerBackground,
      ),
    ).toBe(true);
    expect(
      haloOf({ pressedAction: 'close' }).quads.some(
        (quad) => quad.color === DEFAULT_TABLE_THEME.haloDangerPressedBackground,
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
