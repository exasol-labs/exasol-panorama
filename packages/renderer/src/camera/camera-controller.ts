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
  /** Whether the viewport above is a real measurement or the placeholder. */
  #measured = false;
  /**
   * The part of the viewport the user can actually see, or `null` for all of it.
   *
   * These differ because the canvas is drawn larger than the window shows and
   * clipped to it — see `PanoramaCanvas`. Everything geometric works in the
   * drawn viewport, because that is what the projection covers and what screen
   * coordinates are measured in. Everything about *where to put things* works in
   * this one, because a table placed where nobody can see it has been lost.
   */
  #visible: Viewport | null = null;

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

  /** The visible part of the viewport, anchored at its top-left corner. */
  get visible(): Viewport {
    return this.#visible ?? this.#viewport;
  }

  /**
   * Narrows the viewport to the part of it on screen.
   *
   * Nothing moves: the projection is unchanged, so every pixel already drawn
   * stays exactly where it is and the window simply shows more or less of it.
   * That is the whole point — this is what a window resize does now, and it
   * cannot disturb the picture because it does not touch it.
   */
  setVisible(viewport: Viewport): void {
    this.#visible = {
      width: Math.max(1, viewport.width),
      height: Math.max(1, viewport.height),
    };
  }

  /**
   * Adopts a new viewport, keeping the world where it is on screen.
   *
   * The camera is centre-anchored: `centerX`/`centerY` sit in the middle of the
   * viewport. So a viewport 200px wider would put everything 100px further right
   * without the camera having moved — which during a window resize reads as the
   * whole scene sliding, one step per frame, for as long as the drag lasts.
   *
   * Moving the centre by half of whatever the viewport gained holds the top-left
   * corner still instead: a resize reveals or hides world at the edges that
   * moved, and leaves everything already on screen exactly where it was.
   *
   * The first measurement is adopted rather than compensated for. There is no
   * previous viewport to hold anything still relative to — only the 1x1
   * placeholder this starts life with.
   */
  setViewport(viewport: Viewport): void {
    const width = Math.max(1, viewport.width);
    const height = Math.max(1, viewport.height);
    const previous = this.#viewport;
    this.#viewport = { width, height };
    if (!this.#measured) {
      this.#measured = true;
      return;
    }
    const { scale } = this.#state;
    this.#state = {
      ...this.#state,
      centerX: this.#state.centerX + (width - previous.width) / (2 * scale),
      centerY: this.#state.centerY + (height - previous.height) / (2 * scale),
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
    const visible = this.visible;
    const availableWidth = Math.max(1, visible.width - margin * 2);
    const availableHeight = Math.max(1, visible.height - margin * 2);
    const scale = clamp(
      Math.min(
        availableWidth / Math.max(1, rect.width),
        availableHeight / Math.max(1, rect.height),
      ),
      this.#minScale,
      this.#maxScale,
    );
    // Centred in the visible part, which is at the top-left of the drawn one: the
    // offset between the two centres is half of what is drawn but not shown.
    this.#state = {
      scale,
      centerX: rect.x + rect.width / 2 + (this.#viewport.width - visible.width) / (2 * scale),
      centerY: rect.y + rect.height / 2 + (this.#viewport.height - visible.height) / (2 * scale),
    };
  }

  /**
   * The world rectangle the user can see: what "where am I looking" means, and
   * so what placing a new table and revealing an existing one both work from.
   */
  visibleWorldRect(): { x: number; y: number; width: number; height: number } {
    const topLeft = this.screenToWorld(0, 0);
    const { width, height } = this.visible;
    const { scale } = this.#state;
    return { x: topLeft.x, y: topLeft.y, width: width / scale, height: height / scale };
  }

  /**
   * The world rectangle the projection covers — everything drawn, seen or not.
   * Wider than the above when the canvas is drawn larger than the window shows,
   * and what culling has to use: a table cut from the draw list because it was
   * outside the window is a table missing from the pixels a window resize is
   * about to reveal.
   */
  drawnWorldRect(): { x: number; y: number; width: number; height: number } {
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
