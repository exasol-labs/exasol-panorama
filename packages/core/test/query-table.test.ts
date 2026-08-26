import { describe, expect, it } from 'vitest';
import type { EntityId, TableColumnView, TableEntity } from '@panorama/core';
import {
  applyCommand,
  buildTableColumns,
  buildTableEntity,
  emptyWorld,
  dataType,
  describeCommand,
  isQueryTable,
  tableContentWidth,
  tableDisplayName,
} from '@panorama/core';
import { TEST_CONNECTION, makeTable, testIds } from './fixtures.js';

const ids = testIds(7);

const queryTable = (overrides: { sql?: string; mode?: 'result' | 'editing' } = {}): TableEntity =>
  buildTableEntity(ids, {
    source: {
      kind: 'query',
      connectionId: TEST_CONNECTION,
      sql: overrides.sql ?? 'SELECT 1',
      label: 'SALES.ORDERS · SQL',
    },
    mode: overrides.mode ?? 'editing',
    columns: [],
  });

/** A world holding one query table and one plain table. */
const worldWith = (
  query: TableEntity,
): { world: ReturnType<typeof emptyWorld>; plain: TableEntity } => {
  const plain = makeTable(ids);
  let world = emptyWorld();
  for (const entity of [query, plain]) {
    const applied = applyCommand(world, { type: 'CreateTableEntity', entity });
    if (!applied.ok) throw new Error(applied.error.message);
    world = applied.value;
  }
  return { world, plain };
};

describe('a query-backed table', () => {
  it('is titled by its label rather than a schema and table', () => {
    const entity = queryTable();
    expect(tableDisplayName(entity)).toBe('SALES.ORDERS · SQL');
    expect(isQueryTable(entity)).toBe(true);
    expect(isQueryTable(makeTable(ids))).toBe(false);
  });

  it('starts in whichever mode it was built for', () => {
    expect(queryTable().mode).toBe('editing');
    expect(queryTable({ mode: 'result' }).mode).toBe('result');
    // A stored relation is always showing its result; there is nothing to edit.
    expect(makeTable(ids).mode).toBe('result');
  });

  it('describes its commands for the history view', () => {
    const entity = queryTable();
    expect(describeCommand({ type: 'CreateTableEntity', entity })).toBe(
      'Create table SALES.ORDERS · SQL',
    );
    expect(describeCommand({ type: 'SetTableQuery', tableId: entity.id, sql: 'SELECT 2' })).toBe(
      'Edit query',
    );
    expect(describeCommand({ type: 'SetTableMode', tableId: entity.id, mode: 'editing' })).toBe(
      'Edit query',
    );
    expect(describeCommand({ type: 'SetTableMode', tableId: entity.id, mode: 'result' })).toBe(
      'Show result',
    );
    expect(describeCommand({ type: 'SetTableColumns', tableId: entity.id, columns: [] })).toBe(
      'Set 0 columns',
    );
  });
});

describe('SetTableQuery', () => {
  it('replaces the statement', () => {
    const entity = queryTable({ sql: 'SELECT 1' });
    const { world } = worldWith(entity);
    const applied = applyCommand(world, {
      type: 'SetTableQuery',
      tableId: entity.id,
      sql: 'SELECT 2',
    });
    if (!applied.ok) throw new Error(applied.error.message);
    const updated = applied.value.entities.get(entity.id);
    if (updated === undefined || updated.type !== 'table' || !isQueryTable(updated)) {
      throw new Error('expected a query table');
    }
    expect(updated.source.sql).toBe('SELECT 2');
    // The mode is untouched: running is a separate step from editing.
    expect(updated.mode).toBe('editing');
  });

  it('refuses a statement that is only whitespace', () => {
    const entity = queryTable();
    const { world } = worldWith(entity);
    const applied = applyCommand(world, { type: 'SetTableQuery', tableId: entity.id, sql: '  \n' });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('invalid-argument');
  });

  it('refuses a table that is not backed by a query', () => {
    const entity = queryTable();
    const { world, plain } = worldWith(entity);
    const applied = applyCommand(world, {
      type: 'SetTableQuery',
      tableId: plain.id,
      sql: 'SELECT',
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('not-a-query');
  });

  it('refuses a table that is not there', () => {
    const entity = queryTable();
    const { world } = worldWith(entity);
    const applied = applyCommand(world, {
      type: 'SetTableQuery',
      tableId: 'table:missing' as EntityId,
      sql: 'SELECT 1',
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('entity-not-found');
  });
});

describe('SetTableMode', () => {
  it('switches between the editor and the result', () => {
    const entity = queryTable();
    const { world } = worldWith(entity);
    const shown = applyCommand(world, {
      type: 'SetTableMode',
      tableId: entity.id,
      mode: 'result',
    });
    if (!shown.ok) throw new Error(shown.error.message);
    expect(shown.value.entities.get(entity.id)).toMatchObject({ mode: 'result' });

    const back = applyCommand(shown.value, {
      type: 'SetTableMode',
      tableId: entity.id,
      mode: 'editing',
    });
    if (!back.ok) throw new Error(back.error.message);
    expect(back.value.entities.get(entity.id)).toMatchObject({ mode: 'editing' });
  });

  it('refuses a stored relation, which has no editor', () => {
    const entity = queryTable();
    const { world, plain } = worldWith(entity);
    const applied = applyCommand(world, {
      type: 'SetTableMode',
      tableId: plain.id,
      mode: 'editing',
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('not-a-query');
  });
});

describe('SetTableColumns', () => {
  const columns = (): TableColumnView[] =>
    buildTableColumns(ids, [
      { name: 'TOTAL', type: dataType('decimal', 'DECIMAL(18,2)', { scale: 2 }) },
      { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
    ]);

  it('gives a query table the shape its result turned out to have', () => {
    const entity = queryTable();
    const { world } = worldWith(entity);
    expect(entity.columns).toHaveLength(0);
    const applied = applyCommand(world, {
      type: 'SetTableColumns',
      tableId: entity.id,
      columns: columns(),
    });
    if (!applied.ok) throw new Error(applied.error.message);
    const updated = applied.value.entities.get(entity.id);
    expect(updated).toMatchObject({ type: 'table' });
    if (updated === undefined || updated.type !== 'table') return;
    expect(updated.columns.map((column) => column.sourceColumn.name)).toEqual(['TOTAL', 'COUNTRY']);
    // Wide enough for the gutter plus both columns.
    expect(tableContentWidth(updated.columns)).toBeGreaterThan(
      tableContentWidth(updated.columns.slice(0, 1)),
    );
  });

  it('refuses a column id used twice', () => {
    const entity = queryTable();
    const { world } = worldWith(entity);
    const [first] = columns();
    if (first === undefined) throw new Error('expected a column');
    const applied = applyCommand(world, {
      type: 'SetTableColumns',
      tableId: entity.id,
      columns: [first, first],
    });
    expect(applied.ok).toBe(false);
    if (applied.ok) return;
    expect(applied.error.code).toBe('invalid-argument');
  });

  it('refuses a table that is not there', () => {
    const entity = queryTable();
    const { world } = worldWith(entity);
    const applied = applyCommand(world, {
      type: 'SetTableColumns',
      tableId: 'table:missing' as EntityId,
      columns: [],
    });
    expect(applied.ok).toBe(false);
  });
});
