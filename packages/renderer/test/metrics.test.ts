import { describe, expect, it } from 'vitest';
import {
  ELLIPSIS,
  alignOffset,
  baselineOffset,
  measureText,
  truncateToWidth,
} from '@panorama/renderer';

/** Every glyph is one unit wide per point of font size; bold is 20% wider. */
const advance = (char: string, fontSize: number, bold: boolean): number =>
  char === ' ' ? fontSize * 0.5 : fontSize * (bold ? 1.2 : 1);

describe('measureText', () => {
  it('sums advances', () => {
    expect(measureText('abc', 10, false, advance)).toBe(30);
    expect(measureText('abc', 10, true, advance)).toBe(36);
    expect(measureText('', 10, false, advance)).toBe(0);
    expect(measureText('a b', 10, false, advance)).toBe(25);
  });

  it('counts astral characters once', () => {
    expect(measureText('a😀', 10, false, advance)).toBe(20);
  });
});

describe('truncateToWidth', () => {
  it('keeps text that fits', () => {
    expect(truncateToWidth('abc', 100, 10, false, advance)).toEqual({
      text: 'abc',
      width: 30,
      truncated: false,
    });
  });

  it('keeps text that exactly fits', () => {
    expect(truncateToWidth('abc', 30, 10, false, advance).truncated).toBe(false);
  });

  it('appends an ellipsis when clipping', () => {
    const result = truncateToWidth('abcdef', 35, 10, false, advance);
    expect(result.text).toBe(`ab${ELLIPSIS}`);
    expect(result.width).toBe(30);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing when not even the ellipsis fits', () => {
    expect(truncateToWidth('abcdef', 5, 10, false, advance)).toEqual({
      text: '',
      width: 0,
      truncated: true,
    });
  });

  it('handles a non-positive box', () => {
    expect(truncateToWidth('abc', 0, 10, false, advance)).toEqual({
      text: '',
      width: 0,
      truncated: true,
    });
    expect(truncateToWidth('', 0, 10, false, advance).truncated).toBe(false);
  });
});

describe('alignment', () => {
  it('positions runs inside their box', () => {
    expect(alignOffset('left', 30, 100)).toBe(0);
    expect(alignOffset('right', 30, 100)).toBe(70);
    expect(alignOffset('center', 30, 100)).toBe(35);
  });

  it('never pushes overflowing text out of the box', () => {
    expect(alignOffset('right', 200, 100)).toBe(0);
    expect(alignOffset('center', 200, 100)).toBe(0);
  });
});

describe('baselineOffset', () => {
  it('optically centres the cap height', () => {
    expect(baselineOffset(24, 12)).toBe(16);
    expect(baselineOffset(0, 0)).toBe(0);
  });
});
