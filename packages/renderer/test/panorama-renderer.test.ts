import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { TableEntity } from '@panorama/core';
import { PanoramaCore, isEntityActivated } from '@panorama/core';
import type { TextSystem, TableViewModel } from '@panorama/renderer';
import { GlyphAtlas, PanoramaRenderer, buildTableDrawList, toBabylonY } from '@panorama/renderer';
import { dataView, makeTable, testIds, testRasterizer } from './fixtures.js';

/** A text system with deterministic metrics and no canvas. */
const createTestTextSystem = (uploads: {
  count: number;
}): ((scene: Scene, size: number) => TextSystem) => {
  return (scene, size) => ({
    atlas: new GlyphAtlas({ rasterizer: testRasterizer(), width: size, height: size }),
    material: new StandardMaterial('test-glyphs', scene),
    upload: (): void => {
      uploads.count += 1;
    },
    dispose: (): void => {},
  });
};

interface Harness {
  readonly core: PanoramaCore;
  readonly renderer: PanoramaRenderer;
  readonly engine: NullEngine;
  readonly table: TableEntity;
  readonly uploads: { count: number };
}

const created: Harness[] = [];

const setup = (options: { view?: TableViewModel | null } = {}): Harness => {
  const ids = testIds();
  const core = new PanoramaCore({ ids });
  const table = makeTable(ids, {
    position: { x: 0, y: 0, z: 0 },
    size: { width: 600, height: 400 },
  });
  core.dispatch({ type: 'CreateTableEntity', entity: table });
  const stored = core.world.entities.get(table.id) as TableEntity;

  const engine = new NullEngine();
  const uploads = { count: 0 };
  const view: TableViewModel | null =
    options.view === undefined
      ? { scrollTop: 0, scrollLeft: 0, rowCount: 1_000_000, data: dataView() }
      : options.view;

  const renderer = new PanoramaRenderer({
    core,
    engine,
    views: { viewFor: () => view },
    createTextSystem: createTestTextSystem(uploads),
    atlasSize: 256,
  });
  renderer.resize(1_000, 800);
  const harness = { core, renderer, engine, table: stored, uploads };
  created.push(harness);
  return harness;
};

afterEach(() => {
  for (const harness of created.splice(0)) {
    harness.renderer.dispose();
    harness.engine.dispose();
  }
});

describe('PanoramaRenderer', () => {
  it('draws a table into two batches', () => {
    const harness = setup();
    harness.renderer.renderFrame();
    const stats = harness.renderer.stats;

    expect(stats.tables).toBe(1);
    expect(stats.renderedRows).toBeGreaterThan(0);
    expect(stats.quads).toBeGreaterThan(0);
    expect(stats.glyphs).toBeGreaterThan(0);
    expect(stats.drawCalls).toBe(2);
    expect(harness.renderer.scene.scene.meshes).toHaveLength(2);
  });

  it('keeps GPU work proportional to visible cells, not the relation', () => {
    const small = setup({
      view: { scrollTop: 0, scrollLeft: 0, rowCount: 100, data: dataView() },
    });
    const huge = setup({
      view: { scrollTop: 0, scrollLeft: 0, rowCount: 10_000_000_000, data: dataView() },
    });
    small.renderer.renderFrame();
    huge.renderer.renderFrame();
    expect(huge.renderer.stats.quads).toBe(small.renderer.stats.quads);
    expect(huge.renderer.stats.glyphs).toBeGreaterThan(0);
  });

  it('culls tables outside the viewport', () => {
    const harness = setup();
    harness.renderer.camera.moveTo(100_000, 100_000);
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.tables).toBe(0);
    expect(harness.renderer.stats.quads).toBe(0);
    expect(harness.renderer.stats.drawCalls).toBe(0);
  });

  it('drops detail when zoomed far out', () => {
    const harness = setup();
    harness.renderer.renderFrame();
    const full = harness.renderer.stats.glyphs;
    harness.renderer.camera.setScale(0.1);
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.glyphs).toBeLessThan(full);
    expect(harness.renderer.stats.renderedRows).toBe(0);
  });

  it('uploads the atlas only when new glyphs appear', () => {
    const harness = setup();
    harness.renderer.renderFrame();
    expect(harness.uploads.count).toBe(1);
    harness.renderer.renderFrame();
    expect(harness.uploads.count).toBe(1);
  });

  it('renders tables with no open data session as empty chrome', () => {
    const harness = setup({ view: null });
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.tables).toBe(1);
    expect(harness.renderer.stats.placeholderCells).toBe(0);
    expect(harness.renderer.stats.renderedRows).toBe(0);
  });

  it('mirrors the camera onto the Babylon camera', () => {
    const harness = setup();
    harness.renderer.camera.moveTo(200, 100);
    harness.renderer.camera.setScale(2);
    harness.renderer.renderFrame();
    const camera = harness.renderer.scene.camera;
    expect(camera.position.x).toBe(200);
    expect(camera.position.y).toBe(toBabylonY(100));
    expect(camera.orthoRight).toBe(1_000 / 4);
    expect(camera.orthoTop).toBe(800 / 4);
  });

  it('memoises the column layout by column identity', () => {
    const harness = setup();
    const first = harness.renderer.layoutFor(harness.table);
    expect(harness.renderer.layoutFor(harness.table)).toBe(first);
    const changed = {
      ...harness.table,
      columns: harness.table.columns.map((column) => ({ ...column })),
    };
    expect(harness.renderer.layoutFor(changed)).not.toBe(first);
  });

  it('previews an in-flight drag without touching the document', () => {
    const harness = setup();
    harness.core.dispatchSession({
      type: 'BeginDrag',
      drag: {
        kind: 'move-entity',
        entityId: harness.table.id,
        pointerStart: { x: 0, y: 0, z: 0 },
        entityStart: { x: 0, y: 0, z: 0 },
      },
    });
    harness.core.dispatchSession({
      type: 'SetPointer',
      pointer: { world: { x: 120, y: 40, z: 0 }, screenX: 0, screenY: 0 },
    });
    expect(harness.renderer.drawnEntity(harness.table).transform).toMatchObject({
      x: 120,
      y: 40,
    });
    expect(harness.core.world.entities.get(harness.table.id)?.transform.x).toBe(0);
  });

  it('highlights the hovered row', () => {
    const harness = setup();
    harness.core.dispatchSession({ type: 'SetHovered', id: harness.table.id });
    harness.core.dispatchSession({
      type: 'SetPointer',
      pointer: { world: { x: 100, y: 120, z: 0 }, screenX: 0, screenY: 0 },
    });
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.tables).toBe(1);

    // Above the header there is no hovered row.
    harness.core.dispatchSession({
      type: 'SetPointer',
      pointer: { world: { x: 100, y: 5, z: 0 }, screenX: 0, screenY: 0 },
    });
    expect(() => harness.renderer.renderFrame()).not.toThrow();
  });

  it('skips dangling ids in the stacking order', () => {
    const harness = setup();
    const order = [...harness.core.world.order, 'table:ghost'];
    Object.defineProperty(harness.core.world, 'order', { value: order, configurable: true });
    expect(() => harness.renderer.renderFrame()).not.toThrow();
    expect(harness.renderer.stats.tables).toBe(1);
  });

  it('starts and stops the render loop once', () => {
    const harness = setup();
    const run = vi.spyOn(harness.engine, 'runRenderLoop');
    const stop = vi.spyOn(harness.engine, 'stopRenderLoop');

    harness.renderer.start();
    harness.renderer.start();
    expect(harness.renderer.running).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);

    harness.renderer.stop();
    harness.renderer.stop();
    expect(harness.renderer.running).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('runs the render loop callback', () => {
    const harness = setup();
    let loop: (() => void) | null = null;
    vi.spyOn(harness.engine, 'runRenderLoop').mockImplementation((callback) => {
      loop = callback as () => void;
    });
    harness.renderer.start();
    expect(loop).not.toBeNull();
    (loop as unknown as () => void)();
    expect(harness.renderer.stats.frames).toBeGreaterThan(0);
  });

  it('offers XR the same scene, with no DOM overlay', async () => {
    const harness = setup();
    const module = await import('@babylonjs/core/XR/webXRDefaultExperience.js');
    const create = vi.spyOn(module.WebXRDefaultExperience, 'CreateAsync');

    // Node has no WebXR device, so entering reports "not available".
    await expect(harness.renderer.enterXR()).resolves.toBeNull();
    // What matters architecturally is that XR is handed the existing scene.
    expect(create).toHaveBeenCalledWith(
      harness.renderer.scene.scene,
      expect.objectContaining({ disableDefaultUI: true }),
    );
  });

  it('reports XR as unavailable rather than throwing', async () => {
    const harness = setup();
    const module = await import('@babylonjs/core/XR/webXRDefaultExperience.js');
    vi.spyOn(module.WebXRDefaultExperience, 'CreateAsync').mockRejectedValueOnce(
      new Error('no xr device'),
    );
    await expect(harness.renderer.enterXR()).resolves.toBeNull();
  });
});

describe('PanoramaScene defaults', () => {
  it('falls back to a neutral clear colour', async () => {
    const { PanoramaScene } = await import('@panorama/renderer');
    const engine = new NullEngine();
    const scene = new PanoramaScene({ engine });
    expect(scene.scene.clearColor.a).toBe(1);
    scene.dispose();
    engine.dispose();
  });
});

describe('revealEntity', () => {
  it('does nothing when the entity is already fully visible', () => {
    const harness = setup();
    harness.renderer.camera.moveTo(300, 200);
    const before = { ...harness.renderer.camera.state };
    harness.renderer.revealEntity(harness.table.id);
    expect(harness.renderer.camera.state).toEqual(before);
  });

  it('pans just enough to bring a table on screen', () => {
    const harness = setup();
    // Push the camera far to the left of the table.
    harness.renderer.camera.moveTo(-4_000, -4_000);
    harness.renderer.revealEntity(harness.table.id, 48);

    const view = harness.renderer.camera.visibleWorldRect();
    const { x, y, width, height } = harness.table.transform;
    expect(x).toBeGreaterThanOrEqual(view.x);
    expect(y).toBeGreaterThanOrEqual(view.y);
    expect(x + width).toBeLessThanOrEqual(view.x + view.width);
    expect(y + height).toBeLessThanOrEqual(view.y + view.height);
    // The zoom is untouched: revealing must not feel like a jump cut.
    expect(harness.renderer.camera.scale).toBe(1);
  });

  it('pans back when the table is off the far edge', () => {
    const harness = setup();
    harness.renderer.camera.moveTo(4_000, 4_000);
    harness.renderer.revealEntity(harness.table.id, 48);
    const view = harness.renderer.camera.visibleWorldRect();
    expect(harness.table.transform.x).toBeGreaterThanOrEqual(view.x);
    expect(harness.table.transform.y).toBeGreaterThanOrEqual(view.y);
  });

  it('aligns a table larger than the viewport to its top-left corner', () => {
    const harness = setup();
    harness.core.dispatch({
      type: 'ResizeEntity',
      id: harness.table.id,
      width: 5_000,
      height: 4_000,
    });
    harness.renderer.camera.moveTo(9_000, 9_000);
    harness.renderer.revealEntity(harness.table.id, 40);

    const view = harness.renderer.camera.visibleWorldRect();
    expect(view.x).toBeCloseTo(-40, 6);
    expect(view.y).toBeCloseTo(-40, 6);
  });

  it('ignores unknown entities', () => {
    const harness = setup();
    const before = { ...harness.renderer.camera.state };
    harness.renderer.revealEntity('table:missing' as never);
    expect(harness.renderer.camera.state).toEqual(before);
  });
});

describe('the action halo across several tables', () => {
  /** Two tables side by side, both in view. */
  const twoTables = (): { harness: Harness; second: TableEntity } => {
    const harness = setup();
    const ids = testIds(7);
    const second = makeTable(ids, {
      position: { x: 900, y: 0, z: 0 },
      size: { width: 600, height: 400 },
    });
    harness.core.dispatch({ type: 'CreateTableEntity', entity: second });
    harness.renderer.camera.moveTo(700, 200);
    harness.renderer.camera.setScale(0.6);
    return { harness, second };
  };

  /** Counts the close icons drawn this frame — one per visible halo. */
  const haloCount = (harness: Harness): number => {
    let icons = 0;
    for (const id of harness.core.world.order) {
      const stored = harness.core.world.entities.get(id);
      if (stored === undefined) continue;
      const entity = harness.renderer.drawnEntity(stored);
      const list = buildTableDrawList({
        entity,
        layout: harness.renderer.layoutFor(entity),
        theme: harness.renderer.theme,
        lod: 'full',
        scrollTop: 0,
        scrollLeft: 0,
        rowCount: 1_000,
        data: dataView(),
        showHalo: isEntityActivated(harness.core.session, entity.id),
        scale: harness.renderer.camera.scale,
      });
      icons += list.texts.filter((run) => run.text === '×').length;
    }
    return icons;
  };

  it('draws no halo until something is activated', () => {
    const { harness } = twoTables();
    expect(haloCount(harness)).toBe(0);
  });

  it('draws exactly one halo when hovering while another table is selected', () => {
    const { harness, second } = twoTables();
    harness.core.dispatchSession({ type: 'SetSelection', ids: [harness.table.id] });
    harness.core.dispatchSession({ type: 'SetHovered', id: second.id });

    expect(haloCount(harness)).toBe(1);
    expect(isEntityActivated(harness.core.session, harness.table.id)).toBe(false);
    expect(isEntityActivated(harness.core.session, second.id)).toBe(true);
  });

  it('moves the halo with the pointer rather than leaving a trail', () => {
    const { harness, second } = twoTables();
    harness.core.dispatchSession({ type: 'SetHovered', id: harness.table.id });
    expect(haloCount(harness)).toBe(1);

    harness.core.dispatchSession({ type: 'SetHovered', id: second.id });
    expect(haloCount(harness)).toBe(1);
    expect(isEntityActivated(harness.core.session, harness.table.id)).toBe(false);
  });

  it('falls back to the selected table when the pointer leaves both', () => {
    const { harness, second } = twoTables();
    harness.core.dispatchSession({ type: 'SetSelection', ids: [harness.table.id] });
    harness.core.dispatchSession({ type: 'SetHovered', id: second.id });
    harness.core.dispatchSession({ type: 'SetHovered', id: null });

    expect(haloCount(harness)).toBe(1);
    expect(isEntityActivated(harness.core.session, harness.table.id)).toBe(true);
  });

  it('renders both tables regardless of which one is activated', () => {
    const { harness } = twoTables();
    harness.core.dispatchSession({ type: 'SetHovered', id: harness.table.id });
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.tables).toBe(2);
  });
});

describe('connectors', () => {
  const bound = (): { harness: Harness; second: TableEntity } => {
    const harness = setup();
    const ids = testIds(11);
    const second = makeTable(ids, {
      position: { x: 800, y: 0, z: 0 },
      size: { width: 600, height: 400 },
    });
    harness.core.dispatch({ type: 'CreateTableEntity', entity: second });
    harness.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: ids.binding(),
        kind: 'connector',
        fromId: harness.table.id,
        toId: second.id,
        from: { mode: 'auto' },
        to: { mode: 'auto' },
        directed: true,
        label: 'COUNTRY = Germany',
      },
    });
    harness.renderer.camera.moveTo(700, 200);
    harness.renderer.camera.setScale(0.7);
    return { harness, second };
  };

  it('draws the line and counts it', () => {
    const { harness } = bound();
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.connectors).toBe(1);
    expect(harness.renderer.stats.tables).toBe(2);
  });

  it('adds no connector work when there are no bindings', () => {
    const harness = setup();
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.connectors).toBe(0);
  });

  it('follows a table that is being dragged, before anything is committed', () => {
    const { harness, second } = bound();
    harness.renderer.renderFrame();

    harness.core.dispatchSession({
      type: 'BeginDrag',
      drag: {
        kind: 'move-entity',
        entityId: second.id,
        pointerStart: { x: 0, y: 0, z: 0 },
        entityStart: { x: 800, y: 0, z: 0 },
      },
    });
    harness.core.dispatchSession({
      type: 'SetPointer',
      pointer: { world: { x: 200, y: 600, z: 0 }, screenX: 0, screenY: 0 },
    });
    harness.renderer.renderFrame();

    // Still exactly one connector, re-routed, with the document untouched.
    expect(harness.renderer.stats.connectors).toBe(1);
    expect(harness.core.world.entities.get(second.id)?.transform.x).toBe(800);
  });

  it('draws the marker compactly, and its label only once revealed', () => {
    const { harness } = bound();
    harness.renderer.renderFrame();
    const compactGlyphs = harness.renderer.stats.glyphs;

    const bindingId = [...harness.core.world.bindings.keys()][0];
    if (bindingId === undefined) throw new Error('expected a binding');
    harness.core.dispatchSession({ type: 'SetHoveredBinding', id: bindingId });
    harness.renderer.renderFrame();

    // Revealing spells the predicate out, so more glyphs are drawn.
    expect(harness.renderer.stats.glyphs).toBeGreaterThan(compactGlyphs);
    expect(harness.renderer.stats.connectors).toBe(1);
  });

  it('culls a connector whose line is off screen', () => {
    const { harness } = bound();
    harness.renderer.camera.moveTo(500_000, 500_000);
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.connectors).toBe(0);
  });

  it('skips a binding whose entities coincide', () => {
    const harness = setup();
    const ids = testIds(12);
    const stacked = makeTable(ids, {
      position: { x: 0, y: 0, z: 0 },
      size: { width: 600, height: 400 },
    });
    harness.core.dispatch({ type: 'CreateTableEntity', entity: stacked });
    harness.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: ids.binding(),
        kind: 'connector',
        fromId: harness.table.id,
        toId: stacked.id,
        from: { mode: 'auto' },
        to: { mode: 'auto' },
        directed: true,
      },
    });
    harness.renderer.renderFrame();
    expect(harness.renderer.stats.connectors).toBe(0);
  });
});
