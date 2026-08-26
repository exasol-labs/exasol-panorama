import type { Rgba } from '../theme.js';

/**
 * A renderer-independent description of one frame of a table.
 *
 * The draw list is deliberately flat and allocation-light: everything is a
 * quad or a text run, so the GPU layer uploads two batches per table rather
 * than creating a scene node per cell.
 */

export interface QuadInstance {
  /** Table-local coordinates: origin top-left, +y downwards. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly color: Rgba;
}

export interface PolygonInstance {
  /**
   * Four corners in world space, wound consistently:
   * `x0,y0, x1,y1, x2,y2, x3,y3`. Repeat a corner for a triangle.
   */
  readonly corners: readonly [number, number, number, number, number, number, number, number];
  readonly color: Rgba;
}

export type TextAlign = 'left' | 'right' | 'center';

export interface ClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A stretch of a run drawn in another colour.
 *
 * Named by character offset rather than by position, because the draw list has
 * no font to measure with — and the layer that does the measuring is the one
 * that lays glyphs out, so it is the one that can colour the fourth through
 * seventeenth of them without anybody guessing at pixel widths.
 */
export interface TextSpan {
  readonly from: number;
  readonly to: number;
  readonly color: Rgba;
}

export interface TextRun {
  readonly x: number;
  /** Top of the box the baseline is derived from — the *full* row, even when
   * only part of it is visible, so text never shifts as a row scrolls in. */
  readonly y: number;
  /** Available width; the text renderer truncates to fit. */
  readonly maxWidth: number;
  readonly height: number;
  readonly text: string;
  readonly color: Rgba;
  readonly align: TextAlign;
  readonly fontSize: number;
  readonly bold?: boolean;
  /** Glyphs are clipped to this rectangle, geometry and texture alike. */
  readonly clip?: ClipRect;
  /** Character ranges to draw in a different colour, e.g. a name that is not one. */
  readonly spans?: readonly TextSpan[];
}

/**
 * Geometry a chart hands over, in its own coordinates.
 *
 * Structurally what `@panorama/chart` produces, restated here so the renderer
 * depends on no chart library — not even on the package that defines the
 * interface one implements.
 */
export interface ChartDrawList {
  readonly polygons: readonly PolygonInstance[];
  readonly texts: readonly ChartTextRun[];
}

/**
 * How wide the renderer's own font makes a string.
 *
 * Handed to whatever lays a chart out, so the labels it positions are positioned
 * for the text that will actually be drawn. Getting this wrong is not subtle: an
 * axis spaced for a font nobody is looking at collides with itself.
 */
export interface ChartMetrics {
  measureText(text: string, fontSize: number, bold: boolean): number;
  readonly fontFamily: string;
}

export interface ChartTextRun {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly color: Rgba;
  readonly align: TextAlign;
  readonly fontSize: number;
  readonly bold?: boolean;
}

export interface TableDrawStats {
  readonly visibleRows: number;
  readonly renderedRows: number;
  readonly visibleColumns: number;
  readonly quads: number;
  readonly textRuns: number;
  readonly characters: number;
  readonly placeholderCells: number;
}

export interface TableDrawList {
  readonly quads: readonly QuadInstance[];
  /**
   * Shapes that are not axis-aligned rectangles: a chart's marks, and anything
   * else whose corners were not decided by a grid.
   */
  readonly polygons: readonly PolygonInstance[];
  readonly texts: readonly TextRun[];
  readonly stats: TableDrawStats;
}
