import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import type { RowFilter } from '@panorama/table';
import type { ExasolConnection, ExasolResultSetHandle } from '@panorama/exasol';
import { createTableSource } from '../src/panorama/start-data-worker.js';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';

/**
 * The factory the *app* installs, tested directly.
 *
 * The worker harness elsewhere mirrors this function rather than calling it,
 * which is exactly how a filter went missing from the Exasol branch while every
 * test kept passing: the harness always sent the demo relation, and the demo
 * relation was given the filter. So this drives the real thing, and reads back
 * the statement the driver would send.
 */
const statements: string[] = [];

const stubConnection = (): ExasolConnection =>
  ({
    id: 'connection:test',
    openResultSet: async (sqlText: string): Promise<ExasolResultSetHandle> => {
      statements.push(sqlText);
      return {
        handle: null,
        numRows: 0,
        columns: [{ name: 'NAME', dataType: { type: 'VARCHAR', size: 64 } }],
        inlineData: [[]],
      } as unknown as ExasolResultSetHandle;
    },
    closeResultSet: async (): Promise<void> => undefined,
  }) as unknown as ExasolConnection;

const sqlFor = async (
  request: Parameters<typeof createTableSource>[0],
): Promise<string | undefined> => {
  statements.length = 0;
  const source = createTableSource(request, stubConnection());
  await source.open();
  await source.close();
  return statements.at(-1);
};

const FILTER: RowFilter = {
  column: 'NAME',
  values: ['Denmark'],
  type: dataType('varchar', 'VARCHAR(64)', { size: 64 }),
};

describe('createTableSource', () => {
  it('selects a whole stored relation when nothing narrows it', async () => {
    await expect(sqlFor({ schema: 'SALES', table: 'ORDERS' })).resolves.toBe(
      'SELECT * FROM "SALES"."ORDERS"',
    );
  });

  it('carries a foreign key filter into the statement it sends', async () => {
    // The bug this exists for: the filter reached the worker and stopped there,
    // so following a key against a real database opened the whole table.
    await expect(sqlFor({ schema: 'SALES', table: 'COUNTRIES', filter: FILTER })).resolves.toBe(
      `SELECT * FROM "SALES"."COUNTRIES" WHERE "NAME" = 'Denmark'`,
    );
  });

  it('compares a numeric key numerically, whichever way Exasol sent it', async () => {
    const key = dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 });
    await expect(
      sqlFor({ schema: 'S', table: 'T', filter: { column: 'ID', values: [4_711], type: key } }),
    ).resolves.toBe('SELECT * FROM "S"."T" WHERE "ID" = 4711');
    // A high-precision key arrives as digits rather than as a JSON number.
    await expect(
      sqlFor({
        schema: 'S',
        table: 'T',
        filter: { column: 'ID', values: ['123456789012345678'], type: key },
      }),
    ).resolves.toBe('SELECT * FROM "S"."T" WHERE "ID" = 123456789012345678');
  });

  it('follows a key to a NULL with IS NULL rather than an impossible equality', async () => {
    await expect(
      sqlFor({ schema: 'S', table: 'T', filter: { column: 'C', values: [null] } }),
    ).resolves.toBe('SELECT * FROM "S"."T" WHERE "C" IS NULL');
  });

  it('runs a statement as given, and never alongside a filter', async () => {
    await expect(
      sqlFor({ schema: 'QUERY', table: 'label', sql: 'SELECT 1 FROM DUAL', filter: FILTER }),
    ).resolves.toBe('SELECT 1 FROM DUAL');
  });

  it('serves a demo relation locally, filter and all', async () => {
    const source = createTableSource(
      { schema: DEMO_SCHEMA, table: 'COUNTRIES', filter: FILTER },
      null,
      { demoLatencyMs: 0 },
    );
    const session = await source.open();
    // Filtered to the one country, without a database to ask.
    expect(session.rowCount).toBe(1);
    await source.close();
  });

  it('serves a whole demo relation when nothing narrows it', async () => {
    const source = createTableSource({ schema: DEMO_SCHEMA, table: 'COUNTRIES' }, null, {
      demoLatencyMs: 0,
    });
    const session = await source.open();
    expect(session.rowCount).toBe(5);
    await source.close();
  });

  it('refuses what it cannot serve, rather than serving something else', async () => {
    expect(() => createTableSource({ schema: 'SALES', table: 'ORDERS' }, null)).toThrow(
      /No connection/u,
    );
    expect(() => createTableSource({ schema: 'S', table: 'T', sql: 'SELECT 1' }, null)).toThrow(
      /without a database/u,
    );
  });
});
