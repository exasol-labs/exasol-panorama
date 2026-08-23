import type { EntityActionId, EntityId, ResizeHandle, TableEntity } from '@panorama/core';
import type { ColumnLayout, ColumnPlacement } from '@panorama/table';
import { columnAtOffset, columnEdgeAtOffset } from '@panorama/table';
import type { TableTheme } from '../theme.js';
import { tableMetrics } from '../table/table-draw.js';
import type { HaloButton } from '../table/halo.js';
import { computeHalo, haloButtonAt } from '../table/halo.js';

/**
 * Hit testing.
 *
 * Interaction must be unambiguous: dragging the title moves the table,
 * dragging a column separator resizes a column, dragging the border resizes
 * the table, and the body scrolls. This module decides which, from geometry
 * alone, so the decision is testable without a browser.
 */

export interface TableHitBase {
  readonly tableId: EntityId;
  readonly cursor: string;
}

export interface TitleHit extends TableHitBase {
  readonly kind: 'title';
}

export interface HeaderHit extends TableHitBase {
  readonly kind: 'header';
  readonly column: ColumnPlacement | null;
}

export interface ColumnResizeHit extends TableHitBase {
  readonly kind: 'column-resize';
  readonly column: ColumnPlacement;
}

export interface BodyHit extends TableHitBase {
  readonly kind: 'body';
  readonly row: number;
  readonly column: ColumnPlacement | null;
}

export interface GutterHit extends TableHitBase {
  readonly kind: 'gutter';
  readonly row: number;
}

export interface EntityResizeHit extends TableHitBase {
  readonly kind: 'resize';
  readonly handle: ResizeHandle;
}

export interface ScrollbarHit extends TableHitBase {
  readonly kind: 'scrollbar';
  readonly axis: 'vertical' | 'horizontal';
}

export interface HaloHit extends TableHitBase {
  readonly kind: 'halo';
  readonly action: EntityActionId;
  readonly button: HaloButton;
}

export type TableHit =
  | HaloHit
  | TitleHit
  | HeaderHit
  | ColumnResizeHit
  | BodyHit
  | GutterHit
  | EntityResizeHit
  | ScrollbarHit;

export interface TableHitInput {
  readonly entity: TableEntity;
  readonly layout: ColumnLayout;
  readonly theme: TableTheme;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowCount: number | null;
  readonly gutterWidth?: number;
  /** Widens the grab zones when the camera is zoomed out. */
  readonly scale?: number;
  /** The halo is only hit-testable while the table is activated. */
  readonly showHalo?: boolean;
}

const RESIZE_CURSORS: Readonly<Record<ResizeHandle, string>> = Object.freeze({
  top: 'ns-resize',
  bottom: 'ns-resize',
  left: 'ew-resize',
  right: 'ew-resize',
  'top-left': 'nwse-resize',
  'top-right': 'nesw-resize',
  'bottom-left': 'nesw-resize',
  'bottom-right': 'nwse-resize',
});

const resizeHandleAt = (
  localX: number,
  localY: number,
  width: number,
  height: number,
  margin: number,
): ResizeHandle | null => {
  const left = localX <= margin;
  const right = localX >= width - margin;
  const top = localY <= margin;
  const bottom = localY >= height - margin;
  if (top && left) return 'top-left';
  if (top && right) return 'top-right';
  if (bottom && left) return 'bottom-left';
  if (bottom && right) return 'bottom-right';
  if (top) return 'top';
  if (bottom) return 'bottom';
  if (left) return 'left';
  if (right) return 'right';
  return null;
};

/**
 * Resolves a point in table-local coordinates to an interaction target.
 * Returns `null` when the point is outside the table.
 */
export const hitTestTable = (
  input: TableHitInput,
  localX: number,
  localY: number,
): TableHit | null => {
  const { entity, theme, layout } = input;
  const width = entity.transform.width;
  const height = entity.transform.height;
  const tableId = entity.id;
  const metrics = tableMetrics(entity, layout, input.rowCount, theme, input.gutterWidth);

  // The halo sits outside the table's own rectangle, so it is tested before the
  // bounds check rather than after it.
  if (input.showHalo === true) {
    const button = haloButtonAt(computeHalo(metrics, theme, input.scale ?? 1), localX, localY);
    if (button !== null) {
      return { kind: 'halo', action: button.action, button, tableId, cursor: 'pointer' };
    }
  }

  if (localX < 0 || localY < 0 || localX >= width || localY >= height) return null;
  const { gutterWidth, headerHeight, rowHeight, bodyWidth, bodyHeight } = metrics;
  // Grab zones are specified in screen pixels, so they stay usable when zoomed out.
  const scale = input.scale ?? 1;
  const margin = theme.resizeMargin / Math.max(0.2, scale);

  // Resizing wins over everything: its zone is the outermost few pixels.
  const handle = resizeHandleAt(localX, localY, width, height, margin);
  if (handle !== null) {
    return { kind: 'resize', handle, tableId, cursor: RESIZE_CURSORS[handle] };
  }

  // The bars sit just outside the body box, so their zones follow from it.
  if (metrics.verticalScrollbar && localX >= gutterWidth + bodyWidth && localY >= headerHeight) {
    return { kind: 'scrollbar', axis: 'vertical', tableId, cursor: 'default' };
  }
  if (metrics.horizontalScrollbar && localY >= headerHeight + bodyHeight && localX >= gutterWidth) {
    return { kind: 'scrollbar', axis: 'horizontal', tableId, cursor: 'default' };
  }

  if (localY < metrics.titleHeight) {
    return { kind: 'title', tableId, cursor: 'grab' };
  }

  const contentX = localX - gutterWidth + input.scrollLeft;
  if (localY < headerHeight) {
    if (localX >= gutterWidth) {
      const edge = columnEdgeAtOffset(layout, contentX, theme.resizeMargin / Math.max(0.2, scale));
      if (edge !== null) {
        return { kind: 'column-resize', column: edge, tableId, cursor: 'col-resize' };
      }
    }
    return {
      kind: 'header',
      column: localX < gutterWidth ? null : columnAtOffset(layout, contentX),
      tableId,
      cursor: 'default',
    };
  }

  const row = Math.floor((localY - headerHeight + input.scrollTop) / rowHeight);
  if (localX < gutterWidth) {
    return { kind: 'gutter', row, tableId, cursor: 'default' };
  }
  return {
    kind: 'body',
    row,
    column: columnAtOffset(layout, contentX),
    tableId,
    cursor: 'default',
  };
};

/** Converts a world point into a table's local coordinate space. */
export const toTableLocal = (
  entity: TableEntity,
  worldX: number,
  worldY: number,
): { x: number; y: number } => ({
  x: worldX - entity.transform.x,
  y: worldY - entity.transform.y,
});
