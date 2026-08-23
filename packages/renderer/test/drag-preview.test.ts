import { describe, expect, it } from 'vitest';
import type { DragState, EntityId, ResizeHandle } from '@panorama/core';
import { DEFAULT_CONSTRAINTS } from '@panorama/core';
import {
  previewColumnWidth,
  previewColumns,
  previewEntity,
  previewTransform,
} from '@panorama/renderer';
import { makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds(), {
  position: { x: 100, y: 50, z: 0 },
  size: { width: 600, height: 400 },
});
const columnId = (table.columns[1] as { id: EntityId }).id;
const at = (x: number, y: number) => ({ x, y });

const moveDrag: DragState = {
  kind: 'move-entity',
  entityId: table.id,
  pointerStart: { x: 200, y: 100, z: 0 },
  entityStart: { x: 100, y: 50, z: 0 },
};

const resizeDrag = (handle: ResizeHandle): DragState => ({
  kind: 'resize-entity',
  entityId: table.id,
  handle,
  pointerStart: { x: 700, y: 450, z: 0 },
  entityStart: { x: 100, y: 50, z: 0 },
  widthStart: 600,
  heightStart: 400,
});

describe('previewTransform', () => {
  it('returns the committed transform when nothing is dragging', () => {
    expect(previewTransform(table, null, at(0, 0))).toBe(table.transform);
    expect(previewTransform(table, moveDrag, null)).toBe(table.transform);
  });

  it('follows the pointer while moving', () => {
    const transform = previewTransform(table, moveDrag, at(260, 130));
    expect(transform).toMatchObject({ x: 160, y: 80 });
  });

  it('ignores drags addressed to another entity', () => {
    const other: DragState = { ...moveDrag, entityId: 'table:other' as EntityId };
    expect(previewTransform(table, other, at(300, 300))).toBe(table.transform);
    const otherResize: DragState = {
      ...resizeDrag('right'),
      entityId: 'table:x' as EntityId,
    } as DragState;
    expect(previewTransform(table, otherResize, at(0, 0))).toBe(table.transform);
  });

  it('resizes from the bottom-right corner', () => {
    const transform = previewTransform(table, resizeDrag('bottom-right'), at(800, 550));
    expect(transform).toMatchObject({ x: 100, y: 50, width: 700, height: 500 });
  });

  it('resizes from the top-left corner, moving the origin', () => {
    const transform = previewTransform(table, resizeDrag('top-left'), at(600, 350));
    expect(transform).toMatchObject({ x: 0, y: -50, width: 700, height: 500 });
  });

  it('constrains single-axis handles', () => {
    expect(previewTransform(table, resizeDrag('right'), at(800, 900))).toMatchObject({
      width: 700,
      height: 400,
    });
    expect(previewTransform(table, resizeDrag('bottom'), at(900, 500))).toMatchObject({
      width: 600,
      height: 450,
    });
    expect(previewTransform(table, resizeDrag('left'), at(600, 500))).toMatchObject({
      x: 0,
      width: 700,
    });
    expect(previewTransform(table, resizeDrag('top'), at(600, 350))).toMatchObject({
      y: -50,
      height: 500,
    });
  });

  it('stops at the minimum size and holds the anchored edge still', () => {
    const transform = previewTransform(table, resizeDrag('top-left'), at(2_000, 2_000));
    expect(transform.width).toBe(DEFAULT_CONSTRAINTS.minTableWidth);
    expect(transform.height).toBe(DEFAULT_CONSTRAINTS.minTableHeight);
    // The bottom-right corner did not move.
    expect(transform.x + transform.width).toBe(700);
    expect(transform.y + transform.height).toBe(450);
  });

  it('leaves the transform alone for column drags', () => {
    const drag: DragState = {
      kind: 'resize-column',
      entityId: table.id,
      columnId,
      pointerStart: { x: 0, y: 0, z: 0 },
      widthStart: 100,
    };
    expect(previewTransform(table, drag, at(500, 0))).toBe(table.transform);
  });
});

describe('previewColumnWidth', () => {
  const drag: DragState = {
    kind: 'resize-column',
    entityId: table.id,
    columnId,
    pointerStart: { x: 300, y: 0, z: 0 },
    widthStart: 120,
  };

  it('follows the pointer', () => {
    expect(previewColumnWidth(drag, at(360, 0), columnId, 120)).toBe(180);
  });

  it('clamps to the column limits', () => {
    expect(previewColumnWidth(drag, at(-1e6, 0), columnId, 120)).toBe(
      DEFAULT_CONSTRAINTS.minColumnWidth,
    );
    expect(previewColumnWidth(drag, at(1e6, 0), columnId, 120)).toBe(
      DEFAULT_CONSTRAINTS.maxColumnWidth,
    );
  });

  it('ignores other columns and other gestures', () => {
    expect(previewColumnWidth(drag, at(360, 0), 'column:other', 120)).toBe(120);
    expect(previewColumnWidth(null, at(360, 0), columnId, 120)).toBe(120);
    expect(previewColumnWidth(drag, null, columnId, 120)).toBe(120);
    expect(previewColumnWidth(moveDrag, at(360, 0), columnId, 120)).toBe(120);
  });
});

describe('previewColumns and previewEntity', () => {
  const drag: DragState = {
    kind: 'resize-column',
    entityId: table.id,
    columnId,
    pointerStart: { x: 300, y: 0, z: 0 },
    widthStart: 120,
  };

  it('applies a column drag to the entity', () => {
    const preview = previewColumns(table, drag, at(400, 0));
    expect(preview.columns[1]?.width).toBe(220);
    expect(preview.columns[0]).toBe(table.columns[0]);
  });

  it('returns the same entity when no column drag applies', () => {
    expect(previewColumns(table, null, at(0, 0))).toBe(table);
    expect(previewColumns(table, moveDrag, at(0, 0))).toBe(table);
    expect(previewColumns(table, { ...drag, entityId: 'table:other' as EntityId }, at(0, 0))).toBe(
      table,
    );
  });

  it('combines transform and column previews', () => {
    expect(previewEntity(table, null, null)).toBe(table);
    const moved = previewEntity(table, moveDrag, at(260, 130));
    expect(moved.transform).toMatchObject({ x: 160, y: 80 });
    const resized = previewEntity(table, drag, at(400, 0));
    expect(resized.columns[1]?.width).toBe(220);
    expect(resized.transform).toBe(table.transform);
  });
});
