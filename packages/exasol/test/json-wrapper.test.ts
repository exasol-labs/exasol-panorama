import { describe, expect, it } from 'vitest';
import type { ExasolValue } from '@panorama/exasol';
import {
  preprocessorForSchema,
  preprocessorForStatement,
  readWrapperSurface,
  wrapperFor,
  wrapperHelperSchemaQuery,
  wrapperPreprocessorQuery,
  wrapperRootsQuery,
} from '@panorama/exasol';

/**
 * Finding the wrapper surface, from the catalogue rather than from names.
 *
 * `exasol-json-tables` installs a wrapper package over a family — views that
 * present the document's properties, and a session preprocessor that rewrites
 * dotted paths written against them. Every schema involved is a free parameter of
 * the generator, so `X_SRC` / `X_VIEW` is one installation's habit; the only
 * fixed point is the metadata table the package publishes, and that is what this
 * looks for.
 *
 * The awkward parts are all about *choosing* a preprocessor, and every case here
 * was taken from a live instance rather than imagined: a wrapper served by five
 * equivalent regenerations, a combined script serving two packages at once, and a
 * schema name that is a prefix of four others.
 */

/** A query and its answer, column-oriented, as the driver hands them over. */
const answering = (
  answers: readonly (readonly [string, readonly (readonly ExasolValue[])[]])[],
): { query: (sql: string) => Promise<readonly (readonly ExasolValue[])[]>; asked: string[] } => {
  const asked: string[] = [];
  return {
    asked,
    query: async (sql) => {
      asked.push(sql);
      for (const [pattern, columns] of answers) if (sql.includes(pattern)) return columns;
      return [];
    },
  };
};

/** The shape `__JVS_ROOTS` comes back in: four columns, one row per root. */
const roots = (
  rows: readonly (readonly [string, string, string, string])[],
): readonly (readonly ExasolValue[])[] => [
  rows.map((row) => row[0]),
  rows.map((row) => row[1]),
  rows.map((row) => row[2]),
  rows.map((row) => row[3]),
];

const scripts = (
  rows: readonly (readonly [string, string])[],
): readonly (readonly ExasolValue[])[] => [rows.map((row) => row[0]), rows.map((row) => row[1])];

describe('the queries it asks', () => {
  /**
   * `_` matches any character in SQL, and wrapper schemas are full of them. An
   * unescaped `LIKE '%JSON_VIEW%'` matched twenty of one instance's thirty-two
   * preprocessors, because `JSON_VIEW` is a prefix of `JSON_VIEW_ACCESS` and the
   * rest — and it would have matched `JSONXVIEW` as well.
   */
  it('escapes the wildcards in a schema name, and matches a config entry', () => {
    const sql = wrapperPreprocessorQuery('JSON_VIEW', 'JSON_VIEW_INTERNAL');
    // The entry in `allowed_json_schemas`, not the bare name: that is what gates
    // the rewriting, and what a prefix cannot satisfy by accident.
    // Inside a quoted SQL literal, so the pattern's own quotes are doubled.
    expect(sql).toContain("[''JSON\\_VIEW''] = true");
    expect(sql).toContain('JSON\\_VIEW\\_INTERNAL');
    expect(sql).toContain("ESCAPE '\\'");
    // And the helper schema, which is what rules out a genuinely stale one.
    expect(sql.match(/SCRIPT_TEXT LIKE/gu)).toHaveLength(2);
  });

  it('looks for the package by its metadata table, not by a naming convention', () => {
    expect(wrapperHelperSchemaQuery()).toContain("TABLE_NAME = '__JVS_ROOTS'");
    expect(wrapperRootsQuery('H')).toBe(
      'SELECT ROOT_TABLE, SOURCE_SCHEMA, PUBLIC_SCHEMA, PUBLIC_VIEW FROM "H"."__JVS_ROOTS"',
    );
  });
});

describe('reading the surface', () => {
  it('maps a source table to the view that presents it', async () => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
      ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'WRAP', 'orders']])],
      ["[''WRAP''] = true", scripts([['PP', 'WRAP_PREPROCESSOR']])],
    ]);
    const surface = await readWrapperSurface(query);
    expect(wrapperFor(surface, 'SRC', 'orders')).toEqual({
      sourceSchema: 'SRC',
      rootTable: 'orders',
      schema: 'WRAP',
      view: 'orders',
      helperSchema: 'H1',
      preprocessor: '"PP"."WRAP_PREPROCESSOR"',
    });
    // A table nothing wraps, which is every ordinary table there has ever been.
    expect(wrapperFor(surface, 'SRC', 'somewhere_else')).toBeUndefined();
  });

  /**
   * The child tables of a family are not in the wrapper schema — only the root
   * is. So a child box has no wrapper, and that is a fact about the package
   * rather than a gap here.
   */
  it('wraps only the roots the package publishes', async () => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
      ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'WRAP', 'orders']])],
    ]);
    const surface = await readWrapperSurface(query);
    expect(wrapperFor(surface, 'SRC', 'orders_line_items_arr')).toBeUndefined();
  });

  it('asks one package about its preprocessor once, however many roots it has', async () => {
    const { query, asked } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
      [
        '"H1"."__JVS_ROOTS"',
        roots([
          ['a', 'SRC', 'WRAP', 'a'],
          ['b', 'SRC', 'WRAP', 'b'],
          ['c', 'SRC', 'WRAP', 'c'],
        ]),
      ],
      ["[''WRAP''] = true", scripts([['PP', 'P']])],
    ]);
    await readWrapperSurface(query);
    expect(asked.filter((sql) => sql.includes("SCRIPT_TYPE = 'PREPROCESSOR'"))).toHaveLength(1);
  });
});

describe('choosing a preprocessor', () => {
  /**
   * The one that answers the question the user asked: Exasol allows one
   * preprocessor per session, so a canvas with boxes from two packages would have
   * to switch between them. A *combined* preprocessor is scoped to several
   * packages at once, and shows up as a candidate for each — so the script the
   * most schemas offer is the broadest, and choosing it means no switching.
   *
   * Taken from a live instance: one script serving two Mongo-backed packages,
   * with dotted paths working on both in one session.
   */
  it('prefers the script that covers the most wrapper schemas', async () => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1', 'H2']]],
      ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'W1', 'orders']])],
      ['"H2"."__JVS_ROOTS"', roots([['people', 'SRC', 'W2', 'people']])],
      // Each schema is served by its own dedicated script and by one combined
      // script that covers both.
      [
        "[''W1''] = true",
        scripts([
          ['PP', 'COMBINED'],
          ['PP', 'W1_ONLY'],
        ]),
      ],
      [
        "[''W2''] = true",
        scripts([
          ['PP', 'COMBINED'],
          ['PP', 'W2_ONLY'],
        ]),
      ],
    ]);
    const surface = await readWrapperSurface(query);
    expect(preprocessorForSchema(surface, 'W1')).toBe('"PP"."COMBINED"');
    expect(preprocessorForSchema(surface, 'W2')).toBe('"PP"."COMBINED"');
  });

  /**
   * Several equivalent regenerations is the ordinary case, not a broken one:
   * regenerating a package into a new preprocessor schema leaves the old one
   * installed, and both stay correct. Five serve one schema on the instance this
   * was written against — refusing to choose would have denied the paths to the
   * most-used wrapper there.
   */
  it('takes the first by name where several are equally wide, and stays with it', async () => {
    const candidates = scripts([
      ['B_PP', 'P'],
      ['A_PP', 'P'],
      ['C_PP', 'P'],
    ]);
    const chosen = async () => {
      const { query } = answering([
        ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
        ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'WRAP', 'orders']])],
        ["[''WRAP''] = true", candidates],
      ]);
      return preprocessorForSchema(await readWrapperSurface(query), 'WRAP');
    };
    expect(await chosen()).toBe('"A_PP"."P"');
    // Stable: a canvas that reopens must not silently start switching.
    expect(await chosen()).toBe('"A_PP"."P"');
  });

  /**
   * A usable state, not a broken one. The view still reads — it is an ordinary
   * view — and only the path and array syntax is unavailable, which is worth
   * saying rather than guessing a script for.
   */
  it('leaves the preprocessor absent where none qualifies', async () => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
      ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'WRAP', 'orders']])],
    ]);
    const surface = await readWrapperSurface(query);
    expect(wrapperFor(surface, 'SRC', 'orders')?.preprocessor).toBeUndefined();
    expect(preprocessorForSchema(surface, 'WRAP')).toBeUndefined();
    expect(preprocessorForSchema(surface, 'NOT_A_WRAPPER')).toBeUndefined();
    expect(preprocessorForSchema(null, 'WRAP')).toBeUndefined();
  });
});

describe('when the catalogue will not answer', () => {
  /**
   * A helper schema the user cannot select from, or one left by a half-removed
   * package, is a reason to have no wrapper for those tables — not a reason for
   * the connection to fail. Opening the table is what was asked for.
   */
  it('skips a package it cannot read and keeps the ones it can', async () => {
    const asked: string[] = [];
    const query = async (sql: string): Promise<readonly (readonly ExasolValue[])[]> => {
      asked.push(sql);
      if (sql.includes("TABLE_NAME = '__JVS_ROOTS'")) return [['BROKEN', 'H2']];
      if (sql.includes('"BROKEN"."__JVS_ROOTS"')) throw new Error('insufficient privileges');
      if (sql.includes('"H2"."__JVS_ROOTS"')) return roots([['people', 'SRC', 'W2', 'people']]);
      if (sql.includes("[''W2''] = true")) throw new Error('no script catalogue for you');
      return [];
    };
    const surface = await readWrapperSurface(query);
    expect(surface.size).toBe(1);
    expect(wrapperFor(surface, 'SRC', 'people')?.view).toBe('people');
    // The one that threw cost its own package and nothing else.
    expect(wrapperFor(surface, 'SRC', 'people')?.preprocessor).toBeUndefined();
  });

  it('is an empty surface where nothing is installed', async () => {
    const { query } = answering([]);
    expect((await readWrapperSurface(query)).size).toBe(0);
  });

  /**
   * A script row it cannot read in full names no script, so it is dropped — and
   * a schema left with no readable candidate has no preprocessor rather than a
   * half-quoted one.
   */
  it('drops a script row it cannot read in full', async () => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
      ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'WRAP', 'orders']])],
      [
        "[''WRAP''] = true",
        // Column-oriented: schemas, then names. The first row has no schema.
        [
          [null, 'GOOD_PP'],
          ['NAMELESS', 'P'],
        ],
      ],
    ]);
    const surface = await readWrapperSurface(query);
    // The unreadable row is dropped and the readable one behind it stands.
    expect(preprocessorForSchema(surface, 'WRAP')).toBe('"GOOD_PP"."P"');
  });

  /** A row missing any of the four fields describes no wrapper, so it is dropped. */
  it('drops a root row it cannot read in full', async () => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1']]],
      [
        '"H1"."__JVS_ROOTS"',
        [
          ['ok', 'partial'],
          ['SRC', 'SRC'],
          ['WRAP', null],
          ['ok', 'partial'],
        ],
      ],
    ]);
    const surface = await readWrapperSurface(query);
    expect([...surface.keys()]).toEqual(['SRC.ok']);
  });
});

describe('choosing a preprocessor for a statement', () => {
  const surface = async (): Promise<Awaited<ReturnType<typeof readWrapperSurface>>> => {
    const { query } = answering([
      ["TABLE_NAME = '__JVS_ROOTS'", [['H1', 'H2']]],
      ['"H1"."__JVS_ROOTS"', roots([['orders', 'SRC', 'JSON_VIEW', 'orders']])],
      ['"H2"."__JVS_ROOTS"', roots([['people', 'SRC', 'JSON_VIEW_ARCHIVE', 'people']])],
      // The query escapes `_` for LIKE, so the pattern carries the backslash.
      ["[''JSON\\_VIEW''] = true", scripts([['PP', 'MAIN']])],
      ["[''JSON\\_VIEW\\_ARCHIVE''] = true", scripts([['PP', 'ARCHIVE']])],
    ]);
    return readWrapperSurface(query);
  };

  /**
   * The statement is the only thing that can be asked. A query box's own schema
   * is a label rather than a schema, and what decides whether the paths have to
   * be rewritten is which schema the `FROM` actually names.
   */
  it('reads the schema out of the statement, quoted or not', async () => {
    const found = await surface();
    expect(preprocessorForStatement(found, 'SELECT "a.b" FROM "JSON_VIEW"."orders"')).toBe(
      '"PP"."MAIN"',
    );
    // Unquoted, which Exasol folds to upper case.
    expect(preprocessorForStatement(found, 'select x from json_view.orders')).toBe('"PP"."MAIN"');
  });

  /**
   * The boundary check, and the reason it is not a plain `includes`. `JSON_VIEW`
   * is a prefix of `JSON_VIEW_ARCHIVE`, and a statement against the archive must
   * not be handed the other package's preprocessor — it would fail as a scope
   * error on a schema the user never mentioned.
   */
  it('does not take a schema whose name is merely a prefix', async () => {
    const found = await surface();
    expect(preprocessorForStatement(found, 'SELECT * FROM "JSON_VIEW_ARCHIVE"."people"')).toBe(
      '"PP"."ARCHIVE"',
    );
  });

  it('is nothing for a statement that reads no wrapper', async () => {
    const found = await surface();
    expect(preprocessorForStatement(found, 'SELECT * FROM "SRC"."orders"')).toBeUndefined();
    expect(preprocessorForStatement(found, 'SELECT 1')).toBeUndefined();
    expect(preprocessorForStatement(null, 'SELECT * FROM "JSON_VIEW"."orders"')).toBeUndefined();
    // A schema *named* in a string literal is not a schema the statement reads
    // from — but this is a scan, so it is worth being honest that it would match.
    // The cost is a preprocessor set for a statement that did not need one, which
    // is scoped and therefore harmless.
  });

  /**
   * One preprocessor per session is Exasol's rule, so a statement joining two
   * wrapper surfaces is a thing the database cannot do. The first is chosen and
   * the database reports the other as a scope error naming the schema it would
   * not rewrite — which is a better answer than this guessing.
   */
  it('takes the first of two wrapper schemas, deterministically', async () => {
    const found = await surface();
    const both = 'SELECT * FROM "JSON_VIEW_ARCHIVE"."people" JOIN "JSON_VIEW"."orders" ON 1 = 1';
    expect(preprocessorForStatement(found, both)).toBe('"PP"."MAIN"');
    expect(preprocessorForStatement(found, both)).toBe('"PP"."MAIN"');
  });
});
