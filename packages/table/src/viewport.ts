import type { EntityId } from '@panorama/core';
import { clamp } from '@panorama/core';
import type { ColumnLayout, TableChromeMetrics } from './layout.js';
import { computeColumnWindow, maxScrollLeft } from './layout.js';

/**
 * What should currently be visible.
 *
 * The viewport is pure arithmetic over scroll offsets: it never consults the
 * cache and never awaits anything, which is what allows the viewport to keep
 * moving while data is in flight.
 */

export interface RowWindowInput {
  readonly scrollTop: number;
  readonly rowHeight: number;
  readonly bodyHeight: number;
  readonly rowCount: number | null;
  /** Rows rendered beyond the visible edge, absorbing one frame of scrolling. */
  readonly overscan?: number;
}

export interface RowWindow {
  readonly firstVisibleRow: number;
  readonly visibleRowCount: number;
  readonly firstRenderedRow: number;
  readonly renderedRowCount: number;
  /** Y offset of the first rendered row relative to the body top; always ≤ 0. */
  readonly offsetY: number;
}

export const DEFAULT_ROW_OVERSCAN = 6;

export const computeRowWindow = (input: RowWindowInput): RowWindow => {
  const { rowHeight, bodyHeight, rowCount } = input;
  const overscan = input.overscan ?? DEFAULT_ROW_OVERSCAN;
  const scrollTop = Math.max(0, input.scrollTop);

  if (rowHeight <= 0 || bodyHeight <= 0 || rowCount === 0) {
    return {
      firstVisibleRow: 0,
      visibleRowCount: 0,
      firstRenderedRow: 0,
      renderedRowCount: 0,
      offsetY: 0,
    };
  }

  const firstVisibleRow = Math.floor(scrollTop / rowHeight);
  const partial = scrollTop - firstVisibleRow * rowHeight;
  const spanned = Math.ceil((bodyHeight + partial) / rowHeight);

  const firstRendered = Math.max(0, firstVisibleRow - overscan);
  const lastRenderedExclusive = firstVisibleRow + spanned + overscan;

  const limit = rowCount ?? Number.POSITIVE_INFINITY;
  const visibleRowCount = Math.max(0, Math.min(firstVisibleRow + spanned, limit) - firstVisibleRow);
  const renderedRowCount = Math.max(0, Math.min(lastRenderedExclusive, limit) - firstRendered);

  return {
    firstVisibleRow,
    visibleRowCount,
    firstRenderedRow: firstRendered,
    renderedRowCount,
    offsetY: firstRendered * rowHeight - scrollTop,
  };
};

export const maxScrollTop = (
  rowCount: number | null,
  rowHeight: number,
  bodyHeight: number,
): number => {
  if (rowCount === null) return Number.POSITIVE_INFINITY;
  return Math.max(0, rowCount * rowHeight - Math.max(0, bodyHeight));
};

export const clampScrollTop = (
  scrollTop: number,
  rowCount: number | null,
  rowHeight: number,
  bodyHeight: number,
): number => clamp(scrollTop, 0, maxScrollTop(rowCount, rowHeight, bodyHeight));

export const clampScrollLeft = (
  scrollLeft: number,
  layout: ColumnLayout,
  bodyWidth: number,
): number => clamp(scrollLeft, 0, maxScrollLeft(layout, bodyWidth));

/**
 * The viewport description shared with the data worker and the performance
 * overlay. Deliberately coarse-grained: one message per meaningful change,
 * never one per frame of a smooth scroll.
 */
export interface TableViewport {
  readonly firstVisibleRow: number;
  readonly visibleRowCount: number;
  readonly firstVisibleColumn: number;
  readonly visibleColumns: readonly EntityId[];
  readonly verticalPixelOffset: number;
  readonly horizontalPixelOffset: number;
  readonly velocityY: number;
}

export interface ViewportInput {
  readonly metrics: TableChromeMetrics;
  readonly layout: ColumnLayout;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowCount: number | null;
  readonly velocityY: number;
  readonly rowOverscan?: number;
  readonly columnOverscan?: number;
}

export interface ViewportResult {
  readonly rows: RowWindow;
  readonly columns: ReturnType<typeof computeColumnWindow>;
  readonly viewport: TableViewport;
}

export const computeViewport = (input: ViewportInput): ViewportResult => {
  const rows = computeRowWindow({
    scrollTop: input.scrollTop,
    rowHeight: input.metrics.rowHeight,
    bodyHeight: input.metrics.bodyHeight,
    rowCount: input.rowCount,
    ...(input.rowOverscan === undefined ? {} : { overscan: input.rowOverscan }),
  });
  const columns = computeColumnWindow(
    input.layout,
    input.scrollLeft,
    input.metrics.bodyWidth,
    input.columnOverscan,
  );
  return {
    rows,
    columns,
    viewport: {
      firstVisibleRow: rows.firstVisibleRow,
      visibleRowCount: rows.visibleRowCount,
      firstVisibleColumn: columns.first,
      visibleColumns: columns.placements.map((placement) => placement.id),
      verticalPixelOffset: input.scrollTop,
      horizontalPixelOffset: input.scrollLeft,
      velocityY: input.velocityY,
    },
  };
};

/** True when two viewports would produce the same data requirements. */
export const sameDataRequirements = (a: TableViewport, b: TableViewport): boolean =>
  a.firstVisibleRow === b.firstVisibleRow &&
  a.visibleRowCount === b.visibleRowCount &&
  a.firstVisibleColumn === b.firstVisibleColumn &&
  a.visibleColumns.length === b.visibleColumns.length &&
  Math.sign(a.velocityY) === Math.sign(b.velocityY);
