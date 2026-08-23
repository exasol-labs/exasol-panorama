/**
 * Glyph atlas.
 *
 * Text is the single biggest determinant of how a data grid feels, so glyphs
 * are rasterised once into a shared texture and drawn as instanced quads. No
 * glyph is ever regenerated while scrolling, which is what keeps text stable
 * during motion.
 */

export interface GlyphKey {
  readonly char: string;
  readonly fontSize: number;
  readonly bold: boolean;
}

export interface GlyphSlot {
  readonly char: string;
  readonly fontSize: number;
  readonly bold: boolean;
  /** Pixel rectangle inside the atlas. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Distance from the glyph's origin to the left of its bitmap. */
  readonly bearingX: number;
  /** Distance from the baseline to the top of its bitmap. */
  readonly bearingY: number;
  readonly advance: number;
}

export interface GlyphMetrics {
  readonly width: number;
  readonly height: number;
  readonly bearingX: number;
  readonly bearingY: number;
  readonly advance: number;
}

/** Draws one glyph into the atlas and reports its metrics. */
export interface GlyphRasterizer {
  measure(key: GlyphKey): GlyphMetrics;
  /** Draws the glyph with its bitmap origin at (x, y). */
  draw(key: GlyphKey, x: number, y: number): void;
  clear(): void;
}

export interface GlyphAtlasOptions {
  readonly rasterizer: GlyphRasterizer;
  readonly width?: number;
  readonly height?: number;
  readonly padding?: number;
  /**
   * Atlas pixels per world unit. Glyphs are rasterised at the display's device
   * pixel ratio so they stay sharp, but slot metrics are reported in atlas
   * pixels — consumers divide by this to get world-space geometry.
   */
  readonly scale?: number;
}

export const DEFAULT_ATLAS_SIZE = 1024;

const keyOf = (key: GlyphKey): string => `${key.fontSize}|${key.bold ? 'b' : 'r'}|${key.char}`;

/**
 * A shelf-packing atlas: glyphs of similar height share a row, which is a good
 * fit for text where every glyph in a run has the same size.
 */
export class GlyphAtlas {
  readonly width: number;
  readonly height: number;
  /** Atlas pixels per world unit; 2 on a Retina display. */
  readonly scale: number;
  readonly #rasterizer: GlyphRasterizer;
  readonly #padding: number;
  readonly #slots = new Map<string, GlyphSlot>();
  #shelfY = 0;
  #shelfX = 0;
  #shelfHeight = 0;
  #version = 0;
  #full = false;

  constructor(options: GlyphAtlasOptions) {
    this.#rasterizer = options.rasterizer;
    this.width = options.width ?? DEFAULT_ATLAS_SIZE;
    this.height = options.height ?? DEFAULT_ATLAS_SIZE;
    this.scale = options.scale ?? 1;
    this.#padding = options.padding ?? 1;
  }

  /** Increments whenever the atlas bitmap changed and must be re-uploaded. */
  get version(): number {
    return this.#version;
  }

  get glyphCount(): number {
    return this.#slots.size;
  }

  get isFull(): boolean {
    return this.#full;
  }

  /** Returns the slot for a glyph, rasterising it on first use. */
  slot(key: GlyphKey): GlyphSlot | null {
    const id = keyOf(key);
    const existing = this.#slots.get(id);
    if (existing !== undefined) return existing;
    return this.#rasterize(id, key);
  }

  #rasterize(id: string, key: GlyphKey): GlyphSlot | null {
    const metrics = this.#rasterizer.measure(key);
    const width = Math.ceil(metrics.width);
    const height = Math.ceil(metrics.height);

    if (width === 0 || height === 0) {
      // Whitespace has no bitmap but still advances the pen.
      const slot: GlyphSlot = { ...key, x: 0, y: 0, width: 0, height: 0, ...metricsOf(metrics) };
      this.#slots.set(id, slot);
      return slot;
    }
    if (width + this.#padding * 2 > this.width) {
      this.#full = true;
      return null;
    }

    if (this.#shelfX + width + this.#padding > this.width) {
      this.#shelfY += this.#shelfHeight + this.#padding;
      this.#shelfX = 0;
      this.#shelfHeight = 0;
    }
    if (this.#shelfY + height + this.#padding > this.height) {
      this.#full = true;
      return null;
    }

    const x = this.#shelfX + this.#padding;
    const y = this.#shelfY + this.#padding;
    this.#rasterizer.draw(key, x, y);
    this.#shelfX = x + width;
    this.#shelfHeight = Math.max(this.#shelfHeight, height);
    this.#version += 1;

    const slot: GlyphSlot = { ...key, x, y, width, height, ...metricsOf(metrics) };
    this.#slots.set(id, slot);
    return slot;
  }

  /** Advance width in *world* units. */
  advance(key: GlyphKey): number {
    return (this.slot(key)?.advance ?? 0) / this.scale;
  }

  reset(): void {
    this.#slots.clear();
    this.#shelfX = 0;
    this.#shelfY = 0;
    this.#shelfHeight = 0;
    this.#full = false;
    this.#version += 1;
    this.#rasterizer.clear();
  }
}

const metricsOf = (
  metrics: GlyphMetrics,
): Pick<GlyphSlot, 'bearingX' | 'bearingY' | 'advance'> => ({
  bearingX: metrics.bearingX,
  bearingY: metrics.bearingY,
  advance: metrics.advance,
});
