import type { Rgba } from '../theme.js';
import type { ClipRect, TextRun } from '../table/draw-list.js';
import type { GlyphAtlas } from './glyph-atlas.js';
import type { AdvanceFn } from './metrics.js';
import { alignOffset, baselineOffset, measureText, truncateToWidth } from './metrics.js';

/**
 * The Panorama text abstraction.
 *
 * The grid talks to this interface, never to a font implementation, so the
 * atlas renderer below can be swapped for a dedicated MSDF engine later
 * without touching the table.
 */

export interface GlyphQuad {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Atlas texture coordinates, normalised. */
  readonly u0: number;
  readonly v0: number;
  readonly u1: number;
  readonly v1: number;
  readonly color: Rgba;
}

export interface TextLayout {
  readonly quads: readonly GlyphQuad[];
  readonly width: number;
  readonly truncated: boolean;
}

export interface TextRenderer {
  /** Lays out one run, clipped to its box, in table-local coordinates. */
  layout(run: TextRun): TextLayout;
  measure(text: string, fontSize: number, bold: boolean): number;
  /** Lays out every run of a frame into a single batch. */
  layoutAll(runs: readonly TextRun[]): TextLayout;
}

/**
 * Trims a glyph to a clip rectangle, adjusting its texture coordinates by the
 * same proportion. This is what lets a partially visible row keep its baseline
 * instead of having its text squeezed into the sliver that shows.
 */
export const clipGlyph = (quad: GlyphQuad, clip: ClipRect | undefined): GlyphQuad | null => {
  if (clip === undefined) return quad;
  const left = Math.max(quad.x, clip.x);
  const top = Math.max(quad.y, clip.y);
  const right = Math.min(quad.x + quad.width, clip.x + clip.width);
  const bottom = Math.min(quad.y + quad.height, clip.y + clip.height);
  if (right <= left || bottom <= top) return null;
  if (
    left === quad.x &&
    top === quad.y &&
    right === quad.x + quad.width &&
    bottom === quad.y + quad.height
  ) {
    return quad;
  }

  const uPerPixel = (quad.u1 - quad.u0) / quad.width;
  const vPerPixel = (quad.v1 - quad.v0) / quad.height;
  return {
    x: left,
    y: top,
    width: right - left,
    height: bottom - top,
    u0: quad.u0 + (left - quad.x) * uPerPixel,
    v0: quad.v0 + (top - quad.y) * vPerPixel,
    u1: quad.u1 - (quad.x + quad.width - right) * uPerPixel,
    v1: quad.v1 - (quad.y + quad.height - bottom) * vPerPixel,
    color: quad.color,
  };
};

export class AtlasTextRenderer implements TextRenderer {
  readonly #atlas: GlyphAtlas;
  readonly #advance: AdvanceFn;

  constructor(atlas: GlyphAtlas) {
    this.#atlas = atlas;
    this.#advance = (char, fontSize, bold): number => atlas.advance({ char, fontSize, bold });
  }

  get atlas(): GlyphAtlas {
    return this.#atlas;
  }

  measure(text: string, fontSize: number, bold: boolean): number {
    return measureText(text, fontSize, bold, this.#advance);
  }

  layout(run: TextRun): TextLayout {
    const bold = run.bold === true;
    const fitted = truncateToWidth(run.text, run.maxWidth, run.fontSize, bold, this.#advance);
    if (fitted.text === '') return { quads: [], width: 0, truncated: fitted.truncated };

    const baseline = run.y + baselineOffset(run.height, run.fontSize);
    let penX = run.x + alignOffset(run.align, fitted.width, run.maxWidth);
    const quads: GlyphQuad[] = [];

    for (const char of fitted.text) {
      const slot = this.#atlas.slot({ char, fontSize: run.fontSize, bold });
      if (slot === null) break;
      if (slot.width > 0 && slot.height > 0) {
        // Slot metrics are atlas pixels; geometry is world units.
        const scale = this.#atlas.scale;
        const quad = clipGlyph(
          {
            x: penX + slot.bearingX / scale,
            y: baseline - slot.bearingY / scale,
            width: slot.width / scale,
            height: slot.height / scale,
            u0: slot.x / this.#atlas.width,
            v0: slot.y / this.#atlas.height,
            u1: (slot.x + slot.width) / this.#atlas.width,
            v1: (slot.y + slot.height) / this.#atlas.height,
            color: run.color,
          },
          run.clip,
        );
        if (quad !== null) quads.push(quad);
      }
      penX += slot.advance / this.#atlas.scale;
    }

    return { quads, width: fitted.width, truncated: fitted.truncated };
  }

  layoutAll(runs: readonly TextRun[]): TextLayout {
    const quads: GlyphQuad[] = [];
    let width = 0;
    let truncated = false;
    for (const run of runs) {
      const layout = this.layout(run);
      quads.push(...layout.quads);
      width = Math.max(width, layout.width);
      truncated = truncated || layout.truncated;
    }
    return { quads, width, truncated };
  }
}
