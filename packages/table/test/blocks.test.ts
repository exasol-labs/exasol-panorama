import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BLOCK_SIZE,
  blockCountForRows,
  blockIndexForRow,
  blockRowCount,
  blockStartRow,
  blocksForRows,
  clampBlockIndex,
} from '@panorama/table';

describe('block arithmetic', () => {
  it('maps rows to blocks', () => {
    expect(DEFAULT_BLOCK_SIZE).toBe(256);
    expect(blockIndexForRow(0, 256)).toBe(0);
    expect(blockIndexForRow(255, 256)).toBe(0);
    expect(blockIndexForRow(256, 256)).toBe(1);
    expect(blockIndexForRow(10_240, 256)).toBe(40);
    expect(blockStartRow(40, 256)).toBe(10_240);
  });

  it('reports rows in a block, honouring the end of the result set', () => {
    expect(blockRowCount(0, 256, null)).toBe(256);
    expect(blockRowCount(0, 256, 1_000)).toBe(256);
    expect(blockRowCount(3, 256, 1_000)).toBe(1_000 - 768);
    expect(blockRowCount(4, 256, 1_000)).toBe(0);
  });

  it('covers a row range', () => {
    expect(blocksForRows(0, 256, 256)).toEqual({ first: 0, last: 0 });
    expect(blocksForRows(0, 257, 256)).toEqual({ first: 0, last: 1 });
    expect(blocksForRows(4_300, 34, 256)).toEqual({ first: 16, last: 16 });
    expect(blocksForRows(4_090, 20, 256)).toEqual({ first: 15, last: 16 });
    // Degenerate ranges collapse onto the starting block.
    expect(blocksForRows(500, 0, 256)).toEqual({ first: 1, last: 1 });
    expect(blocksForRows(-10, 5, 256)).toEqual({ first: 0, last: 0 });
  });

  it('counts and clamps blocks', () => {
    expect(blockCountForRows(null, 256)).toBeNull();
    expect(blockCountForRows(0, 256)).toBe(0);
    expect(blockCountForRows(257, 256)).toBe(2);
    expect(clampBlockIndex(-5, 1_000, 256)).toBe(0);
    expect(clampBlockIndex(99, 1_000, 256)).toBe(3);
    expect(clampBlockIndex(99, null, 256)).toBe(99);
    expect(clampBlockIndex(3, 0, 256)).toBe(0);
  });
});
