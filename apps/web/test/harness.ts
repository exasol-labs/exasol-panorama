import type { EntityId } from '@panorama/core';
import type { TableDataSource, TableSchema } from '@panorama/table';
import { dataType } from '@panorama/core';
import type { ConnectionFactoryOptions, TableSourceRequest } from '@panorama/worker';
import { DataWorker, DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import type { ExasolConnection } from '@panorama/exasol';
import { ManualScheduler, MockTableDataSource, factRelation } from '@panorama/test-support';
import type { WorkspaceOptions } from '../src/panorama/workspace.js';
import { Workspace } from '../src/panorama/workspace.js';
import { DEMO_SCHEMA, demoRelation, demoSchema } from '../src/panorama/demo.js';

export interface AppHarness {
  readonly workspace: Workspace;
  readonly client: DataWorkerClient;
  readonly scheduler: ManualScheduler;
  readonly connections: ConnectionFactoryOptions[];
  /** Every source request the worker made, so a test can assert on the SQL. */
  readonly sourceRequests: TableSourceRequest[];
  settle(): Promise<void>;
  /**
   * Runs scheduled work on real turns of the event loop until `promise`
   * settles. `settle` yields only to microtasks, which is all a fetch needs; an
   * export deflates through the platform's `CompressionStream`, whose output
   * arrives on a task.
   */
  drive<TValue>(promise: Promise<TValue>): Promise<TValue>;
  /** Runs a bounded number of real turns, leaving work part-finished. */
  pump(rounds: number): Promise<void>;
}

export const TEST_SCHEMA: TableSchema = {
  schema: 'PANORAMA_TEST',
  table: 'SALES',
  columns: [
    { name: 'ORDER_ID', type: dataType('decimal', 'DECIMAL(18,0)', { scale: 0 }) },
    { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
    { name: 'ORDER_DATE', type: dataType('date', 'DATE') },
    { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { scale: 2 }) },
  ],
};

export interface HarnessOptions {
  readonly rowCount?: number;
  /** Stands in for the browser's save dialog; see `save-file.ts`. */
  readonly openExportSink?: WorkspaceOptions['openExportSink'];
  readonly latencyMs?: number;
  readonly failOpen?: boolean;
  /** Lays charts out; omitted where a test only cares about the numbers. */
  readonly chartSurface?: WorkspaceOptions['chartSurface'];
  /** Turns an SVG into PNG bytes; the browser's job, so stubbed here. */
  readonly rasteriseSvg?: WorkspaceOptions['rasteriseSvg'];
  /** Fails only the statements this matches, for a step that stops working. */
  readonly failStatement?: (sql: string) => boolean;
  readonly failDescribe?: boolean;
  /** Simulates a source that cannot report how many rows it has. */
  readonly hideRowCount?: boolean;
  /** Shortens the wait for a window of rows, for the case where none arrive. */
  readonly rowWaitMs?: number;
  /**
   * A connection that does not say which database it reached.
   *
   * Allowed by the contract — the factory comes from outside, and a stub or an
   * embedder's own connection need not report a session — so it is a case worth
   * having, not only a branch worth covering.
   */
  readonly quietLogin?: boolean;
  /** Where database sockets should be opened; the desktop shell's, in an app. */
  readonly databaseSocket?: WorkspaceOptions['databaseSocket'];
}

export const createAppHarness = (options: HarnessOptions = {}): AppHarness => {
  const pair = createInProcessEndpointPair();
  const scheduler = new ManualScheduler();
  const connections: ConnectionFactoryOptions[] = [];
  const sourceRequests: TableSourceRequest[] = [];

  new DataWorker({
    endpoint: pair.worker,
    createConnection: (connection): ExasolConnection => {
      connections.push(connection);
      return {
        id: 'connection:test',
        // What the database says about itself at login, which is what anything
        // else claiming to reach the same one is checked against.
        ...(options.quietLogin === true
          ? {}
          : {
              sessionInfo: {
                sessionId: 4_242,
                databaseName: 'PANORAMA_TEST_DB',
                releaseVersion: '8.32.0',
                productName: 'EXASolution',
              },
            }),
        open: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
        listSchemas: async () => [{ name: 'PANORAMA_TEST' }],
        listTables: async () => [
          // A table's count comes from the catalogue; a view has none.
          { schema: 'PANORAMA_TEST', name: 'SALES', kind: 'TABLE', rowCount: 2_830_000_000 },
          { schema: 'PANORAMA_TEST', name: 'SALES_V', kind: 'VIEW' },
        ],
        describeTable: async (): Promise<TableSchema> => {
          if (options.failDescribe === true) throw new Error('object not found');
          return TEST_SCHEMA;
        },
      } as unknown as ExasolConnection;
    },
    createSource: (
      request: TableSourceRequest,
      connection: ExasolConnection | null,
    ): TableDataSource => {
      sourceRequests.push(request);
      // Mirrors the real factory: only a database can run a statement.
      if (request.sql !== undefined && connection === null) {
        throw new Error('Cannot run SQL without a database connection');
      }
      // Mirrors the real worker: the demo schema is served locally.
      const relation =
        request.schema === DEMO_SCHEMA
          ? demoRelation(request.table)
          : factRelation(options.rowCount ?? 100_000);
      if (relation === undefined) throw new Error(`No demo relation ${request.table}`);
      return new MockTableDataSource({
        relation,
        scheduler: scheduler.schedule,
        ...(options.latencyMs === undefined ? {} : { latency: options.latencyMs }),
        ...(options.failOpen === true ||
        (request.sql !== undefined && options.failStatement?.(request.sql) === true)
          ? { failOpen: 'permission-denied' as const }
          : {}),
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        ...(options.hideRowCount === true ? { reportRowCount: false as const } : {}),
      });
    },
  });

  const client = new DataWorkerClient(pair.main);
  const workspace = new Workspace({
    client,
    blockSize: 256,
    clock: () => scheduler.now,
    resolveSchema: (schema, table) => (schema === DEMO_SCHEMA ? demoSchema(table) : undefined),
    ...(options.openExportSink === undefined ? {} : { openExportSink: options.openExportSink }),
    ...(options.chartSurface === undefined ? {} : { chartSurface: options.chartSurface }),
    ...(options.rasteriseSvg === undefined ? {} : { rasteriseSvg: options.rasteriseSvg }),
    ...(options.rowWaitMs === undefined ? {} : { rowWaitMs: options.rowWaitMs }),
    ...(options.databaseSocket === undefined ? {} : { databaseSocket: options.databaseSocket }),
  });

  return {
    workspace,
    client,
    scheduler,
    connections,
    sourceRequests,
    settle: async (): Promise<void> => {
      for (let round = 0; round < 30; round += 1) {
        scheduler.runAll();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    drive: async <TValue>(promise: Promise<TValue>): Promise<TValue> => {
      let done = false;
      const tracked = promise.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      for (let round = 0; round < 5_000 && !done; round += 1) {
        scheduler.runAll();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      await tracked;
      return promise;
    },
    pump: async (rounds: number): Promise<void> => {
      for (let round = 0; round < rounds; round += 1) {
        scheduler.runAll();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    },
  };
};

export const firstTableId = (harness: AppHarness): EntityId => {
  const id = harness.workspace.core.world.order[0];
  if (id === undefined) throw new Error('no table is open');
  return id;
};
