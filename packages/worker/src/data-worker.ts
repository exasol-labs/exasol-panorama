import type { EntityId } from '@panorama/core';
import type { ResultChunk, RowFilter, TableDataSession, TableDataSource } from '@panorama/table';
import {
  DEFAULT_BLOCK_SIZE,
  FetchScheduler,
  TableDataError,
  blockStartRow,
  chunkTransferables,
} from '@panorama/table';
import type { ExasolConnection, ExasolCredentials } from '@panorama/exasol';
import { ExasolTableDataSource } from '@panorama/exasol';
import type { WorkerEndpoint } from './endpoint.js';
import type {
  MainToWorkerMessage,
  OpenTableResult,
  SerializedError,
  WorkerToMainMessage,
} from './messages.js';

/**
 * The worker half.
 *
 * Owns the Exasol connection, protocol decoding, result-set lifecycle and
 * fetch scheduling. The render thread never waits on any of it: it asks for
 * blocks and carries on drawing.
 */

export interface TableSourceRequest {
  readonly tableId: EntityId;
  readonly schema: string;
  readonly table: string;
  readonly filter?: RowFilter;
}

export interface ConnectionFactoryOptions {
  readonly url: string;
  readonly credentials: ExasolCredentials;
  readonly onStatusChange: (status: string, error?: unknown) => void;
}

export interface DataWorkerOptions {
  readonly endpoint: WorkerEndpoint;
  /** Injected so tests can run the worker against a mock data source. */
  readonly createConnection?: (options: ConnectionFactoryOptions) => ExasolConnection;
  readonly createSource?: (
    request: TableSourceRequest,
    connection: ExasolConnection | null,
  ) => TableDataSource;
  readonly maxConcurrentFetches?: number;
}

export const serializeError = (error: unknown): SerializedError => {
  if (error instanceof TableDataError) return { code: error.code, message: error.message };
  if (error instanceof Error) return { code: 'protocol-error', message: error.message };
  return { code: 'protocol-error', message: String(error) };
};

interface OpenTable {
  readonly source: TableDataSource;
  session: TableDataSession;
  /** Assigned immediately after construction; the scheduler closes over the entry. */
  scheduler: FetchScheduler | null;
  blockSize: number;
  generation: number;
}

export class DataWorker {
  readonly #endpoint: WorkerEndpoint;
  readonly #options: DataWorkerOptions;
  readonly #tables = new Map<EntityId, OpenTable>();
  #connection: ExasolConnection | null = null;

  constructor(options: DataWorkerOptions) {
    this.#options = options;
    this.#endpoint = options.endpoint;
    this.#endpoint.addEventListener('message', (event) => {
      void this.handle(event.data as MainToWorkerMessage);
    });
  }

  #post(message: WorkerToMainMessage, transfer?: Transferable[]): void {
    this.#endpoint.postMessage(message, transfer);
  }

  #reply(requestId: number, value: unknown): void {
    this.#post({ type: 'result', requestId, ok: true, value });
  }

  #fail(requestId: number, error: unknown): void {
    this.#post({ type: 'result', requestId, ok: false, error: serializeError(error) });
  }

  async handle(message: MainToWorkerMessage): Promise<void> {
    switch (message.type) {
      case 'connect':
        return this.#connect(message.requestId, message.url, message.credentials);
      case 'disconnect':
        return this.#disconnect(message.requestId);
      case 'listSchemas':
        return this.#run(message.requestId, async () => this.#requireConnection().listSchemas());
      case 'listTables':
        return this.#run(message.requestId, async () =>
          this.#requireConnection().listTables(message.schema),
        );
      case 'describeTable':
        return this.#run(message.requestId, async () =>
          this.#requireConnection().describeTable(message.schema, message.table),
        );
      case 'openTable':
        return this.#openTable(message.requestId, message);
      case 'reopenTable':
        return this.#reopenTable(message.requestId, message.tableId);
      case 'closeTable':
        return this.#closeTable(message.requestId, message.tableId);
      case 'requestBlocks':
        this.#requestBlocks(message.tableId, message.generation, message.blockSize, message.blocks);
        return;
    }
  }

  async #run(requestId: number, action: () => Promise<unknown>): Promise<void> {
    try {
      this.#reply(requestId, await action());
    } catch (error) {
      this.#fail(requestId, error);
    }
  }

  #requireConnection(): ExasolConnection {
    if (this.#connection === null) {
      throw new TableDataError('connection-lost', 'Not connected to Exasol');
    }
    return this.#connection;
  }

  async #connect(requestId: number, url: string, credentials: ExasolCredentials): Promise<void> {
    const factory = this.#options.createConnection;
    if (factory === undefined) {
      this.#fail(requestId, new TableDataError('connection-failed', 'No connection factory'));
      return;
    }
    try {
      this.#connection = factory({
        url,
        credentials,
        onStatusChange: (status, error): void => {
          this.#post({
            type: 'connectionStatus',
            status: status as 'connected',
            ...(error === undefined ? {} : { error: serializeError(error) }),
          });
        },
      });
      await this.#connection.open();
      this.#reply(requestId, { connectionId: this.#connection.id });
    } catch (error) {
      this.#connection = null;
      this.#fail(requestId, error);
    }
  }

  async #disconnect(requestId: number): Promise<void> {
    for (const tableId of [...this.#tables.keys()]) await this.#teardown(tableId);
    const connection = this.#connection;
    this.#connection = null;
    try {
      if (connection !== null) await connection.close();
      this.#reply(requestId, null);
    } catch (error) {
      this.#fail(requestId, error);
    }
  }

  #createSource(request: TableSourceRequest): TableDataSource {
    const factory = this.#options.createSource;
    if (factory !== undefined) return factory(request, this.#connection);
    return new ExasolTableDataSource({
      connection: this.#requireConnection(),
      schema: request.schema,
      table: request.table,
      ...(request.filter === undefined ? {} : { filter: request.filter }),
    });
  }

  async #openTable(requestId: number, request: TableSourceRequest): Promise<void> {
    await this.#teardown(request.tableId);
    try {
      const source = this.#createSource(request);
      const session = await source.open();
      const entry: OpenTable = {
        source,
        session,
        blockSize: DEFAULT_BLOCK_SIZE,
        generation: 0,
        scheduler: null,
      };
      entry.scheduler = this.#createScheduler(request.tableId, entry);
      this.#tables.set(request.tableId, entry);
      const result: OpenTableResult = {
        schema: session.schema,
        rowCount: session.rowCount,
        generation: 0,
      };
      this.#reply(requestId, result);
    } catch (error) {
      this.#fail(requestId, error);
    }
  }

  /**
   * Opens a fresh result set for an existing table after a reconnect. The new
   * generation invalidates every response still in flight, because positions
   * in the new result set are not guaranteed to match the old ones.
   */
  async #reopenTable(requestId: number, tableId: EntityId): Promise<void> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) {
      this.#fail(requestId, new TableDataError('not-found', `Table ${tableId} is not open`));
      return;
    }
    try {
      entry.scheduler?.invalidate();
      entry.session = await entry.source.open();
      entry.generation += 1;
      const result: OpenTableResult = {
        schema: entry.session.schema,
        rowCount: entry.session.rowCount,
        generation: entry.generation,
      };
      this.#reply(requestId, result);
    } catch (error) {
      this.#fail(requestId, error);
    }
  }

  #createScheduler(tableId: EntityId, entry: OpenTable): FetchScheduler {
    return new FetchScheduler({
      ...(this.#options.maxConcurrentFetches === undefined
        ? {}
        : { maxConcurrent: this.#options.maxConcurrentFetches }),
      execute: async (blockIndex, signal): Promise<ResultChunk> =>
        entry.session.fetch(
          {
            startPosition: blockStartRow(blockIndex, entry.blockSize),
            maxRows: entry.blockSize,
          },
          signal,
        ),
      onLoaded: (blockIndex, chunk): void => {
        this.#post(
          {
            type: 'rowsAvailable',
            tableId,
            generation: entry.generation,
            blockIndex,
            chunk,
          },
          chunkTransferables(chunk),
        );
      },
      onFailed: (blockIndex, error): void => {
        this.#post({
          type: 'blockFailed',
          tableId,
          generation: entry.generation,
          blockIndex,
          error: serializeError(error),
        });
      },
    });
  }

  #requestBlocks(
    tableId: EntityId,
    generation: number,
    blockSize: number,
    blocks: readonly { index: number; priority: number }[],
  ): void {
    const entry = this.#tables.get(tableId);
    // Silently drop requests for closed tables and superseded result sets.
    if (entry === undefined || entry.generation !== generation) return;
    entry.blockSize = blockSize;
    entry.scheduler?.setDesired(blocks);
  }

  async #teardown(tableId: EntityId): Promise<void> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) return;
    this.#tables.delete(tableId);
    entry.scheduler?.dispose();
    await entry.source.close();
  }

  async #closeTable(requestId: number, tableId: EntityId): Promise<void> {
    try {
      await this.#teardown(tableId);
      this.#reply(requestId, null);
    } catch (error) {
      this.#fail(requestId, error);
    }
  }

  get openTableCount(): number {
    return this.#tables.size;
  }
}
