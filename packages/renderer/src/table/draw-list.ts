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

export type TextAlign = 'left' | 'right' | 'center';

export interface ClipRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
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
  readonly texts: readonly TextRun[];
  readonly stats: TableDrawStats;
}
