import { afterEach, describe, expect, it, vi } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial.js';
import type { Scene } from '@babylonjs/core/scene.js';
import type { EntityId, TableEntity } from '@panorama/core';
import { PanoramaCore, buildTableEntity, isEntityActivated } from '@panorama/core';
import type { TextSystem, TableViewModel } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  GlyphAtlas,
  PanoramaRenderer,
  buildTableDrawList,
  toBabylonY,
} from '@panorama/renderer';
import { TEST_CONNECTION, dataView, makeTable, testIds, testRasterizer } from './fixtures.js';

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

  it('turns off the interaction features its geometry cannot answer', () => {
    // Every quad is `isPickable = false` and each batch is a single mesh, so a
    // controller ray could only ever hit "the table layer". Left on, these
    // features also pull in modules that are not registered under deep ES
    // imports, and Babylon fails the whole initialisation.
    const harness = setup();
    expect(harness.renderer.scene.scene.meshes.every((mesh) => !mesh.isPickable)).toBe(true);
  });

  it('hangs everything it draws from one node, so XR is a transform', () => {
    const harness = setup();
    harness.renderer.renderFrame(16);
    const parents = harness.renderer.scene.scene.meshes.map((mesh) => mesh.parent?.name);
    expect(parents.length).toBeGreaterThan(0);
    expect(parents.every((name) => name === 'panorama-stage')).toBe(true);
    // And it starts life on the desktop, at its own size.
    expect(harness.renderer.inXR).toBe(false);
  });

  it('probes for a headset once and remembers the answer', async () => {
    const harness = setup();
    const module = await import('@babylonjs/core/XR/webXRDefaultExperience.js');
    const create = vi.spyOn(module.WebXRDefaultExperience, 'CreateAsync');
    create.mockClear();

    await expect(harness.renderer.prepareXR()).resolves.toBe(false);
    const afterFirst = create.mock.calls.length;
    await expect(harness.renderer.prepareXR()).resolves.toBe(false);
    // Support does not change while the page is open, and the probe is on the
    // path of a click that has a user-activation deadline.
    expect(create.mock.calls.length).toBe(afterFirst);
  });

  /**
   * Found by the installability probe: building the XR experience fetched a
   * controller profile list from a third-party host, on every page load, and
   * failed with no network. An installed application asks nobody's server for
   * anything before it has been asked to.
   */
  it('takes controller profiles from the bundle and not from the internet', async () => {
    const harness = setup();
    const module = await import('@babylonjs/core/XR/webXRDefaultExperience.js');
    const create = vi.spyOn(module.WebXRDefaultExperience, 'CreateAsync');
    await harness.renderer.prepareXR();
    expect(create).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        inputOptions: { disableOnlineControllerRepository: true },
      }),
    );
  });

  it('leaves the world on the desk when a session will not start', async () => {
    const harness = setup();
    await expect(harness.renderer.enterXR()).resolves.toBeNull();
    expect(harness.renderer.inXR).toBe(false);
  });

  /**
   * There is no headset in Node, so the only way to cover entering one is to
   * stand in for Babylon's experience. What is being checked is Panorama's own
   * half: that it asks to enter, shrinks the world, and puts it back.
   */
  const withFakeHeadset = async (
    options: { supported?: boolean; enterFails?: boolean } = {},
  ): Promise<{ listeners: Array<(state: number) => void>; entered: string[] }> => {
    const listeners: Array<(state: number) => void> = [];
    const entered: string[] = [];
    const module = await import('@babylonjs/core/XR/webXRDefaultExperience.js');
    vi.spyOn(module.WebXRDefaultExperience, 'CreateAsync').mockResolvedValue({
      baseExperience: {
        sessionManager: {
          isSessionSupportedAsync: async (): Promise<boolean> => options.supported ?? true,
        },
        onStateChangedObservable: {
          add: (listener: (state: number) => void): void => {
            listeners.push(listener);
          },
        },
        enterXRAsync: async (mode: string, space: string): Promise<void> => {
          if (options.enterFails === true) throw new Error('session refused');
          entered.push(`${mode}/${space}`);
        },
      },
    } as never);
    return { listeners, entered };
  };

  it('enters immersive VR and stands the world in front of the viewer', async () => {
    const harness = setup();
    const { entered } = await withFakeHeadset();

    await expect(harness.renderer.prepareXR()).resolves.toBe(true);
    expect(await harness.renderer.enterXR()).not.toBeNull();
    // Creating the experience is not entering it; Babylon waits to be asked.
    expect(entered).toEqual(['immersive-vr/local-floor']);
    expect(harness.renderer.inXR).toBe(true);
  });

  it('puts the world back on the desk when the headset comes off', async () => {
    const harness = setup();
    const { listeners } = await withFakeHeadset();
    const { WebXRState } = await import('@babylonjs/core/XR/webXRTypes.js');
    await harness.renderer.enterXR();
    expect(harness.renderer.inXR).toBe(true);

    for (const listener of listeners) listener(WebXRState.NOT_IN_XR);
    expect(harness.renderer.inXR).toBe(false);
  });

  it('does not shrink the world when the session is refused', async () => {
    const harness = setup();
    await withFakeHeadset({ enterFails: true });
    await expect(harness.renderer.enterXR()).resolves.toBeNull();
    // Otherwise the desktop would be left rendering a world 0.2% of its size.
    expect(harness.renderer.inXR).toBe(false);
  });

  it('reports a browser that has WebXR but no immersive headset', async () => {
    const harness = setup();
    await withFakeHeadset({ supported: false });
    await expect(harness.renderer.prepareXR()).resolves.toBe(false);
    await expect(harness.renderer.enterXR()).resolves.toBeNull();
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

describe('the renderer and the statistics panels', () => {
  const summary = {
    column: 'COUNTRY',
    rows: 100,
    nulls: 0,
    basis: 'exact',
    distinct: 2,
    frequencies: [
      { value: 'DE', count: 60 },
      { value: 'US', count: 40 },
    ],
    frequenciesComplete: true,
  } as const;

  const setupWithSummaries = (): {
    readonly core: PanoramaCore;
    readonly renderer: PanoramaRenderer;
    readonly engine: NullEngine;
    readonly table: TableEntity;
    readonly asked: EntityId[];
  } => {
    const ids = testIds();
    const core = new PanoramaCore({ ids });
    const table = makeTable(ids, {
      position: { x: 0, y: 0, z: 0 },
      size: { width: 600, height: 400 },
    });
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const stored = core.world.entities.get(table.id) as TableEntity;
    const engine = new NullEngine();
    const asked: EntityId[] = [];
    const renderer = new PanoramaRenderer({
      core,
      engine,
      views: {
        viewFor: () => ({ scrollTop: 0, scrollLeft: 0, rowCount: 100, data: dataView() }),
        columnSummariesFor: (entity) => {
          asked.push(entity.id);
          const first = entity.columns[0];
          return first === undefined ? undefined : new Map([[first.id, { summary }]]);
        },
      },
      createTextSystem: createTestTextSystem({ count: 0 }),
      atlasSize: 256,
    });
    renderer.resize(1_000, 800);
    created.push({ core, renderer, engine, table: stored, uploads: { count: 0 } });
    return { core, renderer, engine, table: stored, asked };
  };

  it('draws a panel for a picked-out column and nothing for none', () => {
    const harness = setupWithSummaries();
    harness.renderer.renderFrame();
    const plain = harness.renderer.stats.quads;

    const first = harness.table.columns[0]?.id as EntityId;
    harness.core.dispatchSession({ type: 'SetSelectedColumns', ids: [first] });
    harness.renderer.renderFrame();

    expect(harness.renderer.stats.quads).toBeGreaterThan(plain);
    expect(harness.asked).toContain(harness.table.id);
  });

  it('keeps the panels out of a table parked below', () => {
    const harness = setupWithSummaries();
    const first = harness.table.columns[0]?.id as EntityId;
    harness.core.dispatchSession({ type: 'SetSelectedColumns', ids: [first] });

    const below = makeTable(testIds(2), {
      position: { x: 0, y: 460, z: 0 },
      size: { width: 600, height: 400 },
    });
    harness.core.dispatch({ type: 'CreateTableEntity', entity: below });
    harness.renderer.renderFrame();

    // Above the table, which is the only free side: a panel is opaque, and the
    // rows underneath are data.
    expect(harness.renderer.stats.quads).toBeGreaterThan(0);
    const list = buildTableDrawList({
      entity: harness.table,
      layout: harness.renderer.layoutFor(harness.table),
      theme: DEFAULT_TABLE_THEME,
      lod: 'full',
      scrollTop: 0,
      scrollLeft: 0,
      rowCount: 100,
      data: dataView(),
      selectedColumns: [first],
      columnSummaries: new Map([[first, { summary }]]),
      panelObstacles: [{ x: 0, y: 460, width: 600, height: 400 }],
    });
    expect(list.quads.some((quad) => quad.y < 0)).toBe(true);
  });
});

describe('the renderer and a chart', () => {
  const chartDrawList = {
    polygons: [{ corners: [0, 0, 10, 0, 10, 10, 10, 10] as const, color: [0, 0, 1, 1] as const }],
    texts: [
      {
        x: 2,
        y: 4,
        width: 30,
        height: 12,
        text: 'DE',
        color: [0, 0, 0, 1] as const,
        align: 'left' as const,
        fontSize: 10,
      },
    ],
  };

  const setupWithChart = (): {
    readonly core: PanoramaCore;
    readonly renderer: PanoramaRenderer;
    readonly asked: { width: number; height: number; measured: number }[];
  } => {
    const ids = testIds();
    const core = new PanoramaCore({ ids });
    const chart = buildTableEntity(ids, {
      source: {
        kind: 'chart',
        connectionId: TEST_CONNECTION,
        spec: { type: 'bar', category: 'C', values: ['V'], aggregate: 'sum' },
        label: 'S.T · Chart',
        derivedFrom: 'table:base' as EntityId,
      },
      mode: 'result',
      columns: [],
      position: { x: 0, y: 0, z: 0 },
      size: { width: 420, height: 300 },
    });
    core.dispatch({ type: 'CreateTableEntity', entity: chart });
    const engine = new NullEngine();
    const asked: { width: number; height: number; measured: number }[] = [];
    const renderer = new PanoramaRenderer({
      core,
      engine,
      views: {
        viewFor: () => null,
        chartFor: (_entity, width, height, chartMetrics) => {
          asked.push({ width, height, measured: chartMetrics.measureText('DE', 10, false) });
          return { chart: chartDrawList, note: '100 rows' };
        },
      },
      createTextSystem: createTestTextSystem({ count: 0 }),
      atlasSize: 256,
    });
    renderer.resize(1_000, 800);
    created.push({ core, renderer, engine, table: chart, uploads: { count: 0 } });
    return { core, renderer, asked };
  };

  it('draws the chart geometry, and asks for the body it will fill', () => {
    const harness = setupWithChart();
    harness.renderer.renderFrame();

    expect(harness.asked).toHaveLength(1);
    // Narrower and shorter than the box: the title bar, the padding, and the row
    // kept for the note all come off first.
    expect(harness.asked[0]?.width).toBeLessThan(420);
    expect(harness.asked[0]?.height).toBeLessThan(300 - 26);
    // And it is handed the renderer's own text metrics, not a guess.
    expect(harness.asked[0]?.measured).toBeGreaterThan(0);
    expect(harness.renderer.stats.quads).toBeGreaterThan(0);
  });

  /**
   * The defect this exists for, reported by an agent and blocking it: a chart box
   * outside the camera's view was culled before the host was ever asked to lay it
   * out, so the geometry an agent reads back — the only feedback there is on a
   * written option — was `null` for as long as anybody kept asking, while the
   * reduction said `ready`. Culling is about not *drawing*; a picture that has
   * never been laid out does not exist to be asked about.
   */
  it('lays out a chart it is not going to draw, because that is the only record of it', () => {
    const harness = setupWithChart();
    harness.renderer.renderFrame();
    const onScreen = harness.asked.length;
    expect(onScreen).toBe(1);

    // Far enough that nothing of the box, its halo or any panel is in view.
    harness.renderer.camera.moveTo(80_000, 80_000);
    harness.renderer.renderFrame();

    expect(harness.asked.length).toBe(onScreen + 1);
    // Laid out for the same rectangle it would have been drawn in: a picture
    // measured for a different box would report an overflow that is not there.
    expect(harness.asked.at(-1)).toEqual(harness.asked[0]);
    // And it genuinely was not drawn — this is not culling quietly stopping.
    expect(harness.renderer.stats.quads).toBe(0);
  });

  it('asks nothing of a host that cannot draw charts', () => {
    const ids = testIds();
    const core = new PanoramaCore({ ids });
    const table = makeTable(ids, { position: { x: 0, y: 0, z: 0 } });
    core.dispatch({ type: 'CreateTableEntity', entity: table });
    const engine = new NullEngine();
    const renderer = new PanoramaRenderer({
      core,
      engine,
      views: { viewFor: () => null },
      createTextSystem: createTestTextSystem({ count: 0 }),
      atlasSize: 256,
    });
    renderer.resize(1_000, 800);
    created.push({ core, renderer, engine, table, uploads: { count: 0 } });
    expect(() => renderer.renderFrame()).not.toThrow();
  });
});
