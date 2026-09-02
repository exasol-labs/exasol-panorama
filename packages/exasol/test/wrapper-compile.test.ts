import { describe, expect, it } from 'vitest';
import type { ExasolValue, WrapperCompiler } from '@panorama/exasol';
import {
  compileWrapperSql,
  compilerForStatement,
  readWrapperCompilers,
  wrapperCompilerQuery,
  wrapperProvenance,
} from '@panorama/exasol';

/**
 * Compiling JSON-tables SQL instead of setting a session preprocessor.
 *
 * `exasol-json-tables` now ships `COMPILE_SQL`, and where it is installed it is
 * the better path: no session state, no grepping generated Lua to find a
 * preprocessor, and — installed for every package, which is the recommended
 * shape — one statement may span two packages. That last one was written off in
 * this integration as a thing the database could not express, and it is now the
 * case verified against a live instance below.
 */

const answering =
  (columns: readonly (readonly ExasolValue[])[] | Error) =>
  async (): Promise<readonly (readonly ExasolValue[])[]> => {
    if (columns instanceof Error) throw columns;
    return columns;
  };

/** The three columns the discovery query asks for. */
const scripts = (
  rows: readonly (readonly [string, string, string | null])[],
): readonly (readonly ExasolValue[])[] => [
  rows.map((row) => row[0]),
  rows.map((row) => row[1]),
  rows.map((row) => row[2]),
];

/** The Lua line the script carries, as the catalogue returns it. */
const allows = (...schemas: readonly string[]): string =>
  `    local ALLOWED_SCHEMAS_JSON = '${JSON.stringify(schemas)}'`;

/** The seven columns `COMPILE_SQL` answers with, one row. */
const answer = (values: {
  status?: string;
  code?: string;
  message?: string;
  sql?: string;
  plan?: string;
  clarification?: string;
}): readonly (readonly ExasolValue[])[] => [
  [values.status ?? 'OK'],
  [values.code ?? null],
  [values.message ?? null],
  ['the original'],
  [values.sql ?? null],
  [values.plan ?? null],
  [values.clarification ?? null],
];

const PLAN = JSON.stringify({
  tool: 'exasol-json-tables',
  contractVersion: 1,
  rewritten: true,
  packageCount: 22,
  referencedPackages: [{ publicSchema: 'JSON_VIEW', helperSchema: 'JSON_VIEW_INTERNAL' }],
});

const compiler = (schema: string, ...serves: readonly string[]): WrapperCompiler => ({
  schema,
  script: 'COMPILE_SQL',
  serves,
});

describe('finding a compiler', () => {
  /**
   * By a marker in the body, not by name — and the name matters here because
   * `SEMANTIC_ADMIN.COMPILE_SQL` is a different compiler for a different language
   * that happens to share it. `ALLOWED_SCHEMAS_JSON` is generated code rather
   * than prose, so it does not move when somebody rewrites a comment, and the
   * same line says which packages the script was built for.
   */
  it('asks for the marker and the line that says what it serves', () => {
    const sql = wrapperCompilerQuery();
    expect(sql).toContain("SCRIPT_TEXT LIKE '%ALLOWED_SCHEMAS_JSON%'");
    expect(sql).toContain('REGEXP_SUBSTR');
  });

  it('reads the schemas each one serves', async () => {
    const found = await readWrapperCompilers(
      answering(scripts([['JVS_COMPILE', 'COMPILE_SQL', allows('JSON_VIEW', 'EJT_ORDERS_VIEW')]])),
    );
    expect(found).toEqual([
      { schema: 'JVS_COMPILE', script: 'COMPILE_SQL', serves: ['JSON_VIEW', 'EJT_ORDERS_VIEW'] },
    ]);
  });

  /**
   * A script that serves nothing can compile nothing, so offering it would only
   * turn a working preprocessor into a refusal. Same for a generated shape this
   * build no longer recognises: not knowing is the same answer as no compiler.
   */
  it('skips a script it cannot read the scope of', async () => {
    expect(
      await readWrapperCompilers(
        answering(
          scripts([
            ['A', 'C', allows()],
            ['B', 'C', null],
            ['D', 'C', '    local ALLOWED_SCHEMAS_JSON = not-a-quoted-string'],
            // Quoted, and not JSON inside.
            ['F', 'C', "    local ALLOWED_SCHEMAS_JSON = 'not json at all'"],
            ['E', 'C', '    local ALLOWED_SCHEMAS_JSON = \'{"not":"a list"}\''],
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it('has none where the catalogue will not answer', async () => {
    expect(await readWrapperCompilers(answering(new Error('denied')))).toEqual([]);
  });
});

describe('choosing one for a statement', () => {
  const narrow = compiler('ONE', 'JSON_VIEW');
  const wide = compiler('ALL', 'JSON_VIEW', 'EJT_ORDERS_VIEW', 'MONGO_JSON_ORDERS');

  it('picks a compiler that serves the schema the statement names', () => {
    expect(compilerForStatement([narrow], 'SELECT * FROM "JSON_VIEW"."SAMPLE"')).toBe(narrow);
    expect(compilerForStatement([narrow], 'SELECT * FROM MART.ORDER_LINES')).toBeUndefined();
    expect(compilerForStatement([], 'SELECT * FROM "JSON_VIEW"."SAMPLE"')).toBeUndefined();
  });

  /**
   * The widest wins, for the reason the preprocessor choice has: a script serving
   * every package is the one that can also compile a statement spanning two of
   * them, which is the whole thing a session preprocessor cannot do.
   */
  it('prefers the one that serves the most', () => {
    expect(compilerForStatement([narrow, wide], 'SELECT * FROM "JSON_VIEW"."SAMPLE"')).toBe(wide);
    expect(compilerForStatement([wide, narrow], 'SELECT * FROM "JSON_VIEW"."SAMPLE"')).toBe(wide);
  });

  it('is not fooled by a schema whose name is a prefix of another', () => {
    expect(
      compilerForStatement([narrow], 'SELECT * FROM "JSON_VIEW_ARCHIVE"."SAMPLE"'),
    ).toBeUndefined();
  });
});

describe('compiling', () => {
  it('hands back the physical SQL and what it touched', async () => {
    const result = await compileWrapperSql(
      answering(answer({ sql: 'SELECT "a|n" FROM "H"."T"', plan: PLAN })),
      compiler('JVS_COMPILE', 'JSON_VIEW'),
      'SELECT "a.b" FROM "JSON_VIEW"."T"',
    );
    expect(result).toEqual({
      status: 'ok',
      sql: 'SELECT "a|n" FROM "H"."T"',
      rewritten: true,
      packages: ['JSON_VIEW'],
      contractVersion: 1,
    });
  });

  /**
   * The clarification carries the same message *with the offending path in it*,
   * which is the sentence worth showing — it is the difference between "field not
   * visible" and knowing which field.
   */
  it('prefers the clarification’s words to the bare message', async () => {
    const result = await compileWrapperSql(
      answering(
        answer({
          status: 'ERROR',
          code: 'JVS-PATH-ERROR',
          message: 'Field is not visible.',
          clarification: JSON.stringify({
            code: 'JVS-PATH-ERROR',
            message: '"no.such.path": Field "no" is not visible on the current row source.',
            path: 'no.such.path',
          }),
        }),
      ),
      compiler('JVS_COMPILE', 'JSON_VIEW'),
      'SELECT "no.such.path" FROM "JSON_VIEW"."T"',
    );
    expect(result.status).toBe('error');
    expect(result.code).toBe('JVS-PATH-ERROR');
    expect(result.message).toContain('no.such.path');
    expect(result.sql).toBeUndefined();
  });

  it('reports a failing call as an error rather than throwing', async () => {
    const result = await compileWrapperSql(
      answering(new Error('object COMPILE_SQL not found')),
      compiler('JVS_COMPILE', 'JSON_VIEW'),
      'SELECT 1',
    );
    expect(result).toEqual({
      status: 'error',
      packages: [],
      message: 'object COMPILE_SQL not found',
    });
  });

  it('survives a plan it cannot read, and an OK with no SQL', async () => {
    const unreadable = await compileWrapperSql(
      answering(answer({ sql: 'SELECT 1', plan: 'not json' })),
      compiler('JVS_COMPILE', 'JSON_VIEW'),
      'x',
    );
    expect(unreadable).toEqual({ status: 'ok', sql: 'SELECT 1', packages: [] });
    const empty = await compileWrapperSql(
      answering(answer({ status: 'OK' })),
      compiler('JVS_COMPILE', 'JSON_VIEW'),
      'x',
    );
    expect(empty.status).toBe('error');
  });
});

describe('the provenance line', () => {
  it('names the tool, the packages it reached and the contract', () => {
    expect(wrapperProvenance({ status: 'ok', packages: ['JSON_VIEW'], contractVersion: 1 })).toBe(
      'exasol-json-tables · JSON_VIEW · contract v1',
    );
    // The case that could not happen before: two packages in one statement.
    expect(
      wrapperProvenance({ status: 'ok', packages: ['EJT_ORDERS_VIEW', 'VOLTATEL_VOLTATEL_VIEW'] }),
    ).toBe('exasol-json-tables · EJT_ORDERS_VIEW · VOLTATEL_VOLTATEL_VIEW');
  });

  it('says nothing about a statement that reached no package', () => {
    expect(wrapperProvenance({ status: 'ok', packages: [] })).toBeUndefined();
  });
});
