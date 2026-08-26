import { describe, expect, it } from 'vitest';
import type { EntityId, RelationSource, TableEntity, WorldState } from '@panorama/core';
import {
  DERIVED_TABLE,
  applyCommand,
  buildTableEntity,
  composeQuery,
  derivedChain,
  derivedStepName,
  derivedTableRanges,
  derivedTablesOf,
  derivedTreeOf,
  emptyWorld,
  identifierRanges,
  replaceDerivedTable,
  splitWithClause,
} from '@panorama/core';
import { TEST_CONNECTION, makeTable, testIds } from './fixtures.js';

const ids = testIds(11);

/** A stored relation as a *name*: what an identifier can be swapped for. */
const relationSql = (source: RelationSource): string => `"${source.schema}"."${source.table}"`;

const queryOn = (base: EntityId | undefined, sql: string): TableEntity =>
  buildTableEntity(ids, {
    source: {
      kind: 'query',
      connectionId: TEST_CONNECTION,
      sql,
      label: 'step · SQL',
      ...(base === undefined ? {} : { derivedFrom: base }),
    },
    mode: 'result',
    columns: [],
  });

const worldOf = (...entities: readonly TableEntity[]): WorldState => {
  let world = emptyWorld();
  for (const entity of entities) {
    const applied = applyCommand(world, { type: 'CreateTableEntity', entity });
    if (!applied.ok) throw new Error(applied.error.message);
    world = applied.value;
  }
  return world;
};

describe('finding where a statement names its input', () => {
  it('finds it as a table reference', () => {
    expect(derivedTableRanges(`SELECT * FROM ${DERIVED_TABLE}`)).toEqual([{ from: 14, to: 27 }]);
  });

  it('finds every one of them', () => {
    const sql = 'SELECT a.X FROM derived_table a JOIN derived_table b ON a.X = b.X';
    expect(derivedTableRanges(sql)).toHaveLength(2);
  });

  it('finds it however it was capitalised, because an identifier is', () => {
    expect(derivedTableRanges('SELECT * FROM DERIVED_TABLE')).toHaveLength(1);
  });

  it('leaves a longer name that merely contains it alone', () => {
    expect(derivedTableRanges('SELECT * FROM my_derived_table')).toEqual([]);
    expect(derivedTableRanges('SELECT * FROM derived_tables')).toEqual([]);
    expect(derivedTableRanges('SELECT * FROM derived_table2')).toEqual([]);
  });

  it('finds no name at all where there is no name to find', () => {
    // A zero-length name matches everywhere and consumes nothing.
    expect(identifierRanges('SELECT * FROM derived_table', '')).toEqual([]);
  });

  it('leaves it alone inside a string, which is a value and not a name', () => {
    expect(derivedTableRanges("SELECT * FROM t WHERE label = 'derived_table'")).toEqual([]);
    // A doubled quote is SQL's escape, so the literal has not ended there.
    expect(derivedTableRanges("SELECT 'it''s derived_table' FROM t")).toEqual([]);
  });

  it('leaves it alone inside a quoted identifier, which names something real', () => {
    // Someone with a table actually called that has quoted it, and means it.
    expect(derivedTableRanges('SELECT * FROM "derived_table"')).toEqual([]);
  });

  it('leaves it alone inside a comment', () => {
    expect(derivedTableRanges('-- reads derived_table\nSELECT 1')).toEqual([]);
    expect(derivedTableRanges('/* reads\n derived_table */ SELECT 1')).toEqual([]);
    // A comment that runs to the end of the statement still ends.
    expect(derivedTableRanges('SELECT 1 -- derived_table')).toEqual([]);
    expect(derivedTableRanges('SELECT 1 /* derived_table')).toEqual([]);
  });

  it('treats an unterminated string as running to the end, as a database would', () => {
    expect(derivedTableRanges("SELECT 'oops derived_table")).toEqual([]);
  });

  it('still finds it after a comment or a string has closed', () => {
    expect(derivedTableRanges('-- note\nSELECT * FROM derived_table')).toHaveLength(1);
    expect(derivedTableRanges("SELECT 'x' FROM derived_table")).toHaveLength(1);
  });
});

describe('renaming a statement input', () => {
  it('swaps an identifier for an identifier, so every position stays valid', () => {
    expect(replaceDerivedTable('SELECT d.X FROM derived_table AS d', 'step_1')).toBe(
      'SELECT d.X FROM step_1 AS d',
    );
    expect(replaceDerivedTable('SELECT derived_table.X FROM derived_table', 'step_1')).toBe(
      'SELECT step_1.X FROM step_1',
    );
  });

  it('leaves a statement that does not mention it untouched', () => {
    expect(replaceDerivedTable('SELECT 1', 'step_1')).toBe('SELECT 1');
  });
});

describe('the chain a query is built from', () => {
  it('is the query itself, when there is nothing behind it', () => {
    const query = queryOn(undefined, 'SELECT 1');
    const chain = derivedChain(worldOf(query), query.id);
    expect(chain.ok && chain.value.relation).toBeUndefined();
    expect(chain.ok && chain.value.steps.map((step) => step.id)).toEqual([query.id]);
  });

  it('ends at the stored relation it reads, earliest first', () => {
    const table = makeTable(ids);
    const first = queryOn(table.id, 'SELECT * FROM derived_table');
    const second = queryOn(first.id, 'SELECT * FROM derived_table');
    const chain = derivedChain(worldOf(table, first, second), second.id);

    expect(chain.ok && chain.value.relation?.table).toBe('ORDERS');
    expect(chain.ok && chain.value.steps.map((step) => step.id)).toEqual([first.id, second.id]);
  });

  it('refuses anything that is not a query', () => {
    const table = makeTable(ids);
    expect(derivedChain(worldOf(table), table.id)).toMatchObject({
      ok: false,
      error: { code: 'not-a-query' },
    });
    expect(derivedChain(emptyWorld(), 'table:gone' as EntityId)).toMatchObject({
      ok: false,
      error: { code: 'not-a-query' },
    });
  });

  it('says so when the table a query refines has been closed', () => {
    const query = queryOn('table:gone' as EntityId, 'SELECT * FROM derived_table');
    expect(derivedChain(worldOf(query), query.id)).toMatchObject({
      ok: false,
      error: { code: 'missing-base' },
    });
  });

  it('reports a loop rather than following it forever', () => {
    // Not reachable through the app, where a box is opened on a table that
    // already exists — but a document can be written by anything.
    const first = queryOn(undefined, 'SELECT 1');
    const second = queryOn(first.id, 'SELECT * FROM derived_table');
    const looped: TableEntity = {
      ...first,
      source: { ...first.source, kind: 'query', derivedFrom: second.id } as never,
    };
    expect(derivedChain(worldOf(looped, second), second.id)).toMatchObject({
      ok: false,
      error: { code: 'cycle' },
    });
  });
});

describe('what a table has built on it', () => {
  const table = makeTable(ids);
  const first = queryOn(table.id, 'SELECT * FROM derived_table');
  const second = queryOn(first.id, 'SELECT * FROM derived_table');
  const sibling = queryOn(table.id, 'SELECT 2 FROM derived_table');
  const world = worldOf(table, first, second, sibling);

  it('lists what refines it directly', () => {
    expect(derivedTablesOf(world, table.id).map((entity) => entity.id)).toEqual([
      first.id,
      sibling.id,
    ]);
    expect(derivedTablesOf(world, second.id)).toEqual([]);
  });

  it('lists everything above it, each after the one it refines', () => {
    // The order is what makes re-running them safe: a step is run after the step
    // it reads, never before.
    expect(derivedTreeOf(world, table.id).map((entity) => entity.id)).toEqual([
      first.id,
      sibling.id,
      second.id,
    ]);
  });
});

describe('joining a chain into one statement', () => {
  it('names the relation directly, so one query composes to itself', () => {
    const table = makeTable(ids);
    const query = queryOn(table.id, 'SELECT COUNTRY\nFROM derived_table\nWHERE REVENUE > 0');
    expect(composeQuery(worldOf(table, query), query.id, relationSql)).toEqual({
      ok: true,
      value: 'SELECT COUNTRY\nFROM "SALES"."ORDERS"\nWHERE REVENUE > 0',
    });
  });

  it('makes every earlier step a named expression, reading in the order built', () => {
    const table = makeTable(ids);
    const first = queryOn(table.id, 'SELECT COUNTRY, REVENUE\nFROM derived_table');
    const second = queryOn(first.id, 'SELECT *\nFROM derived_table\nWHERE REVENUE > 100');
    const third = queryOn(second.id, 'SELECT COUNTRY\nFROM derived_table');
    const composed = composeQuery(worldOf(table, first, second, third), third.id, relationSql);

    expect(composed.ok && composed.value).toBe(
      [
        'WITH derived_table_1 AS (',
        '  SELECT COUNTRY, REVENUE',
        '  FROM "SALES"."ORDERS"',
        '),',
        'derived_table_2 AS (',
        '  SELECT *',
        '  FROM derived_table_1',
        '  WHERE REVENUE > 100',
        ')',
        'SELECT COUNTRY',
        'FROM derived_table_2',
      ].join('\n'),
    );
  });

  it('leaves a statement with nothing behind it exactly as written', () => {
    const query = queryOn(undefined, 'SELECT 1 FROM derived_table');
    // Nothing to substitute: the database will say what it thinks of that, which
    // is more use than a guess made here.
    expect(composeQuery(worldOf(query), query.id, relationSql)).toEqual({
      ok: true,
      value: 'SELECT 1 FROM derived_table',
    });
  });

  it('turns a headless query into the first expression when something reads it', () => {
    const first = queryOn(undefined, 'SELECT 1 AS N');
    const second = queryOn(first.id, 'SELECT *\nFROM derived_table');
    const composed = composeQuery(worldOf(first, second), second.id, relationSql);
    expect(composed.ok && composed.value).toBe(
      'WITH derived_table_1 AS (\n  SELECT 1 AS N\n)\nSELECT *\nFROM derived_table_1',
    );
  });

  it('does not indent a blank line into trailing spaces', () => {
    const first = queryOn(undefined, 'SELECT 1\n\nFROM t');
    const second = queryOn(first.id, 'SELECT * FROM derived_table');
    const composed = composeQuery(worldOf(first, second), second.id, relationSql);
    expect(composed.ok && composed.value).toContain('  SELECT 1\n\n  FROM t');
  });

  it('passes a failure from the chain straight through', () => {
    const query = queryOn('table:gone' as EntityId, 'SELECT * FROM derived_table');
    expect(composeQuery(worldOf(query), query.id, relationSql)).toMatchObject({
      ok: false,
      error: { code: 'missing-base' },
    });
  });

  it('names its expressions after the reference they stand in for', () => {
    expect(derivedStepName(1)).toBe(`${DERIVED_TABLE}_1`);
    expect(derivedStepName(7)).toBe(`${DERIVED_TABLE}_7`);
  });
});

describe('a step that brings its own WITH clause', () => {
  const chained = (outer: string): string => {
    const table = makeTable(ids);
    const first = queryOn(table.id, 'SELECT COUNTRY, REVENUE\nFROM derived_table');
    const second = queryOn(first.id, outer);
    const composed = composeQuery(worldOf(table, first, second), second.id, relationSql);
    if (!composed.ok) throw new Error(composed.error.message);
    return composed.value;
  };

  it('merges the bindings into one clause rather than writing two', () => {
    // Two clauses in a row is not a statement. One database accepted it by luck;
    // the next one, or a name collision, would not.
    const composed = chained('WITH d AS (\n  SELECT * FROM derived_table\n)\nSELECT * FROM d');
    expect(composed).toBe(
      [
        'WITH derived_table_1 AS (',
        '  SELECT COUNTRY, REVENUE',
        '  FROM "SALES"."ORDERS"',
        '),',
        'd AS (',
        '  SELECT * FROM derived_table_1',
        ')',
        'SELECT * FROM d',
      ].join('\n'),
    );
    expect(composed.match(/\bWITH\b/gu)).toHaveLength(1);
  });

  it('keeps several of its own bindings, in order, with a column list', () => {
    const composed = chained('WITH a (n) AS (SELECT 1), b AS (SELECT * FROM a)\nSELECT * FROM b');
    // Kept as they were written, rather than reformatted: they are the author's.
    expect(composed).toContain('a (n) AS (SELECT 1), b AS (SELECT * FROM a)');
    expect(composed.endsWith('SELECT * FROM b')).toBe(true);
    expect(composed.match(/\bWITH\b/gu)).toHaveLength(1);
  });

  it('carries RECURSIVE onto the merged clause, since it governs all of it', () => {
    expect(chained('WITH RECURSIVE r AS (SELECT 1)\nSELECT * FROM r')).toContain(
      'WITH RECURSIVE derived_table_1 AS (',
    );
  });

  it('gives way when a statement binds a name we would have generated', () => {
    // Two bindings of one name is an error at best and the wrong table at worst.
    const composed = chained('WITH derived_table_1 AS (SELECT 1)\nSELECT * FROM derived_table_1');
    expect(composed).toContain('derived_table_1_x AS (');
    expect(composed).toContain('derived_table_1 AS (SELECT 1)');
    // And the outer statement's own reference is still to its own binding.
    expect(composed.endsWith('SELECT * FROM derived_table_1')).toBe(true);
  });

  it('falls back to writing the statement after the clause when it is not one', () => {
    // Unbalanced, so there is no clause to take apart: better to compose as
    // before and let the database report what it thinks than to guess.
    const composed = chained('WITH broken AS (SELECT 1\nSELECT 2');
    expect(composed).toContain('WITH derived_table_1 AS (');
    expect(composed).toContain('WITH broken AS (SELECT 1');
  });
});

describe('taking a WITH clause apart', () => {
  it('finds nothing to take apart in a plain statement', () => {
    expect(splitWithClause('SELECT 1')).toBeNull();
    expect(splitWithClause('  -- a comment\n/* and another */ SELECT 1')).toBeNull();
    expect(splitWithClause('')).toBeNull();
    // A column called WITHIN is not a clause.
    expect(splitWithClause('SELECT WITHIN FROM t')).toBeNull();
  });

  it('reads the clause past comments, quotes and nested parentheses', () => {
    const clause = splitWithClause(
      "WITH -- named after nothing\n a AS (SELECT ')' AS x, (1 + (2)) AS y) SELECT * FROM a",
    );
    expect(clause?.bindings).toBe("a AS (SELECT ')' AS x, (1 + (2)) AS y)");
    expect(clause?.rest).toBe('SELECT * FROM a');
    expect(clause?.recursive).toBe(false);
  });

  it('reads past comments inside the body it is skipping', () => {
    const clause = splitWithClause(
      'WITH a AS (\n  -- a line comment with ) in it\n  /* and a block one ( */\n  SELECT 1\n) SELECT * FROM a',
    );
    expect(clause?.rest).toBe('SELECT * FROM a');
    expect(clause?.bindings).toContain('SELECT 1');
  });

  it('reads a clause written with no space after the keyword', () => {
    // `WITH(...)` is not a clause; `WITH a AS(SELECT 1)` is, and both turn up.
    expect(splitWithClause('WITH a AS(SELECT 1) SELECT 1')?.rest).toBe('SELECT 1');
    expect(splitWithClause('WITHOUT a AS (SELECT 1) SELECT 1')).toBeNull();
  });

  it('reads a quoted name', () => {
    const clause = splitWithClause('WITH "odd name" AS (SELECT 1) SELECT 1');
    expect(clause?.bindings).toBe('"odd name" AS (SELECT 1)');
  });

  it('refuses what is not shaped like a clause', () => {
    expect(splitWithClause('WITH')).toBeNull();
    expect(splitWithClause('WITH a SELECT 1')).toBeNull();
    expect(splitWithClause('WITH a AS SELECT 1')).toBeNull();
    expect(splitWithClause('WITH a AS (SELECT 1')).toBeNull();
    expect(splitWithClause('WITH a (n AS (SELECT 1)) SELECT 1')).toBeNull();
    // An unbalanced column list, which is not a clause either.
    expect(splitWithClause('WITH a (n AS (SELECT 1) SELECT 1')).toBeNull();
  });
});

describe('finding any identifier, not only the one', () => {
  it('is the same lexer the input reference uses', () => {
    expect(identifierRanges('SELECT * FROM orders o', 'orders')).toEqual([{ from: 14, to: 20 }]);
    // Text and comments are not references, whatever they say.
    expect(identifierRanges("SELECT 'orders' -- orders\n", 'orders')).toEqual([]);
    expect(identifierRanges('SELECT * FROM myorders', 'orders')).toEqual([]);
  });
});
