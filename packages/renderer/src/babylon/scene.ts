import { Scene } from '@babylonjs/core/scene.js';
import { FreeCamera } from '@babylonjs/core/Cameras/freeCamera.js';
import { Camera } from '@babylonjs/core/Cameras/camera.js';
import { Color4 } from '@babylonjs/core/Maths/math.color.js';
import { Vector3 } from '@babylonjs/core/Maths/math.vector.js';
import type { AbstractEngine } from '@babylonjs/core/Engines/abstractEngine.js';
import type { CameraController } from '../camera/camera-controller.js';
import type { Rgba } from '../theme.js';

/**
 * The Panorama scene.
 *
 * One orthographic camera over a 3D world. Even on the desktop the document is
 * spatial — entities carry z — so entering WebXR later means swapping the
 * camera, not rebuilding the scene.
 */

export interface PanoramaSceneOptions {
  readonly engine: AbstractEngine;
  readonly clearColor?: Rgba;
}

/** Panorama world space is +y down; Babylon is +y up. Converted here only. */
export const toBabylonY = (worldY: number): number => -worldY;

export class PanoramaScene {
  readonly scene: Scene;
  readonly camera: FreeCamera;

  constructor(options: PanoramaSceneOptions) {
    this.scene = new Scene(options.engine);
    const [r, g, b, a] = options.clearColor ?? [0.95, 0.96, 0.97, 1];
    this.scene.clearColor = new Color4(r, g, b, a);
    // Nothing in the Stage 1 table is lit; skipping the light pass keeps the
    // frame budget for text.
    this.scene.autoClear = true;
    this.scene.skipPointerMovePicking = true;

    this.camera = new FreeCamera('panorama-camera', new Vector3(0, 0, -100), this.scene);
    this.camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
    this.camera.minZ = 0.1;
    this.camera.maxZ = 1_000;
    this.camera.setTarget(new Vector3(0, 0, 0));
  }

  /** Mirrors the Panorama camera state onto the Babylon camera. */
  syncCamera(controller: CameraController): void {
    const { centerX, centerY, scale } = controller.state;
    const { width, height } = controller.viewport;
    const halfWidth = width / (2 * scale);
    const halfHeight = height / (2 * scale);

    this.camera.orthoLeft = -halfWidth;
    this.camera.orthoRight = halfWidth;
    this.camera.orthoTop = halfHeight;
    this.camera.orthoBottom = -halfHeight;

    const babylonY = toBabylonY(centerY);
    this.camera.position.set(centerX, babylonY, -100);
    this.camera.setTarget(new Vector3(centerX, babylonY, 0));
  }

  dispose(): void {
    this.scene.dispose();
  }
}
