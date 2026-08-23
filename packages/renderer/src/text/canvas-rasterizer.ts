import type { GlyphKey, GlyphMetrics, GlyphRasterizer } from './glyph-atlas.js';

/**
 * Rasterises glyphs with a 2D canvas into an atlas bitmap.
 *
 * The canvas is a private implementation detail of the text subsystem: no DOM
 * grid is ever created, so nothing here prevents the same renderer running in
 * WebXR.
 */

export interface TextMetricsLike {
  readonly width: number;
  readonly actualBoundingBoxLeft?: number;
  readonly actualBoundingBoxRight?: number;
  readonly actualBoundingBoxAscent?: number;
  readonly actualBoundingBoxDescent?: number;
}

export interface CanvasRenderingContext2DLike {
  font: string;
  fillStyle: string;
  textBaseline: string;
  textAlign: string;
  measureText(text: string): TextMetricsLike;
  fillText(text: string, x: number, y: number): void;
  clearRect(x: number, y: number, width: number, height: number): void;
}

export interface CanvasRasterizerOptions {
  readonly context: CanvasRenderingContext2DLike;
  readonly width: number;
  readonly height: number;
  readonly fontFamily?: string;
  /** Extra pixels around each glyph, absorbing antialiasing. */
  readonly padding?: number;
  /** Device pixel ratio the atlas is rasterised at. */
  readonly pixelRatio?: number;
  /** Notified after every draw so the texture can be re-uploaded. */
  readonly onDirty?: () => void;
}

export const DEFAULT_FONT_FAMILY =
  "'SF Mono', 'Segoe UI', 'Inter', system-ui, -apple-system, sans-serif";

export class CanvasGlyphRasterizer implements GlyphRasterizer {
  readonly #context: CanvasRenderingContext2DLike;
  readonly #width: number;
  readonly #height: number;
  readonly #fontFamily: string;
  readonly #padding: number;
  readonly #pixelRatio: number;
  readonly #onDirty: (() => void) | undefined;

  constructor(options: CanvasRasterizerOptions) {
    const context = options.context;
    this.#width = options.width;
    this.#height = options.height;
    this.#onDirty = options.onDirty;
    this.#context = context;
    this.#fontFamily = options.fontFamily ?? DEFAULT_FONT_FAMILY;
    this.#padding = options.padding ?? 1;
    this.#pixelRatio = options.pixelRatio ?? 1;
    this.#context.textBaseline = 'alphabetic';
    this.#context.textAlign = 'left';
    this.#context.fillStyle = '#ffffff';
  }

  #font(key: GlyphKey): string {
    const size = key.fontSize * this.#pixelRatio;
    return `${key.bold ? '600 ' : ''}${size}px ${this.#fontFamily}`;
  }

  measure(key: GlyphKey): GlyphMetrics {
    this.#context.font = this.#font(key);
    const metrics = this.#context.measureText(key.char);
    const left = metrics.actualBoundingBoxLeft ?? 0;
    const right = metrics.actualBoundingBoxRight ?? metrics.width;
    const ascent = metrics.actualBoundingBoxAscent ?? key.fontSize * this.#pixelRatio * 0.8;
    const descent = metrics.actualBoundingBoxDescent ?? key.fontSize * this.#pixelRatio * 0.2;
    const width = Math.max(0, right + left);
    const height = Math.max(0, ascent + descent);
    const pad = this.#padding;
    return {
      width: width === 0 ? 0 : width + pad * 2,
      height: height === 0 ? 0 : height + pad * 2,
      bearingX: -left - pad,
      bearingY: ascent + pad,
      advance: metrics.width,
    };
  }

  draw(key: GlyphKey, x: number, y: number): void {
    const metrics = this.measure(key);
    this.#context.font = this.#font(key);
    this.#context.fillStyle = '#ffffff';
    this.#context.fillText(key.char, x - metrics.bearingX, y + metrics.bearingY);
    this.#onDirty?.();
  }

  clear(): void {
    this.#context.clearRect(0, 0, this.#width, this.#height);
    this.#onDirty?.();
  }
}
