import { describe, expect, it, vi } from 'vitest';
import type { ResultChunk } from '@panorama/table';
import { FetchScheduler, buildFloat64Vector, createResultChunk } from '@panorama/table';

interface Deferred {
  readonly promise: Promise<ResultChunk>;
  resolve(chunk: ResultChunk): void;
  reject(error: unknown): void;
  readonly signal: AbortSignal;
}

const chunkFor = (blockIndex: number): ResultChunk =>
  createResultChunk(blockIndex * 4, 4, [buildFloat64Vector([1, 2, 3, 4])]);

/** Test harness: fetches complete only when the test says so. */
const harness = (options: { maxConcurrent?: number } = {}) => {
  const pending = new Map<number, Deferred>();
  const loaded: number[] = [];
  const failed: Array<{ index: number; error: unknown }> = [];
  const started: number[] = [];
  let now = 0;

  const scheduler = new FetchScheduler({
    ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
    clock: (): number => now,
    execute: (blockIndex, signal) => {
      let resolve!: (chunk: ResultChunk) => void;
      let reject!: (error: unknown) => void;
      const promise = new Promise<ResultChunk>((resolveFn, rejectFn) => {
        resolve = resolveFn;
        reject = rejectFn;
      });
      pending.set(blockIndex, { promise, resolve, reject, signal });
      return promise;
    },
    onLoaded: (blockIndex) => loaded.push(blockIndex),
    onFailed: (blockIndex, error) => failed.push({ index: blockIndex, error }),
    onStarted: (blockIndex) => started.push(blockIndex),
  });

  const settle = async (blockIndex: number): Promise<void> => {
    const deferred = pending.get(blockIndex);
    if (deferred === undefined) throw new Error(`Block ${blockIndex} is not in flight`);
    pending.delete(blockIndex);
    deferred.resolve(chunkFor(blockIndex));
    await Promise.resolve();
    await Promise.resolve();
  };

  const fail = async (blockIndex: number, error: unknown): Promise<void> => {
    const deferred = pending.get(blockIndex);
    if (deferred === undefined) throw new Error(`Block ${blockIndex} is not in flight`);
    pending.delete(blockIndex);
    deferred.reject(error);
    await Promise.resolve();
    await Promise.resolve();
  };

  return {
    scheduler,
    pending,
    loaded,
    failed,
    started,
    settle,
    fail,
    advance: (ms: number): void => {
      now += ms;
    },
  };
};

describe('FetchScheduler', () => {
  it('runs the highest-priority blocks first, within the concurrency limit', () => {
    const { scheduler, started } = harness({ maxConcurrent: 2 });
    scheduler.setDesired([
      { index: 9, priority: 2 },
      { index: 4, priority: 0 },
      { index: 5, priority: 1 },
    ]);
    expect(started).toEqual([4, 5]);
    expect(scheduler.inFlightCount).toBe(2);
    expect(scheduler.queuedCount).toBe(1);
  });

  it('starts the next queued block as each fetch settles', async () => {
    const test = harness({ maxConcurrent: 1 });
    test.scheduler.setDesired([
      { index: 0, priority: 0 },
      { index: 1, priority: 1 },
    ]);
    expect(test.started).toEqual([0]);
    await test.settle(0);
    expect(test.loaded).toEqual([0]);
    expect(test.started).toEqual([0, 1]);
  });

  it('suppresses duplicates', () => {
    const { scheduler, started } = harness({ maxConcurrent: 4 });
    scheduler.setDesired([
      { index: 4, priority: 3 },
      { index: 4, priority: 0 },
      { index: 4, priority: 2 },
    ]);
    expect(started).toEqual([4]);
    scheduler.setDesired([
      { index: 4, priority: 0 },
      { index: 5, priority: 1 },
    ]);
    expect(started).toEqual([4, 5]);
  });

  it('aborts in-flight fetches that are no longer wanted', () => {
    const test = harness({ maxConcurrent: 2 });
    test.scheduler.setDesired([
      { index: 0, priority: 0 },
      { index: 1, priority: 1 },
    ]);
    const aborted = test.pending.get(1)?.signal;
    test.scheduler.setDesired([{ index: 0, priority: 0 }]);
    expect(aborted?.aborted).toBe(true);
    expect(test.scheduler.stats().cancelled).toBe(1);
  });

  it('ignores results for cancelled requests', async () => {
    const test = harness({ maxConcurrent: 2 });
    test.scheduler.setDesired([
      { index: 0, priority: 0 },
      { index: 1, priority: 1 },
    ]);
    test.scheduler.setDesired([{ index: 0, priority: 0 }]);
    await test.settle(1);
    expect(test.loaded).toEqual([]);
  });

  it('rejects stale results after invalidation', async () => {
    const test = harness({ maxConcurrent: 2 });
    test.scheduler.setDesired([{ index: 0, priority: 0 }]);
    expect(test.scheduler.invalidate()).toBe(1);
    await test.settle(0);
    expect(test.loaded).toEqual([]);
    expect(test.scheduler.inFlightCount).toBe(0);
    expect(test.scheduler.queuedCount).toBe(0);
  });

  it('reports failures', async () => {
    const test = harness();
    test.scheduler.setDesired([{ index: 3, priority: 0 }]);
    await test.fail(3, new Error('network'));
    expect(test.failed).toHaveLength(1);
    expect(test.failed[0]?.index).toBe(3);
    expect(test.scheduler.stats().failed).toBe(1);
  });

  it('consults shouldFetch before starting a block', () => {
    const execute = vi.fn(async () => chunkFor(0));
    const scheduler = new FetchScheduler({
      execute,
      onLoaded: () => {},
      onFailed: () => {},
      shouldFetch: (blockIndex) => blockIndex !== 1,
    });
    scheduler.setDesired([
      { index: 0, priority: 0 },
      { index: 1, priority: 1 },
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('measures latency', async () => {
    const test = harness();
    test.scheduler.setDesired([{ index: 0, priority: 0 }]);
    test.advance(120);
    await test.settle(0);
    expect(test.scheduler.stats().lastLatencyMs).toBe(120);
    expect(test.scheduler.stats().averageLatencyMs).toBe(120);

    test.scheduler.setDesired([{ index: 1, priority: 0 }]);
    test.advance(20);
    await test.settle(1);
    expect(test.scheduler.stats().lastLatencyMs).toBe(20);
    expect(test.scheduler.stats().averageLatencyMs).toBe(100);
  });

  it('stops accepting work once disposed', async () => {
    const test = harness();
    test.scheduler.setDesired([{ index: 0, priority: 0 }]);
    const inFlight = test.pending.get(0);
    test.scheduler.dispose();
    expect(inFlight?.signal.aborted).toBe(true);
    test.scheduler.setDesired([{ index: 1, priority: 0 }]);
    test.scheduler.pump();
    expect(test.started).toEqual([0]);
    await test.settle(0);
    expect(test.loaded).toEqual([]);
  });

  it('uses the wall clock and default concurrency by default', () => {
    const scheduler = new FetchScheduler({
      execute: async () => chunkFor(0),
      onLoaded: () => {},
      onFailed: () => {},
    });
    scheduler.setDesired([
      { index: 0, priority: 0 },
      { index: 1, priority: 0 },
      { index: 2, priority: 0 },
      { index: 3, priority: 0 },
    ]);
    expect(scheduler.inFlightCount).toBe(3);
    expect(scheduler.generation).toBe(0);
    expect(scheduler.stats().lastLatencyMs).toBe(0);
  });
});
