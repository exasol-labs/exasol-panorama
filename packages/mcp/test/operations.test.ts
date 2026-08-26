import { describe, expect, it } from 'vitest';
import {
  AGENT_HANDLERS,
  AGENT_TOOLS,
  MAX_COLUMNS,
  MAX_ROWS,
  runOperation,
  toolDefinitions,
  toolNamed,
} from '@panorama/mcp';
import { CHART_SPEC, FakeHost, TEST_CONNECTION, makeTable, sampleColumns } from './fixtures.js';

const hostWithTable = (): { host: FakeHost; tableId: string } => {
  const host = new FakeHost();
  const table = host.add(makeTable(host.ids));
  return { host, tableId: table.id };
};

const run = (host: FakeHost, name: string, args?: unknown): Promise<unknown> =>
  runOperation(host, name, args);

describe('the tool list', () => {
  it('offers one tool per operation, with a schema and a description', () => {
    const tools = toolDefinitions();
    expect(tools).toHaveLength(AGENT_TOOLS.length);
    for (const tool of tools) {
      expect(typeof tool['name']).toBe('string');
      expect((tool['description'] as string).length).toBeGreaterThan(40);
      expect((tool['inputSchema'] as Record<string, unknown>)['type']).toBe('object');
    }
  });

  it('marks the ones that only look, so a client can tell them apart', () => {
    const tools = new Map(toolDefinitions().map((tool) => [tool['name'], tool]));
    expect(tools.get('overview')?.['annotations']).toEqual({ readOnlyHint: true });
    expect(tools.get('dispatch')?.['annotations']).toBeUndefined();
  });

  it('names what it does not have', () => {
    expect(() => toolNamed('drop_table')).toThrow(/no tool called drop_table/u);
    expect(() => toolNamed('drop_table')).toThrow(/overview/u);
  });

  it('has a handler for every tool, and a tool for every handler', () => {
    // The two halves run in different processes — the list is offered by the
    // development server and the handlers run in the page — so this is the seam
    // where a tool that exists but does nothing would be caught.
    expect(Object.keys(AGENT_HANDLERS).sort()).toEqual(AGENT_TOOLS.map((tool) => tool.name).sort());
  });
});

describe('exploring', () => {
  it('names the database it reached, so another way in can be checked against it', async () => {
    const { host } = hostWithTable();
    const overview = (await run(host, 'overview')) as Record<string, unknown>;
    // The evidence for "is this the same database": a URL somebody typed, and a
    // name and version the server itself gave at login.
    expect(overview['database']).toEqual({
      url: 'wss://exasol.test:8563',
      database: 'EXAMPLE_DB',
      version: '8.32.0',
      sessionId: 7,
    });
    host.connectedTo = false;
    expect('database' in ((await run(host, 'overview')) as Record<string, unknown>)).toBe(false);
  });

  it('says what the whole application is up to', async () => {
    const { host, tableId } = hostWithTable();
    const overview = (await run(host, 'overview')) as Record<string, Record<string, unknown>>;
    expect(overview['connected']).toBe(true);
    expect(overview['tables']).toBe(1);
    expect(overview['kinds']).toEqual({ relation: 1, query: 0, chart: 0 });
    expect(overview['history']?.['commits']).toBe(2);
    expect(overview['metrics']?.['openTables']).toBe(1);
    expect(overview['selection']).toEqual([]);
    expect(tableId).toContain('table:');
  });

  it('lists the boxes in stacking order, with what each reads', async () => {
    const { host } = hostWithTable();
    host.rowCount = 100;
    const entities = (await run(host, 'entities')) as Record<string, unknown>[];
    expect(entities).toHaveLength(1);
    expect(entities[0]).toMatchObject({
      name: 'SALES.ORDERS',
      source: { kind: 'relation', schema: 'SALES', table: 'ORDERS' },
      mode: 'result',
      columns: 2,
      rows: 100,
    });
  });

  it('describes one box in as few words as will do', async () => {
    const { host, tableId } = hostWithTable();
    const detail = (await run(host, 'entity', { tableId })) as Record<string, unknown>;
    const columns = detail['columns'] as Record<string, unknown>[];
    // What a next step needs: the names and the types, and nothing about pixels.
    expect(columns).toEqual([
      { name: 'COUNTRY', type: 'VARCHAR(64)' },
      { name: 'REVENUE', type: 'DECIMAL(18,2)' },
    ]);
    expect('bindings' in detail).toBe(false);
    expect('scroll' in detail).toBe(false);
  });

  it('stops naming columns before the answer becomes a column list', async () => {
    const host = new FakeHost();
    const wide = host.add(
      makeTable(host.ids, {
        columns: Array.from({ length: MAX_COLUMNS + 12 }, (_, index) => ({
          name: `COL_${index}`,
          type: sampleColumns[0].type,
        })),
      }),
    );
    const detail = (await run(host, 'entity', { tableId: wide.id })) as Record<string, unknown>;
    expect(detail['columns']).toHaveLength(MAX_COLUMNS);
    // How many there are, so a capped list is not read as the whole table.
    expect(detail['columnCount']).toBe(MAX_COLUMNS + 12);
    const all = (await run(host, 'entity', { tableId: wide.id, verbose: true })) as Record<
      string,
      unknown
    >;
    expect(all['columns']).toHaveLength(MAX_COLUMNS + 12);
  });

  it('says all of it when asked to', async () => {
    const { host, tableId } = hostWithTable();
    const detail = (await run(host, 'entity', { tableId, verbose: true })) as Record<
      string,
      unknown
    >;
    const columns = detail['columns'] as Record<string, unknown>[];
    expect(columns[0]).toMatchObject({ visible: true });
    expect(columns[0]?.['id']).toContain('column:');
    expect(detail['bindings']).toEqual([]);
    expect(detail['scroll']).toEqual({ top: 0, left: 0 });
  });

  it('says which box it cannot find, and where to look', async () => {
    const { host } = hostWithTable();
    await expect(run(host, 'entity', { tableId: 'table:nope' })).rejects.toThrow(
      /no entity table:nope.*"entities"/su,
    );
  });

  it('reads the cells a table has, and says how many it has not', async () => {
    const { host, tableId } = hostWithTable();
    host.rowCount = 4;
    host.rows = [
      { COUNTRY: 'Sweden', REVENUE: 10 },
      { COUNTRY: 'France', REVENUE: 20 },
      { COUNTRY: 'Poland', REVENUE: 30 },
      { COUNTRY: 'Denmark', REVENUE: 40 },
    ];
    const answer = (await run(host, 'rows', { tableId, limit: 3 })) as Record<string, unknown>;
    expect(answer['columns']).toEqual(['COUNTRY', 'REVENUE']);
    expect(answer['totalRows']).toBe(4);
    expect(answer['rows']).toEqual([
      { row: 0, COUNTRY: 'Sweden', REVENUE: 10 },
      { row: 1, COUNTRY: 'France', REVENUE: 20 },
      { row: 2, COUNTRY: 'Poland', REVENUE: 30 },
    ]);
    expect('notFetchedYet' in answer).toBe(false);
  });

  it('does not pass a row that has not arrived off as an empty one', async () => {
    const { host, tableId } = hostWithTable();
    host.rowCount = 3;
    host.rows = [
      { COUNTRY: 'Sweden', REVENUE: 1 },
      { COUNTRY: 'France', REVENUE: 2 },
      { COUNTRY: 'x', REVENUE: 3 },
    ];
    host.notFetched = 2;
    const answer = (await run(host, 'rows', { tableId })) as Record<string, unknown>;
    // A cell that has not been fetched is not null: null is a value a database
    // can return, and an agent would read one as the other.
    expect(answer['rows']).toEqual([{ row: 2, COUNTRY: 'x', REVENUE: 3 }]);
    expect(answer['notFetchedYet']).toBe(2);
  });

  it('stops at the end of the table and at its own ceiling', async () => {
    const { host, tableId } = hostWithTable();
    host.rowCount = 1;
    host.rows = [{ COUNTRY: 'Sweden', REVENUE: 1 }];
    expect(
      ((await run(host, 'rows', { tableId, limit: 50 })) as { rows: unknown[] }).rows,
    ).toHaveLength(1);
    host.rowCount = null;
    host.rows = Array.from({ length: MAX_ROWS + 10 }, () => ({ COUNTRY: 'x', REVENUE: 1 }));
    expect(
      ((await run(host, 'rows', { tableId, limit: MAX_ROWS + 10 })) as { rows: unknown[] }).rows,
    ).toHaveLength(MAX_ROWS);
  });

  it('reports the commit graph as a graph, branches and all', async () => {
    const { host, tableId } = hostWithTable();
    host.core.dispatch({
      type: 'MoveEntities',
      ids: [tableId as never],
      position: { x: 1, y: 2, z: 0 },
    });
    const first = host.core.history.head;
    host.core.undo();
    // Committing from an inner commit branches rather than discarding: both
    // futures are still reachable, which is the whole point of a graph.
    host.core.dispatch({
      type: 'MoveEntities',
      ids: [tableId as never],
      position: { x: 99, y: 99, z: 0 },
    });
    const history = (await run(host, 'history')) as Record<string, unknown>;
    const commits = history['commits'] as Record<string, unknown>[];
    expect(commits).toHaveLength(4);
    expect((history['tips'] as string[]).length).toBe(2);
    expect(commits.filter((commit) => commit['head'] === true)).toHaveLength(1);
    expect(commits[0]?.['did']).toBe('The empty document');
    expect(commits[1]?.['did']).toContain('Create table SALES.ORDERS');
    expect(commits[1]?.['ancestorOfHead']).toBe(true);
    expect(commits.find((commit) => commit['id'] === first)?.['ancestorOfHead']).toBe(false);
    expect(history['canUndo']).toBe(true);
  });

  it('reports the session, which is never in the history', async () => {
    const { host, tableId } = hostWithTable();
    host.core.dispatchSession({ type: 'SetSelection', ids: [tableId as never] });
    const session = (await run(host, 'session')) as Record<string, unknown>;
    expect(session['selection']).toEqual([tableId]);
    expect(session['drag']).toBeNull();
    expect(host.core.history.commits.size).toBe(2);
  });

  it('lists the database, and says when there is not one', async () => {
    const { host } = hostWithTable();
    expect(await run(host, 'catalogue')).toEqual({ schemas: [{ name: 'SALES' }] });
    expect(await run(host, 'catalogue', { schema: 'SALES' })).toEqual({
      schema: 'SALES',
      relations: [{ schema: 'SALES', name: 'ORDERS', kind: 'TABLE' }],
    });
    host.connectedTo = false;
    await expect(run(host, 'catalogue')).rejects.toThrow(/no database connected/u);
  });
});

describe('editing', () => {
  it('applies a command and leaves a commit anyone can undo', async () => {
    const { host, tableId } = hostWithTable();
    const answer = (await run(host, 'dispatch', {
      command: { type: 'MoveEntities', ids: [tableId], position: { x: 40, y: 12, z: 0 } },
    })) as Record<string, unknown>;
    expect(answer['did']).toBe('Move 1 entity');
    expect(answer['commit']).toBe(host.core.history.head);
    expect(host.core.world.entities.get(tableId as never)?.transform.x).toBe(40);
    expect(host.core.canUndo).toBe(true);
  });

  it("passes the application's own refusal back, rather than a second opinion", async () => {
    const { host } = hostWithTable();
    // The fields were fine; what was wrong was the meaning, and that is the
    // application's answer to give — the same one a pointer would get.
    await expect(
      run(host, 'dispatch', {
        command: { type: 'MoveEntities', ids: ['table:gone'], position: { x: 0, y: 0, z: 0 } },
      }),
    ).rejects.toThrow(/entity-not-found/u);
    await expect(
      run(host, 'dispatch', { command: { type: 'RemoveEntities', ids: [] } }),
    ).rejects.toThrow(/invalid-argument: RemoveEntities requires at least one id/u);
  });

  it('changes the session without touching the history', async () => {
    const { host, tableId } = hostWithTable();
    const commits = host.core.history.commits.size;
    const session = (await run(host, 'session_dispatch', {
      command: { type: 'SetSelection', ids: [tableId] },
    })) as Record<string, unknown>;
    expect(session['selection']).toEqual([tableId]);
    expect(host.core.history.commits.size).toBe(commits);
  });

  it('moves the head about the graph', async () => {
    const { host, tableId } = hostWithTable();
    await run(host, 'dispatch', {
      command: { type: 'MoveEntities', ids: [tableId], position: { x: 5, y: 5, z: 0 } },
    });
    const moved = host.core.history.head;
    expect((await run(host, 'checkout', { to: 'undo' })) as Record<string, unknown>).toMatchObject({
      did: 'Create table SALES.ORDERS',
      tables: 1,
    });
    expect((await run(host, 'checkout', { to: 'redo' })) as Record<string, unknown>).toMatchObject({
      head: moved,
    });
    // Straight to a commit, which is how a branch is reached.
    expect(
      (await run(host, 'checkout', { to: host.core.history.root })) as Record<string, unknown>,
    ).toMatchObject({ did: 'The empty document', tables: 0 });
  });

  it('says why a move it cannot make is impossible', async () => {
    const { host } = hostWithTable();
    await run(host, 'checkout', { to: host.core.history.root });
    await expect(run(host, 'checkout', { to: 'undo' })).rejects.toThrow(/at the root commit/u);
    await run(host, 'checkout', { to: 'redo' });
    await expect(run(host, 'checkout', { to: 'redo' })).rejects.toThrow(/no children/u);
    await expect(run(host, 'checkout', { to: 'commit:nope' })).rejects.toThrow(/unknown-commit/u);
  });

  it('opens a relation, which is the one way a table comes into being', async () => {
    const host = new FakeHost();
    const opened = (await run(host, 'open_table', {
      schema: 'SALES',
      table: 'COUNTRIES',
    })) as Record<string, unknown>;
    expect(opened['name']).toBe('SALES.COUNTRIES');
    expect(host.calls).toContain('openTable SALES.COUNTRIES');
  });

  it('performs an action and says what it left behind', async () => {
    const { host, tableId } = hostWithTable();
    host.opensOnAction = (): void => {
      host.add(
        makeTable(host.ids, {
          source: {
            kind: 'query',
            connectionId: TEST_CONNECTION,
            sql: 'SELECT 1',
            label: 'SALES.ORDERS · SQL',
            derivedFrom: tableId as never,
          },
          mode: 'editing',
          columns: [],
        }),
      );
    };
    const answer = (await run(host, 'action', { tableId, action: 'sql' })) as Record<
      string,
      unknown
    >;
    expect(host.calls).toContain(`action sql ${tableId}`);
    const opened = answer['opened'] as Record<string, unknown>[];
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ source: { kind: 'query' }, mode: 'editing' });
  });

  it('refuses an action on a box that is not there', async () => {
    const { host } = hostWithTable();
    await expect(run(host, 'action', { tableId: 'table:gone', action: 'close' })).rejects.toThrow(
      /no entity/u,
    );
    await expect(
      run(host, 'action', { tableId: 'table:gone', action: 'detonate' }),
    ).rejects.toThrow(/action must be one of/u);
  });

  it('writes and runs a statement, and answers with the composed one', async () => {
    const host = new FakeHost();
    const query = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: '',
          label: 'SALES.ORDERS · SQL',
        },
        mode: 'editing',
        columns: [...sampleColumns].slice(0, 1),
      }),
    );
    const answer = (await run(host, 'query', {
      tableId: query.id,
      sql: 'SELECT * FROM derived_table',
    })) as Record<string, unknown>;
    expect(host.drafts.get(query.id)).toBe('SELECT * FROM derived_table');
    expect(host.calls).toContain(`runQuery ${query.id} SELECT * FROM derived_table`);
    // The rows come with the result: "run it, then read it" was two calls for
    // every step, and the first thing anybody does with a result is look at it.
    expect(host.calls).toContain('ensureRows 0+5');
    expect(answer['preview']).toEqual([]);
    // And the shape of it, said once rather than three times over.
    expect(answer['columns']).toEqual([{ name: 'COUNTRY', type: 'VARCHAR(64)' }]);
    expect('composed' in answer).toBe(false);
  });

  it('opens a sibling when the box it was given is worth keeping', async () => {
    const host = new FakeHost();
    const base = host.add(makeTable(host.ids));
    const first = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: 'SELECT 1',
          label: 'SALES.ORDERS · SQL',
          derivedFrom: base.id,
        },
        mode: 'result',
        columns: [],
      }),
    );
    host.opensOnAction = (): void => {
      host.add(
        makeTable(host.ids, {
          source: {
            kind: 'query',
            connectionId: TEST_CONNECTION,
            sql: '',
            label: 'SALES.ORDERS · SQL',
            derivedFrom: base.id,
          },
          mode: 'editing',
          columns: [],
        }),
      );
    };
    const answer = (await run(host, 'query', {
      tableId: first.id,
      sql: 'SELECT 2',
      newBox: true,
      label: 'the variant',
      preview: 0,
    })) as Record<string, unknown>;
    // A variant of the same parent, not a refinement of the box asked about.
    expect(answer['id']).not.toBe(first.id);
    expect(answer['name']).toBe('the variant');
    expect(host.drafts.get(first.id)).toBeUndefined();
    expect(host.calls).toContain(`action sql ${base.id}`);
  });

  it('says so when the new box did not appear', async () => {
    const host = new FakeHost();
    const base = host.add(makeTable(host.ids));
    const query = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: 'SELECT 1',
          label: 'SALES.ORDERS · SQL',
          derivedFrom: base.id,
        },
        mode: 'result',
        columns: [],
      }),
    );
    // The action was performed and opened nothing: better to say so than to
    // quietly run the statement in the box that was to be left alone.
    await expect(
      run(host, 'query', { tableId: query.id, sql: 'SELECT 2', newBox: true }),
    ).rejects.toThrow(/new box was not opened/u);
    expect(host.drafts.get(query.id)).toBeUndefined();
  });

  it('reports a drawn chart, and says when a label fell outside the box', async () => {
    const host = new FakeHost();
    const chart = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'chart',
          connectionId: TEST_CONNECTION,
          spec: CHART_SPEC,
          label: 'SALES.ORDERS · Chart',
          derivedFrom: 'table:base' as never,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    host.geometry = {
      width: 600,
      height: 300,
      polygons: 40,
      texts: 12,
      bounds: null,
      clipped: ['a title nobody can read'],
    };
    const answer = (await run(host, 'chart', { tableId: chart.id, spec: CHART_SPEC })) as {
      drawn: Record<string, unknown>;
    };
    // Nothing to say about what it covers when it covered nothing measurable.
    expect('covers' in answer.drawn).toBe(false);
    expect(answer.drawn['clipped']).toEqual(['a title nobody can read']);

    // And nothing at all before the canvas has laid it out.
    host.geometry = null;
    const early = (await run(host, 'chart', { tableId: chart.id, spec: CHART_SPEC })) as Record<
      string,
      unknown
    >;
    expect(early['drawn']).toBeNull();
    expect(early['note']).toContain('Not drawn yet');
  });

  it('names a chart box as it sets it up', async () => {
    const host = new FakeHost();
    const chart = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'chart',
          connectionId: TEST_CONNECTION,
          spec: CHART_SPEC,
          label: 'SALES.ORDERS · Chart',
          derivedFrom: 'table:base' as never,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    const answer = (await run(host, 'chart', {
      tableId: chart.id,
      spec: CHART_SPEC,
      label: 'revenue by country',
    })) as Record<string, unknown>;
    expect(answer['name']).toBe('revenue by country');
  });

  it('says so when there is no parent to open a sibling from', async () => {
    const host = new FakeHost();
    const headless = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: 'SELECT 1',
          label: 'nothing behind it · SQL',
        },
        mode: 'result',
        columns: [],
      }),
    );
    await expect(
      run(host, 'query', { tableId: headless.id, sql: 'SELECT 2', newBox: true }),
    ).rejects.toThrow(/nothing behind it, so there is no parent/u);
  });

  it('renames a box, so a canvas of them can be told apart', async () => {
    const host = new FakeHost();
    const base = host.add(makeTable(host.ids));
    const query = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: 'SELECT 1',
          label: 'SALES.ORDERS · SQL',
          derivedFrom: base.id,
        },
        mode: 'result',
        columns: [],
      }),
    );
    expect(
      (await run(host, 'label', { tableId: query.id, label: 'deciles' })) as never,
    ).toMatchObject({ name: 'deciles' });
    // A stored relation has a name, and it is the relation's.
    await expect(run(host, 'label', { tableId: base.id, label: 'nope' })).rejects.toThrow(
      /stored relation/u,
    );
  });

  it('applies a list of commands in one call, and stops where it fails', async () => {
    const { host, tableId } = hostWithTable();
    const answer = (await run(host, 'dispatch', {
      commands: [
        { type: 'MoveEntities', ids: [tableId], position: { x: 10, y: 20 } },
        { type: 'ResizeEntity', id: tableId, width: 300, height: 200 },
      ],
    })) as Record<string, unknown>;
    expect(answer['applied']).toBe(2);
    expect(host.core.world.entities.get(tableId as never)?.transform).toMatchObject({
      x: 10,
      y: 20,
      // Depth left unsaid is the ground.
      z: 0,
      width: 300,
    });
    // Half of a tidy-up is easier to reason about than an unknown fraction.
    await expect(
      run(host, 'dispatch', {
        commands: [
          { type: 'MoveEntities', ids: [tableId], position: { x: 1, y: 1 } },
          { type: 'MoveEntities', ids: ['table:gone'], position: { x: 1, y: 1 } },
        ],
      }),
    ).rejects.toThrow(/after 1 of 2/u);
    await expect(run(host, 'dispatch', {})).rejects.toThrow(/either command or commands/u);
  });

  it('says what a box reads from, so a statement can name it', async () => {
    const host = new FakeHost();
    const base = host.add(makeTable(host.ids));
    const onRelation = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: '',
          label: 'SALES.ORDERS · SQL',
          derivedFrom: base.id,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    const onQuery = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: '',
          label: 'SALES.ORDERS · SQL · SQL',
          derivedFrom: onRelation.id,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    // A relation has a name; naming it is clearer than referring to it.
    expect(
      ((await run(host, 'entity', { tableId: onRelation.id })) as Record<string, unknown>)[
        'readsFrom'
      ],
    ).toBe('"SALES"."ORDERS"');
    // A query has no name to write, so it is the one thing "derived_table" is for.
    expect(
      ((await run(host, 'entity', { tableId: onQuery.id })) as Record<string, unknown>)[
        'readsFrom'
      ],
    ).toBe('derived_table');
    // And on the brief too, because a box that has just been opened is about to
    // have a statement written into it.
    const briefs = (await run(host, 'entities', {})) as Record<string, unknown>[];
    expect(briefs.map((brief) => brief['readsFrom'])).toEqual([
      undefined,
      '"SALES"."ORDERS"',
      'derived_table',
    ]);
  });

  it('runs a statement that hid a relation behind "derived_table", and says so', async () => {
    const host = new FakeHost();
    const base = host.add(makeTable(host.ids));
    const query = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: '',
          label: 'SALES.ORDERS · SQL',
          derivedFrom: base.id,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    const vague = (await run(host, 'query', {
      tableId: query.id,
      sql: 'SELECT * FROM derived_table',
    })) as Record<string, unknown>;
    // It ran — the composition makes it valid — and the answer says why it could
    // have been written more plainly.
    expect(vague['note']).toBe(
      'This box reads "SALES"."ORDERS"; naming it is clearer than "derived_table".',
    );
    const plain = (await run(host, 'query', {
      tableId: query.id,
      sql: 'SELECT * FROM "SALES"."ORDERS"',
    })) as Record<string, unknown>;
    expect('note' in plain).toBe(false);
  });

  it('says nothing about "derived_table" where that is the right thing to write', async () => {
    const host = new FakeHost();
    const first = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: 'SELECT 1',
          label: 'A · SQL',
        },
        mode: 'result',
        columns: [],
      }),
    );
    const second = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'query',
          connectionId: TEST_CONNECTION,
          sql: '',
          label: 'A · SQL · SQL',
          derivedFrom: first.id,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    const answer = (await run(host, 'query', {
      tableId: second.id,
      sql: 'SELECT * FROM derived_table WHERE x > 1',
    })) as Record<string, unknown>;
    expect('note' in answer).toBe(false);
  });

  it('sends a statement to a box that can run one', async () => {
    const { host, tableId } = hostWithTable();
    await expect(run(host, 'query', { tableId, sql: 'SELECT 1' })).rejects.toThrow(
      /is a relation box, not a query.*action\(tableId, "sql"\)/su,
    );
  });

  it('sets a chart up and shows it', async () => {
    const host = new FakeHost();
    const chart = host.add(
      makeTable(host.ids, {
        source: {
          kind: 'chart',
          connectionId: TEST_CONNECTION,
          spec: CHART_SPEC,
          label: 'SALES.ORDERS · Chart',
          derivedFrom: 'table:base' as never,
        },
        mode: 'editing',
        columns: [],
      }),
    );
    const answer = (await run(host, 'chart', {
      tableId: chart.id,
      spec: { ...CHART_SPEC, type: 'line' },
    })) as Record<string, unknown>;
    expect(host.chartDrafts.get(chart.id)?.type).toBe('line');
    expect(host.shown).toEqual([chart.id]);
    expect(answer['chart']).toEqual({ status: 'ready' });
    // What the canvas made of it, which is the only feedback there is here.
    expect(answer['drawn']).toMatchObject({ box: { width: 400, height: 260 }, labels: 5 });
    expect('chartColumns' in answer).toBe(false);
    const verbose = (await run(host, 'chart', {
      tableId: chart.id,
      spec: CHART_SPEC,
      verbose: true,
    })) as Record<string, unknown>;
    expect(verbose['chartColumns']).toHaveLength(2);
  });

  it('sends a chart specification to a box that can draw one', async () => {
    const { host, tableId } = hostWithTable();
    await expect(run(host, 'chart', { tableId, spec: CHART_SPEC })).rejects.toThrow(
      /not a chart.*action\(tableId, "chart"\)/su,
    );
  });
});
