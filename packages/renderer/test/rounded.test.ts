import { describe, expect, it } from 'vitest';
import { roundedRectStrips } from '../src/table/rounded.js';

/**
 * A rounded rectangle built from axis-aligned strips, because the ordering law
 * leaves no alternative: all polygons draw before all quads, and the halo draws
 * over tables. So the shape has to be quads, and these are the claims that make a
 * stack of quads a believable rounded rectangle.
 */

const bounds = (strips: readonly { x: number; y: number; width: number; height: number }[]) => ({
  left: Math.min(...strips.map((strip) => strip.x)),
  right: Math.max(...strips.map((strip) => strip.x + strip.width)),
  top: Math.min(...strips.map((strip) => strip.y)),
  bottom: Math.max(...strips.map((strip) => strip.y + strip.height)),
});

const area = (strips: readonly { width: number; height: number }[]): number =>
  strips.reduce((total, strip) => total + strip.width * strip.height, 0);

describe('roundedRectStrips', () => {
  it('fills the rectangle it was given and nothing outside it', () => {
    const strips = roundedRectStrips(10, 20, 22, 22, 3);
    expect(bounds(strips)).toEqual({ left: 10, right: 32, top: 20, bottom: 42 });
  });

  it('covers the whole height with no seam and no overlap', () => {
    const strips = [...roundedRectStrips(0, 0, 22, 16, 4)].sort((a, b) => a.y - b.y);
    let cursor = 0;
    for (const strip of strips) {
      expect(strip.y).toBeCloseTo(cursor, 9);
      cursor = strip.y + strip.height;
    }
    expect(cursor).toBeCloseTo(16, 9);
  });

  /**
   * A rounded rectangle is the rectangle less four corners, and each corner is a
   * square less a quarter circle. The strips should land within a few percent of
   * that — enough to prove they follow an arc rather than, say, a chamfer.
   */
  it('has about the area of a real rounded rectangle', () => {
    const radius = 4;
    const exact = 22 * 22 - (4 - Math.PI) * radius * radius;
    expect(area(roundedRectStrips(0, 0, 22, 22, radius, 4))).toBeCloseTo(exact, 0);
  });

  it('insets the ends and leaves the middle full width', () => {
    const strips = roundedRectStrips(0, 0, 22, 22, 3);
    const widest = Math.max(...strips.map((strip) => strip.width));
    expect(widest).toBe(22);
    const ends = strips.filter((strip) => strip.y === 0 || strip.y + strip.height === 22);
    expect(ends.length).toBe(2);
    for (const end of ends) expect(end.width).toBeLessThan(widest);
  });

  it('is symmetric top to bottom and left to right', () => {
    const strips = roundedRectStrips(0, 0, 22, 22, 3);
    const widths = strips.map((strip) => Math.round(strip.width * 1e6));
    // Every width occurs an even number of times except the middle band's.
    const counted = new Map<number, number>();
    for (const width of widths) counted.set(width, (counted.get(width) ?? 0) + 1);
    expect([...counted.values()].filter((count) => count % 2 === 1)).toEqual([1]);
    for (const strip of strips) {
      // Centred: what is taken off the left is taken off the right.
      expect(strip.x + strip.width / 2).toBeCloseTo(11, 9);
    }
  });

  it('degrades to a plain rectangle where there is nothing to round', () => {
    expect(roundedRectStrips(1, 2, 10, 6, 0)).toEqual([{ x: 1, y: 2, width: 10, height: 6 }]);
    expect(roundedRectStrips(1, 2, 10, 6, -3)).toEqual([{ x: 1, y: 2, width: 10, height: 6 }]);
  });

  /**
   * A button one border-width smaller than its own radius asked for a lozenge.
   * Clamping is what keeps the inner face of a small button a face.
   */
  it('clamps a radius the rectangle is too small to honour', () => {
    const strips = roundedRectStrips(0, 0, 6, 6, 10);
    // Clamped to half the smaller side, so this is a circle — inside the square
    // on every side, and touching it at the middle of each edge.
    const box = bounds(strips);
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(6);
    expect(box.top).toBe(0);
    expect(box.bottom).toBe(6);
    // No full-width band at all, because there is no straight side left: the
    // widest strip is the one nearest the middle, a fraction under the diameter.
    expect(Math.max(...strips.map((strip) => strip.width))).toBeCloseTo(6, 1);
    // Rounded to a circle at most, never past the middle.
    expect(area(strips)).toBeLessThan(36);
    expect(area(strips)).toBeGreaterThan(Math.PI * 9 * 0.9);
  });

  it('draws nothing for a rectangle with no area', () => {
    expect(roundedRectStrips(0, 0, 0, 10, 2)).toEqual([]);
    expect(roundedRectStrips(0, 0, 10, 0, 2)).toEqual([]);
  });

  /**
   * The step count is a question about pixels, so it follows the scale: the halo
   * is drawn at a constant screen size, and a corner that looked smooth on a
   * desk-sized display should not turn into a staircase when the camera zooms.
   */
  it('steps a corner more finely the more screen pixels it covers', () => {
    const near = roundedRectStrips(0, 0, 22, 22, 3, 4).length;
    const far = roundedRectStrips(0, 0, 22, 22, 3, 0.25).length;
    expect(near).toBeGreaterThan(far);
    // And never unboundedly: a button is a dozen quads, not a hundred.
    expect(roundedRectStrips(0, 0, 400, 400, 200, 40).length).toBeLessThanOrEqual(17);
  });

  it('keeps a wide button as wide as it is', () => {
    const wide = roundedRectStrips(0, 0, 60, 22, 3);
    expect(Math.max(...wide.map((strip) => strip.width))).toBe(60);
    expect(bounds(wide).right - bounds(wide).left).toBe(60);
  });
});
