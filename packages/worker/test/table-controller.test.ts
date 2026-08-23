import { describe, expect, it, vi } from 'vitest';
import type { DesiredBlock } from '@panorama/table';
import { TableDataController } from '@panorama/worker';
import type { EntityId } from '@panorama/core';
import { buildFloat64Vector, createResultChunk } from '@panorama/table';
import { ManualScheduler } from '@panorama/test-support';
import { TABLE_ID, createWorkerHarness, stubGateway } from './harness.js';

const controllerWith = (
  harness: ReturnType<typeof createWorkerHarness>,
  overrides: Partial<ConstructorParameters<typeof TableDataController>[0]> = {},
): { controller: TableDataController; changes: () => number; retries: ManualScheduler } => {
  let changes = 0;
  const retries = new ManualScheduler();
  const controller = new TableDataController({
    tableId: TABLE_ID,
    gateway: harness.client,
    blockSize: 256,
    onChange: () => {
      changes += 1;
    },
    schedule: retries.schedule,
    // Share the retry scheduler's virtual clock so backoff is deterministic.
    clock: () => retries.now,
    ...overrides,
  });
  return { controller, changes: () => changes, retries };
};

describe('TableDataController', () => {
  it('requests the visible blocks as soon as the table opens', async () => {
    const harness = createWorkerHarness();
    const { controller } = controllerWith(harness);
    const requested: DesiredBlock[][] = [];
    const original = harness.client.requestBlocks.bind(harness.client);
    vi.spyOn(harness.client, 'requestBlocks').mockImplementation(
      (tableId, generation, blockSize, blocks) => {
        requested.push([...blocks]);
        original(tableId, generation, blockSize, blocks);
      },
    );

    await controller.open('PANORAMA_TEST', 'SALES');
    expect(controller.rowCount).toBe(10_000);
    expect(controller.schema?.columns).toHaveLength(4);
    expect(controller.blockSize).toBe(256);
    expect(requested[0]?.[0]?.index).toBe(0);
  });

  it('serves cells synchronously once blocks arrive', async () => {
    const harness = createWorkerHarness();
    const { controller, changes } = controllerWith(harness);
    await controller.open('PANORAMA_TEST', 'SALES');

    controller.setViewport({ firstVisibleRow: 1_024, visibleRowCount: 34, velocityY: 0 });
    expect(controller.cell(1_024, 0)).toBeUndefined();
    expect(controller.isRangeLoaded(1_024, 34)).toBe(false);

    await harness.settle();
    expect(controller.cell(1_024, 0)).toBe(1_024);
    expect(controller.cell(1_057, 1)).toBe('Denmark');
    expect(controller.isRangeLoaded(1_024, 34)).toBe(true);
    expect(controller.isRangeLoaded(0, 0)).toBe(true);
    expect(changes()).toBeGreaterThan(0);
  });

  it('prefetches ahead of a downward scroll', async () => {
    const harness = createWorkerHarness();
    const { controller } = controllerWith(harness, { aheadBlocks: 2, behindBlocks: 0 });
    await controller.open('PANORAMA_TEST', 'SALES');

    controller.setViewport({ firstVisibleRow: 1_024, visibleRowCount: 34, velocityY: 2_000 });
    await harness.settle();

    expect(controller.cell(1_024, 0)).toBe(1_024);
    expect(controller.cell(1_280, 0)).toBe(1_280);
    expect(controller.cell(1_536, 0)).toBe(1_536);
    // Nothing behind the viewport was requested.
    expect(controller.cell(768, 0)).toBeUndefined();
  });

  it('does not re-request blocks it already has', async () => {
    const harness = createWorkerHarness();
    const { controller } = controllerWith(harness);
    await controller.open('PANORAMA_TEST', 'SALES');
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });
    await harness.settle();
    const fetchesAfterFirst = harness.sources.get('PANORAMA_TEST.SALES')?.stats().fetches ?? 0;

    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });
    await harness.settle();
    expect(harness.sources.get('PANORAMA_TEST.SALES')?.stats().fetches).toBe(fetchesAfterFirst);
  });

  it('keeps memory bounded while scrolling through a huge relation', async () => {
    const harness = createWorkerHarness({
      source: { relation: { ...harnessRelation(), rowCount: 10_000_000_000 } },
    });
    const { controller } = controllerWith(harness, { maxBytes: 400_000, aheadBlocks: 1 });
    await controller.open('PANORAMA_TEST', 'SALES');

    for (let row = 0; row < 200_000; row += 5_000) {
      controller.setViewport({ firstVisibleRow: row, visibleRowCount: 34, velocityY: 3_000 });
      await harness.settle();
    }
    const stats = controller.status().cache;
    expect(stats.bytes).toBeLessThanOrEqual(500_000);
    expect(stats.evictions).toBeGreaterThan(0);
  });

  it('retries a failed block with backoff and recovers', async () => {
    const harness = createWorkerHarness({ source: { failure: { firstAttempts: 1 } } });
    const { controller, retries } = controllerWith(harness);
    await controller.open('PANORAMA_TEST', 'SALES');

    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });
    await harness.settle();
    expect(controller.cell(0, 0)).toBeUndefined();
    expect(controller.status().lastError?.code).toBe('fetch-failed');
    expect(controller.status().cache.failedBlocks).toBeGreaterThan(0);

    retries.advance(1_000);
    await harness.settle();
    expect(controller.cell(0, 0)).toBe(0);
  });

  it('gives up after the retry budget is exhausted', async () => {
    const harness = createWorkerHarness({ source: { failure: { everyNth: 1 } } });
    const { controller, retries } = controllerWith(harness, {
      retry: { maxAttempts: 2, baseDelayMs: 10 },
      aheadBlocks: 0,
      behindBlocks: 0,
    });
    await controller.open('PANORAMA_TEST', 'SALES');
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });

    for (let round = 0; round < 5; round += 1) {
      await harness.settle();
      retries.advance(1_000);
    }
    await harness.settle();
    const fetches = harness.sources.get('PANORAMA_TEST.SALES')?.stats().fetches ?? 0;
    expect(fetches).toBe(2);
    expect(controller.cell(0, 0)).toBeUndefined();
  });

  it('ignores rows belonging to a superseded generation', async () => {
    const harness = createWorkerHarness({ source: { latency: 100 } });
    const { controller } = controllerWith(harness);
    await controller.open('PANORAMA_TEST', 'SALES');
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });

    await controller.reopen();
    expect(controller.generation).toBe(1);
    await harness.settle();
    // Data for the new result set arrives; nothing from the old one leaked in.
    expect(controller.status().generation).toBe(1);
    expect(controller.cell(0, 0)).toBe(0);
  });

  it('ignores events addressed to other tables', async () => {
    const gateway = stubGateway();
    const controller = new TableDataController({ tableId: TABLE_ID, gateway });
    await controller.open('PANORAMA_TEST', 'SALES');

    const chunk = createResultChunk(0, 2, [buildFloat64Vector([1, 2])]);
    gateway.emitRows({
      tableId: 'table:other' as EntityId,
      generation: 0,
      blockIndex: 0,
      chunk,
    });
    gateway.emitFailure({
      tableId: 'table:other' as EntityId,
      generation: 0,
      blockIndex: 0,
      error: { code: 'fetch-failed', message: 'other table' },
    });
    expect(controller.cell(0, 0)).toBeUndefined();
    expect(controller.status().lastError).toBeNull();

    // A stale generation for our own table is dropped too.
    gateway.emitRows({ tableId: TABLE_ID, generation: 99, blockIndex: 0, chunk });
    gateway.emitFailure({
      tableId: TABLE_ID,
      generation: 99,
      blockIndex: 0,
      error: { code: 'fetch-failed', message: 'stale' },
    });
    expect(controller.cell(0, 0)).toBeUndefined();
    expect(controller.status().lastError).toBeNull();
  });

  it('reports status for instrumentation', async () => {
    const harness = createWorkerHarness({ source: { latency: 50 } });
    const { controller } = controllerWith(harness);
    await controller.open('PANORAMA_TEST', 'SALES');
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });

    const pending = controller.status();
    expect(pending.pendingBlocks).toBeGreaterThan(0);
    expect(pending.rowCount).toBe(10_000);
    expect(pending.lastError).toBeNull();

    await harness.settle();
    expect(controller.status().pendingBlocks).toBe(0);
    expect(controller.status().cache.loadedBlocks).toBeGreaterThan(0);
  });

  it('does nothing before the table is opened or after it is closed', async () => {
    const harness = createWorkerHarness();
    const { controller } = controllerWith(harness);
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });
    expect(controller.status().cache.loadedBlocks).toBe(0);

    await controller.open('PANORAMA_TEST', 'SALES');
    await controller.close();
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });
    await harness.settle();
    expect(controller.cell(0, 0)).toBeUndefined();
    // Closing twice is harmless.
    await expect(controller.close()).resolves.toBeUndefined();
  });

  it('schedules retries on real timers when no scheduler is injected', async () => {
    vi.useFakeTimers();
    try {
      const harness = createWorkerHarness({ source: { failure: { firstAttempts: 1 } } });
      const controller = new TableDataController({
        tableId: TABLE_ID,
        gateway: harness.client,
        blockSize: 256,
        aheadBlocks: 0,
        behindBlocks: 0,
      });
      await controller.open('PANORAMA_TEST', 'SALES');
      controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 34, velocityY: 0 });
      await harness.settle();
      expect(controller.status().cache.failedBlocks).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      await harness.settle();
      expect(controller.cell(0, 0)).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses real timers and defaults when none are injected', async () => {
    const harness = createWorkerHarness();
    const controller = new TableDataController({ tableId: TABLE_ID, gateway: harness.client });
    await controller.open('PANORAMA_TEST', 'SALES');
    controller.setViewport({ firstVisibleRow: 0, visibleRowCount: 10, velocityY: 0 });
    await harness.settle();
    expect(controller.cell(0, 0)).toBe(0);
    expect(controller.blockSize).toBe(256);
  });
});

const harnessRelation = () => ({
  schema: 'PANORAMA_TEST',
  table: 'SALES',
  rowCount: 10_000,
  columns: [
    { name: 'ORDER_ID', type: { kind: 'decimal' as const, name: 'DECIMAL(18,0)', scale: 0 } },
    { name: 'COUNTRY', type: { kind: 'varchar' as const, name: 'VARCHAR(64)', size: 64 } },
  ],
});
