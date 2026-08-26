import { describe, expect, it } from 'vitest';
import type { ColumnSummary } from '@panorama/table';
import { HISTOGRAM_BINS, cellValue } from '@panorama/table';
import { dataType } from '@panorama/core';
import { ExasolConnection, ExasolTableDataSource } from '@panorama/exasol';
import { FakeExasolServer, buildRelation } from './fake-exasol.js';
import type { ExasolValue, FakeRelation, FakeServerOptions } from './fake-exasol.js';

const ORDERS = buildRelation(
  [
    { name: 'ORDER_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
    { name: 'COUNTRY', dataType: { type: 'VARCHAR', size: 64 } },
    { name: 'PAID', dataType: { type: 'BOOLEAN' } },
  ],
  1_000,
  (column, row) => {
    if (column === 0) return row;
    if (column === 1) return row % 7 === 0 ? null : `country-${row % 5}`;
    return row % 2 === 0;
  },
);

const openSource = async (
  options: FakeServerOptions = {},
): Promise<{
  source: ExasolTableDataSource;
  connection: ExasolConnection;
  server: FakeExasolServer;
}> => {
  const server = new FakeExasolServer({ relations: { ORDERS }, ...options });
  const connection = new ExasolConnection({
    url: 'wss://exasol.test:8563',
    credentials: { kind: 'token', token: 't' },
    socketFactory: server.factory,
  });
  await connection.open();
  return {
    connection,
    server,
    source: new ExasolTableDataSource({ connection, schema: 'SALES', table: 'ORDERS' }),
  };
};

describe('ExasolTableDataSource', () => {
  it('exposes schema and row count without downloading the relation', async () => {
    const { source, server } = await openSource({ inlineRows: 0, rowsPerFetch: 128 });
    const session = await source.open();
    expect(session.rowCount).toBe(1_000);
    expect(session.schema.columns.map((column) => column.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'PAID',
    ]);
    expect(session.schema.columns[0]?.type.name).toBe('DECIMAL(18,0)');
    expect(server.fetches).toHaveLength(0);
  });

  it('fetches an exact row range regardless of the byte budget', async () => {
    const { source, server } = await openSource({ inlineRows: 0, rowsPerFetch: 30 });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 512, maxRows: 256 });

    expect(chunk.startRow).toBe(512);
    expect(chunk.rowCount).toBe(256);
    // 256 rows at 30 rows per protocol fetch.
    expect(server.fetches).toHaveLength(Math.ceil(256 / 30));
    expect(server.fetches[0]?.startPosition).toBe(512);

    const orderIds = chunk.columns[0];
    const countries = chunk.columns[1];
    const paid = chunk.columns[2];
    if (orderIds === undefined || countries === undefined || paid === undefined) {
      throw new Error('expected three columns');
    }
    expect(cellValue(orderIds, 0)).toBe(512);
    expect(cellValue(orderIds, 255)).toBe(767);
    expect(cellValue(countries, 0)).toBe('country-2');
    expect(cellValue(paid, 0)).toBe(true);
    expect(countries.kind).toBe('dictionary');
  });

  it('preserves NULLs', async () => {
    const { source } = await openSource({ inlineRows: 0, rowsPerFetch: 100 });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 0, maxRows: 8 });
    const countries = chunk.columns[1];
    if (countries === undefined) throw new Error('expected a column');
    expect(cellValue(countries, 0)).toBeNull();
    expect(cellValue(countries, 7)).toBeNull();
    expect(cellValue(countries, 1)).toBe('country-1');
  });

  it('serves inline results without any protocol fetch', async () => {
    const { source, server } = await openSource({ inlineRows: 1_000 });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 900, maxRows: 256 });
    expect(chunk.rowCount).toBe(100);
    expect(server.fetches).toHaveLength(0);
    expect(cellValue(chunk.columns[0] as never, 0)).toBe(900);
  });

  it('clamps the requested range to the end of the result set', async () => {
    const { source } = await openSource({ inlineRows: 0, rowsPerFetch: 500 });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: 900, maxRows: 256 });
    expect(chunk.rowCount).toBe(100);

    const past = await session.fetch({ startPosition: 5_000, maxRows: 256 });
    expect(past.rowCount).toBe(0);
    expect(past.columns).toHaveLength(3);
  });

  it('normalises negative and fractional start positions', async () => {
    const { source } = await openSource({ inlineRows: 0, rowsPerFetch: 500 });
    const session = await source.open();
    const chunk = await session.fetch({ startPosition: -10.7, maxRows: 4 });
    expect(chunk.startRow).toBe(0);
    expect(chunk.rowCount).toBe(4);
  });

  it('honours a configured fetch byte budget', async () => {
    const server = new FakeExasolServer({ relations: { ORDERS }, inlineRows: 0, rowsPerFetch: 50 });
    const connection = new ExasolConnection({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
      socketFactory: server.factory,
    });
    await connection.open();
    const source = new ExasolTableDataSource({
      connection,
      schema: 'SALES',
      table: 'ORDERS',
      fetchBytes: 2_048,
    });
    const session = await source.open();
    await session.fetch({ startPosition: 0, maxRows: 10 });
    expect(server.fetches.at(-1)?.numBytes).toBe(2_048);
  });

  it('aborts between protocol fetches', async () => {
    const { source } = await openSource({ inlineRows: 0, rowsPerFetch: 10 });
    const session = await source.open();
    const controller = new AbortController();
    controller.abort();
    await expect(
      session.fetch({ startPosition: 0, maxRows: 100 }, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('refuses to fetch after the session is closed', async () => {
    const { source, connection } = await openSource({ inlineRows: 0, rowsPerFetch: 100 });
    const session = await source.open();
    await session.close();
    expect(connection.openResultSetCount).toBe(0);
    await expect(session.fetch({ startPosition: 0, maxRows: 1 })).rejects.toMatchObject({
      code: 'session-closed',
    });
    // Closing twice is harmless.
    await expect(session.close()).resolves.toBeUndefined();
  });

  it('replaces the previous result set when reopened', async () => {
    const { source, connection, server } = await openSource({ inlineRows: 0, rowsPerFetch: 100 });
    await source.open();
    expect(connection.openResultSetCount).toBe(1);
    await source.open();
    expect(connection.openResultSetCount).toBe(1);
    expect(server.openResultSetCount).toBe(1);
    await source.close();
    expect(connection.openResultSetCount).toBe(0);
    // Closing an unopened source is harmless.
    await expect(source.close()).resolves.toBeUndefined();
  });

  it('surfaces an expired result set as a retryable, table-level error', async () => {
    const { source, connection } = await openSource({ inlineRows: 0, rowsPerFetch: 100 });
    const session = await source.open();
    await connection.closeResultSet(1);
    await expect(session.fetch({ startPosition: 0, maxRows: 10 })).rejects.toMatchObject({
      code: 'result-set-expired',
    });
  });

  it('fails loudly when the server returns no rows mid-range', async () => {
    const server = new FakeExasolServer({ relations: { ORDERS }, inlineRows: 0 });
    let fetches = 0;
    const connection = new ExasolConnection({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
      socketFactory: (url) => {
        const socket = server.factory(url);
        const inner = socket.onRequest;
        socket.onRequest = (request): void => {
          if (request['command'] === 'fetch') {
            fetches += 1;
            queueMicrotask(() => {
              socket.deliver({ status: 'ok', responseData: { numRows: 0, data: [[], [], []] } });
            });
            return;
          }
          inner?.(request);
        };
        return socket;
      },
    });
    await connection.open();
    const session = await new ExasolTableDataSource({
      connection,
      schema: 'SALES',
      table: 'ORDERS',
    }).open();
    await expect(session.fetch({ startPosition: 0, maxRows: 10 })).rejects.toMatchObject({
      code: 'protocol-error',
    });
    expect(fetches).toBe(1);
  });
});

describe('a statement written by the user', () => {
  it('runs verbatim instead of a generated SELECT', async () => {
    const server = new FakeExasolServer({ relations: { ORDERS } });
    const connection = new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'token', token: 't' },
      socketFactory: server.factory,
    });
    await connection.open();
    const statement = 'SELECT * FROM "SALES"."ORDERS" WHERE PAID = TRUE';
    const source = new ExasolTableDataSource({
      connection,
      // These only label the result; the statement decides what is read.
      schema: 'QUERY',
      table: 'ORDERS · SQL',
      sql: statement,
    });
    const session = await source.open();
    expect(server.executed).toContain(statement);
    // No generated projection was sent alongside it.
    expect(server.executed.some((sql) => sql.startsWith('SELECT * FROM "SALES"."ORDERS"\n'))).toBe(
      false,
    );
    expect(session.schema).toMatchObject({ schema: 'QUERY', table: 'ORDERS · SQL' });
    expect(session.schema.columns.map((column) => column.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'PAID',
    ]);
    await source.close();
  });

  it('takes precedence over a row filter', async () => {
    const server = new FakeExasolServer({ relations: { ORDERS } });
    const connection = new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'token', token: 't' },
      socketFactory: server.factory,
    });
    await connection.open();
    const source = new ExasolTableDataSource({
      connection,
      schema: 'SALES',
      table: 'ORDERS',
      sql: 'SELECT 1 FROM "SALES"."ORDERS"',
      filter: { column: 'COUNTRY', values: ['x'], type: dataType('varchar', 'VARCHAR(64)') },
    });
    await source.open();
    expect(server.executed).toContain('SELECT 1 FROM "SALES"."ORDERS"');
    expect(server.executed.some((sql) => sql.includes('WHERE'))).toBe(false);
    await source.close();
  });
});

describe('summarising a column against a live result set', () => {
  const NUMBER = { type: 'DECIMAL', precision: 18, scale: 0 } as const;
  const TEXT = { type: 'VARCHAR', size: 64 } as const;

  /** One row of aggregates, in the order the query asks for them. */
  const aggregate = (
    rows: ExasolValue,
    present: ExasolValue,
    distinct: ExasolValue,
    min: ExasolValue,
    max: ExasolValue,
    mean: ExasolValue = null,
  ): FakeRelation => ({
    columns: [
      { name: 'C1', dataType: NUMBER },
      { name: 'C2', dataType: NUMBER },
      { name: 'C3', dataType: NUMBER },
      { name: 'C4', dataType: TEXT },
      { name: 'C5', dataType: TEXT },
      { name: 'C6', dataType: { type: 'DOUBLE' } },
    ],
    rowCount: 1,
    data: [[rows], [present], [distinct], [min], [max], [mean]],
  });

  const grouped = (
    values: readonly ExasolValue[],
    counts: readonly ExasolValue[],
    valueType: Record<string, unknown> = TEXT,
  ): FakeRelation => ({
    columns: [
      { name: 'V', dataType: valueType },
      { name: 'N', dataType: NUMBER },
    ],
    rowCount: values.length,
    data: [values, counts],
  });

  const summariseWith = async (
    queries: Record<string, FakeRelation>,
    column = 'COUNTRY',
  ): Promise<ColumnSummary> => {
    const { source } = await openSource({ inlineRows: 0, rowsPerFetch: 128, queries });
    const session = await source.open();
    if (session.summarise === undefined) throw new Error('expected a summarising session');
    return session.summarise(column);
  };

  it('names every value when the database says there are few enough', async () => {
    const summary = await summariseWith({
      'COUNT(DISTINCT': aggregate(1_000, 900, 2, 'DE', 'US'),
      'ORDER BY 2 DESC': grouped(['DE', 'US'], [600, 300]),
    });
    expect(summary.rows).toBe(1_000);
    expect(summary.nulls).toBe(100);
    expect(summary.basis).toBe('exact');
    expect(summary.distinct).toBe(2);
    expect(summary.min).toBe('DE');
    expect(summary.max).toBe('US');
    expect(summary.frequenciesComplete).toBe(true);
    expect(summary.frequencies).toEqual([
      { value: 'DE', count: 600 },
      { value: 'US', count: 300 },
    ]);
  });

  it('asks for the whole distribution rather than the top few', async () => {
    const { source, server } = await openSource({
      inlineRows: 0,
      queries: {
        'COUNT(DISTINCT': aggregate(10, 10, 3, 'a', 'c'),
        'ORDER BY 2 DESC': grouped(['a', 'b', 'c'], [5, 3, 2]),
      },
    });
    const session = await source.open();
    await session.summarise?.('COUNTRY');
    const frequency = server.executed.find((sql) => sql.includes('ORDER BY 2 DESC'));
    // Three distinct values means a limit of three, not of eight: the bars are
    // the whole truth about this column, so the query asks for exactly it.
    expect(frequency).toContain('LIMIT 3');
  });

  it('reads a set of numbers as a series rather than by popularity', async () => {
    const summary = await summariseWith(
      {
        'COUNT(DISTINCT': aggregate(10, 10, 3, 1, 3, 2),
        'ORDER BY 2 DESC': grouped([3, 1, 2], [5, 3, 2], NUMBER),
      },
      'ORDER_ID',
    );
    expect(summary.frequencies?.map((entry) => entry.value)).toEqual([1, 2, 3]);
    expect(summary.mean).toBe(2);
  });

  it('bins a numeric column with more values than can be named', async () => {
    const summary = await summariseWith(
      {
        'COUNT(DISTINCT': aggregate(1_000, 1_000, 500, 0, 240, 120),
        LEAST: grouped([0, 2, 23], [10, 20, 30], NUMBER),
      },
      'ORDER_ID',
    );
    expect(summary.frequencies).toBeUndefined();
    expect(summary.bins).toHaveLength(HISTOGRAM_BINS);
    // Every range, not only the ones with rows: a gap is part of the shape.
    expect(summary.bins?.map((bin) => bin.count).slice(0, 4)).toEqual([10, 0, 20, 0]);
    expect(summary.bins?.[0]).toEqual({ from: 0, to: 10, count: 10 });
    expect(summary.bins?.at(-1)).toEqual({ from: 230, to: 240, count: 30 });
  });

  it('ignores a slice index the database could not have meant', async () => {
    const summary = await summariseWith(
      {
        'COUNT(DISTINCT': aggregate(10, 10, 50, 0, 24, 12),
        LEAST: grouped([-1, 999, 0], [7, 7, 3], NUMBER),
      },
      'ORDER_ID',
    );
    expect(summary.bins?.reduce((total, bin) => total + bin.count, 0)).toBe(3);
  });

  it('draws one bar for a numeric column whose values are all the same', async () => {
    const summary = await summariseWith(
      {
        'COUNT(DISTINCT': aggregate(10, 10, 50, 7, 7, 7),
        LEAST: grouped([0], [10], NUMBER),
      },
      'ORDER_ID',
    );
    expect(summary.bins).toEqual([{ from: 7, to: 7, count: 10 }]);
  });

  it('draws one bar rather than nothing when the range cannot be read', async () => {
    // A DECIMAL wider than a double arrives as text; whatever else that is, it
    // is not a range to cut into twenty-four pieces.
    const summary = await summariseWith(
      {
        'COUNT(DISTINCT': aggregate(10, 10, 50, 'not a number', 'nor this', 1),
        LEAST: grouped([0], [10], NUMBER),
      },
      'ORDER_ID',
    );
    expect(summary.bins).toHaveLength(1);
  });

  it('names the top few of a text column with too many values', async () => {
    const summary = await summariseWith({
      'COUNT(DISTINCT': aggregate(1_000, 1_000, 240, 'AD', 'ZW'),
      'ORDER BY 2 DESC': grouped(['DE', 'US'], [100, 90]),
    });
    expect(summary.frequenciesComplete).toBe(false);
    expect(summary.frequencies).toHaveLength(2);
    expect(summary.bins).toBeUndefined();
  });

  it('says only what it knows about a column that is entirely null', async () => {
    const summary = await summariseWith({
      'COUNT(DISTINCT': aggregate(1_000, 0, 0, null, null),
    });
    expect(summary.nulls).toBe(1_000);
    expect(summary.min).toBeUndefined();
    expect(summary.max).toBeUndefined();
    expect(summary.frequencies).toBeUndefined();
    expect(summary.bins).toBeUndefined();
  });

  it('takes a count the database sent as digits', async () => {
    const summary = await summariseWith({
      'COUNT(DISTINCT': aggregate('1000', '900', '2', 'DE', 'US'),
      'ORDER BY 2 DESC': grouped(['DE', 'US'], ['600', '300']),
    });
    expect(summary.rows).toBe(1_000);
    expect(summary.frequencies?.[0]?.count).toBe(600);
  });

  it('reads no count at all rather than a wrong one', async () => {
    const summary = await summariseWith({
      'COUNT(DISTINCT': aggregate('nonsense', 0, 0, null, null),
    });
    expect(summary.rows).toBe(0);
  });

  it('draws no bars when the grouped answer came back with nothing in it', async () => {
    const nothing: FakeRelation = { columns: [], rowCount: 0, data: [] };
    const summary = await summariseWith({
      'COUNT(DISTINCT': aggregate(10, 10, 2, 'DE', 'US'),
      'ORDER BY 2 DESC': nothing,
    });
    expect(summary.frequencies).toEqual([]);
  });

  it('draws no ranges when the histogram answer came back with nothing in it', async () => {
    const nothing: FakeRelation = { columns: [], rowCount: 0, data: [] };
    const summary = await summariseWith(
      {
        'COUNT(DISTINCT': aggregate(10, 10, 500, 0, 240, 12),
        LEAST: nothing,
      },
      'ORDER_ID',
    );
    // Every range is still described, all of them empty: the panel says "no
    // rows here" rather than showing a chart of a shape nobody reported.
    expect(summary.bins).toHaveLength(HISTOGRAM_BINS);
    expect(summary.bins?.every((bin) => bin.count === 0)).toBe(true);
  });

  it('refuses a column the result set does not have', async () => {
    const { source } = await openSource({ inlineRows: 0 });
    const session = await source.open();
    await expect(session.summarise?.('NO_SUCH_COLUMN')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses to summarise a closed result set', async () => {
    const { source } = await openSource({ inlineRows: 0 });
    const session = await source.open();
    await session.close();
    await expect(session.summarise?.('COUNTRY')).rejects.toMatchObject({
      code: 'session-closed',
    });
  });

  it('abandons a summary whose signal has already been given up on', async () => {
    const { source, server } = await openSource({ inlineRows: 0 });
    const session = await source.open();
    const before = server.executed.length;
    await expect(session.summarise?.('COUNTRY', AbortSignal.abort())).rejects.toMatchObject({
      code: 'aborted',
    });
    // Not asked at all, rather than asked and thrown away.
    expect(server.executed).toHaveLength(before);
  });

  it('summarises what it is showing, not the table it came from', async () => {
    const { connection, server } = await openSource({
      inlineRows: 0,
      queries: { 'COUNT(DISTINCT': aggregate(3, 3, 1, 'DE', 'DE') },
    });
    const filtered = new ExasolTableDataSource({
      connection,
      schema: 'SALES',
      table: 'ORDERS',
      filter: { column: 'ORDER_ID', values: [7], type: dataType('decimal', 'DECIMAL(18,0)') },
    });
    const session = await filtered.open();
    await session.summarise?.('COUNTRY');
    const query = server.executed.find((sql) => sql.includes('COUNT(DISTINCT'));
    // The filter is inside the subquery: a followed key is described as it is
    // shown, and dropping it here would describe a different set of rows.
    expect(query).toContain('WHERE "ORDER_ID" = 7');
  });
});
