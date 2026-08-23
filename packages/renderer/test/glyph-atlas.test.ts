import { describe, expect, it } from 'vitest';
import { GlyphAtlas } from '@panorama/renderer';
import { testRasterizer } from './fixtures.js';

describe('GlyphAtlas', () => {
  it('rasterises each glyph exactly once', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 256, height: 256 });

    const first = atlas.slot({ char: 'A', fontSize: 12, bold: false });
    const again = atlas.slot({ char: 'A', fontSize: 12, bold: false });
    expect(again).toBe(first);
    expect(rasterizer.drawn).toHaveLength(1);
    expect(atlas.glyphCount).toBe(1);
  });

  it('keys glyphs by character, size and weight', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 256, height: 256 });
    atlas.slot({ char: 'A', fontSize: 12, bold: false });
    atlas.slot({ char: 'A', fontSize: 12, bold: true });
    atlas.slot({ char: 'A', fontSize: 13, bold: false });
    atlas.slot({ char: 'B', fontSize: 12, bold: false });
    expect(atlas.glyphCount).toBe(4);
  });

  it('bumps the version only when the bitmap changed', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 256, height: 256 });
    expect(atlas.version).toBe(0);
    atlas.slot({ char: 'A', fontSize: 12, bold: false });
    expect(atlas.version).toBe(1);
    atlas.slot({ char: 'A', fontSize: 12, bold: false });
    expect(atlas.version).toBe(1);
  });

  it('stores whitespace as an advance with no bitmap', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 256, height: 256 });
    const slot = atlas.slot({ char: ' ', fontSize: 10, bold: false });
    expect(slot).toMatchObject({ width: 0, height: 0 });
    expect(atlas.advance({ char: ' ', fontSize: 10, bold: false })).toBeCloseTo(3);
    expect(rasterizer.drawn).toHaveLength(0);
    expect(atlas.version).toBe(0);
  });

  it('wraps onto a new shelf when a row is full', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 40, height: 200, padding: 1 });
    const slots = [...'abcdef'].map((char) => atlas.slot({ char, fontSize: 10, bold: false }));
    const ys = new Set(slots.map((slot) => slot?.y));
    expect(ys.size).toBeGreaterThan(1);
    expect(atlas.isFull).toBe(false);
  });

  it('reports being full rather than overwriting glyphs', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 14, height: 12, padding: 0 });
    expect(atlas.slot({ char: 'a', fontSize: 10, bold: false })).not.toBeNull();
    expect(atlas.slot({ char: 'b', fontSize: 10, bold: false })).not.toBeNull();
    expect(atlas.slot({ char: 'c', fontSize: 10, bold: false })).toBeNull();
    expect(atlas.isFull).toBe(true);
    expect(atlas.advance({ char: 'c', fontSize: 10, bold: false })).toBe(0);
  });

  it('rejects a glyph wider than the atlas', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer, width: 4, height: 100 });
    expect(atlas.slot({ char: 'W', fontSize: 40, bold: false })).toBeNull();
    expect(atlas.isFull).toBe(true);
  });

  it('resets', () => {
    const rasterizer = testRasterizer();
    const atlas = new GlyphAtlas({ rasterizer });
    atlas.slot({ char: 'A', fontSize: 12, bold: false });
    atlas.reset();
    expect(atlas.glyphCount).toBe(0);
    expect(rasterizer.cleared).toBe(1);
    atlas.slot({ char: 'A', fontSize: 12, bold: false });
    expect(rasterizer.drawn).toHaveLength(2);
  });

  it('defaults to a 1024px atlas', () => {
    const atlas = new GlyphAtlas({ rasterizer: testRasterizer() });
    expect(atlas.width).toBe(1_024);
    expect(atlas.height).toBe(1_024);
  });
});
