import { describe, expect, it } from 'vitest';
import type { TextLayout, TextRun } from '@panorama/renderer';
import { AtlasTextRenderer, GlyphAtlas, clipGlyph } from '@panorama/renderer';
import { testRasterizer } from './fixtures.js';

const renderer = (options: { width?: number; height?: number } = {}): AtlasTextRenderer =>
  new AtlasTextRenderer(
    new GlyphAtlas({
      rasterizer: testRasterizer(),
      width: options.width ?? 512,
      height: options.height ?? 512,
      padding: 0,
    }),
  );

const run = (overrides: Partial<TextRun> = {}): TextRun => ({
  x: 100,
  y: 50,
  maxWidth: 200,
  height: 24,
  text: 'abc',
  color: [0, 0, 0, 1],
  align: 'left',
  fontSize: 10,
  ...overrides,
});

describe('AtlasTextRenderer', () => {
  it('produces one quad per visible glyph', () => {
    const layout = renderer().layout(run());
    expect(layout.quads).toHaveLength(3);
    expect(layout.truncated).toBe(false);
    expect(layout.width).toBeCloseTo(18);
  });

  it('advances the pen across the run', () => {
    const layout = renderer().layout(run());
    const xs = layout.quads.map((quad) => quad.x);
    expect(xs[0]).toBe(100);
    expect(xs[1]).toBeCloseTo(106);
    expect(xs[2]).toBeCloseTo(112);
  });

  it('aligns right and centre inside the box', () => {
    const right = renderer().layout(run({ align: 'right' }));
    expect(right.quads[0]?.x).toBeCloseTo(100 + 200 - 18);
    const centre = renderer().layout(run({ align: 'center' }));
    expect(centre.quads[0]?.x).toBeCloseTo(100 + (200 - 18) / 2);
  });

  it('places glyphs on the baseline', () => {
    const layout = renderer().layout(run());
    // baseline = y + round((24 + 10 * 0.72) / 2) = 50 + 16; bearingY = 8.
    expect(layout.quads[0]?.y).toBeCloseTo(50 + 16 - 8);
  });

  it('clips to the cell and marks the run truncated', () => {
    const layout = renderer().layout(run({ text: 'abcdefghij', maxWidth: 30 }));
    expect(layout.truncated).toBe(true);
    // 30px holds the 6px ellipsis plus four 6px characters.
    expect(layout.quads).toHaveLength(5);
    expect(layout.width).toBeCloseTo(30);
  });

  it('emits nothing for empty or zero-width runs', () => {
    expect(renderer().layout(run({ text: '' })).quads).toEqual([]);
    expect(renderer().layout(run({ maxWidth: 0 })).quads).toEqual([]);
  });

  it('skips whitespace, which has no bitmap, but still advances', () => {
    const layout = renderer().layout(run({ text: 'a b' }));
    expect(layout.quads).toHaveLength(2);
    expect(layout.quads[1]?.x).toBeCloseTo(100 + 6 + 3);
  });

  it('stops cleanly when the atlas is full', () => {
    const small = renderer({ width: 14, height: 12 });
    const layout = small.layout(run({ text: 'abcdef', fontSize: 10 }));
    expect(layout.quads.length).toBeLessThan(6);
  });

  it('normalises texture coordinates against the atlas size', () => {
    const text = renderer({ width: 512, height: 512 });
    const quad = text.layout(run({ text: 'a' })).quads[0];
    if (quad === undefined) throw new Error('expected a quad');
    expect(quad.u1 - quad.u0).toBeCloseTo(6 / 512);
    expect(quad.v1 - quad.v0).toBeCloseTo(10 / 512);
  });

  it('measures text and exposes the atlas', () => {
    const text = renderer();
    expect(text.measure('abc', 10, false)).toBeCloseTo(18);
    expect(text.measure('abc', 10, true)).toBeCloseTo(21);
    expect(text.atlas.glyphCount).toBeGreaterThan(0);
  });

  it('batches many runs into one layout', () => {
    const text = renderer();
    const layout = text.layoutAll([run(), run({ text: 'de', y: 80 }), run({ text: '' })]);
    expect(layout.quads).toHaveLength(5);
    expect(layout.truncated).toBe(false);
  });

  it('reports truncation across a batch', () => {
    const text = renderer();
    const layout = text.layoutAll([run(), run({ text: 'abcdefghij', maxWidth: 20 })]);
    expect(layout.truncated).toBe(true);
  });

  it('carries the run colour onto every glyph', () => {
    const layout = renderer().layout(run({ color: [1, 0, 0, 0.5] }));
    expect(layout.quads.every((quad) => quad.color[0] === 1 && quad.color[3] === 0.5)).toBe(true);
  });
});

describe('clipGlyph', () => {
  const quad = {
    x: 100,
    y: 50,
    width: 20,
    height: 10,
    u0: 0.1,
    v0: 0.2,
    u1: 0.3,
    v1: 0.4,
    color: [0, 0, 0, 1] as const,
  };

  it('returns the glyph unchanged when no clip applies', () => {
    expect(clipGlyph(quad, undefined)).toBe(quad);
    expect(clipGlyph(quad, { x: 0, y: 0, width: 1_000, height: 1_000 })).toBe(quad);
  });

  it('drops glyphs entirely outside the clip', () => {
    expect(clipGlyph(quad, { x: 0, y: 0, width: 50, height: 50 })).toBeNull();
    expect(clipGlyph(quad, { x: 200, y: 50, width: 50, height: 50 })).toBeNull();
  });

  it('trims geometry and texture coordinates by the same proportion', () => {
    // Clip away the bottom half.
    const clipped = clipGlyph(quad, { x: 0, y: 0, width: 1_000, height: 55 });
    expect(clipped).toMatchObject({ x: 100, y: 50, width: 20, height: 5 });
    expect(clipped?.v0).toBeCloseTo(0.2);
    expect(clipped?.v1).toBeCloseTo(0.3);
    expect(clipped?.u0).toBeCloseTo(0.1);
    expect(clipped?.u1).toBeCloseTo(0.3);
  });

  it('trims the leading edge too', () => {
    const clipped = clipGlyph(quad, { x: 110, y: 52, width: 1_000, height: 1_000 });
    expect(clipped).toMatchObject({ x: 110, width: 10, y: 52, height: 8 });
    expect(clipped?.u0).toBeCloseTo(0.2);
    expect(clipped?.v0).toBeCloseTo(0.24);
  });
});

describe('clipped runs', () => {
  it('keeps the baseline of a partially visible row', () => {
    const text = renderer();
    const full = text.layout(run({ y: 100, height: 24 }));
    const partial = text.layout(
      run({ y: 100, height: 24, clip: { x: 0, y: 100, width: 1_000, height: 14 } }),
    );
    // Same glyph positions; the partial run is simply cut short.
    expect(partial.quads[0]?.x).toBe(full.quads[0]?.x);
    expect(partial.quads[0]?.y).toBe(full.quads[0]?.y);
    expect(partial.quads[0]?.height).toBeLessThan(full.quads[0]?.height ?? 0);
  });

  it('drops glyphs that fall entirely outside the clip', () => {
    const text = renderer();
    expect(text.layout(run({ clip: { x: 0, y: 0, width: 10, height: 10 } })).quads).toHaveLength(0);
  });
});

describe('device pixel ratio', () => {
  /** The same run, laid out against a 1x and a 2x atlas. */
  const layoutAtScale = (scale: number): TextLayout => {
    const atlas = new GlyphAtlas({
      rasterizer: testRasterizer(scale),
      width: 512 * scale,
      height: 512 * scale,
      padding: 0,
      scale,
    });
    return new AtlasTextRenderer(atlas).layout(run({ text: 'abc', fontSize: 10 }));
  };

  it('keeps world geometry identical when glyphs are rasterised at 2x', () => {
    const at1x = layoutAtScale(1);
    const at2x = layoutAtScale(2);

    expect(at2x.width).toBeCloseTo(at1x.width, 6);
    expect(at2x.quads).toHaveLength(at1x.quads.length);
    at1x.quads.forEach((quad, index) => {
      const scaled = at2x.quads[index];
      expect(scaled?.x).toBeCloseTo(quad.x, 6);
      expect(scaled?.y).toBeCloseTo(quad.y, 6);
      expect(scaled?.width).toBeCloseTo(quad.width, 6);
      expect(scaled?.height).toBeCloseTo(quad.height, 6);
    });
  });

  it('samples the same fraction of a larger atlas', () => {
    const at1x = layoutAtScale(1);
    const at2x = layoutAtScale(2);
    // Twice the pixels in twice the atlas: the same normalised region.
    expect((at2x.quads[0]?.u1 ?? 0) - (at2x.quads[0]?.u0 ?? 0)).toBeCloseTo(
      (at1x.quads[0]?.u1 ?? 0) - (at1x.quads[0]?.u0 ?? 0),
      6,
    );
  });

  it('measures text in world units regardless of the ratio', () => {
    const atlas = new GlyphAtlas({ rasterizer: testRasterizer(2), scale: 2 });
    const text = new AtlasTextRenderer(atlas);
    // 0.6em per glyph in world units, whatever the atlas was rasterised at.
    expect(text.measure('abc', 10, false)).toBeCloseTo(18, 6);
    expect(atlas.scale).toBe(2);
  });
});

describe('colouring part of a run', () => {
  const RED: TextRun['color'] = [1, 0, 0, 1];

  it('colours the characters a span covers and no others', () => {
    const layout = renderer().layout(
      run({ text: 'abcde', spans: [{ from: 1, to: 3, color: RED }] }),
    );
    expect(layout.quads.map((quad) => quad.color)).toEqual([
      [0, 0, 0, 1],
      RED,
      RED,
      [0, 0, 0, 1],
      [0, 0, 0, 1],
    ]);
  });

  it('leaves a run with no spans in one colour', () => {
    const layout = renderer().layout(run({ text: 'abc' }));
    expect(new Set(layout.quads.map((quad) => quad.color))).toHaveLength(1);
  });

  it('counts characters, not code units, so an emoji does not shift a span', () => {
    // A surrogate pair is one character to a reader and two to `length`; the
    // offsets have to agree with the text the caller measured them against.
    const layout = renderer().layout(
      run({ text: 'a\u{1F600}b', spans: [{ from: 3, to: 4, color: RED }] }),
    );
    expect(layout.quads.at(-1)?.color).toEqual(RED);
  });

  it('ignores a span that covers nothing that is drawn', () => {
    const layout = renderer().layout(
      run({ text: 'abc', spans: [{ from: 9, to: 12, color: RED }] }),
    );
    expect(layout.quads.every((quad) => quad.color[0] === 0)).toBe(true);
  });
});
