import { describe, expect, it } from 'vitest';
import { isTableEntity } from '@panorama/core';
import type { TableEntity } from '@panorama/core';
import { presentCell } from '@panorama/table';
import { JSON_FAMILY_SCHEMA_NAME, createAppHarness } from './harness.js';

/**
 * Opening a table that holds a document.
 *
 * End to end from the workspace's side: nothing here is told the table is a
 * family. The harness serves the five tables a loader would have written, and
 * what is asserted is that Panorama works it out from the columns it was handed
 * and draws the document rather than the storage.
 */

const connected = async (options: { jsonFamily?: boolean } = {}) => {
  const harness = createAppHarness(options);
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  return harness;
};

const openFamily = async (table = 'PEOPLE') => {
  const harness = await connected({ jsonFamily: true });
  const opening = harness.workspace.openTable({ schema: JSON_FAMILY_SCHEMA_NAME, table });
  await harness.settle();
  const tableId = await opening;
  await harness.settle();
  const entity = harness.workspace.core.world.entities.get(tableId);
  if (entity === undefined || !isTableEntity(entity)) throw new Error('no table');
  return { harness, tableId, entity: entity as TableEntity };
};

const namesOf = (entity: TableEntity) =>
  entity.columns.filter((column) => column.visible).map((column) => column.sourceColumn.name);

describe('opening a table that holds a document', () => {
  it('draws the properties rather than the columns they are stored in', async () => {
    const { entity } = await openFamily();
    expect(namesOf(entity)).toEqual([
      'mongo_id',
      'name',
      'empty_text',
      'note',
      'value',
      'created_at',
      'profile',
      'tags',
      'items',
    ]);
    // Ten column views where the relation has thirteen columns: nine properties
    // and the hidden `_id`. The four that are not drawn — two masks, the second
    // branch, the object link — are still fetched and still in the cache, now
    // read by the properties that need them rather than shown as themselves.
    expect(entity.columns).toHaveLength(10);
  });

  it('works it out from the columns, having been told nothing', async () => {
    // The only input is the schema the database returned. `document` is what
    // Panorama concluded, and it is what the way back is offered from.
    expect((await openFamily()).entity.source).toMatchObject({ document: true });
  });

  it('leaves an ordinary table exactly as it was', async () => {
    const harness = await connected();
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const tableId = await opening;
    const entity = harness.workspace.core.world.entities.get(tableId) as TableEntity;
    expect(entity.columns.every((column) => column.json === undefined)).toBe(true);
    expect(entity.source).not.toHaveProperty('document');
  });

  it('points a nested property at the table its rows are in', async () => {
    const { entity } = await openFamily();
    const follow = (name: string) =>
      entity.columns.find((column) => column.sourceColumn.name === name)?.json?.follow;
    expect(follow('profile')).toMatchObject({ table: 'PEOPLE_profile', column: '_id' });
    // An array runs the other way: its elements name their parent, so the value
    // to match on comes from the row's own key.
    expect(follow('tags')).toMatchObject({ table: 'PEOPLE_tags_arr', column: '_parent' });
  });

  /**
   * The links are an enrichment, and losing the table to save them would be the
   * wrong trade. A schema whose catalogue will not answer still opens.
   */
  it('still opens when the catalogue will not say what else is in the schema', async () => {
    const harness = await connected({ jsonFamily: true });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored below
    const listTables = harness.client.listTables.bind(harness.client);
    harness.client.listTables = async () => {
      throw new Error('no catalogue today');
    };
    const opening = harness.workspace.openTable({
      schema: JSON_FAMILY_SCHEMA_NAME,
      table: 'PEOPLE',
    });
    await harness.settle();
    const tableId = await opening;
    harness.client.listTables = listTables;
    const entity = harness.workspace.core.world.entities.get(tableId) as TableEntity;
    // Still a document — the properties are read from the columns, which
    // arrived — and simply nowhere to click through to.
    expect(namesOf(entity)).toContain('tags');
    expect(
      entity.columns.find((column) => column.sourceColumn.name === 'tags')?.json?.follow,
    ).toBeUndefined();
  });

  it('reads a child table as a document of its own', async () => {
    const { entity } = await openFamily('PEOPLE_tags_arr');
    // `_pos` stays visible: in a list it is the order of the list, which is the
    // document talking and not the storage.
    expect(namesOf(entity)).toEqual(['_pos', 'value']);
    expect(entity.columns.find((column) => column.sourceColumn.name === '_parent')?.visible).toBe(
      false,
    );
  });
});

describe('reading the rows of a document', () => {
  it('tells an explicit null from a property that was never there', async () => {
    const { harness, tableId, entity } = await openFamily();
    const view = harness.workspace.viewOf(tableId);
    expect(view).not.toBeNull();
    const note = entity.columns.find((column) => column.sourceColumn.name === 'note');
    const cell = (row: number) =>
      presentCell(note?.json as never, (index) => harness.workspace.cellAt(tableId, row, index))
        .state;
    // The same two rows the fixture writes down, now read through the whole
    // stack: worker, cache, column view.
    expect(cell(0)).toBe('null');
    expect(cell(1)).toBe('missing');
  });
});

describe('switching between the document and its storage', () => {
  it('shows the stored columns, and comes back', async () => {
    const { harness, tableId } = await openFamily();
    const columnsNow = () =>
      (harness.workspace.core.world.entities.get(tableId) as TableEntity).columns;

    await harness.drive(harness.workspace.performAction(tableId, 'json'));
    expect(columnsNow().map((column) => column.sourceColumn.name)).toContain('note|n');
    expect(columnsNow().every((column) => column.json === undefined)).toBe(true);
    // Still known to hold a document, which is what keeps the way back offered.
    expect(
      (harness.workspace.core.world.entities.get(tableId) as TableEntity).source,
    ).toMatchObject({ document: true });

    await harness.drive(harness.workspace.performAction(tableId, 'json'));
    expect(columnsNow().map((column) => column.sourceColumn.name)).not.toContain('note|n');
    expect(columnsNow().some((column) => column.json !== undefined)).toBe(true);
  });

  /**
   * In the history, so it undoes.
   *
   * Two commits rather than one — the reshape and the resize that follows it —
   * which is what running a query already does when its result changes shape.
   * Consistency with that is worth more than a batching primitive the history
   * model does not otherwise have.
   */
  it('undoes, because it is something somebody did', async () => {
    const { harness, tableId } = await openFamily();
    await harness.drive(harness.workspace.performAction(tableId, 'json'));
    const names = () =>
      (harness.workspace.core.world.entities.get(tableId) as TableEntity).columns.map(
        (column) => column.sourceColumn.name,
      );
    expect(names()).toContain('note|n');
    harness.workspace.core.undo();
    harness.workspace.core.undo();
    expect(names()).not.toContain('note|n');
    expect(names()).toContain('note');
  });

  it('does nothing on a table that holds no document', async () => {
    const harness = await connected();
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const tableId = await opening;
    await harness.settle();
    const before = (harness.workspace.core.world.entities.get(tableId) as TableEntity).columns;
    await harness.drive(harness.workspace.performAction(tableId, 'json'));
    expect((harness.workspace.core.world.entities.get(tableId) as TableEntity).columns).toEqual(
      before,
    );
  });
});
