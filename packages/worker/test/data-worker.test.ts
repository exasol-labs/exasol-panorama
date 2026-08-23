import { describe, expect, it, vi } from 'vitest';
import type { RowsAvailable } from '@panorama/worker';
import { serializeError } from '@panorama/worker';
import { TableDataError, cellValue } from '@panorama/table';
import { factRelation } from '@panorama/test-support';
import { TABLE_ID, createWorkerHarness } from './harness.js';

describe('DataWorker table lifecycle', () => {
  it('opens a table and reports its schema and row count', async () => {
    const harness = createWorkerHarness();
    const result = await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
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
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');

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
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');

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
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
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
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');

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

    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
    harness.client.requestBlocks(TABLE_ID, 7, 256, [{ index: 0, priority: 0 }]);
    await harness.settle();
    expect(rows).toEqual([]);
  });

  it('reopens a table with a new generation and drops in-flight work', async () => {
    const harness = createWorkerHarness({ source: { latency: 50 } });
    const rows: RowsAvailable[] = [];
    harness.client.onRows((event) => rows.push(event));
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');

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
      harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(harness.worker.openTableCount).toBe(0);
  });

  it('closes tables and releases their result sets', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
    await harness.client.closeTable(TABLE_ID);
    expect(harness.worker.openTableCount).toBe(0);
    // Closing an unknown table is a no-op.
    await expect(harness.client.closeTable(TABLE_ID)).resolves.toBeNull();
  });

  it('replaces an existing table when reopened by id', async () => {
    const harness = createWorkerHarness();
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
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
    await harness.client.openTable(TABLE_ID, 'PANORAMA_TEST', 'SALES');
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
    await expect(client.openTable(TABLE_ID, 'S', 'T')).rejects.toMatchObject({
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

    await client.openTable(TABLE_ID, 'S', 'T');
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

    await client.openTable(TABLE_ID, 'S', 'T');
    await expect(client.closeTable(TABLE_ID)).rejects.toMatchObject({ code: 'protocol-error' });
  });
});
