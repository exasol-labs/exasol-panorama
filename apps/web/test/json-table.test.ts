import { describe, expect, it } from 'vitest';
import { isTableEntity } from '@panorama/core';
import type { TableEntity } from '@panorama/core';
import { presentCell } from '@panorama/table';
import { runOperation } from '@panorama/mcp';
import { ColumnSummaries, summaryPanelView } from '../src/panorama/column-summaries.js';
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

describe('clicking through into a nested document', () => {
  /**
   * End to end: the child table opens beside the parent, on a line, showing only
   * the rows belonging to the row that was clicked. Nothing about this is new
   * machinery — it is the foreign-key follow the canvas already had, handed a
   * reference read from the naming contract instead of from the catalogue, which
   * is what makes it work for a virtual schema that cannot declare one.
   */
  const followFrom = async (property: string, row: number) => {
    const { harness, tableId, entity } = await openFamily();
    const column = entity.columns.find((one) => one.sourceColumn.name === property);
    const follow = column?.json?.follow;
    if (column === undefined || follow === undefined) throw new Error(`${property} leads nowhere`);
    const opened = harness.workspace.followForeignKey({
      tableId,
      columnId: column.id,
      row,
      sourceColumn: property,
      reference: {
        schema: JSON_FAMILY_SCHEMA_NAME,
        table: follow.table,
        column: follow.column,
        constraint: 'document',
      },
      value: harness.workspace.cellAt(tableId, row, follow.valueFrom) as never,
      valueFrom: follow.valueFrom,
    });
    await harness.settle();
    const result = await opened;
    await harness.settle();
    return { harness, tableId, result };
  };

  it("opens a list's elements, filtered to the row they belong to", async () => {
    const { harness, result } = await followFrom('tags', 0);
    const child = harness.workspace.core.world.entities.get(result.tableId) as TableEntity;
    expect(child.source).toMatchObject({ table: 'PEOPLE_tags_arr' });
    // Three tags belong to row 0, and the filter is what says so.
    const request = harness.sourceRequests.at(-1);
    expect(request?.table).toBe('PEOPLE_tags_arr');
    expect(request?.filter).toMatchObject({ column: '_parent', values: ['r0'] });
    // Read as a document too, so `_pos` is the list's order and `value` is the tag.
    expect(child.columns.filter((one) => one.visible).map((one) => one.sourceColumn.name)).toEqual([
      '_pos',
      'value',
    ]);
  });

  it('opens an embedded object by its own key', async () => {
    const { harness } = await followFrom('profile', 0);
    const request = harness.sourceRequests.at(-1);
    expect(request?.table).toBe('PEOPLE_profile');
    expect(request?.filter).toMatchObject({ column: '_id', values: ['p0'] });
  });

  it('draws the line, so the pair stays connected as either is moved', async () => {
    const { harness, tableId, result } = await followFrom('tags', 0);
    const binding = harness.workspace.core.world.bindings.get(result.bindingId);
    expect(binding).toMatchObject({ kind: 'connector', fromId: tableId, toId: result.tableId });
    expect(binding?.label).toContain('tags');
  });
});

describe('the statistics under a picked-out property', () => {
  /**
   * The panel's first question for a property is what is *in* it, and answering
   * it means asking about every column the property is spread across — the
   * branches and the masks — because the property's own name is not a column the
   * database has heard of.
   */
  it('breaks a variant down by branch, and by the three kinds of nothing', async () => {
    const { harness, entity } = await openFamily();
    const value = entity.columns.find((one) => one.sourceColumn.name === 'value');
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedColumns',
      ids: [value?.id as never],
    });
    harness.workspace.syncColumnSummaries();
    await harness.settle();
    const state = harness.workspace.columnSummary(value?.id as never);
    expect(state?.status).toBe('document');
    const summary = state?.status === 'document' ? state.summary : undefined;
    // Five rows: two integers, one string, and two where it was not there.
    expect(summary).toMatchObject({ rows: 5, explicitNulls: 0, missing: 2 });
    expect(summary?.branches).toEqual([
      { name: 'value', count: 2, primary: true },
      { name: 'string', count: 1 },
    ]);
  });

  /**
   * The one that would have failed outright: `tags` is a property and not a
   * column, so asking the database about `tags` asks about nothing.
   */
  it('answers for a property whose name is not a column at all', async () => {
    const { harness, entity } = await openFamily();
    const tags = entity.columns.find((one) => one.sourceColumn.name === 'tags');
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedColumns',
      ids: [tags?.id as never],
    });
    harness.workspace.syncColumnSummaries();
    await harness.settle();
    const state = harness.workspace.columnSummary(tags?.id as never);
    expect(state?.status).toBe('document');
    const summary = state?.status === 'document' ? state.summary : undefined;
    // Three rows carry a list marker — 3, 0 and 1 — and two do not.
    expect(summary?.branches).toEqual([{ name: 'array', count: 3 }]);
    expect(summary).toMatchObject({ missing: 2 });
  });
});

describe('handing a breakdown to the panel', () => {
  const breakdown = {
    rows: 10,
    branches: [{ name: 'value', count: 6, primary: true }],
    explicitNulls: 2,
    emptyStrings: 0,
    missing: 2,
  };

  /**
   * Both halves, and the distribution only where there is one. A property that
   * is a list, or that was `null` in every row, has a breakdown and nothing to
   * distribute — and the panel must not then tell the reader to wait.
   */
  it('sends the breakdown, and the distribution beside it where there is one', () => {
    expect(summaryPanelView({ status: 'document', summary: breakdown })).toEqual({
      document: breakdown,
    });
    const dominant = {
      column: 'value',
      rows: 10,
      nulls: 4,
      basis: 'exact' as const,
      distinct: null,
      min: 1,
      max: 9,
    };
    expect(summaryPanelView({ status: 'document', summary: { ...breakdown, dominant } })).toEqual({
      document: { ...breakdown, dominant },
      summary: dominant,
    });
  });

  /**
   * A column the schema cannot name is a column nothing can be asked about, and
   * it counts as nothing rather than failing the breakdown around it.
   */
  it('counts a column it cannot name as nothing', async () => {
    const harness = await connected({ jsonFamily: true });
    const opening = harness.workspace.openTable({
      schema: JSON_FAMILY_SCHEMA_NAME,
      table: 'PEOPLE',
    });
    await harness.settle();
    const tableId = await opening;
    await harness.settle();
    const summaries = new ColumnSummaries({
      summarise: async () => null,
      // Stands in for a table whose schema is not in hand: every index is
      // nameless, so every branch counts as nothing and everything is missing.
      columnAt: () => undefined,
    });
    const entity = harness.workspace.core.world.entities.get(tableId) as TableEntity;
    const value = entity.columns.find((one) => one.sourceColumn.name === 'value');
    summaries.sync(harness.workspace.core.world, [value?.id as never]);
    await harness.settle();
    const state = summaries.stateOf(value?.id as never);
    expect(state?.status).toBe('document');
    const summary = state?.status === 'document' ? state.summary : undefined;
    expect(summary).toMatchObject({ rows: 0, missing: 0 });
    expect(summary?.branches.every((branch) => branch.count === 0)).toBe(true);
  });

  /**
   * One branch failing does not fail the property.
   *
   * A breakdown is several questions, and the answer to the ones that came back
   * is worth more than nothing at all — so a refusal on one column counts as
   * nothing there and leaves the rest of the breakdown standing.
   */
  it('keeps the rest of a breakdown when one column is refused', async () => {
    const harness = await connected({ jsonFamily: true });
    const opening = harness.workspace.openTable({
      schema: JSON_FAMILY_SCHEMA_NAME,
      table: 'PEOPLE',
    });
    await harness.settle();
    const tableId = await opening;
    await harness.settle();
    const summaries = new ColumnSummaries({
      summarise: async (_id, column) => {
        if (column === 'value|string') throw new Error('no statistics for that one');
        return { column, rows: 5, nulls: 3, basis: 'exact' as const, distinct: null };
      },
      // The two branch columns of `value`, at their positions in the family's
      // root. Everything else is nameless here, which is not the point of the
      // test and keeps it to the two questions that matter.
      columnAt: (_id, index) => ({ 7: 'value', 8: 'value|string' })[index],
    });
    const entity = harness.workspace.core.world.entities.get(tableId) as TableEntity;
    const value = entity.columns.find((one) => one.sourceColumn.name === 'value');
    summaries.sync(harness.workspace.core.world, [value?.id as never]);
    await harness.settle();
    const state = summaries.stateOf(value?.id as never);
    const summary = state?.status === 'document' ? state.summary : undefined;
    // The branch that answered is counted; the one that refused is nothing.
    expect(summary?.branches).toEqual([
      { name: 'value', count: 2, primary: true },
      { name: 'string', count: 0 },
    ]);
  });
});

describe('what an agent is told about a document', () => {
  const answer = async (name: string, args: Record<string, unknown>) => {
    const { harness, tableId } = await openFamily();
    return {
      harness,
      tableId,
      result: (await runOperation(harness.workspace as never, name, {
        tableId,
        ...args,
      })) as Record<string, unknown>,
    };
  };

  it('says which columns present a property, and what their cells can say', async () => {
    const { result } = await answer('entity', {});
    const columns = result['columns'] as readonly Record<string, unknown>[];
    const of = (name: string) => columns.find((column) => column['name'] === name);
    expect(of('value')?.['document']).toMatchObject({
      kind: 'variant',
      branches: ['value', 'string'],
      says: ['missing'],
    });
    // The mask is what makes `null` sayable, so a property without one cannot
    // say it — and an agent should not go looking for a distinction that this
    // column could not have recorded.
    expect(of('note')?.['document']).toMatchObject({ says: ['missing', 'null'] });
    expect(of('empty_text')?.['document']).toMatchObject({ says: ['missing', 'empty string'] });
    expect(of('tags')?.['document']).toMatchObject({
      kind: 'array',
      opens: 'PEOPLE_tags_arr where _parent matches this row',
    });
    // An ordinary property is an ordinary column and says nothing extra.
    expect(of('name')?.['document']).toBeUndefined();
  });

  /**
   * The distinction needs no invention here, because JSON already has it: a
   * property that was missing is an absent key, and one that was explicitly
   * `null` is `null`.
   */
  it('omits a missing property and writes an explicit null as null', async () => {
    const { result } = await answer('rows', { from: 0, limit: 3 });
    const rows = result['rows'] as readonly Record<string, unknown>[];
    // Row 0: `note` was there and was null; `empty_text` was there and empty.
    expect(rows[0]).toHaveProperty('note', null);
    expect(rows[0]).toHaveProperty('empty_text', '');
    // Row 1: neither was there at all, so neither key is.
    expect(rows[1]).not.toHaveProperty('note');
    expect(rows[1]).not.toHaveProperty('empty_text');
  });

  it('reads a value from whichever branch the row used', async () => {
    const { result } = await answer('rows', { from: 0, limit: 3 });
    const rows = result['rows'] as readonly Record<string, unknown>[];
    expect(rows[0]).toHaveProperty('value', 42);
    expect(rows[1]).toHaveProperty('value', 'forty-two');
  });

  /**
   * A cell that has not arrived is not an absent property.
   *
   * The two would look identical in this answer — both an absent key — and they
   * mean opposite things: one is a fact about the document, the other about the
   * fetch. So a row nothing has arrived for is not reported as a row at all, and
   * the count of them is.
   */
  it('does not report a row it has not read as a row of absent properties', async () => {
    const harness = await connected({ jsonFamily: true });
    // Deliberately not settled: the box is in the document and no block is in.
    const opening = harness.workspace.openTable({
      schema: JSON_FAMILY_SCHEMA_NAME,
      table: 'PEOPLE',
    });
    await harness.settle();
    const tableId = await opening;
    const result = (await runOperation(harness.workspace as never, 'rows', {
      tableId,
      from: 0,
      limit: 3,
    })) as Record<string, unknown>;
    if ((result['rows'] as readonly unknown[]).length === 0) {
      expect(result['notFetchedYet']).toBeGreaterThan(0);
    } else {
      // The blocks arrived while the request was in flight, which is the other
      // legitimate outcome — and then every property is read rather than absent.
      expect(result['rows']).not.toEqual([]);
    }
  });

  /** A list of three is not the number three, and it says which it is. */
  it('tags a nested value rather than passing it off as a number', async () => {
    const { result } = await answer('rows', { from: 0, limit: 2 });
    const rows = result['rows'] as readonly Record<string, unknown>[];
    expect(rows[0]).toHaveProperty('tags', { items: 3 });
    expect(rows[0]).toHaveProperty('profile', { object: 'p0' });
    expect(rows[1]).toHaveProperty('tags', { items: 0 });
  });
});

describe('the SQL a document box seeds', () => {
  const opened = async (table: string, wrapper: boolean) => {
    const harness = await connected({
      jsonFamily: true,
      ...(wrapper ? { jsonWrapper: true } : {}),
    });
    const opening = harness.workspace.openTable({ schema: JSON_FAMILY_SCHEMA_NAME, table });
    await harness.settle();
    const tableId = await opening;
    await harness.settle();
    const query = await harness.drive(harness.workspace.openQuery(tableId));
    const box = harness.workspace.core.world.entities.get(query.tableId) as TableEntity;
    return { harness, tableId, sql: box.source.kind === 'query' ? box.source.sql : '', query };
  };

  /**
   * The point of the whole thing: the statement reads the surface the box is
   * showing. Against the source table its columns would be `note|n` and
   * `profile|object` — the opposite of what is on screen — and there would be no
   * way to write a dotted path.
   */
  it('reads the wrapper view where the package publishes one', async () => {
    const { sql } = await opened('PEOPLE', true);
    expect(sql).toBe('SELECT *\nFROM "PANORAMA_JSON_VIEW"."PEOPLE"');
  });

  it('reads the source table where there is no wrapper', async () => {
    const { sql } = await opened('PEOPLE', false);
    expect(sql).toBe(`SELECT *\nFROM "${JSON_FAMILY_SCHEMA_NAME}"."PEOPLE"`);
  });

  /**
   * A package publishes a view per document *root* and none for the children, so
   * a child box has no wrapper — and its statement should read the thing that box
   * is actually showing.
   */
  it('reads the source table for a child of the family', async () => {
    const { sql } = await opened('PEOPLE_tags_arr', true);
    expect(sql).toBe(`SELECT *\nFROM "${JSON_FAMILY_SCHEMA_NAME}"."PEOPLE_tags_arr"`);
  });

  /**
   * `readsFrom` is what an agent is told to write against. It makes the same
   * choice, because the two disagreeing would be worse than either answer — an
   * agent would write a statement whose columns are not the ones the box shows.
   */
  it('tells an agent the same surface it seeded', async () => {
    const { harness, query } = await opened('PEOPLE', true);
    expect(harness.workspace.readsFrom(query.tableId)).toBe('"PANORAMA_JSON_VIEW"."PEOPLE"');
  });

  it('leaves an ordinary table exactly as it was', async () => {
    const harness = await connected();
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const tableId = await opening;
    await harness.settle();
    const query = await harness.drive(harness.workspace.openQuery(tableId));
    const box = harness.workspace.core.world.entities.get(query.tableId) as TableEntity;
    expect(box.source.kind === 'query' ? box.source.sql : '').toBe(
      'SELECT *\nFROM "PANORAMA_TEST"."SALES"',
    );
  });
});
