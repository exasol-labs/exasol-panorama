import type { EntityId, TableColumnView, TableEntity } from '@panorama/core';
import { ROW_NUMBER_GUTTER_WIDTH } from '@panorama/core';

/**
 * Horizontal layout and hit testing.
 *
 * Row virtualization alone is not enough: a relation may have thousands of
 * columns, so the first visible column is found by binary search over prefix
 * offsets rather than by scanning.
 */

export interface ColumnPlacement {
  readonly id: EntityId;
  /** Index within the table's visible columns. */
  readonly index: number;
  /** Index within `TableEntity.columns`, including hidden ones. */
  readonly sourceIndex: number;
  readonly x: number;
  readonly width: number;
  readonly column: TableColumnView;
}

export interface ColumnLayout {
  readonly placements: readonly ColumnPlacement[];
  readonly totalWidth: number;
}

export const computeColumnLayout = (columns: readonly TableColumnView[]): ColumnLayout => {
  const placements: ColumnPlacement[] = [];
  let x = 0;
  columns.forEach((column, sourceIndex) => {
    if (!column.visible) return;
    placements.push({
      id: column.id,
      index: placements.length,
      sourceIndex,
      x,
      width: column.width,
      column,
    });
    x += column.width;
  });
  return { placements, totalWidth: x };
};

/** Index of the last placement whose `x` is `<= offset`, or 0 when empty. */
const findPlacementIndex = (layout: ColumnLayout, offset: number): number => {
  const { placements } = layout;
  let low = 0;
  let high = placements.length - 1;
  let result = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const placement = placements[middle] as ColumnPlacement;
    if (placement.x <= offset) {
      result = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return result;
};

export interface ColumnWindow {
  readonly first: number;
  readonly count: number;
  readonly placements: readonly ColumnPlacement[];
}

/**
 * Columns intersecting `[scrollLeft, scrollLeft + viewWidth)` plus a buffer on
 * each side. Only these need text layout and GPU data.
 */
export const computeColumnWindow = (
  layout: ColumnLayout,
  scrollLeft: number,
  viewWidth: number,
  overscan = 1,
): ColumnWindow => {
  const { placements } = layout;
  if (placements.length === 0 || viewWidth <= 0) {
    return { first: 0, count: 0, placements: [] };
  }
  const left = Math.max(0, scrollLeft);
  const right = left + viewWidth;
  const startIndex = findPlacementIndex(layout, left);
  let endIndex = startIndex;
  while (
    endIndex + 1 < placements.length &&
    (placements[endIndex] as ColumnPlacement).x + (placements[endIndex] as ColumnPlacement).width <
      right
  ) {
    endIndex += 1;
  }
  const first = Math.max(0, startIndex - overscan);
  const last = Math.min(placements.length - 1, endIndex + overscan);
  return { first, count: last - first + 1, placements: placements.slice(first, last + 1) };
};

export const maxScrollLeft = (layout: ColumnLayout, viewWidth: number): number =>
  Math.max(0, layout.totalWidth - Math.max(0, viewWidth));

/** The column under a horizontal offset in content space, if any. */
export const columnAtOffset = (layout: ColumnLayout, offset: number): ColumnPlacement | null => {
  if (layout.placements.length === 0 || offset < 0 || offset >= layout.totalWidth) return null;
  // Placements are contiguous, so the search result always contains the offset.
  return layout.placements[findPlacementIndex(layout, offset)] as ColumnPlacement;
};

/**
 * The column whose trailing edge is within `tolerance` of `offset`. This is the
 * resize target; the trailing edge is used so the gesture matches every other
 * spreadsheet.
 */
export const columnEdgeAtOffset = (
  layout: ColumnLayout,
  offset: number,
  tolerance = 4,
): ColumnPlacement | null => {
  for (const placement of layout.placements) {
    const edge = placement.x + placement.width;
    if (Math.abs(edge - offset) <= tolerance) return placement;
    if (placement.x - tolerance > offset) break;
  }
  return null;
};

export interface TableChromeMetrics {
  /** Width of the pinned result-position gutter. */
  readonly gutterWidth: number;
  readonly headerHeight: number;
  readonly rowHeight: number;
  /** Width available for scrolling cells. */
  readonly bodyWidth: number;
  /** Height available for rows. */
  readonly bodyHeight: number;
}

export const tableChromeMetrics = (
  entity: TableEntity,
  gutterWidth = ROW_NUMBER_GUTTER_WIDTH,
): TableChromeMetrics => ({
  gutterWidth,
  headerHeight: entity.view.headerHeight,
  rowHeight: entity.view.rowHeight,
  bodyWidth: Math.max(0, entity.transform.width - gutterWidth),
  bodyHeight: Math.max(0, entity.transform.height - entity.view.headerHeight),
});
