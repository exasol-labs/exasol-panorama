import { clamp } from '@panorama/core';

/**
 * The Panorama canvas camera.
 *
 * A 2D orthographic view over an infinite world. World coordinates use +y
 * downwards, matching the table's own layout space; the Babylon layer flips
 * once, at the boundary, rather than every module reasoning about two
 * conventions.
 */

export interface Viewport {
  /** CSS pixels. */
  readonly width: number;
  readonly height: number;
}

export interface CameraState {
  /** World point shown at the centre of the viewport. */
  readonly centerX: number;
  readonly centerY: number;
  /** CSS pixels per world unit. */
  readonly scale: number;
}

export interface CameraOptions {
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly initial?: Partial<CameraState>;
}

export const DEFAULT_MIN_SCALE = 0.02;
export const DEFAULT_MAX_SCALE = 8;

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export class CameraController {
  readonly #minScale: number;
  readonly #maxScale: number;
  #state: CameraState;
  #viewport: Viewport = { width: 1, height: 1 };

  constructor(options: CameraOptions = {}) {
    this.#minScale = options.minScale ?? DEFAULT_MIN_SCALE;
    this.#maxScale = options.maxScale ?? DEFAULT_MAX_SCALE;
    this.#state = {
      centerX: options.initial?.centerX ?? 0,
      centerY: options.initial?.centerY ?? 0,
      scale: clamp(options.initial?.scale ?? 1, this.#minScale, this.#maxScale),
    };
  }

  get state(): CameraState {
    return this.#state;
  }

  get scale(): number {
    return this.#state.scale;
  }

  get viewport(): Viewport {
    return this.#viewport;
  }

  setViewport(viewport: Viewport): void {
    this.#viewport = {
      width: Math.max(1, viewport.width),
      height: Math.max(1, viewport.height),
    };
  }

  worldToScreen(worldX: number, worldY: number): ScreenPoint {
    const { centerX, centerY, scale } = this.#state;
    return {
      x: (worldX - centerX) * scale + this.#viewport.width / 2,
      y: (worldY - centerY) * scale + this.#viewport.height / 2,
    };
  }

  screenToWorld(screenX: number, screenY: number): ScreenPoint {
    const { centerX, centerY, scale } = this.#state;
    return {
      x: (screenX - this.#viewport.width / 2) / scale + centerX,
      y: (screenY - this.#viewport.height / 2) / scale + centerY,
    };
  }

  /** Pans by a screen-space delta, so dragging tracks the pointer exactly. */
  panByScreen(deltaX: number, deltaY: number): void {
    this.#state = {
      ...this.#state,
      centerX: this.#state.centerX - deltaX / this.#state.scale,
      centerY: this.#state.centerY - deltaY / this.#state.scale,
    };
  }

  moveTo(centerX: number, centerY: number): void {
    this.#state = { ...this.#state, centerX, centerY };
  }

  /** Zooms about a screen point, keeping the world point under it fixed. */
  zoomAt(screenX: number, screenY: number, factor: number): void {
    const before = this.screenToWorld(screenX, screenY);
    const scale = clamp(this.#state.scale * factor, this.#minScale, this.#maxScale);
    this.#state = { ...this.#state, scale };
    const after = this.screenToWorld(screenX, screenY);
    this.#state = {
      ...this.#state,
      centerX: this.#state.centerX + (before.x - after.x),
      centerY: this.#state.centerY + (before.y - after.y),
    };
  }

  setScale(scale: number): void {
    this.#state = { ...this.#state, scale: clamp(scale, this.#minScale, this.#maxScale) };
  }

  /** Frames a world rectangle with a margin, as "zoom to fit" does. */
  fit(rect: { x: number; y: number; width: number; height: number }, margin = 40): void {
    const availableWidth = Math.max(1, this.#viewport.width - margin * 2);
    const availableHeight = Math.max(1, this.#viewport.height - margin * 2);
    const scale = clamp(
      Math.min(
        availableWidth / Math.max(1, rect.width),
        availableHeight / Math.max(1, rect.height),
      ),
      this.#minScale,
      this.#maxScale,
    );
    this.#state = {
      scale,
      centerX: rect.x + rect.width / 2,
      centerY: rect.y + rect.height / 2,
    };
  }

  /** The world rectangle currently on screen, used for culling. */
  visibleWorldRect(): { x: number; y: number; width: number; height: number } {
    const topLeft = this.screenToWorld(0, 0);
    const bottomRight = this.screenToWorld(this.#viewport.width, this.#viewport.height);
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: bottomRight.x - topLeft.x,
      height: bottomRight.y - topLeft.y,
    };
  }
}
