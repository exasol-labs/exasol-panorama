import type { ChartSpec, EntityId } from '@panorama/core';
import { DEFAULT_CHART_ROWS } from '@panorama/core';
import { aggregateChart } from '@panorama/chart';
import type { ResultChunk, TableDataSession, TableDataSource } from '@panorama/table';
import {
  DEFAULT_BLOCK_SIZE,
  FetchScheduler,
  TableDataError,
  blockStartRow,
  chunkTransferables,
} from '@panorama/table';
import type { ExasolConnection, ExasolCredentials } from '@panorama/exasol';
import { ExasolTableDataSource } from '@panorama/exasol';
import type { ExportFormat, ExportResult } from '@panorama/export';
import { ExportError, bufferedSink, isExportError, runExport } from '@panorama/export';
import type { WorkerEndpoint } from './endpoint.js';
import { remoteSink } from './export-sink.js';
import type {
  ChartDataResult,
  MainToWorkerMessage,
  OpenTableRequest,
  OpenTableResult,
  SerializedError,
  WorkerToMainMessage,
} from './messages.js';

/** Rows per protocol fetch while gathering a chart. */
const CHART_FETCH_ROWS = 4_096;

/**
 * The worker half.
 *
 * Owns the Exasol connection, protocol decoding, result-set lifecycle and
 * fetch scheduling. The render thread never waits on any of it: it asks for
 * blocks and carries on drawing.
 */

export type TableSourceRequest = OpenTableRequest;

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
  // A cancelled export must still read as a cancellation on the other side: the
  // shell shows a stopped export differently from a failed one, and every other
  // code an export can raise is about the file rather than the connection.
  if (isExportError(error)) {
    return {
      code: error.code === 'aborted' ? 'aborted' : 'protocol-error',
      message: error.message,
    };
  }
  if (error instanceof Error) return { code: 'protocol-error', message: error.message };
  return { code: 'protocol-error', message: String(error) };
};

const cancelled = (): ExportError => new ExportError('aborted', 'Export cancelled');

interface OpenTable {
  readonly source: TableDataSource;
  /**
   * What the table was opened with. Kept so an export can open a *second*
   * result set for the same statement rather than sharing the cursor the
   * viewport is browsing.
   */
  readonly request: OpenTableRequest;
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
  readonly #exports = new Map<number, RunningExport>();
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
      case 'startExport':
        return this.#startExport(
          message.requestId,
          message.exportId,
          message.tableId,
          message.format,
        );
      case 'exportAck':
        this.#exports.get(message.exportId)?.acknowledge(message.sequence);
        return;
      case 'summariseColumn':
        return this.#summarise(message.requestId, message.tableId, message.column);
      case 'chartData':
        return this.#chartData(message.requestId, message.tableId, message.spec);
      case 'cancelExport':
        this.#exports.get(message.exportId)?.controller.abort();
        this.#reply(message.requestId, null);
        return;
    }
  }

  /**
   * Runs one export to completion.
   *
   * A second data source is opened for the table's own statement and closed
   * again afterwards, so an export never disturbs the result set the viewport is
   * scrolling — the two are independent readers of the same query.
   */
  async #startExport(
    requestId: number,
    exportId: number,
    tableId: EntityId,
    format: ExportFormat,
  ): Promise<void> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) {
      this.#fail(requestId, new TableDataError('not-found', `Table ${tableId} is not open`));
      return;
    }
    const running = new RunningExport(tableId);
    this.#exports.set(exportId, running);
    const source = this.#createSource(entry.request);
    try {
      const session = await source.open();
      const result: ExportResult = await runExport({
        format,
        session,
        // Buffered so that a Parquet page header and a spreadsheet row do not
        // each become their own message.
        sink: bufferedSink(
          remoteSink({
            exportId,
            post: (message, transfer): void => {
              this.#post(message, transfer);
            },
            waitForAck: (sequence): Promise<void> => running.awaitAck(sequence),
          }),
        ),
        signal: running.controller.signal,
        onProgress: (progress): void => {
          this.#post({
            type: 'exportProgress',
            exportId,
            rows: progress.rows,
            bytes: progress.bytes,
            totalRows: progress.totalRows,
          });
        },
      });
      this.#reply(requestId, result);
    } catch (error) {
      this.#fail(requestId, error);
    } finally {
      this.#exports.delete(exportId);
      // Settled rather than awaited: a result set that will not close is not a
      // reason to fail an export that has already finished writing its file.
      await Promise.allSettled([source.close()]);
    }
  }

  /**
   * Describes one column of an open table.
   *
   * The table's own session answers, so the summary describes the statement the
   * table is showing — a followed key or a written query included. A source with
   * nothing to say returns nothing rather than something derived from the blocks
   * that happen to be cached, which would describe the scroll position.
   */
  async #summarise(requestId: number, tableId: EntityId, column: string): Promise<void> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) {
      this.#fail(requestId, new TableDataError('not-found', `Table ${tableId} is not open`));
      return;
    }
    const summarise = entry.session.summarise?.bind(entry.session);
    await this.#run(requestId, async () => (summarise === undefined ? null : summarise(column)));
  }

  /**
   * Reads rows for a chart and reduces them where they already are.
   *
   * Bounded, and it says which rows it read. A chart is a picture of a shape, and
   * the shape of the first twenty thousand rows is usually the shape of the
   * whole — but "usually" is not "always", so the answer carries its own basis
   * and the chart says so on its face.
   */
  async #chartData(requestId: number, tableId: EntityId, spec: ChartSpec): Promise<void> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) {
      this.#fail(requestId, new TableDataError('not-found', `Table ${tableId} is not open`));
      return;
    }
    await this.#run(requestId, async (): Promise<ChartDataResult> => {
      const session = entry.session;
      const total = session.rowCount;
      const wanted = Math.max(1, spec.rowLimit ?? DEFAULT_CHART_ROWS);
      const target = total === null ? wanted : Math.min(wanted, total);
      const chunks: ResultChunk[] = [];
      let read = 0;
      while (read < target) {
        const chunk = await session.fetch({
          startPosition: read,
          maxRows: Math.min(CHART_FETCH_ROWS, target - read),
        });
        if (chunk.rowCount === 0) break;
        chunks.push(chunk);
        read += chunk.rowCount;
      }
      if (chunks.length === 0) return null;
      return aggregateChart({
        spec,
        columns: session.schema.columns.map((column) => column.name),
        chunks,
        totalRows: total,
      });
    });
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
      /**
       * Which database this is, as the database itself said at login.
       *
       * Reported because a session is not the only way to reach a database and
       * anything else that reaches one has to be able to tell whether it is the
       * same database — a name and a version from the server beat a URL somebody
       * typed.
       */
      // `?? null` because the factory comes from outside: a connection that does
      // not say which database it reached is a connection that does not say.
      const session = this.#connection.sessionInfo ?? null;
      this.#reply(requestId, {
        connectionId: this.#connection.id,
        ...(session === null
          ? {}
          : {
              database: session.databaseName,
              version: session.releaseVersion,
              sessionId: session.sessionId,
            }),
      });
    } catch (error) {
      this.#connection = null;
      this.#fail(requestId, error);
    }
  }

  /** Stops every export of a table, or all of them when no table is named. */
  #cancelExports(tableId?: EntityId): void {
    for (const running of this.#exports.values()) {
      if (tableId === undefined || running.tableId === tableId) running.controller.abort();
    }
  }

  async #disconnect(requestId: number): Promise<void> {
    this.#cancelExports();
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
      ...(request.sql === undefined ? {} : { sql: request.sql }),
    });
  }

  async #openTable(requestId: number, request: TableSourceRequest): Promise<void> {
    await this.#teardown(request.tableId);
    try {
      const source = this.#createSource(request);
      const session = await source.open();
      const entry: OpenTable = {
        source,
        request,
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
    // Closing a table stops any export of it: the rows it was writing are about
    // to stop existing.
    this.#cancelExports(tableId);
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

  get runningExportCount(): number {
    return this.#exports.size;
  }
}

/**
 * One export in flight: the acknowledgement it is waiting for, and the signal
 * that stops it.
 *
 * Exactly one chunk is ever outstanding, so there is one waiter rather than a
 * queue of them.
 *
 * The wait ends on a cancellation as well as on an acknowledgement, and that
 * matters. An export spends most of its life inside a write, waiting for the
 * main thread to get the previous chunk onto disk; if only the batch loop
 * watched the signal, pressing stop on an export writing to a slow disk would
 * appear to do nothing until that write had finished.
 */
class RunningExport {
  readonly controller = new AbortController();
  readonly tableId: EntityId;
  #waiting: { sequence: number; resolve: () => void } | null = null;

  constructor(tableId: EntityId) {
    this.tableId = tableId;
  }

  awaitAck(sequence: number): Promise<void> {
    const signal = this.controller.signal;
    if (signal.aborted) return Promise.reject(cancelled());
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        this.#waiting = null;
        reject(cancelled());
      };
      this.#waiting = {
        sequence,
        resolve: (): void => {
          // Removed rather than left to `once`: a long export waits thousands
          // of times, and thousands of listeners on one signal is a leak.
          signal.removeEventListener('abort', onAbort);
          resolve();
        },
      };
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  acknowledge(sequence: number): void {
    const waiting = this.#waiting;
    if (waiting === null || waiting.sequence !== sequence) return;
    this.#waiting = null;
    waiting.resolve();
  }
}
