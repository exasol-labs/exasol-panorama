import { describe, expect, it } from 'vitest';
import type { EntityActionId, EntityId, TableEntity } from '@panorama/core';
import { PanoramaCore } from '@panorama/core';
import { computeColumnLayout } from '@panorama/table';
import type { InteractionHost, TableViewState } from '@panorama/renderer';
import {
  CameraController,
  DEFAULT_TABLE_THEME,
  InteractionController,
  computeHalo,
  tableMetrics,
} from '@panorama/renderer';
import { makeTable, testIds } from './fixtures.js';

interface Harness {
  readonly core: PanoramaCore;
  readonly camera: CameraController;
  readonly controller: InteractionController;
  readonly table: TableEntity;
  readonly scrolls: Array<{ tableId: EntityId; deltaX: number; deltaY: number }>;
  readonly fractions: Array<{ axis: string; fraction: number }>;
  screenOf(localX: number, localY: number): { screenX: number; screenY: number };
}

const setup = (
  options: {
    rowCount?: number | null;
    width?: number;
    onAction?: (entityId: EntityId, action: EntityActionId) => void;
  } = {},
): Harness => {
  const ids = testIds();
  const core = new PanoramaCore({ ids });
  const table = makeTable(ids, {
    position: { x: 0, y: 0, z: 0 },
    size: { width: options.width ?? 600, height: 400 },
  });
  core.dispatch({ type: 'CreateTableEntity', entity: table });
  const stored = core.world.entities.get(table.id) as TableEntity;

  const camera = new CameraController();
  camera.setViewport({ width: 1_000, height: 800 });
  camera.moveTo(0, 0);

  const scrolls: Harness['scrolls'] = [];
  const fractions: Harness['fractions'] = [];
  const view: TableViewState = {
    layout: computeColumnLayout(stored.columns),
    scrollTop: 0,
    scrollLeft: 0,
    rowCount: options.rowCount === undefined ? 1_000_000 : options.rowCount,
  };
  const host: InteractionHost = {
    viewOf: () => view,
    scrollBy: (tableId, deltaX, deltaY) => scrolls.push({ tableId, deltaX, deltaY }),
    scrollToFraction: (_tableId, axis, fraction) => fractions.push({ axis, fraction }),
  };

  const controller = new InteractionController({
    core,
    camera,
    host,
    theme: DEFAULT_TABLE_THEME,
    ...(options.onAction === undefined ? {} : { onAction: options.onAction }),
  });

  return {
    core,
    camera,
    controller,
    table: stored,
    scrolls,
    fractions,
    screenOf: (localX, localY) => {
      const screen = camera.worldToScreen(localX, localY);
      return { screenX: screen.x, screenY: screen.y };
    },
  };
};

describe('selection and hover', () => {
  it('selects the table under the pointer and clears on empty canvas', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(300, 200));
    expect(harness.core.session.selection).toEqual([harness.table.id]);
    expect(harness.core.session.focusedTable).toBe(harness.table.id);

    harness.controller.onPointerUp(harness.screenOf(300, 200));
    harness.controller.onPointerDown(harness.screenOf(5_000, 5_000));
    expect(harness.core.session.selection).toEqual([]);
  });

  it('tracks hover and the cursor', () => {
    const harness = setup();
    harness.controller.onPointerMove(harness.screenOf(300, 10));
    expect(harness.core.session.hovered).toBe(harness.table.id);
    expect(harness.controller.cursor).toBe('grab');

    harness.controller.onPointerMove(harness.screenOf(5_000, 5_000));
    expect(harness.core.session.hovered).toBeNull();
    expect(harness.controller.cursor).toBe('default');
  });

  it('clears pointer state when leaving the canvas', () => {
    const harness = setup();
    harness.controller.onPointerMove(harness.screenOf(300, 10));
    harness.controller.onPointerLeave();
    expect(harness.core.session.pointer).toBeNull();
    expect(harness.core.session.hovered).toBeNull();
  });

  it('picks the topmost table where they overlap', () => {
    const harness = setup();
    const ids = testIds(9);
    const second = makeTable(ids, {
      position: { x: 100, y: 100, z: 0 },
      size: { width: 400, height: 300 },
    });
    harness.core.dispatch({ type: 'CreateTableEntity', entity: second });
    expect(harness.controller.entityAt(150, 150)?.id).toBe(second.id);
    expect(harness.controller.entityAt(20, 20)?.id).toBe(harness.table.id);
    expect(harness.controller.entityAt(-50, -50)).toBeNull();
  });
});

describe('moving a table', () => {
  it('previews with session state and commits one command', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(300, 10));
    expect(harness.core.session.drag?.kind).toBe('move-entity');
    const commitsBefore = harness.core.history.commits.size;

    harness.controller.onPointerMove(harness.screenOf(400, 60));
    harness.controller.onPointerMove(harness.screenOf(500, 110));
    // Nothing was committed while dragging.
    expect(harness.core.history.commits.size).toBe(commitsBefore);
    expect(harness.core.world.entities.get(harness.table.id)?.transform.x).toBe(0);

    harness.controller.onPointerUp(harness.screenOf(500, 110));
    expect(harness.core.session.drag).toBeNull();
    expect(harness.core.history.commits.size).toBe(commitsBefore + 1);
    expect(harness.core.world.entities.get(harness.table.id)?.transform).toMatchObject({
      x: 200,
      y: 100,
    });
  });

  it('commits nothing for a click without movement', () => {
    const harness = setup();
    const commitsBefore = harness.core.history.commits.size;
    harness.controller.onPointerDown(harness.screenOf(300, 10));
    harness.controller.onPointerUp(harness.screenOf(300, 10));
    expect(harness.core.history.commits.size).toBe(commitsBefore);
  });
});

describe('resizing', () => {
  it('resizes a table on release', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(599, 399));
    expect(harness.core.session.drag?.kind).toBe('resize-entity');
    harness.controller.onPointerUp(harness.screenOf(700, 500));
    expect(harness.core.world.entities.get(harness.table.id)?.transform).toMatchObject({
      width: 701,
      height: 501,
    });
  });

  it('resizes a column on release', () => {
    const harness = setup();
    const first = harness.table.columns[0];
    if (first === undefined) throw new Error('expected columns');
    const edge = 64 + first.width;
    harness.controller.onPointerDown(harness.screenOf(edge, 30));
    expect(harness.core.session.drag?.kind).toBe('resize-column');

    harness.controller.onPointerUp(harness.screenOf(edge + 40, 30));
    const updated = harness.core.world.entities.get(harness.table.id) as TableEntity;
    expect(updated.columns[0]?.width).toBe(first.width + 40);
  });

  it('commits nothing when a column drag ends where it began', () => {
    const harness = setup();
    const first = harness.table.columns[0];
    if (first === undefined) throw new Error('expected columns');
    const edge = 64 + first.width;
    const commitsBefore = harness.core.history.commits.size;
    harness.controller.onPointerDown(harness.screenOf(edge, 30));
    harness.controller.onPointerUp(harness.screenOf(edge, 30));
    expect(harness.core.history.commits.size).toBe(commitsBefore);
  });

  it('ignores a resize whose entity vanished mid-gesture', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(599, 399));
    harness.core.dispatch({ type: 'RemoveEntities', ids: [harness.table.id] });
    const commits = harness.core.history.commits.size;
    harness.controller.onPointerUp(harness.screenOf(700, 500));
    expect(harness.core.history.commits.size).toBe(commits);
  });
});

describe('canvas panning', () => {
  it('pans the camera without touching the document', () => {
    const harness = setup();
    harness.controller.onPointerDown({ screenX: 50, screenY: 50 });
    expect(harness.core.session.drag?.kind).toBe('pan-canvas');
    const commits = harness.core.history.commits.size;

    harness.controller.onPointerMove({ screenX: 0, screenY: 0 });
    expect(harness.camera.state.centerX).toBe(50);
    expect(harness.camera.state.centerY).toBe(50);

    harness.controller.onPointerUp({ screenX: 0, screenY: 0 });
    expect(harness.core.history.commits.size).toBe(commits);
    expect(harness.core.session.drag).toBeNull();
  });

  it('does nothing on pointer up without a drag', () => {
    const harness = setup();
    expect(() => harness.controller.onPointerUp(harness.screenOf(10, 10))).not.toThrow();
  });
});

describe('wheel handling', () => {
  it('scrolls the table under the pointer', () => {
    const harness = setup();
    harness.controller.onWheel(
      { deltaX: 0, deltaY: 120, deltaMode: 0 },
      harness.screenOf(300, 200),
    );
    expect(harness.scrolls).toHaveLength(1);
    expect(harness.scrolls[0]).toMatchObject({ tableId: harness.table.id, deltaY: 120 });
  });

  it('scrolls horizontally with shift', () => {
    const harness = setup();
    harness.controller.onWheel(
      { deltaX: 0, deltaY: 90, deltaMode: 0, shiftKey: true },
      harness.screenOf(300, 200),
    );
    expect(harness.scrolls[0]).toMatchObject({ deltaX: 90, deltaY: 0 });
  });

  it('converts screen pixels into table units when zoomed', () => {
    const harness = setup();
    harness.camera.setScale(2);
    const point = harness.camera.worldToScreen(300, 200);
    harness.controller.onWheel(
      { deltaX: 0, deltaY: 100, deltaMode: 0 },
      { screenX: point.x, screenY: point.y },
    );
    expect(harness.scrolls[0]?.deltaY).toBe(50);
  });

  it('pans the canvas when the pointer is not over a table body', () => {
    const harness = setup();
    harness.controller.onWheel(
      { deltaX: 0, deltaY: 100, deltaMode: 0 },
      { screenX: 50, screenY: 50 },
    );
    expect(harness.scrolls).toHaveLength(0);
    expect(harness.camera.state.centerY).toBe(100);
  });

  it('pans rather than scrolls over the header', () => {
    const harness = setup();
    harness.controller.onWheel({ deltaX: 0, deltaY: 100, deltaMode: 0 }, harness.screenOf(300, 10));
    expect(harness.scrolls).toHaveLength(0);
  });

  it('zooms with ctrl held', () => {
    const harness = setup();
    const before = harness.camera.scale;
    const result = harness.controller.onWheel(
      { deltaX: 0, deltaY: -100, deltaMode: 0, ctrlKey: true },
      harness.screenOf(300, 200),
    );
    expect(result.zoom).toBe(true);
    expect(harness.camera.scale).toBeGreaterThan(before);
    expect(harness.scrolls).toHaveLength(0);
  });

  it('applies separate wheel and trackpad sensitivities', () => {
    const ids = testIds();
    const core = new PanoramaCore({ ids });
    const table = makeTable(ids, {
      position: { x: 0, y: 0, z: 0 },
      size: { width: 600, height: 400 },
    });
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const camera = new CameraController();
    camera.setViewport({ width: 1_000, height: 800 });
    const scrolls: number[] = [];
    const controller = new InteractionController({
      core,
      camera,
      theme: DEFAULT_TABLE_THEME,
      wheelScale: 2,
      trackpadScale: 0.5,
      host: {
        viewOf: () => ({
          layout: computeColumnLayout(table.columns),
          scrollTop: 0,
          scrollLeft: 0,
          rowCount: 1_000,
        }),
        scrollBy: (_id, _dx, dy) => scrolls.push(dy),
        scrollToFraction: () => {},
      },
    });
    const point = camera.worldToScreen(300, 200);
    const at = { screenX: point.x, screenY: point.y };
    controller.onWheel({ deltaX: 0, deltaY: 100, deltaMode: 0 }, at);
    controller.onWheel({ deltaX: 0, deltaY: 4, deltaMode: 0 }, at);
    expect(scrolls).toEqual([200, 2]);
  });
});

describe('scrollbar dragging', () => {
  it('scrolls to the dragged fraction', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(590, 200));
    expect(harness.fractions).toHaveLength(1);
    harness.controller.onPointerMove(harness.screenOf(590, 300));
    expect(harness.fractions).toHaveLength(2);
    expect(harness.fractions[1]?.fraction).toBeGreaterThan(harness.fractions[0]?.fraction ?? 0);

    harness.controller.onPointerUp(harness.screenOf(590, 300));
    harness.controller.onPointerMove(harness.screenOf(590, 350));
    expect(harness.fractions).toHaveLength(2);
  });

  it('drags the horizontal scrollbar', () => {
    const harness = setup({ width: 200 });
    // The horizontal bar sits above the bottom resize margin.
    harness.controller.onPointerDown(harness.screenOf(150, 388));
    expect(harness.fractions.at(-1)?.axis).toBe('horizontal');
    expect(harness.fractions.at(-1)?.fraction).toBeGreaterThan(0);
  });

  it('clamps the fraction to the track', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(590, 380));
    harness.controller.onPointerMove(harness.screenOf(590, 1_000));
    expect(harness.fractions.at(-1)?.fraction).toBe(1);
  });

  it('stops when the table disappears mid-drag', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(590, 200));
    harness.core.dispatch({ type: 'RemoveEntities', ids: [harness.table.id] });
    const count = harness.fractions.length;
    harness.controller.onPointerMove(harness.screenOf(590, 300));
    expect(harness.fractions).toHaveLength(count);
  });
});

describe('tables without an open data session', () => {
  it('still hit-tests using an empty layout', () => {
    const ids = testIds();
    const core = new PanoramaCore({ ids });
    const table = makeTable(ids, { position: { x: 0, y: 0, z: 0 } });
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const camera = new CameraController();
    camera.setViewport({ width: 800, height: 600 });
    const controller = new InteractionController({
      core,
      camera,
      theme: DEFAULT_TABLE_THEME,
      host: {
        viewOf: () => null,
        scrollBy: () => {},
        scrollToFraction: () => {},
      },
    });
    const point = camera.worldToScreen(300, 10);
    controller.onPointerDown({ screenX: point.x, screenY: point.y });
    expect(core.session.drag?.kind).toBe('move-entity');
    expect(controller.lastPointer).not.toBeNull();
  });
});

describe('the action halo', () => {
  const haloCentre = (harness: Harness): { screenX: number; screenY: number } => {
    const halo = computeHalo(
      tableMetrics(
        harness.table,
        computeColumnLayout(harness.table.columns),
        1_000_000,
        DEFAULT_TABLE_THEME,
      ),
      DEFAULT_TABLE_THEME,
    );
    const button = halo.buttons[0];
    if (button === undefined) throw new Error('expected a halo button');
    return harness.screenOf(button.x + button.size / 2, button.y + button.size / 2);
  };

  const activate = (harness: Harness): void => {
    harness.controller.onPointerMove(harness.screenOf(300, 200));
  };

  it('is only reachable once the table is activated', () => {
    const harness = setup();
    expect(harness.controller.entityAt(300, -20)).toBeNull();

    activate(harness);
    // Hover keeps the table activated, so the halo above it is now pickable.
    const point = haloCentre(harness);
    const world = harness.camera.screenToWorld(point.screenX, point.screenY);
    expect(harness.controller.entityAt(world.x, world.y)?.id).toBe(harness.table.id);
  });

  it('tracks the hovered action and shows a pointer cursor', () => {
    const harness = setup();
    activate(harness);
    harness.controller.onPointerMove(haloCentre(harness));

    expect(harness.core.session.hoveredAction).toEqual({
      entityId: harness.table.id,
      action: 'close',
    });
    expect(harness.controller.cursor).toBe('pointer');
    // Moving back onto the body clears it again.
    harness.controller.onPointerMove(harness.screenOf(300, 200));
    expect(harness.core.session.hoveredAction).toBeNull();
  });

  it('fires the action on release over the same button', () => {
    const actions: Array<{ id: string; action: string }> = [];
    const harness = setup({ onAction: (id, action) => actions.push({ id, action }) });
    activate(harness);
    const point = haloCentre(harness);

    harness.controller.onPointerDown(point);
    expect(harness.core.session.pressedAction).toEqual({
      entityId: harness.table.id,
      action: 'close',
    });
    // Pressing a button neither selects the table nor starts a drag.
    expect(harness.core.session.drag).toBeNull();
    expect(actions).toEqual([]);

    harness.controller.onPointerUp(point);
    expect(actions).toEqual([{ id: harness.table.id, action: 'close' }]);
    expect(harness.core.session.pressedAction).toBeNull();
  });

  it('abandons the press when released elsewhere', () => {
    const actions: string[] = [];
    const harness = setup({ onAction: (_id, action) => actions.push(action) });
    activate(harness);

    harness.controller.onPointerDown(haloCentre(harness));
    harness.controller.onPointerUp(harness.screenOf(300, 200));
    expect(actions).toEqual([]);
    expect(harness.core.session.pressedAction).toBeNull();
  });

  it('records no document command for a halo press', () => {
    const harness = setup();
    activate(harness);
    const commits = harness.core.history.commits.size;
    const point = haloCentre(harness);
    harness.controller.onPointerDown(point);
    harness.controller.onPointerUp(point);
    expect(harness.core.history.commits.size).toBe(commits);
  });

  it('works without an action handler', () => {
    const harness = setup();
    activate(harness);
    const point = haloCentre(harness);
    harness.controller.onPointerDown(point);
    expect(() => harness.controller.onPointerUp(point)).not.toThrow();
  });

  it('clears hover and press state when the pointer leaves', () => {
    const harness = setup();
    activate(harness);
    harness.controller.onPointerDown(haloCentre(harness));
    harness.controller.onPointerLeave();
    expect(harness.core.session.hoveredAction).toBeNull();
    expect(harness.core.session.pressedAction).toBeNull();
  });

  it('stays reachable for a selected table the pointer has left', () => {
    const harness = setup();
    harness.controller.onPointerDown(harness.screenOf(300, 200));
    harness.controller.onPointerUp(harness.screenOf(300, 200));
    expect(harness.core.session.selection).toEqual([harness.table.id]);

    harness.controller.onPointerMove(harness.screenOf(5_000, 5_000));
    expect(harness.core.session.hovered).toBeNull();
    // Selection alone keeps the halo available.
    harness.controller.onPointerMove(haloCentre(harness));
    expect(harness.core.session.hoveredAction?.action).toBe('close');
  });
});
