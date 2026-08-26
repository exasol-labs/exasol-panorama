import { describe, expect, it } from 'vitest';
import { NullEngine } from '@babylonjs/core/Engines/nullEngine.js';
import {
  PanoramaScene,
  XR_METRES_PER_UNIT,
  XR_PANEL_DISTANCE,
  XR_PANEL_HEIGHT,
  XrStage,
  placementFor,
  worldToStagePoint,
} from '@panorama/renderer';

/**
 * The XR placement maths.
 *
 * None of this can be checked in a headset from here, so the arithmetic is
 * pinned down instead: a scene in pixel units has to end up a plausible size, in
 * front of the viewer, the right way up.
 */

describe('placing the world on an XR panel', () => {
  it('puts the point the viewer was looking at straight ahead', () => {
    const centre = { x: 1_200, y: -450 };
    const placement = placementFor(centre);
    const ahead = worldToStagePoint(placement, centre);
    expect(ahead.x).toBeCloseTo(0, 9);
    expect(ahead.y).toBeCloseTo(XR_PANEL_HEIGHT, 9);
    expect(ahead.z).toBeCloseTo(XR_PANEL_DISTANCE, 9);
  });

  it('shrinks a table from pixels to something you could stand in front of', () => {
    const placement = placementFor({ x: 0, y: 0 });
    // A 550-unit table is 550 pixels on the desktop; in the headset it has to
    // be about a metre, not the length of a street.
    const left = worldToStagePoint(placement, { x: 0, y: 0 });
    const right = worldToStagePoint(placement, { x: 550, y: 0 });
    const metres = right.x - left.x;
    expect(metres).toBeGreaterThan(0.8);
    expect(metres).toBeLessThan(2);
  });

  it('keeps the world the right way up', () => {
    const placement = placementFor({ x: 0, y: 0 });
    // Panorama's +y is downwards; a row further down the table must appear
    // lower in the room, not higher.
    const top = worldToStagePoint(placement, { x: 0, y: 0 });
    const below = worldToStagePoint(placement, { x: 0, y: 200 });
    expect(below.y).toBeLessThan(top.y);
  });

  it('stands the panel in front of the viewer, above the floor', () => {
    const placement = placementFor({ x: 5_000, y: 5_000 });
    expect(placement.position.z).toBe(XR_PANEL_DISTANCE);
    expect(worldToStagePoint(placement, { x: 5_000, y: 5_000 }).y).toBeCloseTo(XR_PANEL_HEIGHT, 9);
  });

  it('can be asked for a different size and distance', () => {
    const placement = placementFor({ x: 0, y: 0 }, { metresPerUnit: 0.01, distance: 4, height: 2 });
    expect(placement.scale).toBe(0.01);
    expect(worldToStagePoint(placement, { x: 100, y: 0 }).x).toBeCloseTo(1, 9);
    expect(placement.position.z).toBe(4);
    expect(placement.position.y).toBe(2);
  });

  it('defaults to the shared constants', () => {
    expect(placementFor({ x: 0, y: 0 }).scale).toBe(XR_METRES_PER_UNIT);
  });
});

describe('XrStage', () => {
  const stage = (): { stage: XrStage; dispose: () => void } => {
    const engine = new NullEngine();
    const scene = new PanoramaScene({ engine });
    const created = new XrStage(scene.scene);
    return {
      stage: created,
      dispose: (): void => {
        created.dispose();
        scene.scene.dispose();
        engine.dispose();
      },
    };
  };

  it('is identity until the headset is entered', () => {
    const { stage: node, dispose } = stage();
    expect(node.placed).toBe(false);
    expect(node.root.scaling.x).toBe(1);
    expect(node.root.position.z).toBe(0);
    dispose();
  });

  it('shrinks and moves the world when placed', () => {
    const { stage: node, dispose } = stage();
    node.place({ x: 400, y: 300 });
    expect(node.placed).toBe(true);
    expect(node.root.scaling.x).toBeCloseTo(XR_METRES_PER_UNIT, 9);
    expect(node.root.position.z).toBeCloseTo(XR_PANEL_DISTANCE, 9);
    // Uniform, or the text would be stretched.
    expect(node.root.scaling.y).toBe(node.root.scaling.x);
    expect(node.root.scaling.z).toBe(node.root.scaling.x);
    dispose();
  });

  it('puts the world back on the desk when the headset comes off', () => {
    const { stage: node, dispose } = stage();
    node.place({ x: 400, y: 300 });
    node.reset();
    expect(node.placed).toBe(false);
    expect(node.root.scaling.asArray()).toEqual([1, 1, 1]);
    expect(node.root.position.asArray()).toEqual([0, 0, 0]);
    dispose();
  });
});
