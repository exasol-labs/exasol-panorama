import { describe, expect, it } from 'vitest';
import type { Command, EntityId, TableEntity, WorldState } from '@panorama/core';
import {
  DEFAULT_CONSTRAINTS,
  applyCommand,
  buildTableEntity,
  emptyWorld,
  getEntity,
  tableDisplayName,
  unwrap,
  withEntity,
} from '@panorama/core';
import { TEST_CONNECTION, makeTable, testIds } from './fixtures.js';

const ids = testIds();

const worldWith = (table: TableEntity): WorldState => withEntity(emptyWorld(), table);

const expectError = (world: WorldState, command: Command, code: string): void => {
  const result = applyCommand(world, command);
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.error.code).toBe(code);
  expect(result.error.message).toBeTruthy();
};

describe('CreateTableEntity', () => {
  it('adds the table to the world', () => {
    const table = makeTable(ids);
    const next = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: table }));
    expect(getEntity(next, table.id)).toEqual(table);
  });

  it('clamps oversized and undersized geometry to the constraints', () => {
    const table = makeTable(ids, { size: { width: 10, height: 10 } });
    const next = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: table }));
    const created = getEntity(next, table.id) as TableEntity;
    expect(created.transform.width).toBe(DEFAULT_CONSTRAINTS.minTableWidth);
    expect(created.transform.height).toBe(DEFAULT_CONSTRAINTS.minTableHeight);
  });

  it('clamps column widths', () => {
    const table = makeTable(ids);
    const wide: TableEntity = {
      ...table,
      columns: table.columns.map((column) => ({ ...column, width: 99_999 })),
    };
    const next = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: wide }));
    const created = getEntity(next, table.id) as TableEntity;
    for (const column of created.columns) {
      expect(column.width).toBe(DEFAULT_CONSTRAINTS.maxColumnWidth);
    }
  });

  it('rejects a duplicate id', () => {
    const table = makeTable(ids);
    expectError(worldWith(table), { type: 'CreateTableEntity', entity: table }, 'duplicate-entity');
  });

  it.each([
    ['non-finite x', { transform: { x: Number.NaN } }],
    ['non-finite y', { transform: { y: Number.POSITIVE_INFINITY } }],
    ['non-finite z', { transform: { z: Number.NaN } }],
    ['zero width', { transform: { width: 0 } }],
    ['negative height', { transform: { height: -5 } }],
  ])('rejects %s', (_label, patch) => {
    const table = makeTable(ids);
    const broken: TableEntity = {
      ...table,
      transform: { ...table.transform, ...(patch.transform ?? {}) },
    };
    expectError(emptyWorld(), { type: 'CreateTableEntity', entity: broken }, 'invalid-argument');
  });

  it.each([
    ['zero row height', { rowHeight: 0 }],
    ['negative header height', { headerHeight: -1 }],
    ['negative horizontal offset', { horizontalOffset: -1 }],
    ['non-finite horizontal offset', { horizontalOffset: Number.NaN }],
  ])('rejects %s', (_label, patch) => {
    const table = makeTable(ids);
    const broken: TableEntity = { ...table, view: { ...table.view, ...patch } };
    expectError(emptyWorld(), { type: 'CreateTableEntity', entity: broken }, 'invalid-argument');
  });

  it('rejects duplicate column ids', () => {
    const table = makeTable(ids);
    const first = table.columns[0] as TableEntity['columns'][number];
    const broken: TableEntity = { ...table, columns: [first, first] };
    expectError(emptyWorld(), { type: 'CreateTableEntity', entity: broken }, 'invalid-argument');
  });

  it('rejects non-positive column widths', () => {
    const table = makeTable(ids);
    const broken: TableEntity = {
      ...table,
      columns: table.columns.map((column) => ({ ...column, width: 0 })),
    };
    expectError(emptyWorld(), { type: 'CreateTableEntity', entity: broken }, 'invalid-argument');
  });
});

describe('MoveEntities', () => {
  it('moves to an absolute position and raises the entity', () => {
    const first = makeTable(ids);
    const second = makeTable(ids);
    const world = withEntity(worldWith(first), second);
    const next = unwrap(
      applyCommand(world, {
        type: 'MoveEntities',
        ids: [first.id],
        position: { x: 100, y: 200, z: 1 },
      }),
    );
    expect(getEntity(next, first.id)?.transform).toMatchObject({ x: 100, y: 200, z: 1 });
    expect(next.order.at(-1)).toBe(first.id);
  });

  it('moves several entities to the same position', () => {
    const first = makeTable(ids);
    const second = makeTable(ids);
    const world = withEntity(worldWith(first), second);
    const next = unwrap(
      applyCommand(world, {
        type: 'MoveEntities',
        ids: [first.id, second.id],
        position: { x: 7, y: 8, z: 0 },
      }),
    );
    expect(getEntity(next, first.id)?.transform.x).toBe(7);
    expect(getEntity(next, second.id)?.transform.y).toBe(8);
  });

  it('rejects an empty id list', () => {
    expectError(
      emptyWorld(),
      { type: 'MoveEntities', ids: [], position: { x: 0, y: 0, z: 0 } },
      'invalid-argument',
    );
  });

  it('rejects non-finite positions', () => {
    const table = makeTable(ids);
    expectError(
      worldWith(table),
      { type: 'MoveEntities', ids: [table.id], position: { x: Number.NaN, y: 0, z: 0 } },
      'invalid-argument',
    );
    expectError(
      worldWith(table),
      { type: 'MoveEntities', ids: [table.id], position: { x: 0, y: Number.NaN, z: 0 } },
      'invalid-argument',
    );
    expectError(
      worldWith(table),
      { type: 'MoveEntities', ids: [table.id], position: { x: 0, y: 0, z: Number.NaN } },
      'invalid-argument',
    );
  });

  it('rejects unknown ids without partially applying', () => {
    const table = makeTable(ids);
    expectError(
      worldWith(table),
      {
        type: 'MoveEntities',
        ids: [table.id, 'table:missing' as EntityId],
        position: { x: 1, y: 1, z: 0 },
      },
      'entity-not-found',
    );
  });
});

describe('ResizeEntity', () => {
  it('resizes in place', () => {
    const table = makeTable(ids);
    const next = unwrap(
      applyCommand(worldWith(table), {
        type: 'ResizeEntity',
        id: table.id,
        width: 900,
        height: 400,
      }),
    );
    expect(getEntity(next, table.id)?.transform).toMatchObject({
      x: table.transform.x,
      y: table.transform.y,
      width: 900,
      height: 400,
    });
  });

  it('accepts a new position for top/left handle drags', () => {
    const table = makeTable(ids);
    const next = unwrap(
      applyCommand(worldWith(table), {
        type: 'ResizeEntity',
        id: table.id,
        width: 500,
        height: 300,
        position: { x: -50, y: -20, z: 0 },
      }),
    );
    expect(getEntity(next, table.id)?.transform).toMatchObject({ x: -50, y: -20 });
  });

  it('clamps to the minimum size instead of failing', () => {
    const table = makeTable(ids);
    const next = unwrap(
      applyCommand(worldWith(table), { type: 'ResizeEntity', id: table.id, width: 1, height: 1 }),
    );
    expect(getEntity(next, table.id)?.transform.width).toBe(DEFAULT_CONSTRAINTS.minTableWidth);
    expect(getEntity(next, table.id)?.transform.height).toBe(DEFAULT_CONSTRAINTS.minTableHeight);
  });

  it('validates ids, sizes and positions', () => {
    const table = makeTable(ids);
    expectError(
      emptyWorld(),
      { type: 'ResizeEntity', id: table.id, width: 100, height: 100 },
      'entity-not-found',
    );
    expectError(
      worldWith(table),
      { type: 'ResizeEntity', id: table.id, width: Number.NaN, height: 100 },
      'invalid-argument',
    );
    expectError(
      worldWith(table),
      { type: 'ResizeEntity', id: table.id, width: 100, height: -3 },
      'invalid-argument',
    );
    expectError(
      worldWith(table),
      {
        type: 'ResizeEntity',
        id: table.id,
        width: 100,
        height: 100,
        position: { x: Number.NaN, y: 0, z: 0 },
      },
      'invalid-argument',
    );
  });
});

describe('ResizeColumn', () => {
  it('resizes one column and leaves the others untouched', () => {
    const table = makeTable(ids);
    const target = table.columns[1] as TableEntity['columns'][number];
    const next = unwrap(
      applyCommand(worldWith(table), {
        type: 'ResizeColumn',
        tableId: table.id,
        columnId: target.id,
        width: 250,
      }),
    );
    const updated = getEntity(next, table.id) as TableEntity;
    expect(updated.columns[1]?.width).toBe(250);
    expect(updated.columns[0]).toEqual(table.columns[0]);
  });

  it('clamps to the column width limits', () => {
    const table = makeTable(ids);
    const target = table.columns[0] as TableEntity['columns'][number];
    const narrow = unwrap(
      applyCommand(worldWith(table), {
        type: 'ResizeColumn',
        tableId: table.id,
        columnId: target.id,
        width: 1,
      }),
    );
    expect((getEntity(narrow, table.id) as TableEntity).columns[0]?.width).toBe(
      DEFAULT_CONSTRAINTS.minColumnWidth,
    );
  });

  it('validates the table, the column and the width', () => {
    const table = makeTable(ids);
    const target = table.columns[0] as TableEntity['columns'][number];
    expectError(
      emptyWorld(),
      { type: 'ResizeColumn', tableId: table.id, columnId: target.id, width: 100 },
      'entity-not-found',
    );
    expectError(
      worldWith(table),
      {
        type: 'ResizeColumn',
        tableId: table.id,
        columnId: 'column:missing' as EntityId,
        width: 100,
      },
      'column-not-found',
    );
    expectError(
      worldWith(table),
      { type: 'ResizeColumn', tableId: table.id, columnId: target.id, width: 0 },
      'invalid-argument',
    );
  });
});

describe('ReorderColumns', () => {
  it('applies a full permutation', () => {
    const table = makeTable(ids);
    const reversed = [...table.columns].reverse().map((column) => column.id);
    const next = unwrap(
      applyCommand(worldWith(table), {
        type: 'ReorderColumns',
        tableId: table.id,
        columnIds: reversed,
      }),
    );
    expect((getEntity(next, table.id) as TableEntity).columns.map((c) => c.id)).toEqual(reversed);
  });

  it('rejects partial permutations, unknown and duplicate ids', () => {
    const table = makeTable(ids);
    const first = table.columns[0] as TableEntity['columns'][number];
    expectError(
      worldWith(table),
      { type: 'ReorderColumns', tableId: table.id, columnIds: [first.id] },
      'invalid-argument',
    );
    expectError(
      worldWith(table),
      {
        type: 'ReorderColumns',
        tableId: table.id,
        columnIds: table.columns.map((_, index) =>
          index === 0
            ? ('column:missing' as EntityId)
            : (table.columns[index] as TableEntity['columns'][number]).id,
        ),
      },
      'column-not-found',
    );
    expectError(
      worldWith(table),
      {
        type: 'ReorderColumns',
        tableId: table.id,
        columnIds: table.columns.map(() => first.id),
      },
      'invalid-argument',
    );
    expectError(
      emptyWorld(),
      { type: 'ReorderColumns', tableId: table.id, columnIds: [] },
      'entity-not-found',
    );
  });
});

describe('SetColumnVisibility', () => {
  it('hides and shows a column', () => {
    const table = makeTable(ids);
    const target = table.columns[2] as TableEntity['columns'][number];
    const hidden = unwrap(
      applyCommand(worldWith(table), {
        type: 'SetColumnVisibility',
        tableId: table.id,
        columnId: target.id,
        visible: false,
      }),
    );
    expect((getEntity(hidden, table.id) as TableEntity).columns[2]?.visible).toBe(false);
  });

  it('validates the table and the column', () => {
    const table = makeTable(ids);
    expectError(
      emptyWorld(),
      {
        type: 'SetColumnVisibility',
        tableId: table.id,
        columnId: 'column:x' as EntityId,
        visible: true,
      },
      'entity-not-found',
    );
    expectError(
      worldWith(table),
      {
        type: 'SetColumnVisibility',
        tableId: table.id,
        columnId: 'column:x' as EntityId,
        visible: true,
      },
      'column-not-found',
    );
  });
});

describe('RemoveEntities', () => {
  it('removes entities', () => {
    const table = makeTable(ids);
    const next = unwrap(
      applyCommand(worldWith(table), { type: 'RemoveEntities', ids: [table.id] }),
    );
    expect(next.entities.size).toBe(0);
  });

  it('rejects empty and unknown id lists', () => {
    expectError(emptyWorld(), { type: 'RemoveEntities', ids: [] }, 'invalid-argument');
    expectError(
      emptyWorld(),
      { type: 'RemoveEntities', ids: ['table:missing' as EntityId] },
      'entity-not-found',
    );
  });
});

describe('entity type checks', () => {
  it('reports a wrong entity type', () => {
    const table = makeTable(ids);
    // Simulate a future non-table entity sharing the world.
    const world: WorldState = {
      entities: new Map([[table.id, { ...table, type: 'sticky' } as unknown as TableEntity]]),
      order: [table.id],
      bindings: new Map(),
    };
    expectError(
      world,
      { type: 'ResizeEntity', id: table.id, width: 200, height: 200 },
      'wrong-entity-type',
    );
  });
});

describe('renaming a box', () => {
  const queryBox = (): TableEntity =>
    buildTableEntity(ids, {
      source: {
        kind: 'query',
        connectionId: TEST_CONNECTION,
        sql: 'SELECT 1',
        label: 'SALES.ORDERS · SQL',
      },
      mode: 'result',
      columns: [],
    });

  it('gives a box a name of its own', () => {
    // A canvas where seven boxes all say "RAW.CLAIMS · SQL" is one you have to
    // read the statements to navigate.
    const box = queryBox();
    const applied = applyCommand(worldWith(box), {
      type: 'SetTableLabel',
      tableId: box.id,
      label: 'deciles by claim type',
    });
    expect(applied.ok).toBe(true);
    const renamed = applied.ok ? applied.value.entities.get(box.id) : undefined;
    expect(tableDisplayName(renamed as TableEntity)).toBe('deciles by claim type');
  });

  it("refuses a stored relation, whose name is the relation's", () => {
    const table = makeTable(ids);
    expectError(
      worldWith(table),
      { type: 'SetTableLabel', tableId: table.id, label: 'sales' },
      'wrong-entity-type',
    );
  });

  it('refuses a blank name and a box that is not there', () => {
    const box = queryBox();
    expectError(
      worldWith(box),
      { type: 'SetTableLabel', tableId: box.id, label: '   ' },
      'invalid-argument',
    );
    expectError(
      emptyWorld(),
      { type: 'SetTableLabel', tableId: box.id, label: 'anything' },
      'entity-not-found',
    );
  });
});
