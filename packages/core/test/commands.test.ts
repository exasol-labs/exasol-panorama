import { describe, expect, it } from 'vitest';
import type { Command, EntityId } from '@panorama/core';
import { commandError, describeCommand } from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds());
const columnId = (table.columns[0] as { id: EntityId }).id;

describe('describeCommand', () => {
  const cases: ReadonlyArray<readonly [Command, string]> = [
    [{ type: 'CreateTableEntity', entity: table }, 'Create table SALES.ORDERS'],
    [{ type: 'MoveEntities', ids: [table.id], position: { x: 0, y: 0, z: 0 } }, 'Move 1 entity'],
    [
      { type: 'MoveEntities', ids: [table.id, table.id], position: { x: 0, y: 0, z: 0 } },
      'Move 2 entities',
    ],
    [
      { type: 'ResizeEntity', id: table.id, width: 800.4, height: 600.6 },
      'Resize entity to 800×601',
    ],
    [{ type: 'ResizeColumn', tableId: table.id, columnId, width: 120.2 }, 'Resize column to 120'],
    [{ type: 'ReorderColumns', tableId: table.id, columnIds: [columnId] }, 'Reorder columns'],
    [{ type: 'SetColumnVisibility', tableId: table.id, columnId, visible: true }, 'Show column'],
    [{ type: 'SetColumnVisibility', tableId: table.id, columnId, visible: false }, 'Hide column'],
    [{ type: 'RemoveEntities', ids: [table.id] }, 'Remove 1 entity'],
    [{ type: 'RemoveEntities', ids: [table.id, table.id] }, 'Remove 2 entities'],
  ];

  it.each(cases)('describes %j', (command, expected) => {
    expect(describeCommand(command)).toBe(expected);
  });
});

describe('commandError', () => {
  it('builds a machine-readable error', () => {
    expect(commandError('invalid-argument', 'nope')).toEqual({
      code: 'invalid-argument',
      message: 'nope',
    });
  });
});
