import { describe, expect, it } from 'vitest';
import type { EntityId } from '@panorama/core';
import { dataType, resolveBinding, tableDisplayName } from '@panorama/core';
import { createAppHarness, firstTableId } from './harness.js';
import { blockSizeForColumns } from '../src/panorama/workspace.js';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';

describe('Workspace connection', () => {
  it('connects, adopts the connection id and lists metadata', async () => {
    const harness = createAppHarness();
    const result = await harness.workspace.connect({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'password', username: 'sys', password: 'exasol' },
    });

    expect(result.connectionId).toBe('connection:test');
    expect(harness.workspace.connectionId).toBe('connection:test');
    expect(harness.connections[0]?.url).toBe('wss://exasol.test:8563');
    await expect(harness.workspace.listSchemas()).resolves.toEqual([{ name: 'PANORAMA_TEST' }]);
    await expect(harness.workspace.listTables('PANORAMA_TEST')).resolves.toHaveLength(2);

    await expect(harness.workspace.disconnect()).resolves.toBeUndefined();
  });

  it('starts with a placeholder connection id that can be set directly', () => {
    const { workspace } = createAppHarness();
    expect(workspace.connectionId).toBe('connection:pending');
    workspace.connectionId = 'connection:manual' as never;
    expect(workspace.connectionId).toBe('connection:manual');
  });

  it('skips tables whose entity has been removed when updating', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    harness.workspace.core.dispatch({ type: 'RemoveEntities', ids: [id] });
    expect(() => harness.workspace.update(16)).not.toThrow();
  });
});

describe('Workspace tables', () => {
  const connect = async (harness: ReturnType<typeof createAppHarness>): Promise<void> => {
    await harness.workspace.connect({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
    });
  };

  it('creates an entity, opens a result set and selects the table', async () => {
    const harness = createAppHarness();
    await connect(harness);
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });

    const entity = harness.workspace.core.world.entities.get(id);
    expect(entity).toBeDefined();
    expect(tableDisplayName(entity as never)).toBe('PANORAMA_TEST.SALES');
    expect(entity?.columns).toHaveLength(4);
    expect(harness.workspace.core.session.selection).toEqual([id]);
    expect(harness.workspace.openTableCount).toBe(1);
    expect(harness.workspace.viewOfTable(id)?.rowCount).toBe(100_000);
  });

  it('records exactly one commit for opening a table', async () => {
    const harness = createAppHarness();
    await connect(harness);
    const before = harness.workspace.core.history.commits.size;
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    expect(harness.workspace.core.history.commits.size).toBe(before + 1);
  });

  it('staggers tables so a second one does not hide the first', async () => {
    const harness = createAppHarness();
    await connect(harness);
    const first = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const second = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const a = harness.workspace.core.world.entities.get(first);
    const b = harness.workspace.core.world.entities.get(second);
    expect(b?.transform.x).toBeGreaterThan(a?.transform.x ?? 0);
  });

  it('honours an explicit position', async () => {
    const harness = createAppHarness();
    await connect(harness);
    const id = await harness.workspace.openTable({
      schema: 'PANORAMA_TEST',
      table: 'SALES',
      position: { x: 640, y: 320 },
    });
    expect(harness.workspace.core.world.entities.get(id)?.transform).toMatchObject({
      x: 640,
      y: 320,
      z: 0,
    });
  });

  it('reports a describe failure without creating an entity', async () => {
    const harness = createAppHarness({ failDescribe: true });
    await connect(harness);
    await expect(
      harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'MISSING' }),
    ).rejects.toThrow(/not found/);
    expect(harness.workspace.core.world.entities.size).toBe(0);
  });

  it('cleans up when the result set cannot be opened', async () => {
    const harness = createAppHarness({ failOpen: true });
    await connect(harness);
    await expect(
      harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(harness.workspace.openTableCount).toBe(0);
  });

  it('closes a table and removes its entity', async () => {
    const harness = createAppHarness();
    await connect(harness);
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.workspace.closeTable(id);
    expect(harness.workspace.openTableCount).toBe(0);
    expect(harness.workspace.core.world.entities.size).toBe(0);
    // Closing an unknown table is harmless.
    await expect(harness.workspace.closeTable(id)).resolves.toBeUndefined();
  });

  it('closes every table at once', async () => {
    const harness = createAppHarness();
    await connect(harness);
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.workspace.closeAll();
    expect(harness.workspace.openTableCount).toBe(0);
  });

  it('reopens every result set after a reconnect', async () => {
    const harness = createAppHarness();
    await connect(harness);
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const view = harness.workspace.viewOfTable(id);
    view?.scrollBy(0, 5_000, 0);
    await harness.workspace.reopenAll();
    expect(view?.controller.generation).toBe(1);
    expect(view?.scrollTop).toBe(0);
  });
});

describe('Workspace as a renderer and interaction host', () => {
  it('provides view state for open tables only', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const entity = harness.workspace.core.world.entities.get(id);
    if (entity === undefined) throw new Error('expected an entity');

    expect(harness.workspace.viewFor(entity)).toMatchObject({ rowCount: 100_000 });
    expect(harness.workspace.viewOf(id)?.layout.placements.length).toBeGreaterThan(0);
    expect(harness.workspace.viewFor({ ...entity, id: 'table:other' as never })).toBeNull();
    expect(harness.workspace.viewOf('table:other' as never)).toBeNull();
  });

  it('serves cells through the view model once data arrives', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const entity = harness.workspace.core.world.entities.get(id);
    if (entity === undefined) throw new Error('expected an entity');

    harness.workspace.update(16);
    await harness.settle();
    expect(harness.workspace.viewFor(entity)?.data.cell(0, 0)).toBe(0);
  });

  it('reads cells for the interaction controller', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    harness.workspace.update(16);
    await harness.settle();

    expect(harness.workspace.cellAt(id, 0, 0)).toBe(0);
    expect(harness.workspace.cellAt('table:none' as never, 0, 0)).toBeUndefined();
  });

  it('scrolls and ignores scroll for unknown tables', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    harness.workspace.scrollBy(id, 0, 500);
    expect(harness.workspace.viewOfTable(id)?.vertical.target).toBe(500);
    expect(() => harness.workspace.scrollBy('table:none' as never, 0, 10)).not.toThrow();
  });

  it('jumps to a scrollbar fraction', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const id = firstTableId(harness);
    const view = harness.workspace.viewOfTable(id);
    if (view === undefined) throw new Error('expected a view');

    harness.workspace.scrollToFraction(id, 'vertical', 1);
    expect(view.scrollTop).toBeGreaterThan(0);
    harness.workspace.scrollToFraction(id, 'vertical', 0);
    expect(view.scrollTop).toBe(0);

    harness.workspace.scrollToFraction(id, 'horizontal', 1);
    expect(view.scrollLeft).toBeGreaterThanOrEqual(0);
    // Unknown tables are ignored.
    expect(() =>
      harness.workspace.scrollToFraction('table:none' as never, 'vertical', 1),
    ).not.toThrow();
  });
});

describe('Workspace instrumentation', () => {
  it('aggregates cache metrics across tables', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    expect(harness.workspace.dataMetrics()).toMatchObject({ cacheBlocks: 0 });

    harness.workspace.update(16);
    await harness.settle();
    const metrics = harness.workspace.dataMetrics();
    expect(metrics.cacheBlocks).toBeGreaterThan(0);
    expect(metrics.cacheBytes).toBeGreaterThan(0);
    expect(metrics.fetchesPending).toBe(0);
  });
});

describe('blockSizeForColumns', () => {
  it('keeps the default for ordinary row widths', () => {
    expect(blockSizeForColumns(4, 256)).toBe(256);
    expect(blockSizeForColumns(200, 256)).toBe(256);
  });

  it('shrinks blocks for very wide rows so one block stays affordable', () => {
    expect(blockSizeForColumns(1_000, 256)).toBe(65);
    expect(blockSizeForColumns(5_000, 256)).toBe(32);
    expect(blockSizeForColumns(100_000, 256)).toBe(32);
  });

  it('never exceeds the configured maximum', () => {
    expect(blockSizeForColumns(1, 64)).toBe(64);
    expect(blockSizeForColumns(0, 64)).toBe(64);
  });

  it('is used when opening a wide table', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const wide = {
      schema: 'PANORAMA_TEST',
      table: 'WIDE',
      columns: Array.from({ length: 2_000 }, (_, index) => ({
        name: `COL_${index}`,
        type: dataType('varchar', 'VARCHAR(64)', { size: 64 }),
      })),
    };
    const id = await harness.workspace.openTable({
      schema: 'PANORAMA_TEST',
      table: 'WIDE',
      knownSchema: wide,
    });
    expect(harness.workspace.viewOfTable(id)?.controller.blockSize).toBe(32);
  });
});

describe('halo actions', () => {
  const openOne = async (): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    id: EntityId;
  }> => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const id = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    return { harness, id };
  };

  it('closes a table and releases its result set', async () => {
    const { harness, id } = await openOne();
    await harness.workspace.performAction(id, 'close');
    expect(harness.workspace.openTableCount).toBe(0);
    expect(harness.workspace.core.world.entities.size).toBe(0);
  });

  it('clears every session reference to a closed table', async () => {
    const { harness, id } = await openOne();
    const core = harness.workspace.core;
    core.dispatchSession({ type: 'SetHovered', id });
    core.dispatchSession({ type: 'SetSelection', ids: [id] });
    core.dispatchSession({ type: 'SetHoveredAction', target: { entityId: id, action: 'close' } });
    core.dispatchSession({ type: 'SetPressedAction', target: { entityId: id, action: 'close' } });

    await harness.workspace.performAction(id, 'close');

    expect(core.session.hovered).toBeNull();
    expect(core.session.selection).toEqual([]);
    expect(core.session.hoveredAction).toBeNull();
    expect(core.session.pressedAction).toBeNull();
  });

  it('leaves other tables and their session state alone', async () => {
    const { harness, id } = await openOne();
    const other = await harness.workspace.openTable({
      schema: 'PANORAMA_TEST',
      table: 'SALES',
    });
    harness.workspace.core.dispatchSession({ type: 'SetSelection', ids: [other] });
    harness.workspace.core.dispatchSession({ type: 'SetHovered', id: other });

    await harness.workspace.performAction(id, 'close');

    expect(harness.workspace.openTableCount).toBe(1);
    expect(harness.workspace.core.session.selection).toEqual([other]);
    expect(harness.workspace.core.session.hovered).toBe(other);
  });

  it('records the close as an undoable command', async () => {
    const { harness, id } = await openOne();
    const commits = harness.workspace.core.history.commits.size;
    await harness.workspace.performAction(id, 'close');
    expect(harness.workspace.core.history.commits.size).toBe(commits + 1);

    // Undo brings the entity back; its result set is gone, so it draws as
    // empty chrome until reopened.
    expect(harness.workspace.core.undo()).toBe(true);
    expect(harness.workspace.core.world.entities.has(id)).toBe(true);
    expect(harness.workspace.viewOfTable(id)).toBeUndefined();
  });
});

describe('following a foreign key', () => {
  const openSales = async (): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    sourceId: EntityId;
  }> => {
    const harness = createAppHarness();
    const sourceId = await harness.workspace.openTable({
      schema: DEMO_SCHEMA,
      table: 'SAMPLE_100',
    });
    return { harness, sourceId };
  };

  const followFrom = async (
    harness: ReturnType<typeof createAppHarness>,
    sourceId: EntityId,
    value: string,
  ) => {
    const source = harness.workspace.core.world.entities.get(sourceId);
    if (source === undefined) throw new Error('expected the source table');
    const column = source.columns.find((entry) => entry.sourceColumn.name === 'COUNTRY');
    if (column === undefined) throw new Error('expected a COUNTRY column');
    return harness.workspace.followForeignKey({
      tableId: sourceId,
      columnId: column.id,
      row: 0,
      sourceColumn: 'COUNTRY',
      reference: column.sourceColumn.foreignKey as never,
      value,
    });
  };

  it('opens the referenced table showing only the matching rows', async () => {
    const { harness, sourceId } = await openSales();
    const { tableId } = await followFrom(harness, sourceId, 'Denmark');

    const opened = harness.workspace.core.world.entities.get(tableId);
    expect(opened?.source.table).toBe('COUNTRIES');
    // COUNTRIES holds one row per country, so the filter leaves exactly one.
    expect(harness.workspace.viewOfTable(tableId)?.rowCount).toBe(1);

    harness.workspace.update(16);
    await harness.settle();
    expect(harness.workspace.viewOfTable(tableId)?.cell(0, 0)).toBe('Denmark');
  });

  it('binds the two tables with a directed, labelled connector', async () => {
    const { harness, sourceId } = await openSales();
    const { tableId, bindingId } = await followFrom(harness, sourceId, 'France');

    const binding = harness.workspace.core.world.bindings.get(bindingId);
    expect(binding).toMatchObject({
      kind: 'connector',
      fromId: sourceId,
      toId: tableId,
      directed: true,
      label: 'COUNTRY = France',
    });
    expect(binding?.meta).toMatchObject({
      kind: 'foreign-key',
      column: 'COUNTRY',
      referencedTable: 'COUNTRIES',
      referencedColumn: 'NAME',
    });
  });

  it('places the new table beside the one it came from', async () => {
    const { harness, sourceId } = await openSales();
    const { tableId } = await followFrom(harness, sourceId, 'Poland');
    const source = harness.workspace.core.world.entities.get(sourceId);
    const opened = harness.workspace.core.world.entities.get(tableId);
    expect(opened?.transform.x).toBeGreaterThan(
      (source?.transform.x ?? 0) + (source?.transform.width ?? 0),
    );
    expect(opened?.transform.y).toBe(source?.transform.y);
  });

  it('keeps the connection through moves, and resolves it live', async () => {
    const { harness, sourceId } = await openSales();
    const { tableId, bindingId } = await followFrom(harness, sourceId, 'Sweden');
    const core = harness.workspace.core;
    const binding = core.world.bindings.get(bindingId);
    if (binding === undefined) throw new Error('expected a binding');

    const before = resolveBinding(core.world, binding);
    core.dispatch({ type: 'MoveEntities', ids: [tableId], position: { x: -4_000, y: 900, z: 0 } });
    const after = resolveBinding(core.world, binding);

    // The record never changed; only the derived geometry did.
    expect(core.world.bindings.get(bindingId)).toBe(binding);
    expect(after?.to).not.toEqual(before?.to);
    expect(after?.from).not.toEqual(before?.from);
  });

  it('takes the connector with the table when either end is closed', async () => {
    const { harness, sourceId } = await openSales();
    const { tableId } = await followFrom(harness, sourceId, 'Germany');
    expect(harness.workspace.core.world.bindings.size).toBe(1);

    await harness.workspace.closeTable(tableId);
    expect(harness.workspace.core.world.bindings.size).toBe(0);
    expect(harness.workspace.core.world.entities.size).toBe(1);
  });

  it('rejects a follow from a table or column that is gone', async () => {
    const { harness, sourceId } = await openSales();
    const source = harness.workspace.core.world.entities.get(sourceId);
    const column = source?.columns.find((entry) => entry.sourceColumn.name === 'COUNTRY');
    if (column === undefined) throw new Error('expected a column');

    await expect(
      harness.workspace.followForeignKey({
        tableId: 'table:gone' as EntityId,
        columnId: column.id,
        row: 0,
        sourceColumn: 'COUNTRY',
        reference: column.sourceColumn.foreignKey as never,
        value: 'Germany',
      }),
    ).rejects.toThrow(/No table/);

    await expect(
      harness.workspace.followForeignKey({
        tableId: sourceId,
        columnId: 'column:gone' as EntityId,
        row: 0,
        sourceColumn: 'COUNTRY',
        reference: column.sourceColumn.foreignKey as never,
        value: 'Germany',
      }),
    ).rejects.toThrow(/No column/);
  });
});

describe('sizing a followed table', () => {
  it('shrinks to the rows the key actually matched', async () => {
    const harness = createAppHarness();
    const sourceId = await harness.workspace.openTable({
      schema: DEMO_SCHEMA,
      table: 'SAMPLE_100',
    });
    const source = harness.workspace.core.world.entities.get(sourceId);
    const column = source?.columns.find((entry) => entry.sourceColumn.name === 'COUNTRY');
    if (source === undefined || column === undefined) throw new Error('expected a column');

    const { tableId } = await harness.workspace.followForeignKey({
      tableId: sourceId,
      columnId: column.id,
      row: 0,
      sourceColumn: 'COUNTRY',
      reference: column.sourceColumn.foreignKey as never,
      value: 'Germany',
    });

    const opened = harness.workspace.core.world.entities.get(tableId);
    if (opened === undefined) throw new Error('expected the opened table');
    // One matching row, floored at three so the table still reads as a table.
    expect(opened.transform.height).toBe(opened.view.headerHeight + 3 * opened.view.rowHeight);
    expect(opened.transform.height).toBeLessThan(source.transform.height);
  });

  it('leaves the table at its default size when the row count is unknown', async () => {
    const harness = createAppHarness({ hideRowCount: true });
    const sourceId = await harness.workspace.openTable({
      schema: DEMO_SCHEMA,
      table: 'SAMPLE_100',
    });
    const source = harness.workspace.core.world.entities.get(sourceId);
    const column = source?.columns.find((entry) => entry.sourceColumn.name === 'COUNTRY');
    if (source === undefined || column === undefined) throw new Error('expected a column');

    const { tableId } = await harness.workspace.followForeignKey({
      tableId: sourceId,
      columnId: column.id,
      row: 0,
      sourceColumn: 'COUNTRY',
      reference: column.sourceColumn.foreignKey as never,
      value: 'Germany',
    });

    // Nothing to fit to, so the table keeps the size it was created with.
    const opened = harness.workspace.core.world.entities.get(tableId);
    expect(opened?.transform.height).toBe(source.transform.height);
  });
});
