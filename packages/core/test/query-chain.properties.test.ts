import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { EntityId, RelationSource, TableEntity, WorldState } from '@panorama/core';
import {
  DERIVED_TABLE,
  applyCommand,
  buildTableEntity,
  composeQuery,
  derivedTableRanges,
  emptyWorld,
  identifierRanges,
  replaceDerivedTable,
  splitWithClause,
} from '@panorama/core';
import { TEST_CONNECTION, testIds } from './fixtures.js';

/**
 * Properties of the statement scanner.
 *
 * This is the one hand-written parser in the codebase whose input is whatever
 * somebody typed into a box — or whatever an agent sent — and it is index
 * arithmetic over a string with two unbounded loops in it. Example tests say
 * what happens to the statements we thought of. These say what must hold for
 * every statement, and they are the tests that would have caught the composition
 * bug this file's `WITH` handling was written to fix.
 *
 * Seeds are pinned on every run. A property test that draws different inputs
 * each time reaches different lines each time, which would make the 100 % line
 * gate report a different number on every run; and a failure nobody can replay
 * is a failure nobody can fix.
 */

const RUNS = { numRuns: 300 } as const;

/** Fragments a statement is made of, including the ones that bite. */
const ATOMS: readonly string[] = [
  DERIVED_TABLE,
  'DERIVED_TABLE',
  'Derived_Table',
  'derived_table_1',
  'derived_table_1_x',
  'my_derived_table',
  'derived_tables',
  'SELECT',
  ' ',
  '\n',
  '\t',
  '*',
  ',',
  '.',
  '(',
  ')',
  '"',
  "'",
  '--',
  '/*',
  '*/',
  'FROM',
  'WITH',
  'RECURSIVE',
  'AS',
  't',
  '1',
  '_',
  '$',
  "'derived_table'",
  "'it''s derived_table'",
  '"derived_table"',
  '-- derived_table\n',
  '/* derived_table */',
  'ORDER BY 1',
];

/** Statement-shaped soup: the atoms in any order, balanced or not. */
const sqlSoup = fc
  .array(fc.constantFrom(...ATOMS), { maxLength: 24 })
  .map((parts) => parts.join(''));

/** Anything at all, including lone surrogates and control characters. */
const anyText = fc.string({ unit: 'binary', maxLength: 40 });

const statement = fc.oneof({ weight: 3, arbitrary: sqlSoup }, { weight: 1, arbitrary: anyText });

/** An identifier a replacement can safely be, for the properties that need one. */
const replacementName = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/u);

describe('the scanner is total', () => {
  it('answers about any string at all, rather than throwing or hanging', () => {
    fc.assert(
      fc.property(statement, (sql) => {
        // Returning at all is the property: a scanner that failed to advance its
        // index would not come back, and the test would time out rather than fail
        // with a message — which is itself the signal.
        expect(() => derivedTableRanges(sql)).not.toThrow();
        expect(() => replaceDerivedTable(sql, 'x')).not.toThrow();
        expect(() => splitWithClause(sql)).not.toThrow();
      }),
      { seed: 20260826, ...RUNS },
    );
  });

  it('answers about any name, including the empty one and punctuation', () => {
    fc.assert(
      fc.property(statement, anyText, (sql, name) => {
        expect(() => identifierRanges(sql, name)).not.toThrow();
      }),
      { seed: 7, ...RUNS },
    );
  });
});

describe('the ranges a scan reports', () => {
  it('are inside the statement, in order, and never overlap', () => {
    fc.assert(
      fc.property(statement, (sql) => {
        const ranges = derivedTableRanges(sql);
        let previous = 0;
        for (const range of ranges) {
          expect(range.from).toBeGreaterThanOrEqual(previous);
          expect(range.to).toBeGreaterThan(range.from);
          expect(range.to).toBeLessThanOrEqual(sql.length);
          previous = range.to;
        }
      }),
      { seed: 101, ...RUNS },
    );
  });

  it('each cover the name itself, whatever its case', () => {
    fc.assert(
      fc.property(statement, (sql) => {
        for (const range of derivedTableRanges(sql)) {
          expect(sql.slice(range.from, range.to).toLowerCase()).toBe(DERIVED_TABLE);
        }
      }),
      { seed: 102, ...RUNS },
    );
  });

  it('never sit inside a longer identifier', () => {
    const identifierChar = /[A-Za-z0-9_$]/u;
    fc.assert(
      fc.property(statement, (sql) => {
        for (const range of derivedTableRanges(sql)) {
          const before = range.from === 0 ? '' : (sql[range.from - 1] as string);
          const after = sql[range.to] ?? '';
          expect(before === '' || !identifierChar.test(before)).toBe(true);
          expect(after === '' || !identifierChar.test(after)).toBe(true);
        }
      }),
      { seed: 103, ...RUNS },
    );
  });
});

describe('replacing the name a statement calls its input by', () => {
  it('changes only the ranges it reported', () => {
    fc.assert(
      fc.property(statement, replacementName, (sql, replacement) => {
        const ranges = derivedTableRanges(sql);
        const out = replaceDerivedTable(sql, replacement);
        // Length arithmetic is the cheapest statement of "each range, once".
        expect(out.length).toBe(
          sql.length + ranges.length * (replacement.length - DERIVED_TABLE.length),
        );
      }),
      { seed: 104, ...RUNS },
    );
  });

  it('changes nothing but the name own case when it replaces itself', () => {
    fc.assert(
      fc.property(statement, (sql) => {
        // An unquoted identifier is matched without regard to case, so replacing
        // `Derived_Table` with the canonical spelling is a change of case and
        // nothing else. Everything outside the ranges must survive exactly.
        const out = replaceDerivedTable(sql, DERIVED_TABLE);
        expect(out.toLowerCase()).toBe(sql.toLowerCase());
        expect(out.length).toBe(sql.length);
      }),
      { seed: 105, ...RUNS },
    );
  });

  it('leaves nothing behind to replace a second time', () => {
    fc.assert(
      fc.property(statement, replacementName, (sql, replacement) => {
        const once = replaceDerivedTable(sql, replacement);
        expect(replaceDerivedTable(once, replacement)).toBe(once);
      }),
      { seed: 106, ...RUNS },
    );
  });

  it('leaves a statement that never names it as a reference alone', () => {
    /**
     * The name where it is text rather than a reference: inside a literal, inside
     * a quoted identifier, inside a comment, and as part of a longer word. None
     * of these may be rewritten — a `WHERE label = 'derived_table'` that changed
     * under the substitution would silently compare against the wrong string.
     */
    const hidden = fc
      .array(
        fc.constantFrom(
          "'derived_table'",
          "'it''s derived_table, twice: derived_table'",
          '"derived_table"',
          '-- derived_table\n',
          '/* derived_table */',
          'my_derived_table',
          'derived_tables',
          'derived_table2',
          'SELECT',
          ' ',
          '\n',
          ',',
          '*',
        ),
        { maxLength: 16 },
      )
      .map((parts) => parts.join(''));
    fc.assert(
      fc.property(hidden, replacementName, (sql, replacement) => {
        expect(replaceDerivedTable(sql, replacement)).toBe(sql);
      }),
      { seed: 107, ...RUNS },
    );
  });
});

describe('taking a statement own WITH clause apart', () => {
  const cte = fc.tuple(
    fc.stringMatching(/^[a-z][a-z0-9_]{0,6}$/u),
    fc.constantFrom('SELECT 1', "SELECT 'a, b'", 'SELECT (1)', 'SELECT * FROM t WHERE x = 1'),
  );

  it('recovers the bindings and the query they were in front of', () => {
    fc.assert(
      fc.property(
        fc.array(cte, { minLength: 1, maxLength: 4 }),
        fc.boolean(),
        fc.constantFrom('SELECT * FROM a', 'SELECT 1', 'SELECT * FROM a JOIN b ON a.x = b.x'),
        (bindings, recursive, rest) => {
          const written = bindings.map(([name, body]) => `${name} AS (${body})`).join(', ');
          const sql = `WITH ${recursive ? 'RECURSIVE ' : ''}${written}\n${rest}`;
          const split = splitWithClause(sql);
          expect(split).not.toBeNull();
          const clause = split as NonNullable<typeof split>;
          expect(clause.recursive).toBe(recursive);
          expect(clause.bindings).toBe(written);
          expect(clause.rest).toBe(rest);
        },
      ),
      { seed: 108, ...RUNS },
    );
  });

  it('reports parts of the statement it was given, never invented text', () => {
    fc.assert(
      fc.property(statement, (sql) => {
        const clause = splitWithClause(sql);
        if (clause === null) return;
        expect(sql).toContain(clause.bindings);
        expect(sql.endsWith(clause.rest)).toBe(true);
      }),
      { seed: 109, ...RUNS },
    );
  });

  it('says nothing about a statement that does not begin with the keyword', () => {
    fc.assert(
      fc.property(statement, (sql) => {
        if (/^\s*with\b/iu.test(sql)) return;
        // A leading comment can still hide a clause behind it, which is why this
        // only claims the plain case.
        if (/^\s*(--|\/\*)/u.test(sql)) return;
        expect(splitWithClause(sql)).toBeNull();
      }),
      { seed: 110, ...RUNS },
    );
  });
});

describe('composing a chain into one statement', () => {
  const ids = testIds(31);
  const relationSql = (source: RelationSource): string => `"${source.schema}"."${source.table}"`;

  const table = (): TableEntity =>
    buildTableEntity(ids, {
      source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'SALES', table: 'ORDERS' },
      columns: [],
    });

  const queryOn = (base: EntityId, sql: string): TableEntity =>
    buildTableEntity(ids, {
      source: {
        kind: 'query',
        connectionId: TEST_CONNECTION,
        sql,
        label: 'step',
        derivedFrom: base,
      },
      mode: 'result',
      columns: [],
    });

  const worldOf = (entities: readonly TableEntity[]): WorldState => {
    let world = emptyWorld();
    for (const entity of entities) {
      const applied = applyCommand(world, { type: 'CreateTableEntity', entity });
      if (!applied.ok) throw new Error(applied.error.message);
      world = applied.value;
    }
    return world;
  };

  /**
   * Statements that fight the generated names on purpose: a step is free to bind
   * `derived_table_1` itself, and two bindings of one name in a clause is an
   * error at best and the wrong table at worst.
   */
  const plainStep = fc.constantFrom(
    `SELECT * FROM ${DERIVED_TABLE}`,
    `SELECT * FROM ${DERIVED_TABLE} WHERE x = 1`,
    `SELECT * FROM ${DERIVED_TABLE} a JOIN ${DERIVED_TABLE} b ON a.x = b.x`,
    `SELECT derived_table_1 FROM ${DERIVED_TABLE}`,
    `SELECT x AS derived_table_2 FROM ${DERIVED_TABLE}`,
    `SELECT 'derived_table_1' AS derived_table_1_x FROM ${DERIVED_TABLE}`,
    `SELECT * FROM ${DERIVED_TABLE} -- derived_table_3\n`,
  );

  /** The same, plus steps carrying a `WITH` clause of their own to be merged. */
  const step = fc.oneof(
    plainStep,
    fc.constantFrom(
      `WITH derived_table_1 AS (SELECT 1) SELECT * FROM ${DERIVED_TABLE}`,
      `WITH derived_table_1_x AS (SELECT 1) SELECT * FROM ${DERIVED_TABLE}`,
      `WITH RECURSIVE derived_table_2 AS (SELECT 1) SELECT * FROM ${DERIVED_TABLE}`,
    ),
  );

  /** Every name the composed clause binds, as the composer wrote them. */
  const boundNames = (sql: string): readonly string[] =>
    [...sql.matchAll(/^\s*([A-Za-z_][A-Za-z0-9_$]*) AS \(/gmu)].map((match) => match[1] as string);

  const chainOf = (steps: readonly string[]): { world: WorldState; last: EntityId } => {
    const relation = table();
    const entities: TableEntity[] = [relation];
    let previous: EntityId = relation.id;
    for (const sql of steps) {
      const next = queryOn(previous, sql);
      entities.push(next);
      previous = next.id;
    }
    return { world: worldOf(entities), last: previous };
  };

  it('never binds one name twice, however the steps were written', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 4 }), (steps) => {
        const { world, last } = chainOf(steps);
        const composed = composeQuery(world, last, relationSql);
        expect(composed.ok).toBe(true);
        if (!composed.ok) return;
        // Two bindings of one name in a clause is an error at best and the wrong
        // table at worst — including when one of them came from a step's own
        // clause, merged in rather than written after ours.
        const names = boundNames(composed.value);
        expect(new Set(names).size).toBe(names.length);
      }),
      { seed: 111, numRuns: 200 },
    );
  });

  it('never gives a step a name that step already uses for something else', () => {
    fc.assert(
      fc.property(fc.array(plainStep, { minLength: 1, maxLength: 4 }), (steps) => {
        const { world, last } = chainOf(steps);
        const composed = composeQuery(world, last, relationSql);
        expect(composed.ok).toBe(true);
        if (!composed.ok) return;
        // No step here carries a clause of its own, so every name the composed
        // clause binds is one the composer chose. None may be a name a step is
        // already using as a column, an alias or a table.
        for (const name of boundNames(composed.value)) {
          for (const sql of steps) {
            expect(identifierRanges(sql, name)).toEqual([]);
          }
        }
      }),
      { seed: 113, numRuns: 200 },
    );
  });

  it('resolves every reference to the input, leaving none behind', () => {
    fc.assert(
      fc.property(fc.array(step, { minLength: 1, maxLength: 4 }), (steps) => {
        const { world, last } = chainOf(steps);
        const composed = composeQuery(world, last, relationSql);
        expect(composed.ok).toBe(true);
        if (!composed.ok) return;
        // The chain reads a stored relation, so every step's `derived_table` has
        // a name to become. One left over would be a reference to nothing.
        expect(derivedTableRanges(composed.value)).toEqual([]);
      }),
      { seed: 112, numRuns: 200 },
    );
  });
});
