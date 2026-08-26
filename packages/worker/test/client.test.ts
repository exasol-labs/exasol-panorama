import { describe, expect, it, vi } from 'vitest';
import type { WorkerEndpoint, WorkerToMainMessage } from '@panorama/worker';
import { DataWorkerClient, deserializeError } from '@panorama/worker';
import type { EntityId } from '@panorama/core';

const TABLE = 'table:x' as EntityId;

const fakeEndpoint = (): {
  endpoint: WorkerEndpoint;
  sent: unknown[];
  deliver: (message: WorkerToMainMessage) => void;
  listenerCount: () => number;
} => {
  const listeners = new Set<(event: { data: unknown }) => void>();
  const sent: unknown[] = [];
  return {
    sent,
    listenerCount: (): number => listeners.size,
    deliver: (message): void => {
      for (const listener of [...listeners]) listener({ data: message });
    },
    endpoint: {
      postMessage: (message): void => {
        sent.push(message);
      },
      addEventListener: (_type, listener): void => {
        listeners.add(listener);
      },
      removeEventListener: (_type, listener): void => {
        listeners.delete(listener);
      },
    },
  };
};

describe('DataWorkerClient', () => {
  it('correlates responses by request id', async () => {
    const { endpoint, sent, deliver } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);

    const schemas = client.listSchemas();
    const tables = client.listTables('SALES');
    expect(sent).toHaveLength(2);

    deliver({ type: 'result', requestId: 2, ok: true, value: ['tables'] });
    deliver({ type: 'result', requestId: 1, ok: true, value: ['schemas'] });

    await expect(tables).resolves.toEqual(['tables']);
    await expect(schemas).resolves.toEqual(['schemas']);
  });

  it('rejects with a reconstructed TableDataError', async () => {
    const { endpoint, deliver } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    const pending = client.describeTable('S', 'T');
    deliver({
      type: 'result',
      requestId: 1,
      ok: false,
      error: { code: 'permission-denied', message: 'nope' },
    });
    await expect(pending).rejects.toMatchObject({ code: 'permission-denied', message: 'nope' });
  });

  it('falls back to a protocol error when none was supplied', async () => {
    const { endpoint, deliver } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    const pending = client.connect('wss://x', { kind: 'token', token: 't' });
    deliver({ type: 'result', requestId: 1, ok: false });
    await expect(pending).rejects.toMatchObject({ code: 'protocol-error' });
  });

  it('ignores results for unknown request ids', () => {
    const { endpoint, deliver } = fakeEndpoint();
    new DataWorkerClient(endpoint);
    expect(() => deliver({ type: 'result', requestId: 99, ok: true, value: null })).not.toThrow();
  });

  it('fans out row, failure and status events', () => {
    const { endpoint, deliver } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    const rows = vi.fn();
    const failures = vi.fn();
    const statuses = vi.fn();
    const offRows = client.onRows(rows);
    client.onBlockFailed(failures);
    client.onConnectionStatus(statuses);

    const chunk = { startRow: 0, rowCount: 0, columns: [], byteSize: 0 };
    deliver({ type: 'rowsAvailable', tableId: TABLE, generation: 0, blockIndex: 3, chunk });
    deliver({
      type: 'blockFailed',
      tableId: TABLE,
      generation: 0,
      blockIndex: 3,
      error: { code: 'fetch-failed', message: 'x' },
    });
    deliver({ type: 'connectionStatus', status: 'connected' });
    deliver({
      type: 'connectionStatus',
      status: 'failed',
      error: { code: 'connection-lost', message: 'dropped' },
    });

    expect(rows).toHaveBeenCalledWith({ tableId: TABLE, generation: 0, blockIndex: 3, chunk });
    expect(failures).toHaveBeenCalledTimes(1);
    expect(statuses).toHaveBeenCalledTimes(2);
    expect(statuses).toHaveBeenLastCalledWith({
      status: 'failed',
      error: { code: 'connection-lost', message: 'dropped' },
    });

    offRows();
    deliver({ type: 'rowsAvailable', tableId: TABLE, generation: 0, blockIndex: 4, chunk });
    expect(rows).toHaveBeenCalledTimes(1);
  });

  it('supports unsubscribing from failures and status', () => {
    const { endpoint, deliver } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    const failures = vi.fn();
    const statuses = vi.fn();
    client.onBlockFailed(failures)();
    client.onConnectionStatus(statuses)();

    deliver({
      type: 'blockFailed',
      tableId: TABLE,
      generation: 0,
      blockIndex: 0,
      error: { code: 'fetch-failed', message: 'x' },
    });
    deliver({ type: 'connectionStatus', status: 'connected' });
    expect(failures).not.toHaveBeenCalled();
    expect(statuses).not.toHaveBeenCalled();
  });

  it('sends block requests as fire-and-forget messages', () => {
    const { endpoint, sent } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    client.requestBlocks(TABLE, 2, 256, [{ index: 1, priority: 0 }]);
    expect(sent).toEqual([
      {
        type: 'requestBlocks',
        tableId: TABLE,
        generation: 2,
        blockSize: 256,
        blocks: [{ index: 1, priority: 0 }],
      },
    ]);
  });

  it('builds every request message', () => {
    const { endpoint, sent } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    void client.connect('wss://x', { kind: 'token', token: 't' });
    void client.disconnect();
    void client.openTable({ tableId: TABLE, schema: 'S', table: 'T' });
    void client.reopenTable(TABLE);
    void client.closeTable(TABLE);
    expect((sent as Array<{ type: string }>).map((message) => message.type)).toEqual([
      'connect',
      'disconnect',
      'openTable',
      'reopenTable',
      'closeTable',
    ]);
  });

  it('rejects pending work and stops listening once disposed', async () => {
    const { endpoint, listenerCount, sent } = fakeEndpoint();
    const client = new DataWorkerClient(endpoint);
    const pending = client.listSchemas();
    client.dispose();

    await expect(pending).rejects.toMatchObject({ code: 'session-closed' });
    expect(listenerCount()).toBe(0);
    await expect(client.listSchemas()).rejects.toMatchObject({ code: 'session-closed' });
    client.requestBlocks(TABLE, 0, 256, []);
    expect(sent).toHaveLength(1);
  });
});

describe('deserializeError', () => {
  it('rebuilds a typed error', () => {
    const error = deserializeError({ code: 'result-set-expired', message: 'gone' });
    expect(error.code).toBe('result-set-expired');
    expect(error.message).toBe('gone');
  });
});
