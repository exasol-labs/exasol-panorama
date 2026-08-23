import { describe, expect, it } from 'vitest';
import { RowCache, buildFloat64Vector, buildTextVector, createResultChunk } from '@panorama/table';

const chunkOf = (startRow: number, rowCount: number, base = 0) =>
  createResultChunk(startRow, rowCount, [
    buildFloat64Vector(Array.from({ length: rowCount }, (_, index) => base + index)),
    buildTextVector(Array.from({ length: rowCount }, (_, index) => `row-${startRow + index}`)),
  ]);

const clockFrom = (start = 0): (() => number) => {
  let now = start;
  return (): number => (now += 1);
};

describe('RowCache', () => {
  it('starts empty', () => {
    const cache = new RowCache({ blockSize: 4 });
    expect(cache.blockSize).toBe(4);
    expect(cache.bytes).toBe(0);
    expect(cache.stateOf(0)).toBe('absent');
    expect(cache.has(0)).toBe(false);
    expect(cache.chunk(0)).toBeNull();
    expect(cache.snapshot(0)).toBeUndefined();
    expect(cache.cell(0, 0)).toBeUndefined();
    expect(cache.stats()).toMatchObject({ loadedBlocks: 0, loadingBlocks: 0, failedBlocks: 0 });
  });

  it('tracks loading, loaded and failed blocks', () => {
    const cache = new RowCache({ blockSize: 4, clock: clockFrom() });
    cache.markLoading(0);
    expect(cache.stateOf(0)).toBe('loading');
    cache.put(0, chunkOf(0, 4));
    expect(cache.stateOf(0)).toBe('loaded');
    expect(cache.has(0)).toBe(true);
    expect(cache.bytes).toBeGreaterThan(0);

    expect(cache.chunk(0)).not.toBeNull();
    cache.markFailed(1, { code: 'fetch-failed', message: 'boom' });
    expect(cache.stateOf(1)).toBe('failed');
    expect(cache.snapshot(1)?.error?.message).toBe('boom');
    expect(cache.attempts(1)).toBe(1);
    expect(cache.failedAt(1)).toBeGreaterThan(0);
    expect(cache.stats()).toMatchObject({ loadedBlocks: 1, failedBlocks: 1 });
  });

  it('never downgrades a loaded block to loading', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(0, 4));
    cache.markLoading(0);
    expect(cache.stateOf(0)).toBe('loaded');
  });

  it('releases bytes when a loaded block fails or is replaced', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(0, 4));
    const bytes = cache.bytes;
    cache.put(0, chunkOf(0, 4));
    expect(cache.bytes).toBe(bytes);
    cache.markFailed(0, { code: 'fetch-failed', message: 'lost' });
    expect(cache.bytes).toBe(0);
  });

  it('reads cells by absolute result position', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(10, chunkOf(40, 4, 100));
    expect(cache.startRowOf(10)).toBe(40);
    expect(cache.cell(40, 0)).toBe(100);
    expect(cache.cell(43, 1)).toBe('row-43');
    // Unknown blocks, unknown columns and out-of-range rows read as undefined.
    expect(cache.cell(0, 0)).toBeUndefined();
    expect(cache.cell(-1, 0)).toBeUndefined();
    expect(cache.cell(40, 9)).toBeUndefined();
  });

  it('reads undefined for rows outside a short trailing block', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(0, 2));
    expect(cache.cell(1, 0)).toBe(1);
    expect(cache.cell(3, 0)).toBeUndefined();
  });

  it('reads undefined for a block whose chunk starts elsewhere', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(4, 4));
    expect(cache.cell(0, 0)).toBeUndefined();
  });

  it('evicts the least recently used block when over the byte budget', () => {
    const cache = new RowCache({ blockSize: 4, maxBytes: 200, clock: clockFrom() });
    cache.put(0, chunkOf(0, 4));
    cache.put(1, chunkOf(4, 4));
    cache.touch([0]);
    cache.put(2, chunkOf(8, 4));
    expect(cache.bytes).toBeLessThanOrEqual(200);
    expect(cache.has(1)).toBe(false);
    expect(cache.has(2)).toBe(true);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });

  it('respects the block-count ceiling for narrow rows', () => {
    const cache = new RowCache({ blockSize: 4, maxBytes: 1e9, maxBlocks: 2, clock: clockFrom() });
    cache.put(0, chunkOf(0, 4));
    cache.put(1, chunkOf(4, 4));
    cache.put(2, chunkOf(8, 4));
    expect(cache.stats().loadedBlocks).toBe(2);
    expect(cache.has(0)).toBe(false);
  });

  it('never evicts pinned blocks', () => {
    const cache = new RowCache({ blockSize: 4, maxBytes: 1, clock: clockFrom() });
    cache.pin([0]);
    cache.put(0, chunkOf(0, 4));
    cache.put(1, chunkOf(4, 4));
    expect(cache.has(0)).toBe(true);
    expect(cache.has(1)).toBe(false);
    // Re-pinning replaces the previous pin set.
    cache.pin([1]);
    cache.put(1, chunkOf(4, 4));
    expect(cache.has(1)).toBe(true);
  });

  it('ignores touches for unknown blocks', () => {
    const cache = new RowCache({ blockSize: 4 });
    expect(() => cache.touch([99])).not.toThrow();
  });

  it('deletes blocks', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(0, 4));
    expect(cache.delete(0)).toBe(true);
    expect(cache.delete(0)).toBe(false);
    expect(cache.bytes).toBe(0);
  });

  it('clears and invalidates', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(0, 4));
    cache.clear();
    expect(cache.stats().loadedBlocks).toBe(0);
    expect(cache.generation).toBe(0);

    cache.put(0, chunkOf(0, 4));
    expect(cache.invalidate()).toBe(1);
    expect(cache.generation).toBe(1);
    expect(cache.bytes).toBe(0);
    expect(cache.has(0)).toBe(false);
  });

  it('keeps memory bounded regardless of how far the user scrolls', () => {
    const cache = new RowCache({ blockSize: 256, maxBytes: 64_000, clock: clockFrom() });
    for (let block = 0; block < 1_000; block += 1) {
      cache.pin([block]);
      cache.put(block, chunkOf(block * 256, 256));
    }
    expect(cache.bytes).toBeLessThan(200_000);
    expect(cache.stats().loadedBlocks).toBeLessThan(20);
  });

  it('reports defaults for unknown blocks and applies default limits', () => {
    const cache = new RowCache();
    expect(cache.blockSize).toBe(256);
    expect(cache.attempts(7)).toBe(0);
    expect(cache.failedAt(7)).toBe(0);
    cache.markLoading(7);
    expect(cache.chunk(7)).toBeNull();
    expect(cache.stats()).toMatchObject({ loadingBlocks: 1, maxBytes: 64 * 1024 * 1024 });
  });

  it('uses the wall clock by default', () => {
    const cache = new RowCache({ blockSize: 4 });
    cache.put(0, chunkOf(0, 4));
    expect(cache.snapshot(0)?.lastAccess).toBeGreaterThan(0);
  });
});
