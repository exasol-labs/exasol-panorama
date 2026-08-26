import { describe, expect, it } from 'vitest';
import type { EntityId } from '@panorama/core';
import { DERIVED_TABLE, isQueryTable, isTableEntity } from '@panorama/core';
import { createAppHarness, firstTableId } from './harness.js';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';

const connected = async (
  options: Parameters<typeof createAppHarness>[0] = {},
): Promise<ReturnType<typeof createAppHarness>> => {
  const harness = createAppHarness(options);
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  return harness;
};

const openBase = async (
  schema = 'PANORAMA_TEST',
  table = 'SALES',
): Promise<{ harness: ReturnType<typeof createAppHarness>; baseId: EntityId }> => {
  const harness = await connected();
  await harness.workspace.openTable({ schema, table });
  return { harness, baseId: firstTableId(harness) };
};

const queryEntity = (harness: ReturnType<typeof createAppHarness>, id: EntityId) => {
  const entity = harness.workspace.core.world.entities.get(id);
  if (entity === undefined || !isTableEntity(entity) || !isQueryTable(entity)) {
    throw new Error('expected a query table');
  }
  return entity;
};

describe('the SQL action', () => {
  it('is offered for a database-backed table', async () => {
    const { harness, baseId } = await openBase();
    expect(harness.workspace.disabledActionsFor(baseId)).toEqual([]);
  });

  it('is greyed out for a sample table, which has no engine behind it', async () => {
    const harness = await connected();
    await harness.workspace.openTable({ schema: DEMO_SCHEMA, table: 'SAMPLE_100' });
    expect(harness.workspace.disabledActionsFor(firstTableId(harness))).toEqual(['sql']);
  });

  it('reports nothing for a table that is not there', async () => {
    const harness = await connected();
    expect(harness.workspace.disabledActionsFor('table:gone' as EntityId)).toEqual([]);
  });

  it('refuses to open an editor on a sample table', async () => {
    const harness = await connected();
    await harness.workspace.openTable({ schema: DEMO_SCHEMA, table: 'SAMPLE_100' });
    await expect(harness.workspace.openQuery(firstTableId(harness))).rejects.toThrow(
      /not backed by a database/,
    );
  });

  it('refuses to open an editor on a table that is not there', async () => {
    const harness = await connected();
    await expect(harness.workspace.openQuery('table:gone' as EntityId)).rejects.toThrow(/No table/);
  });
});

describe('opening a SQL editor', () => {
  it('creates a box in editing mode, connected to its source', async () => {
    const { harness, baseId } = await openBase();
    const { tableId, bindingId } = await harness.workspace.openQuery(baseId);

    const entity = queryEntity(harness, tableId);
    expect(entity.mode).toBe('editing');
    expect(entity.source.label).toBe('PANORAMA_TEST.SALES · SQL');
    // No result yet, so no columns to show.
    expect(entity.columns).toEqual([]);

    const binding = harness.workspace.core.world.bindings.get(bindingId);
    expect(binding).toMatchObject({
      fromId: baseId,
      toId: tableId,
      directed: true,
      meta: { kind: 'query' },
      // The label is the statement, which is what the marker reveals on demand.
      label: 'SELECT * FROM "PANORAMA_TEST"."SALES"',
    });
  });

  it('starts from a statement that selects the whole table', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    expect(harness.workspace.queryDraft(tableId)).toBe('SELECT *\nFROM "PANORAMA_TEST"."SALES"');
  });

  it('places the box beside its source rather than on the stagger', async () => {
    const { harness, baseId } = await openBase();
    const base = harness.workspace.core.world.entities.get(baseId);
    const { tableId } = await harness.workspace.openQuery(baseId);
    const box = queryEntity(harness, tableId);
    expect(box.transform.x).toBeGreaterThan((base?.transform.x ?? 0) + 1);
    expect(box.transform.y).toBe(base?.transform.y);
  });

  it('names its input rather than quoting it when a query box is itself queried', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(tableId, 'SELECT COUNTRY FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();

    const { tableId: nested } = await harness.workspace.openQuery(tableId);
    // One short line, not the statement it is built on wrapped in parentheses:
    // by the third level of refinement that is a wall nobody can read their own
    // clause out of.
    expect(harness.workspace.queryDraft(nested)).toBe(`SELECT *\nFROM ${DERIVED_TABLE}`);
    // And the statement actually sent puts the levels back together.
    expect(harness.workspace.composedQuery(nested)).toBe(
      'WITH derived_table_1 AS (\n  SELECT COUNTRY FROM "PANORAMA_TEST"."SALES"\n)\nSELECT *\nFROM derived_table_1',
    );
  });
});

describe('the draft statement', () => {
  it('is not a command, so typing does not fill history', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    const before = harness.workspace.core.history.commits.size;

    for (const text of ['S', 'SE', 'SEL', 'SELECT 1']) {
      harness.workspace.setQueryDraft(tableId, text);
    }
    expect(harness.workspace.queryDraft(tableId)).toBe('SELECT 1');
    expect(harness.workspace.core.history.commits.size).toBe(before);
  });

  it('falls back to the committed statement for a box with no draft', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    const committed = queryEntity(harness, tableId).source.sql;
    // A fresh workspace-side draft map would still answer with the entity's SQL.
    expect(harness.workspace.queryDraft(tableId)).toBe(committed);
  });

  it('is empty for anything that is not a query box', async () => {
    const { harness, baseId } = await openBase();
    expect(harness.workspace.queryDraft(baseId)).toBe('');
    expect(harness.workspace.queryDraft('table:gone' as EntityId)).toBe('');
  });
});

describe('running a query', () => {
  it('sends the statement and turns the box into its result', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    const statement = 'SELECT COUNTRY, REVENUE FROM "PANORAMA_TEST"."SALES"';

    await harness.workspace.runQuery(tableId, statement);
    await harness.settle();

    const entity = queryEntity(harness, tableId);
    expect(entity.mode).toBe('result');
    expect(entity.source.sql).toBe(statement);
    // The statement reached the data source verbatim.
    expect(harness.sourceRequests.at(-1)).toMatchObject({ sql: statement, schema: 'QUERY' });
    // And the box now has the columns the result turned out to have.
    expect(entity.columns.length).toBeGreaterThan(0);
    expect(harness.workspace.viewOfTable(tableId)?.schema?.columns.length).toBe(
      entity.columns.length,
    );
  });

  it('commits the draft when no statement is passed', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    harness.workspace.setQueryDraft(tableId, 'SELECT 42 FROM "PANORAMA_TEST"."SALES"');

    await harness.workspace.runQuery(tableId);
    await harness.settle();
    expect(queryEntity(harness, tableId).source.sql).toBe('SELECT 42 FROM "PANORAMA_TEST"."SALES"');
  });

  it('costs exactly one history entry no matter how much was typed', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    for (const text of ['S', 'SE', 'SELECT 1']) harness.workspace.setQueryDraft(tableId, text);

    const before = harness.workspace.core.history.commits.size;
    await harness.workspace.runQuery(tableId, 'SELECT 1 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    // The statement, the columns it produced, the mode, the resize, and the
    // connector's new label — but nothing at all for the typing.
    expect(harness.workspace.core.history.commits.size - before).toBeLessThanOrEqual(5);
  });

  it('refuses an empty statement', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    await expect(harness.workspace.runQuery(tableId, '   ')).rejects.toThrow(/Enter a statement/);
    // The box stays in its editor so the text can be fixed.
    expect(queryEntity(harness, tableId).mode).toBe('editing');
  });

  it('refuses a table that is not a query box', async () => {
    const { harness, baseId } = await openBase();
    await expect(harness.workspace.runQuery(baseId, 'SELECT 1')).rejects.toThrow(/No query table/);
  });

  it('replaces the previous result rather than leaking it', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(tableId, 'SELECT 1 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    const first = harness.workspace.viewOfTable(tableId);

    await harness.workspace.runQuery(tableId, 'SELECT 2 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    expect(harness.workspace.viewOfTable(tableId)).not.toBe(first);
    expect(harness.sourceRequests.filter((request) => request.sql !== undefined)).toHaveLength(2);
  });

  it('does not resize when a refined statement returns the same shape', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(tableId, 'SELECT 1 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    const width = queryEntity(harness, tableId).transform.width;

    await harness.workspace.runQuery(tableId, 'SELECT 2 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    // Same columns, so the box must not jump: a refinement is not a new table.
    expect(queryEntity(harness, tableId).transform.width).toBe(width);
  });

  it('leaves the box in its editor when the statement fails', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    // A lost connection is the realistic failure: the box must not pretend to
    // be showing a result it never received.
    await harness.workspace.disconnect();
    await expect(
      harness.workspace.runQuery(tableId, 'SELECT bad FROM "PANORAMA_TEST"."SALES"'),
    ).rejects.toThrow();
    // Still editable, and the statement it rejected is still there to fix.
    expect(queryEntity(harness, tableId).mode).toBe('editing');
    expect(harness.workspace.queryDraft(tableId)).toContain('SELECT bad');
    expect(harness.workspace.hasQueryResult(tableId)).toBe(false);
  });
});

describe('switching a query box back and forth', () => {
  const runOnce = async (): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    tableId: EntityId;
  }> => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(tableId, 'SELECT 1 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    return { harness, tableId };
  };

  it('goes back to the editor to be refined', async () => {
    const { harness, tableId } = await runOnce();
    harness.workspace.editQuery(tableId);
    expect(queryEntity(harness, tableId).mode).toBe('editing');
    // The result is kept, so switching forward again is instant.
    expect(harness.workspace.hasQueryResult(tableId)).toBe(true);
  });

  it('is what the edit button does', async () => {
    const { harness, tableId } = await runOnce();
    const boxes = harness.workspace.core.world.order.length;

    await harness.workspace.performAction(tableId, 'edit');
    expect(queryEntity(harness, tableId).mode).toBe('editing');
    // Editing a statement never opens another box.
    expect(harness.workspace.core.world.order.length).toBe(boxes);
  });

  it('derives a further box when SQL is pressed on a query table', async () => {
    const { harness, tableId } = await runOnce();
    const boxes = harness.workspace.core.world.order.length;

    // Not a toggle: refining a query is how the next one is made, so the box
    // stays on its result and a new one appears beside it.
    await harness.workspace.performAction(tableId, 'sql');
    expect(queryEntity(harness, tableId).mode).toBe('result');
    expect(harness.workspace.core.world.order.length).toBe(boxes + 1);
  });

  it('is the same button going back, once there is a result', async () => {
    const { harness, tableId } = await runOnce();
    await harness.workspace.performAction(tableId, 'edit');
    expect(queryEntity(harness, tableId).mode).toBe('editing');
    expect(harness.workspace.disabledActionsFor(tableId)).toEqual([]);

    // Pressing it again leaves the editor rather than opening a second one.
    await harness.workspace.performAction(tableId, 'edit');
    expect(queryEntity(harness, tableId).mode).toBe('result');
  });

  it('has nothing to cancel during a first edit, and says so', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    expect(harness.workspace.hasQueryResult(tableId)).toBe(false);
    // Nothing to go back to, and nothing to write to a file either.
    expect(harness.workspace.disabledActionsFor(tableId)).toEqual([
      'edit',
      'export',
      'export-csv',
      'export-xlsx',
      'export-parquet',
    ]);

    // Pressing it changes nothing: there is no result behind the editor yet.
    await harness.workspace.performAction(tableId, 'edit');
    expect(queryEntity(harness, tableId).mode).toBe('editing');

    // Once the statement has run there is somewhere to go back to.
    await harness.workspace.runQuery(tableId);
    await harness.settle();
    harness.workspace.editQuery(tableId);
    expect(harness.workspace.disabledActionsFor(tableId)).toEqual([]);
  });

  it('never offers cancelling on a table showing its result', async () => {
    const { harness, tableId } = await runOnce();
    expect(queryEntity(harness, tableId).mode).toBe('result');
    expect(harness.workspace.disabledActionsFor(tableId)).toEqual([]);
  });

  it('abandons an edit without running the field', async () => {
    const { harness, tableId } = await runOnce();
    harness.workspace.editQuery(tableId);
    harness.workspace.setQueryDraft(tableId, 'SELECT nonsense FROM nowhere');

    harness.workspace.showQueryResult(tableId);
    expect(queryEntity(harness, tableId).mode).toBe('result');
    // The committed statement is untouched: Escape is not "run".
    expect(queryEntity(harness, tableId).source.sql).toBe('SELECT 1 FROM "PANORAMA_TEST"."SALES"');
  });

  it('cannot leave the editor before there is a result to show', async () => {
    const { harness, baseId } = await openBase();
    const { tableId } = await harness.workspace.openQuery(baseId);
    harness.workspace.showQueryResult(tableId);
    expect(queryEntity(harness, tableId).mode).toBe('editing');
  });

  it('opens a new box when the button is pressed on an ordinary table', async () => {
    const { harness, baseId } = await openBase();
    const before = harness.workspace.core.world.order.length;
    await harness.workspace.performAction(baseId, 'sql');
    expect(harness.workspace.core.world.order.length).toBe(before + 1);
  });

  it('retitles its line to the statement it now runs', async () => {
    const { harness, tableId } = await runOnce();
    const labelOf = (): string | undefined =>
      [...harness.workspace.core.world.bindings.values()].find(
        (binding) => binding.toId === tableId,
      )?.label;
    expect(labelOf()).toBe('SELECT 1 FROM "PANORAMA_TEST"."SALES"');

    await harness.workspace.runQuery(tableId, 'SELECT 2 FROM "PANORAMA_TEST"."SALES"');
    await harness.settle();
    // A line describing a query the box no longer runs is worse than no label.
    expect(labelOf()).toBe('SELECT 2 FROM "PANORAMA_TEST"."SALES"');
  });

  it('flattens and trims a long statement down to one line', async () => {
    const { harness, tableId } = await runOnce();
    const long = `SELECT\n  ${'COUNTRY, '.repeat(20)}1\nFROM "PANORAMA_TEST"."SALES"`;
    await harness.workspace.runQuery(tableId, long);
    await harness.settle();
    const label = [...harness.workspace.core.world.bindings.values()].find(
      (binding) => binding.toId === tableId,
    )?.label;
    expect(label).not.toContain('\n');
    expect(label?.length).toBeLessThanOrEqual(90);
    expect(label?.endsWith('…')).toBe(true);
  });

  it('reports which boxes are showing an editor', async () => {
    const { harness, tableId } = await runOnce();
    expect(harness.workspace.editingQueryTables()).toEqual([]);
    harness.workspace.editQuery(tableId);
    expect(harness.workspace.editingQueryTables()).toEqual([tableId]);
  });

  it('ignores an edit request for a table with no statement', async () => {
    const { harness, baseId } = await openBase();
    // The edit button is not offered on a stored relation, so reaching here at
    // all would be a bug; it must not corrupt anything if it happens.
    await expect(harness.workspace.performAction(baseId, 'edit')).rejects.toThrow(
      /nothing to configure/,
    );
  });

  it('refuses to edit a table that has no editor', async () => {
    const { harness, baseId } = await openBase();
    expect(() => harness.workspace.editQuery(baseId)).toThrow(/nothing to configure/);
  });

  it('closes like any other table, taking its line with it', async () => {
    const { harness, tableId } = await runOnce();
    await harness.workspace.closeTable(tableId);
    expect(harness.workspace.core.world.entities.has(tableId)).toBe(false);
    expect(harness.workspace.core.world.bindings.size).toBe(0);
  });
});

describe('a chain of refinements', () => {
  const connectedChain = async (
    options: Parameters<typeof createAppHarness>[0] = {},
  ): Promise<{ harness: ReturnType<typeof createAppHarness>; baseId: EntityId }> => {
    const harness = await connected(options);
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    return { harness, baseId: firstTableId(harness) };
  };

  /** A table, a box on it, and a box on that — each having run. */
  const openChain = async (): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    baseId: EntityId;
    firstId: EntityId;
    secondId: EntityId;
  }> => {
    const { harness, baseId } = await openBase();
    const { tableId: firstId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(firstId, 'SELECT COUNTRY, REVENUE\nFROM derived_table');
    await harness.settle();
    const { tableId: secondId } = await harness.workspace.openQuery(firstId);
    await harness.workspace.runQuery(secondId, 'SELECT *\nFROM derived_table\nWHERE REVENUE > 0');
    await harness.settle();
    return { harness, baseId, firstId, secondId };
  };

  it('sends the levels joined into one statement', async () => {
    const { harness } = await openChain();
    expect(harness.sourceRequests.at(-1)?.sql).toBe(
      [
        'WITH derived_table_1 AS (',
        '  SELECT COUNTRY, REVENUE',
        '  FROM "PANORAMA_TEST"."SALES"',
        ')',
        'SELECT *',
        'FROM derived_table_1',
        'WHERE REVENUE > 0',
      ].join('\n'),
    );
  });

  it('keeps each box holding only its own step', async () => {
    const { harness, firstId, secondId } = await openChain();
    // Neither statement mentions the other: that is the whole point.
    expect(queryEntity(harness, firstId).source.sql).toBe(
      'SELECT COUNTRY, REVENUE\nFROM derived_table',
    );
    expect(queryEntity(harness, secondId).source.sql).toBe(
      'SELECT *\nFROM derived_table\nWHERE REVENUE > 0',
    );
  });

  it('runs the boxes above one that changes', async () => {
    const { harness, firstId, secondId } = await openChain();
    const before = harness.sourceRequests.length;

    await harness.workspace.runQuery(firstId, 'SELECT COUNTRY\nFROM derived_table');
    await harness.settle();

    // Two statements sent: the one that changed, and the one built on it.
    expect(harness.sourceRequests.length).toBe(before + 2);
    expect(harness.sourceRequests.at(-1)?.sql).toContain('SELECT COUNTRY\n  FROM');
    // And the box above it is showing rows again rather than left as it was.
    expect(queryEntity(harness, secondId).mode).toBe('result');
    expect(harness.workspace.hasQueryResult(secondId)).toBe(true);
  });

  it('leaves a box that has never run alone', async () => {
    const { harness, firstId } = await openChain();
    const { tableId: unrun } = await harness.workspace.openQuery(firstId);
    const before = harness.sourceRequests.length;

    await harness.workspace.runQuery(firstId, 'SELECT COUNTRY FROM derived_table');
    await harness.settle();

    // The box that ran, plus the one that had a result. Nothing for the editor
    // still being written: it has nothing to bring up to date.
    expect(harness.sourceRequests.length).toBe(before + 2);
    expect(queryEntity(harness, unrun).mode).toBe('editing');
  });

  it('reports a box above that stopped working, and refreshes the rest', async () => {
    // One step above the box that changes fails; the other must still be brought
    // up to date, and the failure named rather than swallowed.
    const { harness, baseId } = await connectedChain({
      failStatement: (sql) => sql.includes('THIS_COLUMN_IS_GONE'),
    });
    const { tableId: firstId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(firstId, 'SELECT COUNTRY, REVENUE FROM derived_table');
    await harness.settle();

    const { tableId: broken } = await harness.workspace.openQuery(firstId);
    await harness.workspace.runQuery(broken, 'SELECT * FROM derived_table');
    await harness.settle();
    const { tableId: fine } = await harness.workspace.openQuery(firstId);
    await harness.workspace.runQuery(fine, 'SELECT COUNTRY FROM derived_table');
    await harness.settle();

    // The broken step only breaks once the earlier step stops providing what it
    // names, which is exactly the situation this has to report.
    harness.workspace.setQueryDraft(broken, 'SELECT THIS_COLUMN_IS_GONE FROM derived_table');
    harness.workspace.core.dispatch({
      type: 'SetTableQuery',
      tableId: broken,
      sql: 'SELECT THIS_COLUMN_IS_GONE FROM derived_table',
    });

    const before = harness.sourceRequests.length;
    await expect(
      harness.workspace.runQuery(firstId, 'SELECT COUNTRY FROM derived_table'),
    ).rejects.toThrow(/Could not refresh a view built on this one/);
    // Three statements attempted: the one that changed and both above it.
    expect(harness.sourceRequests.length).toBe(before + 3);
    expect(harness.workspace.hasQueryResult(fine)).toBe(true);
  });

  it('closes the boxes built on a table that closes', async () => {
    const { harness, baseId, firstId, secondId } = await openChain();
    await harness.workspace.closeTable(baseId);

    // A box holds a reference to its input, so with the input gone there is
    // nothing for its statement to read.
    for (const id of [baseId, firstId, secondId]) {
      expect(harness.workspace.core.world.entities.has(id)).toBe(false);
    }
    expect(harness.workspace.hasQueryResult(secondId)).toBe(false);
  });

  it('closes only what is built on the table that closed', async () => {
    const { harness, baseId, firstId, secondId } = await openChain();
    await harness.workspace.closeTable(firstId);

    expect(harness.workspace.core.world.entities.has(baseId)).toBe(true);
    expect(harness.workspace.core.world.entities.has(firstId)).toBe(false);
    expect(harness.workspace.core.world.entities.has(secondId)).toBe(false);
  });

  it('refuses to run a box whose input has been closed out from under it', async () => {
    const { harness, baseId, firstId } = await openChain();
    // Removing the entity without the workspace's own cascade, which is what an
    // agent editing the document directly would do.
    harness.workspace.core.dispatch({ type: 'RemoveEntities', ids: [baseId] });
    await expect(
      harness.workspace.runQuery(firstId, 'SELECT 1 FROM derived_table'),
    ).rejects.toThrow(/no longer open/);
  });
});
