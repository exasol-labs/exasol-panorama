import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY_POLICY,
  PRIORITY_VISIBLE,
  computeDesiredBlocks,
  shouldRetryBlock,
} from '@panorama/table';

const indices = (blocks: readonly { index: number }[]): number[] =>
  blocks.map((block) => block.index);

describe('computeDesiredBlocks', () => {
  const base = {
    firstVisibleRow: 1_024,
    visibleRowCount: 34,
    blockSize: 256,
    rowCount: 1_000_000,
  };

  it('gives the visible blocks the highest priority', () => {
    const blocks = computeDesiredBlocks({ ...base, velocityY: 0 });
    const visible = blocks.filter((block) => block.priority === PRIORITY_VISIBLE);
    expect(indices(visible)).toEqual([4]);
    expect(blocks[0]?.index).toBe(4);
  });

  it('prefers blocks below the viewport when scrolling down', () => {
    const blocks = computeDesiredBlocks({ ...base, velocityY: 1_200 });
    expect(indices(blocks).slice(0, 3)).toEqual([4, 5, 3]);
    // Depth ahead exceeds depth behind.
    expect(indices(blocks)).toContain(7);
    expect(indices(blocks)).not.toContain(2);
  });

  it('prefers blocks above the viewport when scrolling up', () => {
    const blocks = computeDesiredBlocks({ ...base, velocityY: -1_200 });
    expect(indices(blocks).slice(0, 3)).toEqual([4, 3, 5]);
    expect(indices(blocks)).toContain(1);
    expect(indices(blocks)).not.toContain(6);
  });

  it('reprioritises immediately when the direction reverses', () => {
    const down = computeDesiredBlocks({ ...base, velocityY: 1_200 });
    const up = computeDesiredBlocks({ ...base, velocityY: -1_200 });
    expect(down[1]?.index).toBe(5);
    expect(up[1]?.index).toBe(3);
  });

  it('is symmetric when effectively stationary', () => {
    const blocks = computeDesiredBlocks({ ...base, velocityY: 10 });
    expect(indices(blocks)).toContain(3);
    expect(indices(blocks)).toContain(5);
    expect(indices(blocks)).toContain(7);
    expect(indices(blocks)).toContain(1);
  });

  it('never asks for blocks before the start or past the end', () => {
    const atTop = computeDesiredBlocks({ ...base, firstVisibleRow: 0, velocityY: -1_000 });
    expect(indices(atTop)).toEqual([0, 1]);
    const nearTop = computeDesiredBlocks({ ...base, firstVisibleRow: 300, velocityY: -1_000 });
    expect(Math.min(...indices(nearTop))).toBe(0);

    const atEnd = computeDesiredBlocks({
      ...base,
      firstVisibleRow: 900,
      visibleRowCount: 34,
      rowCount: 1_000,
      velocityY: 1_000,
    });
    expect(Math.max(...indices(atEnd))).toBe(3);
  });

  it('handles unknown and empty row counts', () => {
    expect(computeDesiredBlocks({ ...base, rowCount: null, velocityY: 0 }).length).toBeGreaterThan(
      0,
    );
    expect(computeDesiredBlocks({ ...base, rowCount: 0, velocityY: 0 })).toEqual([]);
    expect(
      computeDesiredBlocks({ ...base, rowCount: 0, visibleRowCount: 0, velocityY: 0 }),
    ).toEqual([]);
  });

  it('still requests the first block for a zero-height viewport', () => {
    const blocks = computeDesiredBlocks({
      ...base,
      firstVisibleRow: 0,
      visibleRowCount: 0,
      velocityY: 0,
    });
    expect(indices(blocks)).toContain(0);
  });

  it('supports a deeper trailing than leading buffer', () => {
    const blocks = computeDesiredBlocks({
      ...base,
      velocityY: 1_000,
      aheadBlocks: 0,
      behindBlocks: 2,
    });
    expect(indices(blocks)).toEqual([4, 3, 2]);
  });

  it('honours explicit depths', () => {
    const blocks = computeDesiredBlocks({
      ...base,
      velocityY: 1_000,
      aheadBlocks: 1,
      behindBlocks: 0,
    });
    expect(indices(blocks)).toEqual([4, 5]);
  });

  it('spans several blocks for a tall viewport', () => {
    const blocks = computeDesiredBlocks({
      ...base,
      firstVisibleRow: 200,
      visibleRowCount: 600,
      velocityY: 0,
      aheadBlocks: 0,
      behindBlocks: 0,
    });
    expect(indices(blocks)).toEqual([0, 1, 2, 3]);
  });
});

describe('shouldRetryBlock', () => {
  it('retries immediately when nothing has been attempted', () => {
    expect(shouldRetryBlock(0, 0, 1_000)).toBe(true);
  });

  it('backs off exponentially and eventually gives up', () => {
    expect(shouldRetryBlock(1, 1_000, 1_100)).toBe(false);
    expect(shouldRetryBlock(1, 1_000, 1_300)).toBe(true);
    expect(shouldRetryBlock(2, 1_000, 1_400)).toBe(false);
    expect(shouldRetryBlock(2, 1_000, 1_600)).toBe(true);
    expect(shouldRetryBlock(DEFAULT_RETRY_POLICY.maxAttempts, 0, 1e9)).toBe(false);
  });

  it('caps the delay', () => {
    expect(
      shouldRetryBlock(3, 0, 5_000, { maxAttempts: 10, baseDelayMs: 1_000, maxDelayMs: 2_000 }),
    ).toBe(true);
  });
});
