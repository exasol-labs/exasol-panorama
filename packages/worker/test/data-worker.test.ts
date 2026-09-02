import { describe, expect, it, vi } from 'vitest';
import type { EntityId } from '@panorama/core';
import type { RowsAvailable } from '@panorama/worker';
import { serializeError } from '@panorama/worker';
import type { TableDataSession } from '@panorama/table';
import { TableDataError, cellValue } from '@panorama/table';
import { MAX_SUMMARY_SCAN, factRelation } from '@panorama/test-support';
import type { RowFilter } from '@panorama/table';
import { dataType } from '@panorama/core';
import { compileSemanticSql } from '@panorama/exasol';
import { TABLE_ID, createWorkerHarness } from './harness.js';

describe('DataWorker table lifecycle', () => {
  it('opens a table and reports its schema and row count', async () => {
    const harness = createWorkerHarness();
    const result = await harness.client.openTable({
      tableId: TABLE_ID,
      schema: 'PANORAMA_TEST',
      table: 'SALES',
    });
    expect(result.rowCount).toBe(10_000);
    expect(result.generation).toBe(0);
    expect(result.schema.columns.map((column) => column.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'ORDER_DATE',
      'REVENUE',
    ]);
    expect(harness.worker.openTableCount).toBe(1);
  });

  it('fetches requested blocks and posts them back', async () => {
    const harness = createWorkerHarness();
    const rows: RowsAvailable[] = [];
    harness.client.onRows((event) => rows.push(event));
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });

    harness.client.requestBlocks(TABLE_ID, 0, 256, [
      { index: 4, priority: 0 },
      { index: 5, priority: 1 },
    ]);
    await harness.settle();

    expect(rows.map((event) => event.blockIndex).sort()).toEqual([4, 5]);
    const block = rows.find((event) => event.blockIndex === 4);
    expect(block?.chunk.startRow).toBe(1_024);
    expect(block?.chunk.rowCount).toBe(256);
    expect(cellValue(block?.chunk.columns[0] as never, 0)).toBe(1_024);
  });

  it('honours the requested block size', async () => {
    const harness = createWorkerHarness();
    const rows: RowsAvailable[] = [];
    harness.client.onRows((event) => rows.push(event));
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });

    harness.client.requestBlocks(TABLE_ID, 0, 64, [{ index: 2, priority: 0 }]);
    await harness.settle();
    expect(rows[0]?.chunk.startRow).toBe(128);
    expect(rows[0]?.chunk.rowCount).toBe(64);
  });

  it('bounds concurrent fetches', async () => {
    const harness = createWorkerHarness({
      maxConcurrentFetches: 2,
      source: { latency: 20 },
    });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    harness.client.requestBlocks(
      TABLE_ID,
      0,
      256,
      Array.from({ length: 10 }, (_, index) => ({ index, priority: index })),
    );
    await harness.settle();
    expect(harness.sources.get('PANORAMA_TEST.SALES')?.stats().maxConcurrentFetches).toBe(2);
  });

  it('reports block failures without tearing the table down', async () => {
    const harness = createWorkerHarness({ source: { failure: { everyNth: 1 } } });
    const failures: number[] = [];
    harness.client.onBlockFailed((event) => failures.push(event.blockIndex));
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });

    harness.client.requestBlocks(TABLE_ID, 0, 256, [{ index: 0, priority: 0 }]);
    await harness.settle();
    expect(failures).toEqual([0]);
    expect(harness.worker.openTableCount).toBe(1);
  });

  it('ignores block requests for unknown tables and stale generations', async () => {
    const harness = createWorkerHarness();
    const rows: RowsAvailable[] = [];
    harness.client.onRows((event) => rows.push(event));

    harness.client.requestBlocks(TABLE_ID, 0, 256, [{ index: 0, priority: 0 }]);
    await harness.settle();
    expect(rows).toEqual([]);

    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    harness.client.requestBlocks(TABLE_ID, 7, 256, [{ index: 0, priority: 0 }]);
    await harness.settle();
    expect(rows).toEqual([]);
  });

  it('reopens a table with a new generation and drops in-flight work', async () => {
    const harness = createWorkerHarness({ source: { latency: 50 } });
    const rows: RowsAvailable[] = [];
    harness.client.onRows((event) => rows.push(event));
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });

    harness.client.requestBlocks(TABLE_ID, 0, 256, [{ index: 0, priority: 0 }]);
    await Promise.resolve();
    const reopened = await harness.client.reopenTable(TABLE_ID);
    expect(reopened.generation).toBe(1);
    await harness.settle();
    // The response for the old result set was discarded.
    expect(rows).toEqual([]);

    harness.client.requestBlocks(TABLE_ID, 1, 256, [{ index: 0, priority: 0 }]);
    await harness.settle();
    expect(rows.map((event) => event.generation)).toEqual([1]);
  });

  it('fails to reopen a table that is not open', async () => {
    const harness = createWorkerHarness();
    await expect(harness.client.reopenTable(TABLE_ID)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('surfaces an open failure', async () => {
    const harness = createWorkerHarness({ source: { failOpen: 'permission-denied' } });
    await expect(
      harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(harness.worker.openTableCount).toBe(0);
  });

  it('closes tables and releases their result sets', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.client.closeTable(TABLE_ID);
    expect(harness.worker.openTableCount).toBe(0);
    // Closing an unknown table is a no-op.
    await expect(harness.client.closeTable(TABLE_ID)).resolves.toBeNull();
  });

  it('replaces an existing table when reopened by id', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    expect(harness.worker.openTableCount).toBe(1);
  });
});

describe('DataWorker connection handling', () => {
  it('rejects metadata calls before connecting', async () => {
    const harness = createWorkerHarness();
    await expect(harness.client.listSchemas()).rejects.toMatchObject({ code: 'connection-lost' });
    await expect(harness.client.listTables('S')).rejects.toMatchObject({
      code: 'connection-lost',
    });
    await expect(harness.client.describeTable('S', 'T')).rejects.toMatchObject({
      code: 'connection-lost',
    });
  });

  it('refuses to connect without a connection factory', async () => {
    const harness = createWorkerHarness();
    await expect(
      harness.client.connect('wss://x', { kind: 'token', token: 't' }),
    ).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('connects, forwards metadata and reports status changes', async () => {
    const listSchemas = vi.fn(async () => [{ name: 'SALES' }]);
    const listTables = vi.fn(async () => [{ schema: 'SALES', name: 'ORDERS', kind: 'TABLE' }]);
    const describeTable = vi.fn(async () => ({ schema: 'SALES', table: 'ORDERS', columns: [] }));
    const close = vi.fn(async () => undefined);
    let notify: ((status: string, error?: unknown) => void) | null = null;

    const harness = createWorkerHarness({
      createConnection: (options) => {
        notify = options.onStatusChange;
        return {
          id: 'connection:1',
          open: async (): Promise<void> => undefined,
          close,
          listSchemas,
          listTables,
          describeTable,
        } as never;
      },
    });

    const statuses: string[] = [];
    harness.client.onConnectionStatus((event) => statuses.push(event.status));

    await expect(
      harness.client.connect('wss://x', { kind: 'password', username: 'sys', password: 'p' }),
    ).resolves.toEqual({ connectionId: 'connection:1' });

    await expect(harness.client.listSchemas()).resolves.toEqual([{ name: 'SALES' }]);
    await expect(harness.client.listTables('SALES')).resolves.toHaveLength(1);
    await expect(harness.client.describeTable('SALES', 'ORDERS')).resolves.toMatchObject({
      table: 'ORDERS',
    });

    (notify as unknown as (status: string, error?: unknown) => void)(
      'failed',
      new TableDataError('connection-lost', 'dropped'),
    );
    await Promise.resolve();
    expect(statuses).toEqual(['failed']);

    await harness.client.disconnect();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reports a failed connection attempt', async () => {
    const harness = createWorkerHarness({
      createConnection: () =>
        ({
          id: 'connection:1',
          open: async (): Promise<void> => {
            throw new TableDataError('authentication-failed', 'bad password');
          },
        }) as never,
    });
    await expect(
      harness.client.connect('wss://x', { kind: 'token', token: 't' }),
    ).rejects.toMatchObject({ code: 'authentication-failed' });
    // The failed connection is not retained.
    await expect(harness.client.listSchemas()).rejects.toMatchObject({ code: 'connection-lost' });
  });

  it('closes open tables when disconnecting', async () => {
    const harness = createWorkerHarness({
      createConnection: () =>
        ({
          id: 'connection:1',
          open: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
        }) as never,
    });
    await harness.client.connect('wss://x', { kind: 'token', token: 't' });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.client.disconnect();
    expect(harness.worker.openTableCount).toBe(0);
  });

  it('reports a failure while disconnecting', async () => {
    const harness = createWorkerHarness({
      createConnection: () =>
        ({
          id: 'connection:1',
          open: async (): Promise<void> => undefined,
          close: async (): Promise<void> => {
            throw new Error('socket stuck');
          },
        }) as never,
    });
    await harness.client.connect('wss://x', { kind: 'token', token: 't' });
    await expect(harness.client.disconnect()).rejects.toMatchObject({ code: 'protocol-error' });
  });

  it('disconnects cleanly when never connected', async () => {
    const harness = createWorkerHarness();
    await expect(harness.client.disconnect()).resolves.toBeNull();
  });
});

describe('serializeError', () => {
  it('preserves data-error codes and degrades gracefully', () => {
    expect(serializeError(new TableDataError('not-found', 'gone'))).toEqual({
      code: 'not-found',
      message: 'gone',
    });
    expect(serializeError(new Error('boom'))).toEqual({ code: 'protocol-error', message: 'boom' });
    expect(serializeError('plain string')).toEqual({
      code: 'protocol-error',
      message: 'plain string',
    });
  });
});

describe('the default Exasol source factory', () => {
  it('requires a connection', async () => {
    const { DataWorker } = await import('@panorama/worker');
    const { createInProcessEndpointPair, DataWorkerClient } = await import('@panorama/worker');
    const pair = createInProcessEndpointPair();
    new DataWorker({ endpoint: pair.worker });
    const client = new DataWorkerClient(pair.main);
    await expect(
      client.openTable({ tableId: TABLE_ID, schema: 'S', table: 'T' }),
    ).rejects.toMatchObject({
      code: 'connection-lost',
    });
    expect(factRelation().table).toBe('SALES');
  });
});

describe('DataWorker failure paths', () => {
  const brokenSource = (fail: 'reopen' | 'close') => {
    let opens = 0;
    return {
      open: async (): Promise<unknown> => {
        opens += 1;
        if (fail === 'reopen' && opens > 1) throw new TableDataError('result-set-expired', 'gone');
        return {
          schema: { schema: 'S', table: 'T', columns: [] },
          rowCount: 10,
          fetch: async (): Promise<unknown> => ({
            startRow: 0,
            rowCount: 0,
            columns: [],
            byteSize: 0,
          }),
          close: async (): Promise<void> => undefined,
        };
      },
      close: async (): Promise<void> => {
        if (fail === 'close') throw new Error('cannot release handle');
      },
    };
  };

  it('reports a failed reopen', async () => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const pair = createInProcessEndpointPair();
    new DataWorker({ endpoint: pair.worker, createSource: () => brokenSource('reopen') as never });
    const client = new DataWorkerClient(pair.main);

    await client.openTable({ tableId: TABLE_ID, schema: 'S', table: 'T' });
    await expect(client.reopenTable(TABLE_ID)).rejects.toMatchObject({
      code: 'result-set-expired',
    });
  });

  it('reports a failure while closing a table', async () => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const pair = createInProcessEndpointPair();
    new DataWorker({ endpoint: pair.worker, createSource: () => brokenSource('close') as never });
    const client = new DataWorkerClient(pair.main);

    await client.openTable({ tableId: TABLE_ID, schema: 'S', table: 'T' });
    await expect(client.closeTable(TABLE_ID)).rejects.toMatchObject({ code: 'protocol-error' });
  });
});

describe('DataWorker column summaries', () => {
  it('describes a column of an open table', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const summary = await harness.drive(harness.client.summariseColumn(TABLE_ID, 'COUNTRY'));

    expect(summary?.column).toBe('COUNTRY');
    expect(summary?.rows).toBeGreaterThan(0);
    expect(summary?.frequencies?.length).toBeGreaterThan(0);
  });

  it('says which rows it looked at, for a relation too big to walk', async () => {
    const harness = createWorkerHarness({
      source: { relation: factRelation(MAX_SUMMARY_SCAN * 2) },
    });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const summary = await harness.drive(harness.client.summariseColumn(TABLE_ID, 'COUNTRY'));

    // A statement about the first hundred thousand rows that does not say so is
    // a statement about the whole table, and a wrong one.
    expect(summary?.basis).toBe('sampled');
    expect(summary?.rows).toBe(MAX_SUMMARY_SCAN);
  });

  it('says nothing at all rather than guessing, for a source that cannot answer', async () => {
    // A session with no `summarise`: deriving one from the blocks that happen to
    // be cached would describe the scroll position rather than the column.
    const session: TableDataSession = {
      schema: { schema: 'S', table: 'T', columns: [] },
      rowCount: 3,
      fetch: () => Promise.reject(new Error('not asked for')),
      close: () => Promise.resolve(),
    };
    const harness = createWorkerHarness({
      createSource: () => ({
        open: () => Promise.resolve(session),
        close: () => Promise.resolve(),
      }),
    });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });

    await expect(
      harness.drive(harness.client.summariseColumn(TABLE_ID, 'COUNTRY')),
    ).resolves.toBeNull();
  });

  it('refuses a column of a table nobody opened', async () => {
    const harness = createWorkerHarness();
    await expect(harness.client.summariseColumn(TABLE_ID, 'COUNTRY')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('passes on what the source said about a column it does not have', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    await expect(
      harness.drive(harness.client.summariseColumn(TABLE_ID, 'NO_SUCH_COLUMN')),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('DataWorker chart data', () => {
  const spec = {
    type: 'bar',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
  } as const;

  it('reduces the rows beside the rows, and reports what it read', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const data = await harness.drive(harness.client.chartData(TABLE_ID, spec));

    expect(data?.data.categories.length).toBeGreaterThan(0);
    expect(data?.data.series[0]?.name).toBe('REVENUE');
    // Ten thousand rows in the relation, and the default limit is above that.
    expect(data?.data.rows).toBe(10_000);
    expect(data?.data.basis).toBe('exact');
  });

  it('builds each named data set from the box that supplies it', async () => {
    const harness = createWorkerHarness();
    const other = 'table:other' as EntityId;
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.client.openTable({ tableId: other, schema: 'PANORAMA_TEST', table: 'OTHER' });
    const answer = await harness.drive(
      harness.client.chartData(
        TABLE_ID,
        {
          ...spec,
          frames: [
            { name: 'mine', kind: 'rows', columns: ['COUNTRY'], rowLimit: 3 },
            { name: 'theirs', kind: 'rows', columns: ['COUNTRY'], rowLimit: 4 },
          ],
        },
        { theirs: other },
      ),
    );
    // Named in the order the specification named them, whichever box each read
    // and whichever order the reads finished in.
    expect(answer?.frames.map((frame) => frame.name)).toEqual(['primary', 'mine', 'theirs']);
    expect(answer?.frames[1]?.rows).toHaveLength(3);
    expect(answer?.frames[2]?.rows).toHaveLength(4);
  });

  it('reads one box once, however many data sets it supplies', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const before = harness.sources.get('PANORAMA_TEST.SALES')?.stats().fetches ?? 0;
    await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          { name: 'a', kind: 'rows', columns: ['COUNTRY'] },
          { name: 'b', kind: 'rows', columns: ['REVENUE'] },
          { name: 'c', kind: 'scalar', column: 'REVENUE', aggregate: 'sum' },
        ],
      }),
    );
    const once = (harness.sources.get('PANORAMA_TEST.SALES')?.stats().fetches ?? 0) - before;
    // Three data sets are three questions about one result set, not three fetches
    // of it. The relation is ten thousand rows and the block size is four
    // thousand, so one read is three fetches; three reads would be nine.
    expect(once).toBeLessThanOrEqual(3);
  });

  it('gives a data set from a box that is not open no rows, and still draws the rest', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(
        TABLE_ID,
        { ...spec, frames: [{ name: 'gone', kind: 'rows', columns: ['COUNTRY'] }] },
        { gone: 'table:closed' as EntityId },
      ),
    );
    // Reported as empty rather than as a failure: the other data sets are still
    // worth drawing, and the answer says which one had nothing.
    expect(answer?.frames.map((frame) => frame.name)).toEqual(['primary', 'gone']);
    expect(answer?.frames[1]?.rows).toEqual([]);
    expect(answer?.data.categories.length).toBeGreaterThan(0);
  });

  it('reads the window a data set asked for by position, not the beginning', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'page',
            kind: 'rows',
            columns: ['COUNTRY'],
            window: { by: 'position', from: 4_000, count: 25 },
          },
        ],
      }),
    );
    const page = answer?.frames.find((frame) => frame.name === 'page');
    expect(page?.rows).toHaveLength(25);
    // And it says which part of the relation that was: a picture cannot.
    expect(page?.window).toEqual({ by: 'position', from: 4_000, count: 25 });
  });

  it('keeps only the rows inside a range along a column', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'range',
            kind: 'rows',
            columns: ['ORDER_ID', 'COUNTRY'],
            key: 'ORDER_ID',
            window: { by: 'value', column: 'ORDER_ID', from: 10, to: 60 },
          },
        ],
      }),
    );
    const range = answer?.frames.find((frame) => frame.name === 'range');
    expect(range?.rows.length).toBeGreaterThan(0);
    for (const row of range?.rows ?? []) {
      expect(Number(row[0])).toBeGreaterThanOrEqual(10);
      expect(Number(row[0])).toBeLessThanOrEqual(60);
    }
    // It says how far it had to walk to find them, which for a relation in
    // another order is more rows than it kept.
    expect(range?.scanned ?? 0).toBeGreaterThanOrEqual(range?.rows.length ?? 0);
  });

  it('stops reading a range as soon as the column has passed it', async () => {
    // Which is what makes this a range read rather than a scan: a relation in the
    // order the axis is in — a statement with an `ORDER BY`, which is what a series
    // is drawn from — is not walked past the end of the range.
    const ordered = {
      ...factRelation(200_000),
      valueFor: (_type: unknown, column: number, row: number): unknown =>
        column === 0 ? row : row % 97,
    };
    const harness = createWorkerHarness({ source: { relation: ordered as never } });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'range',
            kind: 'rows',
            columns: ['ORDER_ID'],
            window: { by: 'value', column: 'ORDER_ID', from: 100, to: 300 },
          },
        ],
      }),
    );
    const range = answer?.frames.find((frame) => frame.name === 'range');
    expect(range?.rows).toHaveLength(201);
    // Two hundred thousand rows in the relation; a few thousand walked.
    expect(range?.scanned ?? Infinity).toBeLessThan(10_000);
  });

  it('bounds a range on a text column the way the column would order it', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'range',
            kind: 'rows',
            columns: ['COUNTRY'],
            window: { by: 'value', column: 'COUNTRY', from: 'F', to: 'Gz' },
          },
        ],
      }),
    );
    const range = answer?.frames.find((frame) => frame.name === 'range');
    expect(range?.rows.length).toBeGreaterThan(0);
    for (const row of range?.rows ?? []) {
      expect(String(row[0]) >= 'F' && String(row[0]) <= 'Gz').toBe(true);
    }
  });

  it('gives a range on a column it has not got nothing at all', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'range',
            kind: 'rows',
            columns: ['COUNTRY'],
            window: { by: 'value', column: 'NOWHERE', from: 1, to: 2 },
          },
        ],
      }),
    );
    // Nothing can be said to be in range, and treating every row as inside it
    // would be a lie. The reduction beside it is still drawn.
    expect(answer?.frames.find((frame) => frame.name === 'range')?.rows).toEqual([]);
    expect(answer?.data.categories.length).toBeGreaterThan(0);
  });

  it('gives a range that matches no rows an empty data set rather than everything', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'range',
            kind: 'rows',
            columns: ['COUNTRY'],
            window: { by: 'value', column: 'COUNTRY', from: 'zzzz', to: 'zzzzz' },
          },
        ],
      }),
    );
    expect(answer?.frames.find((frame) => frame.name === 'range')?.rows).toEqual([]);
  });

  it('reads a window from a source that cannot say how many rows it has', async () => {
    const harness = createWorkerHarness({ source: { reportRowCount: false } });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        frames: [
          {
            name: 'page',
            kind: 'rows',
            columns: ['COUNTRY'],
            window: { by: 'position', from: 100, count: 30 },
          },
        ],
      }),
    );
    // A count it cannot check against is not a reason to read nothing: it asks
    // for the window and reports what came back.
    const page = answer?.frames.find((frame) => frame.name === 'page');
    expect(page?.rows).toHaveLength(30);
    expect(page?.of).toBeNull();
  });

  it('resamples a long series where the rows are', async () => {
    const harness = createWorkerHarness({ source: { relation: factRelation(50_000) } });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const answer = await harness.drive(
      harness.client.chartData(TABLE_ID, {
        ...spec,
        rowLimit: 20_000,
        frames: [
          { name: 'line', kind: 'resample', x: 'ORDER_ID', values: ['REVENUE'], points: 300 },
        ],
      }),
    );
    const line = answer?.frames.find((frame) => frame.name === 'line');
    // Twenty thousand rows read beside the rows; three hundred points crossed.
    expect(line?.read).toBe(20_000);
    expect(line?.rows.length).toBeLessThanOrEqual(300);
    expect(line?.basis).toBe('sampled');
  });

  it('stops at the limit and says the picture is of a beginning', async () => {
    const harness = createWorkerHarness({ source: { relation: factRelation(100_000) } });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const data = await harness.drive(
      harness.client.chartData(TABLE_ID, { ...spec, rowLimit: 500 }),
    );

    expect(data?.data.rows).toBe(500);
    expect(data?.data.basis).toBe('sampled');
  });

  it('never asks for fewer than one row, however small the limit', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const data = await harness.drive(harness.client.chartData(TABLE_ID, { ...spec, rowLimit: 0 }));
    expect(data?.data.rows).toBe(1);
  });

  it('has nothing to draw from a table with no rows', async () => {
    const harness = createWorkerHarness({ source: { relation: factRelation(0) } });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    await expect(harness.drive(harness.client.chartData(TABLE_ID, spec))).resolves.toBeNull();
  });

  it('refuses a table nobody opened', async () => {
    const harness = createWorkerHarness();
    await expect(harness.client.chartData(TABLE_ID, spec)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('reads a source that cannot say how many rows it has', async () => {
    const harness = createWorkerHarness({ source: { reportRowCount: false } });
    await harness.client.openTable({ tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' });
    const data = await harness.drive(
      harness.client.chartData(TABLE_ID, { ...spec, rowLimit: 300 }),
    );
    // It cannot claim to have read everything, so it does not.
    expect(data?.data.rows).toBe(300);
    expect(data?.data.basis).toBe('sampled');
  });
});

describe('the preprocessor a statement runs under', () => {
  /**
   * A statement reading a JSON wrapper view needs that package's session
   * preprocessor, and the worker chooses it from the statement rather than from
   * the box's source — a query box's schema is a label, and what decides whether
   * the dotted paths must be rewritten is which schema the `FROM` names.
   *
   * Asserted through the real `#createSource`, because that is the only place the
   * choice is made; every other test replaces it.
   */
  const connection = (opened: string[]) =>
    ({
      id: 'connection:1',
      open: async (): Promise<void> => undefined,
      close: async (): Promise<void> => undefined,
      // No semantic layer on this connection, which is the ordinary case and the
      // one that must leave the wrapper path exactly as it was.
      semanticSurface: async () => null,
      wrapperCompilers: async () => [],
      wrapperSurface: async () =>
        new Map([
          [
            'SRC.orders',
            {
              sourceSchema: 'SRC',
              rootTable: 'orders',
              schema: 'WRAP',
              view: 'orders',
              helperSchema: 'H',
              preprocessor: '"PP"."P"',
            },
          ],
        ]),
      openResultSet: async (sqlText: string, preprocessor?: string | null) => {
        opened.push(`${preprocessor ?? 'none'} | ${sqlText}`);
        return {
          handle: null,
          columns: [{ name: 'ORDER_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } }],
          numRows: 0,
          numRowsInMessage: 0,
          inlineData: [[]],
        };
      },
    }) as never;

  it('sets it for a statement that reads a wrapper view, and not otherwise', async () => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const opened: string[] = [];
    const pair = createInProcessEndpointPair();
    // No `createSource`, so the real one runs — which is the only place the
    // preprocessor is chosen, and every other test in this file replaces it.
    new DataWorker({ endpoint: pair.worker, createConnection: () => connection(opened) });
    const client = new DataWorkerClient(pair.main);
    await client.connect('wss://x', { kind: 'token', token: 't' });
    await client.openTable({
      tableId: TABLE_ID,
      schema: 'QUERY',
      table: 'q',
      sql: 'SELECT "a.b" FROM "WRAP"."orders"',
    });
    expect(opened.at(-1)).toBe('"PP"."P" | SELECT "a.b" FROM "WRAP"."orders"');

    await client.openTable({ tableId: 'table:2' as never, schema: 'SRC', table: 'orders' });
    // The stored table needs no preprocessor: it has no paths to rewrite.
    expect(opened.at(-1)).toContain('none | ');
  });
});

/**
 * Compiling a statement that reads a semantic object, on the way to running it.
 *
 * The whole point of doing it here rather than setting the layer's session
 * preprocessor: the source is handed the *physical* SQL, so the rows, the column
 * statistics and an export all read the same ordinary query. Under the
 * preprocessor the derived queries are rewritten a second time, and one of them
 * came back with a silently wrong count.
 */
describe('compiling a semantic statement', () => {
  const SURFACE = {
    version: '0.1',
    models: [{ id: 1, name: 'sales', publishedSchema: 'SEMANTIC_SALES', published: true }],
    fields: [
      { modelId: 1, fieldId: 1, object: 'SALES', column: 'TOTAL_REVENUE', kind: 'metric' as const },
    ],
    metrics: [],
    invalidPairs: [],
  };
  const PHYSICAL = 'SELECT SUM(x) AS "total_revenue" FROM "MART"."ORDER_LINES"';

  const connection = (opened: string[], compiled: readonly (readonly unknown[])[]) =>
    ({
      id: 'connection:1',
      open: async (): Promise<void> => undefined,
      close: async (): Promise<void> => undefined,
      semanticSurface: async () => SURFACE,
      wrapperCompilers: async () => [],
      wrapperSurface: async () => new Map(),
      // The real reader over fabricated columns, so the nine-column contract is
      // exercised here rather than mocked past.
      compileSemantic: async (statement: string) => {
        opened.push(`compile | ${statement}`);
        return compileSemanticSql(async () => compiled as never, statement);
      },
      openResultSet: async (sqlText: string, preprocessor?: string | null) => {
        opened.push(`${preprocessor ?? 'none'} | ${sqlText}`);
        return {
          handle: null,
          columns: [
            { name: 'total_revenue', dataType: { type: 'DECIMAL', precision: 18, scale: 2 } },
          ],
          numRows: 0,
          numRowsInMessage: 0,
          inlineData: [[]],
        };
      },
    }) as never;

  const compileAnswer = (
    status: string,
    sql: string | null,
    extra: { message?: string; clarification?: string; plan?: string } = {},
  ) => [
    [status],
    [null],
    [extra.message ?? null],
    ['original'],
    [sql],
    [extra.plan ?? null],
    [extra.clarification ?? null],
    [1],
    [null],
  ];

  const started = async (compiled: readonly (readonly unknown[])[]) => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const opened: string[] = [];
    const pair = createInProcessEndpointPair();
    // The real `#prepareSource`, which is the only place the decision is made.
    new DataWorker({ endpoint: pair.worker, createConnection: () => connection(opened, compiled) });
    const client = new DataWorkerClient(pair.main);
    await client.connect('wss://x', { kind: 'token', token: 't' });
    return { client, opened };
  };

  it('runs the compiled SQL rather than the statement it was given', async () => {
    const plan = JSON.stringify({
      model: 'sales',
      relationship_paths: ['order_line_to_order'],
      selected_materialization: { physical_schema: 'MART', physical_object: 'ROLLUP' },
    });
    const { client, opened } = await started(compileAnswer('OK', PHYSICAL, { plan }));
    const result = await client.openTable({
      tableId: TABLE_ID,
      schema: 'SEMANTIC_SALES',
      table: 'SALES',
    });
    expect(opened[0]).toBe('compile | SELECT * FROM "SEMANTIC_SALES"."SALES"');
    // What actually ran is the physical SQL, so everything derived from the
    // statement — summaries, histograms, an export — is derived from that too.
    expect(opened[1]).toBe(`none | ${PHYSICAL}`);
    expect(result.compiled).toEqual({
      sql: PHYSICAL,
      provenance: 'sales · via order_line_to_order · from MART.ROLLUP',
    });
  });

  /**
   * The bug this test exists for: the decision used to be made from a *peek* at
   * whatever surface somebody else had already read, so a statement compiled only
   * if the main thread had asked for the semantic surface earlier in the session.
   * It does ask, on connect — but a rule that holds only when two unrelated
   * pieces of code run in the right order is not a rule, and this is the shape of
   * getting it wrong: the box shows the guard's error instead of its rows.
   *
   * Nothing here asks for the surface. The worker reads it itself or the
   * statement is not compiled at all.
   */
  it('compiles without anyone having asked for the surface first', async () => {
    const { client, opened } = await started(compileAnswer('OK', PHYSICAL));
    await client.openTable({ tableId: TABLE_ID, schema: 'SEMANTIC_SALES', table: 'SALES' });
    expect(opened[1]).toBe(`none | ${PHYSICAL}`);
  });

  it('compiles once, and reopens on what it already had', async () => {
    const { client, opened } = await started(compileAnswer('OK', PHYSICAL));
    await client.openTable({ tableId: TABLE_ID, schema: 'SEMANTIC_SALES', table: 'SALES' });
    await client.reopenTable(TABLE_ID);
    expect(opened.filter((entry) => entry.startsWith('compile'))).toHaveLength(1);
  });

  it('leaves an ordinary statement alone', async () => {
    const { client, opened } = await started(compileAnswer('OK', PHYSICAL));
    await client.openTable({ tableId: TABLE_ID, schema: 'MART', table: 'ORDER_LINES' });
    expect(opened).toEqual(['none | SELECT * FROM "MART"."ORDER_LINES"']);
  });

  /** A refusal is the answer, so it reaches the box as the layer's own words. */
  it('shows what the layer said when it would not compile', async () => {
    const { client } = await started(
      compileAnswer('NEEDS_CLARIFICATION', null, {
        message: 'Unknown semantic field: product_category.',
        clarification: JSON.stringify({ clarification_question: 'Query that view instead.' }),
      }),
    );
    await expect(
      client.openTable({ tableId: TABLE_ID, schema: 'SEMANTIC_SALES', table: 'SALES' }),
    ).rejects.toThrow('Unknown semantic field: product_category. Query that view instead.');
  });

  it('says something even when the layer said nothing', async () => {
    const { client } = await started(compileAnswer('ERROR', null));
    await expect(
      client.openTable({ tableId: TABLE_ID, schema: 'SEMANTIC_SALES', table: 'SALES' }),
    ).rejects.toThrow('would not compile');
  });
});

/**
 * The statements the worker builds for a live source.
 *
 * These used to be asserted against the web application's own source factory,
 * which built its `ExasolTableDataSource` itself. That is exactly how a published
 * semantic object came to be read as written: a factory that answers every
 * request takes the worker's two decisions away from it — the JSON wrapper
 * preprocessor, and the semantic compile — and neither is visible in the source
 * it returns. The host may now only serve what nothing else can, and these are
 * asserted where they are made.
 */
describe('the statement a live source is opened with', () => {
  const openedBy = async (
    request: { schema: string; table: string; filter?: RowFilter; sql?: string },
    createSource?: () => undefined,
  ): Promise<string | undefined> => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const statements: string[] = [];
    const pair = createInProcessEndpointPair();
    new DataWorker({
      endpoint: pair.worker,
      ...(createSource === undefined ? {} : { createSource }),
      createConnection: () =>
        ({
          id: 'connection:1',
          open: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
          semanticSurface: async () => null,
          wrapperCompilers: async () => [],
          wrapperSurface: async () => new Map(),
          openResultSet: async (sqlText: string) => {
            statements.push(sqlText);
            return {
              handle: null,
              columns: [{ name: 'A', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } }],
              numRows: 0,
              numRowsInMessage: 0,
              inlineData: [[]],
            };
          },
        }) as never,
    });
    const client = new DataWorkerClient(pair.main);
    await client.connect('wss://x', { kind: 'token', token: 't' });
    await client.openTable({ tableId: TABLE_ID, ...request });
    return statements.at(-1);
  };

  it('selects a whole stored relation when nothing narrows it', async () => {
    await expect(openedBy({ schema: 'SALES', table: 'ORDERS' })).resolves.toBe(
      'SELECT * FROM "SALES"."ORDERS"',
    );
  });

  /**
   * The bug this exists for: the filter reached the worker and stopped there, so
   * following a key against a real database opened the whole table.
   */
  it('carries a foreign key filter into the statement it sends', async () => {
    await expect(
      openedBy({
        schema: 'SALES',
        table: 'COUNTRIES',
        filter: {
          column: 'NAME',
          values: ['Denmark'],
          type: dataType('varchar', 'VARCHAR(64)', { size: 64 }),
        },
      }),
    ).resolves.toBe(`SELECT * FROM "SALES"."COUNTRIES" WHERE "NAME" = 'Denmark'`);
  });

  it('runs a statement as given, and never alongside a filter', async () => {
    await expect(
      openedBy({
        schema: 'QUERY',
        table: 'label',
        sql: 'SELECT 1 FROM DUAL',
        filter: { column: 'C', values: [null] },
      }),
    ).resolves.toBe('SELECT 1 FROM DUAL');
  });

  /** A host factory that declines leaves the source — and both decisions — here. */
  it('builds the source itself when the host declines', async () => {
    await expect(openedBy({ schema: 'SALES', table: 'ORDERS' }, () => undefined)).resolves.toBe(
      'SELECT * FROM "SALES"."ORDERS"',
    );
  });
});

/**
 * Compiling a JSON-tables statement rather than setting its preprocessor.
 *
 * Where `exasol-json-tables` has installed `COMPILE_SQL`, the compiler is the
 * better path: no session state, and — installed for every package — a statement
 * may span two of them, which one session preprocessor cannot express. Where it
 * is *not* installed the per-statement preprocessor still does the work, and
 * that path must not be disturbed to reach the tidier one.
 */
describe('compiling a JSON tables statement', () => {
  const COMPILER = {
    schema: 'JVS_COMPILE',
    script: 'COMPILE_SQL',
    serves: ['JSON_VIEW', 'EJT_ORDERS_VIEW'],
  };
  const PHYSICAL = 'SELECT "a|n" FROM "JSON_VIEW_INTERNAL"."T"';

  const started = async (
    compilers: readonly (typeof COMPILER)[],
    compiled: (statement: string) => { status: 'ok' | 'error'; sql?: string; message?: string },
  ) => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const opened: string[] = [];
    const pair = createInProcessEndpointPair();
    new DataWorker({
      endpoint: pair.worker,
      createConnection: () =>
        ({
          id: 'connection:1',
          open: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
          semanticSurface: async () => null,
          wrapperCompilers: async () => compilers,
          wrapperSurface: async () =>
            new Map([
              [
                'SRC.t',
                {
                  sourceSchema: 'SRC',
                  rootTable: 't',
                  schema: 'JSON_VIEW',
                  view: 't',
                  helperSchema: 'H',
                  preprocessor: '"PP"."P"',
                },
              ],
            ]),
          compileWrapper: async (_compiler: unknown, statement: string) => {
            opened.push(`compile | ${statement}`);
            return { packages: ['JSON_VIEW'], rewritten: true, ...compiled(statement) };
          },
          openResultSet: async (sqlText: string, preprocessor?: string | null) => {
            opened.push(`${preprocessor ?? 'none'} | ${sqlText}`);
            return {
              handle: null,
              columns: [{ name: 'A', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } }],
              numRows: 0,
              numRowsInMessage: 0,
              inlineData: [[]],
            };
          },
        }) as never,
    });
    const client = new DataWorkerClient(pair.main);
    await client.connect('wss://x', { kind: 'token', token: 't' });
    return { client, opened };
  };

  it('compiles instead of setting a preprocessor', async () => {
    const { client, opened } = await started([COMPILER], () => ({
      status: 'ok',
      sql: PHYSICAL,
    }));
    const result = await client.openTable({
      tableId: TABLE_ID,
      schema: 'Q',
      table: 'q',
      sql: 'SELECT "a.b" FROM "JSON_VIEW"."T"',
    });
    expect(opened[0]).toBe('compile | SELECT "a.b" FROM "JSON_VIEW"."T"');
    // No preprocessor: the compiled SQL is already physical, and pointing a
    // rewriter at a rewriter's output is asking for trouble it need not have.
    expect(opened[1]).toBe(`none | ${PHYSICAL}`);
    expect(result.compiled?.provenance).toContain('exasol-json-tables');
  });

  /** No compiler installed is the ordinary case, and it must be untouched. */
  it('falls back to the preprocessor where nothing serves the statement', async () => {
    const { client, opened } = await started([], () => ({ status: 'ok', sql: PHYSICAL }));
    await client.openTable({
      tableId: TABLE_ID,
      schema: 'Q',
      table: 'q',
      sql: 'SELECT "a.b" FROM "JSON_VIEW"."T"',
    });
    expect(opened).toEqual(['"PP"."P" | SELECT "a.b" FROM "JSON_VIEW"."T"']);
  });

  it('leaves a statement no compiler serves to the preprocessor', async () => {
    const { client, opened } = await started([{ ...COMPILER, serves: ['SOMETHING_ELSE'] }], () => ({
      status: 'ok',
      sql: PHYSICAL,
    }));
    await client.openTable({
      tableId: TABLE_ID,
      schema: 'Q',
      table: 'q',
      sql: 'SELECT "a.b" FROM "JSON_VIEW"."T"',
    });
    expect(opened).toEqual(['"PP"."P" | SELECT "a.b" FROM "JSON_VIEW"."T"']);
  });

  /**
   * A statement with no sugar in it compiles to itself. It is still reported as
   * compiled, because the consequence is the one that matters: a compiler has
   * looked at it, and there is nothing for a session preprocessor to do.
   */
  it('runs the original where there was nothing to rewrite', async () => {
    const { DataWorker, DataWorkerClient, createInProcessEndpointPair } =
      await import('@panorama/worker');
    const opened: string[] = [];
    const pair = createInProcessEndpointPair();
    new DataWorker({
      endpoint: pair.worker,
      createConnection: () =>
        ({
          id: 'connection:1',
          open: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
          semanticSurface: async () => null,
          wrapperCompilers: async () => [COMPILER],
          wrapperSurface: async () => new Map(),
          compileWrapper: async () => ({
            status: 'ok',
            sql: 'ignored',
            rewritten: false,
            packages: [],
          }),
          openResultSet: async (sqlText: string, preprocessor?: string | null) => {
            opened.push(`${preprocessor ?? 'none'} | ${sqlText}`);
            return {
              handle: null,
              columns: [{ name: 'A', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } }],
              numRows: 0,
              numRowsInMessage: 0,
              inlineData: [[]],
            };
          },
        }) as never,
    });
    const client = new DataWorkerClient(pair.main);
    await client.connect('wss://x', { kind: 'token', token: 't' });
    const result = await client.openTable({
      tableId: TABLE_ID,
      schema: 'Q',
      table: 'q',
      sql: 'SELECT "plain" FROM "JSON_VIEW"."T"',
    });
    expect(opened).toEqual(['none | SELECT "plain" FROM "JSON_VIEW"."T"']);
    // Nothing was rewritten, so there is no package to name.
    expect(result.compiled).toEqual({ sql: 'SELECT "plain" FROM "JSON_VIEW"."T"' });
  });

  it('shows what the compiler said when it would not compile', async () => {
    const { client } = await started([COMPILER], () => ({
      status: 'error',
      message: '"no.such.path": Field "no" is not visible on the current row source.',
    }));

    await expect(
      client.openTable({
        tableId: TABLE_ID,
        schema: 'Q',
        table: 'q',
        sql: 'SELECT "no.such.path" FROM "JSON_VIEW"."T"',
      }),
    ).rejects.toThrow('no.such.path');
  });

  it('says something even when the compiler said nothing', async () => {
    const { client } = await started([COMPILER], () => ({ status: 'error' }));
    await expect(
      client.openTable({
        tableId: TABLE_ID,
        schema: 'Q',
        table: 'q',
        sql: 'SELECT "a.b" FROM "JSON_VIEW"."T"',
      }),
    ).rejects.toThrow('would not compile');
  });

  /** An `OK` with no SQL behind it is not something to run on a guess. */
  it('refuses an OK that carried no statement', async () => {
    const { client } = await started([COMPILER], () => ({ status: 'ok' }));
    await expect(
      client.openTable({
        tableId: TABLE_ID,
        schema: 'Q',
        table: 'q',
        sql: 'SELECT "a.b" FROM "JSON_VIEW"."T"',
      }),
    ).rejects.toThrow('would not compile');
  });
});
