import { describe, expect, it, vi } from 'vitest';
import type { CanvasRenderingContext2DLike, TextMetricsLike } from '@panorama/renderer';
import { CanvasGlyphRasterizer, DEFAULT_FONT_FAMILY } from '@panorama/renderer';

interface Recorded {
  readonly fills: Array<{ text: string; x: number; y: number; font: string }>;
  readonly clears: Array<{ width: number; height: number }>;
  context: CanvasRenderingContext2DLike;
}

/** A 2D context stub with predictable metrics. */
const stubContext = (
  metrics: { [K in keyof TextMetricsLike]?: number | undefined } = {},
): Recorded => {
  const fills: Recorded['fills'] = [];
  const clears: Recorded['clears'] = [];
  const context: CanvasRenderingContext2DLike = {
    font: '',
    fillStyle: '',
    textBaseline: '',
    textAlign: '',
    measureText: (text): TextMetricsLike =>
      ({
        width: text.length * 6,
        actualBoundingBoxLeft: 0,
        actualBoundingBoxRight: text.length * 6,
        actualBoundingBoxAscent: 8,
        actualBoundingBoxDescent: 2,
        ...metrics,
      }) as TextMetricsLike,
    fillText: (text, x, y): void => {
      fills.push({ text, x, y, font: context.font });
    },
    clearRect: (_x, _y, width, height): void => {
      clears.push({ width, height });
    },
  };
  return { fills, clears, context };
};

const rasterizer = (recorded: Recorded, pixelRatio = 1): CanvasGlyphRasterizer =>
  new CanvasGlyphRasterizer({
    context: recorded.context,
    width: 512,
    height: 512,
    pixelRatio,
  });

describe('CanvasGlyphRasterizer', () => {
  it('measures a glyph with padding around the ink', () => {
    const recorded = stubContext();
    const metrics = rasterizer(recorded).measure({ char: 'A', fontSize: 12, bold: false });
    expect(metrics).toEqual({
      width: 6 + 2,
      height: 10 + 2,
      bearingX: -1,
      bearingY: 9,
      advance: 6,
    });
  });

  it('reports zero size for glyphs with no ink', () => {
    const recorded = stubContext({
      width: 4,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: 0,
      actualBoundingBoxAscent: 0,
      actualBoundingBoxDescent: 0,
    });
    const metrics = rasterizer(recorded).measure({ char: ' ', fontSize: 12, bold: false });
    expect(metrics).toMatchObject({ width: 0, height: 0, advance: 4 });
  });

  it('falls back when a browser omits the bounding box', () => {
    const recorded = stubContext({
      actualBoundingBoxLeft: undefined,
      actualBoundingBoxRight: undefined,
      actualBoundingBoxAscent: undefined,
      actualBoundingBoxDescent: undefined,
    });
    const metrics = rasterizer(recorded).measure({ char: 'A', fontSize: 10, bold: false });
    // width falls back to the advance, height to 0.8em + 0.2em.
    expect(metrics.width).toBeCloseTo(6 + 2);
    expect(metrics.height).toBeCloseTo(10 + 2);
  });

  it('builds a font string honouring weight, size and pixel ratio', () => {
    const recorded = stubContext();
    const scaled = rasterizer(recorded, 2);
    scaled.draw({ char: 'A', fontSize: 12, bold: true }, 4, 8);
    expect(recorded.fills[0]?.font).toBe(`600 24px ${DEFAULT_FONT_FAMILY}`);

    const plain = rasterizer(recorded);
    plain.draw({ char: 'A', fontSize: 12, bold: false }, 0, 0);
    expect(recorded.fills[1]?.font).toBe(`12px ${DEFAULT_FONT_FAMILY}`);
  });

  it('honours a custom font family', () => {
    const recorded = stubContext();
    const custom = new CanvasGlyphRasterizer({
      context: recorded.context,
      width: 64,
      height: 64,
      fontFamily: 'Courier',
    });
    custom.draw({ char: 'A', fontSize: 10, bold: false }, 0, 0);
    expect(recorded.fills[0]?.font).toBe('10px Courier');
  });

  it('draws glyphs at their bitmap origin', () => {
    const recorded = stubContext();
    rasterizer(recorded).draw({ char: 'A', fontSize: 12, bold: false }, 10, 20);
    // origin.x - bearingX, origin.y + bearingY
    expect(recorded.fills[0]).toMatchObject({ text: 'A', x: 11, y: 29 });
  });

  it('clears the whole atlas', () => {
    const recorded = stubContext();
    rasterizer(recorded).clear();
    expect(recorded.clears).toEqual([{ width: 512, height: 512 }]);
  });

  it('notifies on every change so the texture can be re-uploaded', () => {
    const recorded = stubContext();
    const onDirty = vi.fn();
    const instance = new CanvasGlyphRasterizer({
      context: recorded.context,
      width: 32,
      height: 32,
      onDirty,
    });
    instance.draw({ char: 'A', fontSize: 10, bold: false }, 0, 0);
    instance.clear();
    expect(onDirty).toHaveBeenCalledTimes(2);
  });
});
