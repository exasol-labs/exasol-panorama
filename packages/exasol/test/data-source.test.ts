import { describe, expect, it } from 'vitest';
import { cellValue } from '@panorama/table';
import { ExasolConnection, ExasolTableDataSource } from '@panorama/exasol';
import { FakeExasolServer, buildRelation } from './fake-exasol.js';
import type { FakeServerOptions } from './fake-exasol.js';

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
