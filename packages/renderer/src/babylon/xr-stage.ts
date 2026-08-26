import { TransformNode } from '@babylonjs/core/Meshes/transformNode.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { Scene } from '@babylonjs/core/scene.js';
import { toBabylonY } from './scene.js';

/**
 * Placing the canvas in a room.
 *
 * Panorama's world is measured in pixels: a table is 550 units wide because a
 * table is 550 pixels wide. Taken into a headset unchanged that is 550 *metres*,
 * and the user stands inside a letterform. So in XR the whole scene hangs from
 * one node that shrinks it to human scale and stands it up in front of the
 * viewer, like a screen on a wall.
 *
 * The node is identity on the desktop, so nothing about the 2D path changes and
 * the geometry is built exactly once either way.
 */

/**
 * Metres per world unit in XR. Chosen so a comfortable desktop viewport — about
 * a thousand pixels — becomes a panel a little over two metres wide, which at
 * arm's length fills the view the way a large monitor does.
 */
export const XR_METRES_PER_UNIT = 0.0022;

/** How far in front of the viewer the panel stands, in metres. */
export const XR_PANEL_DISTANCE = 2.4;

/**
 * Height of the panel's centre above the floor, in metres. A little below
 * standing eye level, so the top of a tall table does not run off overhead.
 */
export const XR_PANEL_HEIGHT = 1.4;

export interface XrPlacement {
  readonly scale: number;
  readonly position: { readonly x: number; readonly y: number; readonly z: number };
}

/**
 * Where the root has to sit for a given world point to appear at the centre of
 * the panel. Pure, so the arithmetic is testable without a headset — which is
 * the only way most of this can be checked at all.
 */
export const placementFor = (
  centre: { x: number; y: number },
  options: {
    metresPerUnit?: number;
    distance?: number;
    height?: number;
  } = {},
): XrPlacement => {
  const scale = options.metresPerUnit ?? XR_METRES_PER_UNIT;
  const distance = options.distance ?? XR_PANEL_DISTANCE;
  const height = options.height ?? XR_PANEL_HEIGHT;
  // A world point maps to `position + scale * (x, toBabylonY(y), z)`, so solving
  // for the position that puts `centre` on the panel's axis is a subtraction.
  return {
    scale,
    position: {
      x: -scale * centre.x,
      y: height - scale * toBabylonY(centre.y),
      z: distance,
    },
  };
};

/** The node every drawn mesh hangs from, so one transform moves the whole world. */
export class XrStage {
  readonly root: TransformNode;

  constructor(scene: Scene) {
    this.root = new TransformNode('panorama-stage', scene);
  }

  /** Shrinks the world and stands it in front of the viewer. */
  place(centre: { x: number; y: number }, options: Parameters<typeof placementFor>[1] = {}): void {
    const { scale, position } = placementFor(centre, options);
    this.root.scaling.set(scale, scale, scale);
    this.root.position.set(position.x, position.y, position.z);
  }

  /** Back to the desktop: the world is its own size again, where it was. */
  reset(): void {
    this.root.scaling.set(1, 1, 1);
    this.root.position.set(0, 0, 0);
  }

  get placed(): boolean {
    return this.root.scaling.x !== 1;
  }

  dispose(): void {
    this.root.dispose();
  }
}

/** Exposed for the test that pins the mapping to Babylon's own vector maths. */
export const worldToStagePoint = (
  placement: XrPlacement,
  point: { x: number; y: number; z?: number },
): Vector3 =>
  new Vector3(
    placement.position.x + placement.scale * point.x,
    placement.position.y + placement.scale * toBabylonY(point.y),
    placement.position.z + placement.scale * (point.z ?? 0),
  );
