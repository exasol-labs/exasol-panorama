import { describe, expect, it } from 'vitest';
import type { TableEntity } from '@panorama/core';
import { createAppHarness, firstTableId } from './harness.js';
import type { TableView } from '../src/panorama/table-view.js';

const openTable = async (
  options: Parameters<typeof createAppHarness>[0] = {},
): Promise<{
  harness: ReturnType<typeof createAppHarness>;
  view: TableView;
  entity: TableEntity;
}> => {
  const harness = createAppHarness(options);
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  const id = firstTableId(harness);
  const view = harness.workspace.viewOfTable(id);
  const entity = harness.workspace.core.world.entities.get(id);
  if (view === undefined || entity === undefined) throw new Error('expected an open table');
  return { harness, view, entity };
};

describe('TableView', () => {
  it('exposes the result-set schema and row count', async () => {
    const { view } = await openTable();
    expect(view.schema?.columns).toHaveLength(4);
    expect(view.rowCount).toBe(100_000);
    expect(view.scrollTop).toBe(0);
    expect(view.scrollLeft).toBe(0);
  });

  it('eases a wheel scroll rather than jumping', async () => {
    const { view, entity } = await openTable();
    view.scrollBy(0, 300, 0);
    expect(view.scrollTop).toBe(0);

    view.update(entity, 16, 16);
    expect(view.scrollTop).toBeGreaterThan(0);
    expect(view.scrollTop).toBeLessThan(300);

    for (let frame = 0; frame < 60; frame += 1) view.update(entity, 16, 32 + frame * 16);
    expect(view.scrollTop).toBe(300);
  });

  it('builds a signed velocity while scrolling', async () => {
    const { view, entity } = await openTable();
    for (let frame = 1; frame <= 10; frame += 1) {
      view.scrollBy(0, 60, frame * 16);
      view.update(entity, 16, frame * 16);
    }
    expect(view.velocityY).toBeGreaterThan(0);

    for (let frame = 11; frame <= 25; frame += 1) {
      view.scrollBy(0, -60, frame * 16);
      view.update(entity, 16, frame * 16);
    }
    expect(view.velocityY).toBeLessThan(0);
  });

  it('clamps scrolling to the content, allowing for the scrollbars', async () => {
    const { view, entity } = await openTable();
    view.scrollBy(0, 1e9, 0);
    view.update(entity, 1_000, 1_000);
    const metrics = view.metricsFor(entity);
    expect(view.scrollTop).toBe(100_000 * metrics.rowHeight - metrics.bodyHeight);
    // Space is reserved for the bars, so the last row is never hidden by one.
    expect(metrics.bodyHeight).toBeLessThanOrEqual(
      entity.transform.height - entity.view.headerHeight,
    );

    view.scrollBy(0, -1e9, 2_000);
    view.update(entity, 1_000, 2_000);
    expect(view.scrollTop).toBe(0);
  });

  it('scrolls horizontally only as far as the columns reach', async () => {
    const { view, entity } = await openTable();
    view.scrollBy(1e9, 0, 0);
    view.update(entity, 1_000, 1_000);
    const metrics = view.metricsFor(entity);
    expect(view.scrollLeft).toBe(Math.max(0, view.layout.totalWidth - metrics.bodyWidth));
  });

  it('re-clamps when the table is resized smaller', async () => {
    const { view, entity } = await openTable();
    view.scrollBy(0, 1e9, 0);
    view.update(entity, 1_000, 1_000);
    const tall: TableEntity = {
      ...entity,
      transform: { ...entity.transform, height: 100_000_000 },
    };
    view.update(tall, 16, 1_016);
    expect(view.scrollTop).toBe(0);
  });

  it('requests data only when the requirement changes', async () => {
    const { harness, view, entity } = await openTable();
    await harness.settle();
    const fetchesAfterOpen = harness.workspace.dataMetrics().cacheBlocks;

    // Twenty frames of sub-row easing must not produce twenty requests.
    view.scrollBy(0, 4, 0);
    for (let frame = 0; frame < 20; frame += 1) view.update(entity, 16, frame * 16);
    await harness.settle();
    expect(harness.workspace.dataMetrics().cacheBlocks).toBe(fetchesAfterOpen);
  });

  it('serves cells once the blocks arrive', async () => {
    const { harness, view, entity } = await openTable();
    view.update(entity, 16, 16);
    await harness.settle();
    expect(view.cell(0, 0)).toBe(0);
    expect(typeof view.cell(5, 1)).toBe('string');
  });

  it('keeps the viewport moving while data is a second away', async () => {
    const { harness, view, entity } = await openTable({ latencyMs: 1_000 });
    view.scrollBy(0, 2_400, 0);
    for (let frame = 0; frame < 40; frame += 1) view.update(entity, 16, frame * 16);

    expect(view.scrollTop).toBe(2_400);
    expect(view.cell(100, 0)).toBeUndefined();

    await harness.settle();
    view.update(entity, 16, 1_000);
    await harness.settle();
    expect(view.cell(100, 0)).toBe(100);
  });

  it('returns to the top when the result set is reopened', async () => {
    const { view, entity } = await openTable();
    view.scrollBy(0, 900, 0);
    view.update(entity, 1_000, 1_000);
    await view.reopen();
    expect(view.scrollTop).toBe(0);
    expect(view.controller.generation).toBe(1);
  });

  it('closes cleanly', async () => {
    const { view } = await openTable();
    await expect(view.close()).resolves.toBeUndefined();
  });
});
