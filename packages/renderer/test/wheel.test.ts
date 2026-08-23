import { describe, expect, it } from 'vitest';
import { normalizeWheel, wheelZoomFactor } from '@panorama/renderer';

describe('normalizeWheel', () => {
  it('converts line and page deltas to pixels', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }).pixelsY).toBe(48);
    expect(normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }).pixelsY).toBe(400);
    expect(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }, { lineHeight: 20 }).pixelsY).toBe(
      60,
    );
    expect(
      normalizeWheel({ deltaX: 0, deltaY: 1, deltaMode: 2 }, { pageHeight: 900 }).pixelsY,
    ).toBe(900);
  });

  it('recognises a mouse wheel by its large discrete steps', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 120, deltaMode: 0 }).device).toBe('wheel');
    expect(normalizeWheel({ deltaX: 0, deltaY: 3, deltaMode: 1 }).device).toBe('wheel');
  });

  it('recognises a trackpad by small or fractional deltas', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: 4, deltaMode: 0 }).device).toBe('trackpad');
    expect(normalizeWheel({ deltaX: 0, deltaY: 118.5, deltaMode: 0 }).device).toBe('trackpad');
  });

  it('redirects shift+wheel to the horizontal axis only when needed', () => {
    const swapped = normalizeWheel({ deltaX: 0, deltaY: 100, deltaMode: 0, shiftKey: true });
    expect(swapped).toMatchObject({ pixelsX: 100, pixelsY: 0, horizontal: true });

    const alreadyHorizontal = normalizeWheel({
      deltaX: 60,
      deltaY: 0,
      deltaMode: 0,
      shiftKey: true,
    });
    expect(alreadyHorizontal).toMatchObject({ pixelsX: 60, pixelsY: 0, horizontal: true });
  });

  it('detects horizontal gestures without shift', () => {
    expect(normalizeWheel({ deltaX: 30, deltaY: 2, deltaMode: 0 }).horizontal).toBe(true);
    expect(normalizeWheel({ deltaX: 2, deltaY: 30, deltaMode: 0 }).horizontal).toBe(false);
  });

  it('reports pinch-zoom', () => {
    expect(normalizeWheel({ deltaX: 0, deltaY: -8, deltaMode: 0, ctrlKey: true }).zoom).toBe(true);
    expect(normalizeWheel({ deltaX: 0, deltaY: -8, deltaMode: 0, metaKey: true }).zoom).toBe(true);
    expect(normalizeWheel({ deltaX: 0, deltaY: -8, deltaMode: 0 }).zoom).toBe(false);
  });

  it('respects a custom trackpad threshold', () => {
    expect(
      normalizeWheel({ deltaX: 0, deltaY: 50, deltaMode: 0 }, { trackpadThreshold: 100 }).device,
    ).toBe('trackpad');
  });
});

describe('wheelZoomFactor', () => {
  it('zooms in when scrolling up and out when scrolling down', () => {
    expect(wheelZoomFactor(-100)).toBeGreaterThan(1);
    expect(wheelZoomFactor(100)).toBeLessThan(1);
    expect(wheelZoomFactor(0)).toBe(1);
  });

  it('is symmetric', () => {
    expect(wheelZoomFactor(-100) * wheelZoomFactor(100)).toBeCloseTo(1, 9);
  });
});
