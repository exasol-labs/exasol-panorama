import { describe, expect, it } from 'vitest';
import type { EntityId, Rect } from '@panorama/core';
import { DEFAULT_PLACEMENT_GAP, isTableEntity, rectsIntersect } from '@panorama/core';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';
import { createAppHarness } from './harness.js';

const GAP = DEFAULT_PLACEMENT_GAP;

const rectsOf = (harness: ReturnType<typeof createAppHarness>): readonly Rect[] => {
  const rects: Rect[] = [];
  for (const entity of harness.workspace.core.world.entities.values()) {
    if (isTableEntity(entity)) rects.push(entity.transform);
  }
  return rects;
};

const rectOf = (harness: ReturnType<typeof createAppHarness>, id: EntityId): Rect => {
  const entity = harness.workspace.core.world.entities.get(id);
  if (entity === undefined || !isTableEntity(entity)) throw new Error('expected a table');
  return entity.transform;
};

const open = async (
  harness: ReturnType<typeof createAppHarness>,
  table = 'SAMPLE_100',
): Promise<EntityId> => {
  const opening = harness.workspace.openTable({ schema: DEMO_SCHEMA, table });
  await harness.settle();
  return opening;
};

describe('where a table opened from the explorer lands', () => {
  it('goes beside the explorer, a gap in from the corner of the view', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 1_600, height: 1_000 });
    const id = await open(harness);
    expect(rectOf(harness, id).x).toBe(GAP);
    expect(rectOf(harness, id).y).toBe(GAP);
  });

  it('follows the camera rather than the world origin', async () => {
    const harness = createAppHarness();
    // The user has panned a long way off.
    harness.workspace.viewport = (): Rect => ({
      x: -9_000,
      y: 3_000,
      width: 1_600,
      height: 1_000,
    });
    const id = await open(harness);
    expect(rectOf(harness, id)).toMatchObject({ x: -9_000 + GAP, y: 3_000 + GAP });
  });

  it('never puts one table on top of another', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 1_600, height: 1_000 });
    for (const table of ['SAMPLE_100', 'COUNTRIES', 'SALES', 'TYPE_COVERAGE', 'MOSTLY_NULL']) {
      await open(harness, table);
    }
    const rects = rectsOf(harness);
    expect(rects).toHaveLength(5);
    for (let a = 0; a < rects.length; a += 1) {
      for (let b = a + 1; b < rects.length; b += 1) {
        expect(rectsIntersect(rects[a] as Rect, rects[b] as Rect)).toBe(false);
      }
    }
  });

  it('uses the width of the view before it uses the depth', async () => {
    const harness = createAppHarness();
    // Wide and shallow: across is the only way the second one fits.
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 2_400, height: 750 });
    const first = await open(harness, 'SAMPLE_100');
    const second = await open(harness, 'SAMPLE_100');
    expect(rectOf(harness, second).y).toBe(rectOf(harness, first).y);
    expect(rectOf(harness, second).x).toBe(
      rectOf(harness, first).x + rectOf(harness, first).width + GAP,
    );
  });

  it('goes below the view once the view is full, rather than nowhere useful', async () => {
    const harness = createAppHarness();
    // Sized from the table itself rather than guessed at: room for exactly two
    // of them across and one down.
    let viewport: Rect = { x: 0, y: 0, width: 4_000, height: 4_000 };
    harness.workspace.viewport = (): Rect => viewport;
    const first = await open(harness, 'SAMPLE_100');
    const size = rectOf(harness, first);
    viewport = {
      x: 0,
      y: 0,
      width: GAP + (size.width + GAP) * 2,
      height: GAP + size.height + GAP,
    };

    const second = await open(harness, 'SAMPLE_100');
    expect(rectOf(harness, second).y).toBe(size.y);

    const third = await open(harness, 'SAMPLE_100');
    const rect = rectOf(harness, third);
    // Out of sight — which is what the shell's reveal then corrects — but only
    // just, directly under the row it could not join.
    expect(rect.y + rect.height).toBeGreaterThan(viewport.height);
    expect(rect.y).toBe(size.y + size.height + GAP);
    expect(rect.x).toBe(size.x);
  });

  it('reuses a hole left by a table that was closed', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 1_600, height: 1_000 });
    const first = await open(harness, 'SAMPLE_100');
    const second = await open(harness, 'COUNTRIES');
    const corner = rectOf(harness, first);
    await harness.workspace.closeTable(first);

    // The same relation again, so the hole is exactly the right shape for it.
    const third = await open(harness, 'SAMPLE_100');
    // Back into the corner the first one vacated, not off past the second.
    expect(rectOf(harness, third)).toMatchObject({ x: corner.x, y: corner.y });
    expect(rectsIntersect(rectOf(harness, third), rectOf(harness, second))).toBe(false);
  });

  it('staggers when there is no camera to consult', async () => {
    // No renderer yet, or none at all: the old diagonal, which at least never
    // lands two tables on the same spot.
    const harness = createAppHarness();
    const first = await open(harness, 'SAMPLE_100');
    const second = await open(harness, 'COUNTRIES');
    expect(rectOf(harness, first)).toMatchObject({ x: 0, y: 0 });
    expect(rectOf(harness, second)).toMatchObject({ x: 48, y: 48 });
  });

  it('leaves a position it was given alone', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 1_600, height: 1_000 });
    const opening = harness.workspace.openTable({
      schema: DEMO_SCHEMA,
      table: 'SAMPLE_100',
      position: { x: 4_000, y: 250 },
    });
    await harness.settle();
    const id = await opening;
    // A followed foreign key and a SQL box both place themselves beside their
    // source, and that is not a spot to be improved upon.
    expect(rectOf(harness, id)).toMatchObject({ x: 4_000, y: 250 });
  });

  it('follows a key into a free spot beside the source, not on top of a neighbour', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 4_000, height: 4_000 });
    const source = await open(harness, 'SAMPLE_100');

    // Park a table exactly where the followed one used to be dropped.
    const sourceRect = rectOf(harness, source);
    const squatting = await harness.workspace.openTable({
      schema: DEMO_SCHEMA,
      table: 'TYPE_COVERAGE',
      position: { x: sourceRect.x + sourceRect.width + 220, y: sourceRect.y },
    });
    await harness.settle();
    const squatter = rectOf(harness, squatting);

    const value = harness.workspace.cellAt(source, 0, 1);
    const columns = harness.workspace.core.world.entities.get(source);
    if (columns === undefined || !isTableEntity(columns) || value === undefined) {
      throw new Error('expected a followable cell');
    }
    const following = harness.workspace.followForeignKey({
      tableId: source,
      columnId: columns.columns[1]?.id as never,
      row: 0,
      sourceColumn: 'COUNTRY',
      reference: {
        schema: DEMO_SCHEMA,
        table: 'COUNTRIES',
        column: 'NAME',
        constraint: 'FK_SALES_COUNTRY',
      },
      value,
    });
    await harness.settle();
    const { tableId } = await following;
    const opened = rectOf(harness, tableId);

    // Clear of the neighbour, and still beside the source rather than past it.
    expect(rectsIntersect(opened, squatter)).toBe(false);
    expect(rectsIntersect(opened, sourceRect)).toBe(false);
    expect(opened.x).toBe(squatter.x);
    expect(opened.y).toBeGreaterThanOrEqual(squatter.y + squatter.height);
  });

  it('puts a SQL box in a free spot beside its source too', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 4_000, height: 4_000 });
    await harness.workspace.connect({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
    });
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const base = await opening;
    const baseRect = rectOf(harness, base);

    const squatting = await harness.workspace.openTable({
      schema: 'PANORAMA_TEST',
      table: 'SALES',
      position: { x: baseRect.x + baseRect.width + 220, y: baseRect.y },
    });
    await harness.settle();

    const { tableId } = await harness.workspace.openQuery(base);
    expect(rectsIntersect(rectOf(harness, tableId), rectOf(harness, squatting))).toBe(false);
    expect(rectOf(harness, tableId).x).toBe(baseRect.x + baseRect.width + 220);
  });

  it('places a query box beside its source, not by the explorer', async () => {
    const harness = createAppHarness();
    harness.workspace.viewport = (): Rect => ({ x: 0, y: 0, width: 1_600, height: 1_000 });
    await harness.workspace.connect({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
    });
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const base = await opening;
    const { tableId } = await harness.workspace.openQuery(base);
    expect(rectOf(harness, tableId).x).toBeGreaterThan(rectOf(harness, base).x);
  });
});
