import { describe, expect, it } from 'vitest';
import { CameraController, DEFAULT_MAX_SCALE, DEFAULT_MIN_SCALE } from '@panorama/renderer';

const camera = (): CameraController => {
  const controller = new CameraController();
  controller.setViewport({ width: 800, height: 600 });
  return controller;
};

describe('CameraController', () => {
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
