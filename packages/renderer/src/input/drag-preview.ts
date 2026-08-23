import type { DragState, EntityTransform, TableEntity, WorldConstraints } from '@panorama/core';
import { DEFAULT_CONSTRAINTS, clamp } from '@panorama/core';

/**
 * Live drag previews.
 *
 * A drag must not append a commit per pointer move: the history graph would
 * fill with noise. Instead the *session* holds the drag (start pointer, start
 * transform) and the renderer derives the live geometry from it; one semantic
 * command is dispatched when the pointer is released.
 */

export interface PointerWorld {
  readonly x: number;
  readonly y: number;
}

const resizeAxis = (
  start: number,
  size: number,
  delta: number,
  edge: 'start' | 'end' | 'none',
  min: number,
  max: number,
): { position: number; size: number } => {
  if (edge === 'none') return { position: start, size };
  if (edge === 'end') return { position: start, size: clamp(size + delta, min, max) };
  const end = start + size;
  const nextSize = clamp(size - delta, min, max);
  return { position: end - nextSize, size: nextSize };
};

const horizontalEdge = (handle: string): 'start' | 'end' | 'none' => {
  if (handle.includes('left')) return 'start';
  if (handle.includes('right')) return 'end';
  return 'none';
};

const verticalEdge = (handle: string): 'start' | 'end' | 'none' => {
  if (handle.includes('top')) return 'start';
  if (handle.includes('bottom')) return 'end';
  return 'none';
};

/**
 * The transform an entity should be drawn with right now, accounting for any
 * drag in progress. Returns the committed transform when nothing is dragging.
 */
export const previewTransform = (
  entity: TableEntity,
  drag: DragState | null,
  pointer: PointerWorld | null,
  constraints: WorldConstraints = DEFAULT_CONSTRAINTS,
): EntityTransform => {
  if (drag === null || pointer === null) return entity.transform;
  if (drag.kind === 'move-entity') {
    if (drag.entityId !== entity.id) return entity.transform;
    return {
      ...entity.transform,
      x: drag.entityStart.x + (pointer.x - drag.pointerStart.x),
      y: drag.entityStart.y + (pointer.y - drag.pointerStart.y),
    };
  }
  if (drag.kind === 'resize-entity') {
    if (drag.entityId !== entity.id) return entity.transform;
    const horizontal = resizeAxis(
      drag.entityStart.x,
      drag.widthStart,
      pointer.x - drag.pointerStart.x,
      horizontalEdge(drag.handle),
      constraints.minTableWidth,
      constraints.maxTableWidth,
    );
    const vertical = resizeAxis(
      drag.entityStart.y,
      drag.heightStart,
      pointer.y - drag.pointerStart.y,
      verticalEdge(drag.handle),
      constraints.minTableHeight,
      constraints.maxTableHeight,
    );
    return {
      x: horizontal.position,
      y: vertical.position,
      z: entity.transform.z,
      width: horizontal.size,
      height: vertical.size,
    };
  }
  return entity.transform;
};

/** The width a column should be drawn with while its separator is dragged. */
export const previewColumnWidth = (
  drag: DragState | null,
  pointer: PointerWorld | null,
  columnId: string,
  committedWidth: number,
  constraints: WorldConstraints = DEFAULT_CONSTRAINTS,
): number => {
  if (drag === null || pointer === null) return committedWidth;
  if (drag.kind !== 'resize-column' || drag.columnId !== columnId) return committedWidth;
  return clamp(
    drag.widthStart + (pointer.x - drag.pointerStart.x),
    constraints.minColumnWidth,
    constraints.maxColumnWidth,
  );
};

/** Applies any in-flight column drag to a table, for layout and rendering. */
export const previewColumns = (
  entity: TableEntity,
  drag: DragState | null,
  pointer: PointerWorld | null,
  constraints: WorldConstraints = DEFAULT_CONSTRAINTS,
): TableEntity => {
  if (drag === null || drag.kind !== 'resize-column' || drag.entityId !== entity.id) return entity;
  return {
    ...entity,
    columns: entity.columns.map((column) =>
      column.id === drag.columnId
        ? {
            ...column,
            width: previewColumnWidth(drag, pointer, column.id, column.width, constraints),
          }
        : column,
    ),
  };
};

/** The entity as it should be drawn this frame, with every preview applied. */
export const previewEntity = (
  entity: TableEntity,
  drag: DragState | null,
  pointer: PointerWorld | null,
  constraints: WorldConstraints = DEFAULT_CONSTRAINTS,
): TableEntity => {
  const withColumns = previewColumns(entity, drag, pointer, constraints);
  const transform = previewTransform(withColumns, drag, pointer, constraints);
  return transform === withColumns.transform ? withColumns : { ...withColumns, transform };
};
