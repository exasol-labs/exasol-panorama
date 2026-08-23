import { describe, expect, it } from 'vitest';
import { computeRowWindow } from '@panorama/table';
import { TableDataController } from '@panorama/worker';
import { tallRelation } from '@panorama/test-support';
import { TABLE_ID, createWorkerHarness } from './harness.js';

/**
 * Stage 1C acceptance: interaction must be identical at every latency.
 *
 * The same scripted fling is replayed against 0, 50, 250 and 1 000 ms
 * simulated fetch latency. Scroll position, the rows the renderer walks and
 * the work done per frame must be byte-for-byte identical; only how many cells
 * have data yet is allowed to differ.
 */

const ROW_HEIGHT = 24;
const BODY_HEIGHT = 34 * ROW_HEIGHT;
const FRAMES = 240;
const PIXELS_PER_FRAME = 40;

interface Replay {
  readonly scrollPositions: readonly number[];
  readonly renderedRows: number;
  readonly cellReads: number;
  readonly filledCells: number;
  readonly maxCacheBytes: number;
}

const replayFling = async (latencyMs: number): Promise<Replay> => {
  const harness = createWorkerHarness({
    source: { relation: tallRelation(), latency: latencyMs },
  });
  const controller = new TableDataController({
    tableId: TABLE_ID,
    gateway: harness.client,
    blockSize: 256,
    maxBytes: 2_000_000,
    schedule: () => {},
  });
  await controller.open('PANORAMA_TEST', 'VERY_TALL');

  const scrollPositions: number[] = [];
  let renderedRows = 0;
  let cellReads = 0;
  let filledCells = 0;
  let maxCacheBytes = 0;
  let scrollTop = 0;

  for (let frame = 0; frame < FRAMES; frame += 1) {
    // The viewport advances every frame, whatever the database is doing.
    scrollTop += PIXELS_PER_FRAME;
    scrollPositions.push(scrollTop);

    const window = computeRowWindow({
      scrollTop,
      rowHeight: ROW_HEIGHT,
      bodyHeight: BODY_HEIGHT,
      rowCount: controller.rowCount,
      overscan: 6,
    });
    controller.setViewport({
      firstVisibleRow: window.firstVisibleRow,
      visibleRowCount: window.visibleRowCount,
      velocityY: (PIXELS_PER_FRAME * 1_000) / 16,
    });

    for (let offset = 0; offset < window.renderedRowCount; offset += 1) {
      renderedRows += 1;
      for (let column = 0; column < 4; column += 1) {
        cellReads += 1;
        if (controller.cell(window.firstRenderedRow + offset, column) !== undefined) {
          filledCells += 1;
        }
      }
    }

    maxCacheBytes = Math.max(maxCacheBytes, controller.status().cache.bytes);
    // One frame of wall-clock time passes; pending fetches may or may not land.
    harness.scheduler.advance(16);
    await Promise.resolve();
    await Promise.resolve();
  }

  return { scrollPositions, renderedRows, cellReads, filledCells, maxCacheBytes };
};

describe('latency stress', () => {
  it('produces identical interaction at 0, 50, 250 and 1000 ms latency', async () => {
    const replays = await Promise.all([0, 50, 250, 1_000].map(replayFling));
    const [baseline] = replays;
    if (baseline === undefined) throw new Error('expected replays');

    for (const replay of replays) {
      // Scroll never waits for the database.
      expect(replay.scrollPositions).toEqual(baseline.scrollPositions);
      expect(replay.scrollPositions.at(-1)).toBe(FRAMES * PIXELS_PER_FRAME);
      // The renderer does exactly the same amount of work per frame.
      expect(replay.renderedRows).toBe(baseline.renderedRows);
      expect(replay.cellReads).toBe(baseline.cellReads);
      // Memory stays bounded regardless of how much arrived.
      expect(replay.maxCacheBytes).toBeLessThanOrEqual(2_500_000);
    }
  });

  it('only data availability changes with latency', async () => {
    const fast = await replayFling(0);
    const slow = await replayFling(1_000);
    expect(fast.filledCells).toBeGreaterThan(slow.filledCells);
    // Even at one second per fetch some rows still materialise mid-fling.
    expect(slow.filledCells).toBeGreaterThan(0);
    // At zero latency nearly everything the user sees is present.
    expect(fast.filledCells / fast.cellReads).toBeGreaterThan(0.8);
  });

  it('keeps client memory independent of relation size', async () => {
    const small = createWorkerHarness({ source: { relation: tallRelation(1_000_000) } });
    const huge = createWorkerHarness({ source: { relation: tallRelation(10_000_000_000) } });

    const measure = async (harness: ReturnType<typeof createWorkerHarness>): Promise<number> => {
      const controller = new TableDataController({
        tableId: TABLE_ID,
        gateway: harness.client,
        blockSize: 256,
        maxBytes: 1_000_000,
        schedule: () => {},
      });
      await controller.open('PANORAMA_TEST', 'VERY_TALL');
      for (let row = 0; row < 100_000; row += 2_000) {
        controller.setViewport({ firstVisibleRow: row, visibleRowCount: 34, velocityY: 2_500 });
        await harness.settle();
      }
      return controller.status().cache.bytes;
    };

    const smallBytes = await measure(small);
    const hugeBytes = await measure(huge);
    expect(Math.abs(smallBytes - hugeBytes)).toBeLessThan(smallBytes * 0.25);
    expect(hugeBytes).toBeLessThanOrEqual(1_200_000);
  });
});
