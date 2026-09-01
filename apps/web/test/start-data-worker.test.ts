import { describe, expect, it, vi } from 'vitest';
import { dataType } from '@panorama/core';
import type { RowFilter } from '@panorama/table';
import type { ExasolConnection, ExasolResultSetHandle } from '@panorama/exasol';
import { DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import { createTableSource, startDataWorker } from '../src/panorama/start-data-worker.js';
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

const FILTER: RowFilter = {
  column: 'NAME',
  values: ['Denmark'],
  type: dataType('varchar', 'VARCHAR(64)', { size: 64 }),
};

/**
 * What the page can serve, and — as much — what it must not.
 *
 * The statements a live source sends used to be asserted here, because this
 * function used to build them. It no longer does: everything but a demo relation
 * is the worker's to build, and it has to be, or a live source is created without
 * the JSON wrapper preprocessor its statement needs and without the semantic
 * compile a published object cannot be read without. Those statements are
 * asserted in `packages/worker/test/data-worker.test.ts`, where they are now made.
 */
describe('createTableSource', () => {
  it('serves a demo relation locally, filter and all', async () => {
    const source = createTableSource(
      { schema: DEMO_SCHEMA, table: 'COUNTRIES', filter: FILTER },
      { demoLatencyMs: 0 },
    );
    const session = await source?.open();
    // Filtered to the one country, without a database to ask.
    expect(session?.rowCount).toBe(1);
    await source?.close();
  });

  it('serves a whole demo relation when nothing narrows it', async () => {
    const source = createTableSource(
      { schema: DEMO_SCHEMA, table: 'COUNTRIES' },
      {
        demoLatencyMs: 0,
      },
    );
    const session = await source?.open();
    expect(session?.rowCount).toBe(5);
    await source?.close();
  });

  it('declines everything it is not the only one who can serve', () => {
    expect(createTableSource({ schema: 'SALES', table: 'ORDERS' })).toBeUndefined();
    expect(
      createTableSource({ schema: 'SALES', table: 'COUNTRIES', filter: FILTER }),
    ).toBeUndefined();
    expect(createTableSource({ schema: 'QUERY', table: 'q', sql: 'SELECT 1' })).toBeUndefined();
    // A demo relation that does not exist is not a demo relation.
    expect(createTableSource({ schema: DEMO_SCHEMA, table: 'NOT_A_TABLE' })).toBeUndefined();
  });
});

/**
 * The socket the real factory opens.
 *
 * Here rather than in the harness for the reason at the top of this file: the
 * harness supplies its own connection factory, so the one the application
 * installs — the only one that knows about the desktop shell's socket — would
 * never run. A browser opens the database's own URL; the application opens the
 * shell's, carrying the database as a parameter.
 */
describe('the socket the application opens', () => {
  const recording = (opened: string[]): new (url: string) => unknown =>
    class {
      readyState = 0;
      onopen: unknown = null;
      onmessage: unknown = null;
      onerror: unknown = null;
      onclose: unknown = null;
      constructor(url: string) {
        opened.push(url);
      }
      send(): void {}
      close(): void {}
    };

  const socketFor = async (via?: string): Promise<string | undefined> => {
    const opened: string[] = [];
    vi.stubGlobal('WebSocket', recording(opened));
    const pair = createInProcessEndpointPair();
    startDataWorker(pair.worker);
    const client = new DataWorkerClient(pair.main);
    try {
      // Never resolves: the stub socket never opens, and what is being asserted
      // is which address was dialled, not what came back.
      void client
        .connect('wss://localhost:8563', { kind: 'token', token: 't' }, via)
        .catch(() => undefined);
      await vi.waitFor(() => expect(opened.length).toBe(1));
      return opened[0];
    } finally {
      client.dispose();
      vi.unstubAllGlobals();
    }
  };

  it('is the database itself in a browser', async () => {
    expect(await socketFor()).toBe('wss://localhost:8563');
  });

  it('is the shell’s socket, carrying the database, in the application', async () => {
    expect(await socketFor('ws://127.0.0.1:7356/database?token=abc')).toBe(
      'ws://127.0.0.1:7356/database?token=abc&target=wss%3A%2F%2Flocalhost%3A8563',
    );
  });
});
