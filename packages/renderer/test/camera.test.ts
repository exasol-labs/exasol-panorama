import { describe, expect, it } from 'vitest';
import { CameraController, DEFAULT_MAX_SCALE, DEFAULT_MIN_SCALE } from '@panorama/renderer';

const camera = (): CameraController => {
  const controller = new CameraController();
  controller.setViewport({ width: 800, height: 600 });
  return controller;
};

describe('CameraController', () => {
  /**
   * A window being dragged by its corner resizes the viewport dozens of times a
   * second. Every one of those must leave what is already on screen where it is:
   * a centre-anchored camera would slide the whole scene by half of every change,
   * which reads as the picture drifting for as long as the drag lasts.
   */
  it('holds the world still when the viewport changes size', () => {
    const controller = camera();
    controller.moveTo(500, 400);
    const before = {
      topLeft: controller.screenToWorld(0, 0),
      table: controller.worldToScreen(620, 480),
    };

    // Dragging the bottom-right corner outwards, in the steps a drag arrives in.
    for (const [width, height] of [
      [840, 610],
      [900, 640],
      [1_000, 700],
    ] as const) {
      controller.setViewport({ width, height });
      expect(controller.screenToWorld(0, 0)).toEqual(before.topLeft);
      expect(controller.worldToScreen(620, 480)).toEqual(before.table);
    }

    // And inwards again, which hides world at the edges that moved rather than
    // pulling the rest of it inwards.
    controller.setViewport({ width: 700, height: 500 });
    expect(controller.screenToWorld(0, 0)).toEqual(before.topLeft);
    expect(controller.worldToScreen(620, 480)).toEqual(before.table);

    // A zoomed camera moves by correspondingly less world per pixel.
    controller.zoomAt(0, 0, 2);
    const zoomed = controller.screenToWorld(0, 0);
    controller.setViewport({ width: 900, height: 620 });
    expect(controller.screenToWorld(0, 0)).toEqual(zoomed);
  });

  /**
   * The canvas is drawn larger than the window shows and clipped to it, so the
   * camera has two rectangles: what it projects, and how much of that is on
   * screen. Resizing a window changes only the second — which is exactly why it
   * cannot disturb the picture. The first changes only when the canvas is
   * actually reallocated, which a window resize no longer does.
   */
  it('separates what it draws from what the window shows', () => {
    const controller = camera();
    controller.moveTo(500, 400);
    controller.setViewport({ width: 1_600, height: 1_000 });
    const fixed = {
      topLeft: controller.screenToWorld(0, 0),
      table: controller.worldToScreen(620, 480),
    };

    // Narrowing to the window moves nothing at all: the projection is untouched,
    // so every pixel already drawn is still exactly where it was.
    controller.setVisible({ width: 900, height: 700 });
    expect(controller.screenToWorld(0, 0)).toEqual(fixed.topLeft);
    expect(controller.worldToScreen(620, 480)).toEqual(fixed.table);

    // What is drawn stays the whole canvas — culling must not cut away the
    // tables that live in the strip a resize is about to uncover.
    expect(controller.drawnWorldRect().width).toBeCloseTo(1_600 / controller.scale);
    // What counts as "on screen" is the window, anchored at the same corner.
    const seen = controller.visibleWorldRect();
    expect(seen.x).toBeCloseTo(fixed.topLeft.x);
    expect(seen.y).toBeCloseTo(fixed.topLeft.y);
    expect(seen.width).toBeCloseTo(900 / controller.scale);
    expect(seen.height).toBeCloseTo(700 / controller.scale);

    // Dragged smaller again, over and over, as a drag arrives: still nothing.
    for (const size of [
      { width: 880, height: 690 },
      { width: 700, height: 500 },
      { width: 640, height: 480 },
    ]) {
      controller.setVisible(size);
      expect(controller.screenToWorld(0, 0)).toEqual(fixed.topLeft);
      expect(controller.worldToScreen(620, 480)).toEqual(fixed.table);
    }

    // Framing works in the window, not in the whole canvas: the rectangle ends
    // up centred on what the user can see.
    controller.fit({ x: 0, y: 0, width: 200, height: 100 });
    const centre = controller.screenToWorld(640 / 2, 480 / 2);
    expect(centre.x).toBeCloseTo(100);
    expect(centre.y).toBeCloseTo(50);
  });

  it('maps between world and screen space', () => {
    const controller = camera();
    expect(controller.worldToScreen(0, 0)).toEqual({ x: 400, y: 300 });
    expect(controller.screenToWorld(400, 300)).toEqual({ x: 0, y: 0 });
    expect(controller.screenToWorld(500, 300)).toEqual({ x: 100, y: 0 });
  });

  it('round-trips at any scale and offset', () => {
    const controller = camera();
    controller.moveTo(1_234, -567);
    controller.setScale(2.5);
    const world = controller.screenToWorld(123, 456);
    const screen = controller.worldToScreen(world.x, world.y);
    expect(screen.x).toBeCloseTo(123, 9);
    expect(screen.y).toBeCloseTo(456, 9);
  });

  it('pans in screen space so dragging tracks the pointer', () => {
    const controller = camera();
    controller.setScale(2);
    controller.panByScreen(100, 50);
    expect(controller.state.centerX).toBe(-50);
    expect(controller.state.centerY).toBe(-25);
  });

  it('keeps the world point under the cursor fixed while zooming', () => {
    const controller = camera();
    const before = controller.screenToWorld(700, 500);
    controller.zoomAt(700, 500, 2.5);
    const after = controller.screenToWorld(700, 500);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
    expect(controller.scale).toBe(2.5);
  });

  it('clamps the scale', () => {
    const controller = camera();
    controller.zoomAt(0, 0, 1e6);
    expect(controller.scale).toBe(DEFAULT_MAX_SCALE);
    controller.zoomAt(0, 0, 1e-9);
    expect(controller.scale).toBe(DEFAULT_MIN_SCALE);
    controller.setScale(1_000);
    expect(controller.scale).toBe(DEFAULT_MAX_SCALE);
  });

  it('honours configured limits and an initial state', () => {
    const controller = new CameraController({
      minScale: 0.5,
      maxScale: 2,
      initial: { centerX: 10, centerY: 20, scale: 9 },
    });
    expect(controller.state).toEqual({ centerX: 10, centerY: 20, scale: 2 });
    expect(controller.viewport).toEqual({ width: 1, height: 1 });
  });

  it('never accepts a degenerate viewport', () => {
    const controller = camera();
    controller.setViewport({ width: 0, height: -5 });
    expect(controller.viewport).toEqual({ width: 1, height: 1 });
  });

  it('frames a rectangle', () => {
    const controller = camera();
    controller.fit({ x: 0, y: 0, width: 720, height: 520 }, 40);
    expect(controller.state.centerX).toBe(360);
    expect(controller.state.centerY).toBe(260);
    expect(controller.scale).toBeCloseTo(520 / 520, 6);
  });

  it('fits degenerate rectangles without dividing by zero', () => {
    const controller = camera();
    controller.fit({ x: 5, y: 5, width: 0, height: 0 }, 0);
    expect(Number.isFinite(controller.scale)).toBe(true);
    expect(controller.scale).toBe(DEFAULT_MAX_SCALE);
  });

  it('reports the visible world rectangle for culling', () => {
    const controller = camera();
    controller.setScale(2);
    controller.moveTo(100, 100);
    expect(controller.visibleWorldRect()).toEqual({
      x: 100 - 200,
      y: 100 - 150,
      width: 400,
      height: 300,
    });
  });
});
