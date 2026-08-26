import { describe, expect, it } from 'vitest';
import { runOperation } from '@panorama/mcp';
import { CHART_SPEC, FakeHost, TEST_CONNECTION, makeTable } from './fixtures.js';
import { AUTO_ANCHOR, dataType } from '@panorama/core';
import type { EntityId } from '@panorama/core';

/**
 * How each kind of box reads.
 *
 * A projection is only useful if it says the thing that distinguishes one box
 * from another: a query has a statement, a chart has a specification, and a
 * table showing the rows behind a selection has the chart it follows.
 */

const host = (): FakeHost => new FakeHost();

describe('what a picked mark stands for', () => {
  it('says which data set and row it is, and the value the rows behind it share', async () => {
    const fake = host();
    const chart = fake.add(
      makeTable(fake.ids, {
        source: {
          kind: 'chart',
          connectionId: TEST_CONNECTION,
          spec: CHART_SPEC,
          label: 'a chart',
          derivedFrom: 'table:base' as never,
        },
        mode: 'result',
        columns: [],
      }),
    );
    fake.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: [{ entityId: chart.id, series: 0, data: 0 }],
    });
    const session = (await runOperation(fake, 'session', {})) as {
      selectedMarks: readonly Record<string, unknown>[];
    };
    // A mark on its own is a series and a data index. What anybody wants from one
    // is "the rows behind Sweden", which is what this adds.
    expect(session.selectedMarks[0]).toEqual({
      entityId: chart.id,
      series: 0,
      data: 0,
      frame: 'primary',
      row: 0,
      column: 'COUNTRY',
      value: 'Germany',
    });
  });

  it('reports a mark the picture cannot trace as picked and nothing more', async () => {
    const fake = host();
    const chart = fake.add(
      makeTable(fake.ids, {
        source: {
          kind: 'chart',
          connectionId: TEST_CONNECTION,
          spec: CHART_SPEC,
          label: 'a chart',
          derivedFrom: 'table:base' as never,
        },
        mode: 'result',
        columns: [],
      }),
    );
    fake.meaning = null;
    fake.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: [{ entityId: chart.id, series: 1, data: 2 }],
    });
    const session = (await runOperation(fake, 'session', {})) as {
      selectedMarks: readonly Record<string, unknown>[];
    };
    expect(session.selectedMarks[0]).toEqual({ entityId: chart.id, series: 1, data: 2 });
  });
});

describe('what a box looks like written down', () => {
  it('names a query by its statement and what it refines', async () => {
    const fake = host();
    const base = fake.add(makeTable(fake.ids));
    const query = fake.add(
      makeTable(fake.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: 'SELECT COUNTRY FROM derived_table',
          label: 'SALES.ORDERS · SQL',
          derivedFrom: base.id,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    // An edit that has not been run: the box still shows the old statement.
    fake.drafts.set(query.id, 'SELECT COUNTRY, REVENUE FROM derived_table');
    const detail = (await runOperation(fake, 'entity', { tableId: query.id })) as Record<
      string,
      unknown
    >;
    expect(detail['source']).toEqual({
      kind: 'query',
      label: 'SALES.ORDERS · SQL',
      sql: 'SELECT COUNTRY FROM derived_table',
    });
    expect(detail['derivedFrom']).toBe(base.id);
    // The draft, because it differs from the committed statement — that is news.
    // The composed form is not: it is the same base transformation every time.
    expect(detail['draft']).toBe('SELECT COUNTRY, REVENUE FROM derived_table');
    expect('composed' in detail).toBe(false);
    expect(detail['mode']).toBe('editing');
    const asked = (await runOperation(fake, 'entity', {
      tableId: query.id,
      verbose: true,
    })) as Record<string, unknown>;
    expect(asked['composed']).toContain('derived_table_1');
    // And a draft that is the statement already shown is not said twice.
    fake.drafts.set(query.id, 'SELECT COUNTRY FROM derived_table');
    const settled = (await runOperation(fake, 'entity', { tableId: query.id })) as Record<
      string,
      unknown
    >;
    expect('draft' in settled).toBe(false);
  });

  it('names a chart by its specification', async () => {
    const fake = host();
    const chart = fake.add(
      makeTable(fake.ids, {
        source: {
          kind: 'chart',
          connectionId: TEST_CONNECTION,
          spec: CHART_SPEC,
          label: 'SALES.ORDERS · Chart',
          derivedFrom: 'table:base' as EntityId,
        },
        columns: [],
      }),
    );
    const detail = (await runOperation(fake, 'entity', { tableId: chart.id })) as Record<
      string,
      unknown
    >;
    expect(detail['source']).toMatchObject({ kind: 'chart', spec: CHART_SPEC });
    expect(detail['chart']).toMatchObject({ status: 'ready', data: { rows: 3, basis: 'exact' } });
  });

  it('says which chart a drill-down table follows', async () => {
    const fake = host();
    const table = fake.add(
      makeTable(fake.ids, {
        source: {
          kind: 'relation',
          connectionId: TEST_CONNECTION,
          schema: 'SALES',
          table: 'ORDERS',
          selectionOf: 'table:chart' as EntityId,
        },
      }),
    );
    const brief = ((await runOperation(fake, 'entities', {})) as Record<string, unknown>[])[0];
    expect(brief?.['source']).toMatchObject({ selectionOf: 'table:chart' });
    expect(brief?.['derivedFrom']).toBe('table:chart');
    expect(table.source.kind).toBe('relation');
  });

  it("carries a connector's label and the detail behind it", async () => {
    const fake = host();
    const from = fake.add(makeTable(fake.ids));
    const to = fake.add(makeTable(fake.ids));
    const applied = fake.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: fake.ids.binding(),
        kind: 'connector',
        fromId: from.id,
        toId: to.id,
        from: AUTO_ANCHOR,
        to: AUTO_ANCHOR,
        directed: true,
        label: 'COUNTRY = Denmark',
        meta: { kind: 'foreign-key', column: 'COUNTRY' },
      },
    });
    expect(applied.ok).toBe(true);
    const detail = (await runOperation(fake, 'entity', {
      tableId: from.id,
      verbose: true,
    })) as Record<string, unknown>;
    const bindings = detail['bindings'] as Record<string, unknown>[];
    expect(bindings[0]).toMatchObject({
      from: from.id,
      to: to.id,
      directed: true,
      label: 'COUNTRY = Denmark',
      meta: { kind: 'foreign-key', column: 'COUNTRY' },
    });
    // A plain connector says less, and does not pretend otherwise.
    const bare = fake.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: fake.ids.binding(),
        kind: 'connector',
        fromId: to.id,
        toId: from.id,
        from: AUTO_ANCHOR,
        to: AUTO_ANCHOR,
        directed: false,
      },
    });
    expect(bare.ok).toBe(true);
    const after = (await runOperation(fake, 'entity', {
      tableId: to.id,
      verbose: true,
    })) as Record<string, unknown>;
    const plain = (after['bindings'] as Record<string, unknown>[]).find(
      (binding) => binding['directed'] === false,
    );
    expect(plain).toBeDefined();
    expect('label' in (plain ?? {})).toBe(false);
    expect('meta' in (plain ?? {})).toBe(false);
  });

  it('marks a followable column, and a hidden one', async () => {
    const fake = host();
    const table = fake.add(
      makeTable(fake.ids, {
        columns: [
          {
            name: 'COUNTRY',
            type: dataType('varchar', 'VARCHAR(64)', { size: 64 }),
            foreignKey: {
              schema: 'SALES',
              table: 'COUNTRIES',
              column: 'NAME',
              constraint: 'FK_COUNTRY',
            },
          },
        ],
      }),
    );
    const columnId = table.columns[0]?.id as EntityId;
    fake.core.dispatch({
      type: 'SetColumnVisibility',
      tableId: table.id,
      columnId,
      visible: false,
    });
    const detail = (await runOperation(fake, 'entity', { tableId: table.id })) as Record<
      string,
      unknown
    >;
    const columns = detail['columns'] as Record<string, unknown>[];
    // Hidden is worth saying; visible is the ordinary case and says nothing.
    expect(columns[0]).toEqual({
      name: 'COUNTRY',
      type: 'VARCHAR(64)',
      hidden: true,
      foreignKey: { schema: 'SALES', table: 'COUNTRIES', column: 'NAME', constraint: 'FK_COUNTRY' },
    });
    // A hidden column is not read from, because it is not on screen.
    const rows = (await runOperation(fake, 'rows', { tableId: table.id })) as Record<
      string,
      unknown
    >;
    expect(rows['columns']).toEqual([]);

    // And with one of each, only the visible one is in the answer.
    const both = fake.add(makeTable(fake.ids));
    fake.rowCount = 1;
    fake.rows = [{ COUNTRY: 'Sweden', REVENUE: 12 }];
    fake.core.dispatch({
      type: 'SetColumnVisibility',
      tableId: both.id,
      columnId: both.columns[1]?.id as EntityId,
      visible: false,
    });
    const mixed = (await runOperation(fake, 'rows', { tableId: both.id })) as Record<
      string,
      unknown
    >;
    expect(mixed['columns']).toEqual(['COUNTRY']);
    expect(mixed['rows']).toEqual([{ row: 0, COUNTRY: 'Sweden' }]);
  });

  it('keeps a followable column followable in the short answer too', async () => {
    const fake = host();
    const table = fake.add(
      makeTable(fake.ids, {
        columns: [
          {
            name: 'COUNTRY',
            type: dataType('varchar', 'VARCHAR(64)', { size: 64 }),
            foreignKey: {
              schema: 'SALES',
              table: 'COUNTRIES',
              column: 'NAME',
              constraint: 'FK',
            },
          },
        ],
      }),
    );
    // Terse is about leaving out what a next step cannot use; a key it could
    // follow is not that.
    const detail = (await runOperation(fake, 'entity', { tableId: table.id })) as Record<
      string,
      unknown
    >;
    expect((detail['columns'] as Record<string, unknown>[])[0]?.['foreignKey']).toMatchObject({
      table: 'COUNTRIES',
    });
    const verbose = (await runOperation(fake, 'entity', {
      tableId: table.id,
      verbose: true,
    })) as Record<string, unknown>;
    expect((verbose['columns'] as Record<string, unknown>[])[0]?.['foreignKey']).toBeDefined();
  });

  it('reads a table that is not open, and one whose source cannot count', async () => {
    const fake = host();
    // An entity in the document with no view behind it: an agent can see a box
    // the application has not finished opening, and it says so rather than
    // inventing a scroll position.
    const table = makeTable(fake.ids);
    fake.core.dispatch({ type: 'CreateTableEntity', entity: table });
    fake.rowCount = null;
    const detail = (await runOperation(fake, 'entity', { tableId: table.id })) as Record<
      string,
      unknown
    >;
    expect(detail['rows']).toBeNull();
    const rows = (await runOperation(fake, 'rows', { tableId: table.id, limit: 2 })) as Record<
      string,
      unknown
    >;
    expect(rows['totalRows']).toBeNull();
    expect(rows['rows']).toEqual([]);
    expect(rows['notFetchedYet']).toBe(2);
  });
});
