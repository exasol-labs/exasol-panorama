import type { EntityId } from '@panorama/core';
import type { DesiredBlock, TableDataSource } from '@panorama/table';
import type {
  BlockFailure,
  ConnectionFactoryOptions,
  OpenTableResult,
  RowsAvailable,
  TableDataGateway,
  TableSourceRequest,
} from '@panorama/worker';
import { DataWorker, DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import type { ExasolConnection } from '@panorama/exasol';
import type { MockTableDataSourceOptions } from '@panorama/test-support';
import { ManualScheduler, MockTableDataSource, factRelation } from '@panorama/test-support';

export const TABLE_ID = 'table:test' as EntityId;

export interface WorkerHarness {
  readonly client: DataWorkerClient;
  readonly worker: DataWorker;
  readonly sources: Map<string, MockTableDataSource>;
  readonly scheduler: ManualScheduler;
  /** Runs every scheduled fetch and lets the message queue drain. */
  settle(): Promise<void>;
  /** Runs scheduled work, on real event-loop turns, until `promise` settles. */
  drive<TValue>(promise: Promise<TValue>): Promise<TValue>;
  /** Runs a bounded number of real turns, leaving work part-finished. */
  pump(rounds: number): Promise<void>;
}

export interface HarnessOptions {
  readonly source?: Partial<MockTableDataSourceOptions>;
  /** Replaces the mock entirely, for a source with different capabilities. */
  readonly createSource?: (request: TableSourceRequest) => TableDataSource;
  readonly maxConcurrentFetches?: number;
  readonly createConnection?: (options: ConnectionFactoryOptions) => ExasolConnection;
}

export const createWorkerHarness = (options: HarnessOptions = {}): WorkerHarness => {
  const pair = createInProcessEndpointPair();
  const scheduler = new ManualScheduler();
  const sources = new Map<string, MockTableDataSource>();

  const worker = new DataWorker({
    endpoint: pair.worker,
    ...(options.maxConcurrentFetches === undefined
      ? {}
      : { maxConcurrentFetches: options.maxConcurrentFetches }),
    ...(options.createConnection === undefined
      ? {}
      : { createConnection: options.createConnection }),
    createSource: (request: TableSourceRequest): TableDataSource => {
      const replacement = options.createSource?.(request);
      if (replacement !== undefined) return replacement;
      const source = new MockTableDataSource({
        relation: factRelation(10_000),
        scheduler: scheduler.schedule,
        ...options.source,
      });
      sources.set(`${request.schema}.${request.table}`, source);
      return source;
    },
  });

  const client = new DataWorkerClient(pair.main);

  const settle = async (): Promise<void> => {
    for (let round = 0; round < 40; round += 1) {
      scheduler.runAll();
      await Promise.resolve();
      await Promise.resolve();
    }
  };

  return { client, worker, sources, scheduler, settle, drive, pump };

  /**
   * Runs scheduled work until a promise settles, yielding to *real* turns of
   * the event loop rather than only to microtasks.
   *
   * `settle` is microtasks only, which is all a fetch needs. An export needs
   * more: it deflates through the platform's own `CompressionStream`, whose
   * output arrives on a task rather than a microtask, so a loop that never
   * yields to the event loop parks the export forever.
   */
  async function drive<TValue>(promise: Promise<TValue>): Promise<TValue> {
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
  }

  /** Runs a bounded number of turns, to stop something part-way through. */
  async function pump(rounds: number): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      scheduler.runAll();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
    }
  }
};

export interface StubGateway extends TableDataGateway {
  emitRows(event: RowsAvailable): void;
  emitFailure(event: BlockFailure): void;
  readonly requests: Array<{
    tableId: EntityId;
    generation: number;
    blocks: readonly DesiredBlock[];
  }>;
}

/** A gateway that never fetches; used to test how events are filtered. */
export const stubGateway = (rowCount: number | null = 10_000): StubGateway => {
  const rowListeners = new Set<(event: RowsAvailable) => void>();
  const failureListeners = new Set<(event: BlockFailure) => void>();
  const requests: Array<{
    tableId: EntityId;
    generation: number;
    blocks: readonly DesiredBlock[];
  }> = [];
  return {
    requests,
    openTable: async (): Promise<OpenTableResult> => ({
      schema: { schema: 'PANORAMA_TEST', table: 'SALES', columns: [] },
      rowCount,
      generation: 0,
    }),
    reopenTable: async (): Promise<OpenTableResult> => ({
      schema: { schema: 'PANORAMA_TEST', table: 'SALES', columns: [] },
      rowCount,
      generation: 1,
    }),
    closeTable: async (): Promise<void> => undefined,
    requestBlocks: (tableId, generation, _blockSize, blocks): void => {
      requests.push({ tableId, generation, blocks });
    },
    onRows: (listener): (() => void) => {
      rowListeners.add(listener);
      return (): void => {
        rowListeners.delete(listener);
      };
    },
    onBlockFailed: (listener): (() => void) => {
      failureListeners.add(listener);
      return (): void => {
        failureListeners.delete(listener);
      };
    },
    emitRows: (event): void => {
      for (const listener of [...rowListeners]) listener(event);
    },
    emitFailure: (event): void => {
      for (const listener of [...failureListeners]) listener(event);
    },
  };
};
