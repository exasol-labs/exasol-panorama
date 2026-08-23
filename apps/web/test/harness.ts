import type { EntityId } from '@panorama/core';
import type { TableDataSource, TableSchema } from '@panorama/table';
import { dataType } from '@panorama/core';
import type { ConnectionFactoryOptions, TableSourceRequest } from '@panorama/worker';
import { DataWorker, DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import type { ExasolConnection } from '@panorama/exasol';
import { ManualScheduler, MockTableDataSource, factRelation } from '@panorama/test-support';
import { Workspace } from '../src/panorama/workspace.js';
import { DEMO_SCHEMA, demoRelation, demoSchema } from '../src/panorama/demo.js';

export interface AppHarness {
  readonly workspace: Workspace;
  readonly client: DataWorkerClient;
  readonly scheduler: ManualScheduler;
  readonly connections: ConnectionFactoryOptions[];
  settle(): Promise<void>;
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
  readonly latencyMs?: number;
  readonly failOpen?: boolean;
  readonly failDescribe?: boolean;
  /** Simulates a source that cannot report how many rows it has. */
  readonly hideRowCount?: boolean;
}

export const createAppHarness = (options: HarnessOptions = {}): AppHarness => {
  const pair = createInProcessEndpointPair();
  const scheduler = new ManualScheduler();
  const connections: ConnectionFactoryOptions[] = [];

  new DataWorker({
    endpoint: pair.worker,
    createConnection: (connection): ExasolConnection => {
      connections.push(connection);
      return {
        id: 'connection:test',
        open: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
        listSchemas: async () => [{ name: 'PANORAMA_TEST' }],
        listTables: async () => [
          { schema: 'PANORAMA_TEST', name: 'SALES', kind: 'TABLE' },
          { schema: 'PANORAMA_TEST', name: 'SALES_V', kind: 'VIEW' },
        ],
        describeTable: async (): Promise<TableSchema> => {
          if (options.failDescribe === true) throw new Error('object not found');
          return TEST_SCHEMA;
        },
      } as unknown as ExasolConnection;
    },
    createSource: (request: TableSourceRequest): TableDataSource => {
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
        ...(options.failOpen === true ? { failOpen: 'permission-denied' as const } : {}),
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
  });

  return {
    workspace,
    client,
    scheduler,
    connections,
    settle: async (): Promise<void> => {
      for (let round = 0; round < 30; round += 1) {
        scheduler.runAll();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
  };
};

export const firstTableId = (harness: AppHarness): EntityId => {
  const id = harness.workspace.core.world.order[0];
  if (id === undefined) throw new Error('no table is open');
  return id;
};
