/**
 * Text measurement and truncation.
 *
 * Kept pure and injectable so cell clipping is provable without a canvas —
 * "correct clipping" is one of the Stage 1 text requirements, and it is far
 * too easy to get wrong by an off-by-one at the ellipsis.
 */

import type { TextAlign } from '../table/draw-list.js';

export type AdvanceFn = (char: string, fontSize: number, bold: boolean) => number;

export const ELLIPSIS = '…';

export interface MeasuredText {
  readonly text: string;
  readonly width: number;
  readonly truncated: boolean;
}

export const measureText = (
  text: string,
  fontSize: number,
  bold: boolean,
  advance: AdvanceFn,
): number => {
  let width = 0;
  for (const char of text) width += advance(char, fontSize, bold);
  return width;
};

/**
 * Truncates to fit `maxWidth`, appending an ellipsis. Returns an empty string
 * when not even the ellipsis fits, which is better than a clipped smear.
 */
export const truncateToWidth = (
  text: string,
  maxWidth: number,
  fontSize: number,
  bold: boolean,
  advance: AdvanceFn,
): MeasuredText => {
  if (maxWidth <= 0) return { text: '', width: 0, truncated: text.length > 0 };
  const full = measureText(text, fontSize, bold, advance);
  if (full <= maxWidth) return { text, width: full, truncated: false };

  const ellipsisWidth = advance(ELLIPSIS, fontSize, bold);
  if (ellipsisWidth > maxWidth) return { text: '', width: 0, truncated: true };

  const characters = [...text];
  let width = ellipsisWidth;
  let kept = 0;
  for (const char of characters) {
    const next = advance(char, fontSize, bold);
    if (width + next > maxWidth) break;
    width += next;
    kept += 1;
  }
  return {
    text: `${characters.slice(0, kept).join('')}${ELLIPSIS}`,
    width,
    truncated: true,
  };
};

/** Horizontal offset of a run of `width` inside a box of `maxWidth`. */
export const alignOffset = (align: TextAlign, width: number, maxWidth: number): number => {
  if (align === 'right') return Math.max(0, maxWidth - width);
  if (align === 'center') return Math.max(0, (maxWidth - width) / 2);
  return 0;
};

/**
 * Baseline offset from the top of a box, centring the text optically. Cap
 * height is approximated as 0.72 em, which lines up digits and capitals well
 * enough for a data grid.
 */
export const baselineOffset = (boxHeight: number, fontSize: number): number =>
  Math.round((boxHeight + fontSize * 0.72) / 2);
