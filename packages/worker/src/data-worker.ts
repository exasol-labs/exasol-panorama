import type { ChartSpec, ColumnDataType, EntityId } from '@panorama/core';
import type { ChartFrameSpec, ChartWindowSpec } from '@panorama/core';
import { DEFAULT_CHART_ROWS, MAX_FRAME_ROWS, chartFramesOf } from '@panorama/core';
import type { ChartFrame, ChartFrameInput } from '@panorama/chart';
import { aggregateChart, buildFrame, reductionFrame } from '@panorama/chart';
import type { CellValue, ResultChunk, TableDataSession, TableDataSource } from '@panorama/table';
import {
  DEFAULT_BLOCK_SIZE,
  FetchScheduler,
  TableDataError,
  blockStartRow,
  buildVector,
  cellValue,
  chunkTransferables,
  createResultChunk,
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
 * Rows a value window will walk before it gives up looking.
 *
 * A range read on a relation in that order stops as soon as it passes the bound;
 * on a relation in another order there is nothing to stop it, and walking a
 * billion rows to draw a line is the thing this whole design exists to avoid. So
 * it stops, and the answer says it sampled.
 */
const MAX_WINDOW_SCAN = 200_000;

/**
 * The rows of a chunk whose bound column is inside the range, and whether the
 * chunk ran past it.
 *
 * `null` when none of them are, so a chunk entirely before the range costs
 * nothing. Passing the upper bound is what lets a read in that order stop.
 */
const withinRange = (
  chunk: ResultChunk,
  columnIndex: number,
  low: CellValue,
  high: CellValue,
  types: readonly ColumnDataType[],
): { chunk: ResultChunk; passed: boolean } | null => {
  const empty = createResultChunk(chunk.startRow, 0, []);
  const vector = columnIndex < 0 ? undefined : chunk.columns[columnIndex];
  // No such column: nothing can be said to be in range, and treating every row
  // as inside it would be a lie. Reported as a data set with nothing in it.
  if (vector === undefined) return { chunk: empty, passed: true };
  const rows: number[] = [];
  let passed = false;
  for (let row = 0; row < chunk.rowCount; row += 1) {
    const value = cellValue(vector, row);
    if (value === null) continue;
    if (compareCells(value, low) < 0) continue;
    if (compareCells(value, high) > 0) {
      passed = true;
      continue;
    }
    rows.push(row);
  }
  if (rows.length === 0) return passed ? { chunk: empty, passed } : null;
  return {
    chunk: createResultChunk(
      chunk.startRow,
      rows.length,
      chunk.columns.map((column, index) =>
        buildVector(
          types[index] as ColumnDataType,
          rows.map((row) => cellValue(column, row)),
        ),
      ),
    ),
    passed,
  };
};

/** Two cells, ordered the way the column would order them. */
const compareCells = (left: CellValue, right: CellValue): number => {
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const a = String(left);
  const b = String(right);
  return a < b ? -1 : a > b ? 1 : 0;
};

/** The window a data set asked for, where its kind can have one. */
const windowOf = (frame: ChartFrameSpec): ChartWindowSpec | undefined =>
  frame.kind === 'rows' || frame.kind === 'resample' ? frame.window : undefined;

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
  /** Where to open the socket, if not `url`. See `ConnectMessage.via`. */
  readonly via?: string;
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
        return this.#connect(message.requestId, message.url, message.credentials, message.via);
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
        return this.#chartData(message.requestId, message.tableId, message.spec, message.sources);
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
  async #chartData(
    requestId: number,
    tableId: EntityId,
    spec: ChartSpec,
    sources: Readonly<Record<string, EntityId>> | undefined,
  ): Promise<void> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) {
      this.#fail(requestId, new TableDataError('not-found', `Table ${tableId} is not open`));
      return;
    }
    await this.#run(requestId, async (): Promise<ChartDataResult> => {
      const wanted = Math.max(1, spec.rowLimit ?? DEFAULT_CHART_ROWS);
      // The chart's own reduction reads the beginning, as it always has: a window
      // is a data set's business, and the reduction is a picture of the whole.
      const own = await this.#chartInput(tableId, spec, wanted);
      if (own === null) return null;
      const data = aggregateChart(own);
      const named = chartFramesOf(spec);
      // Grouped by the box they read, so a chart with three data sets from one
      // table reads that table once. A data set is a question about a result set;
      // three questions are not three fetches.
      const elsewhere = new Map<EntityId, ChartFrameSpec[]>();
      const mine: ChartFrameSpec[] = [];
      for (const frame of named) {
        const from = sources?.[frame.name];
        if (from === undefined || from === tableId) {
          mine.push(frame);
          continue;
        }
        elsewhere.set(from, [...(elsewhere.get(from) ?? []), frame]);
      }
      const built = new Map<string, ChartFrame>();
      const empty = (name: string): ChartFrame => ({
        name,
        dimensions: [],
        rows: [],
        read: 0,
        of: null,
        basis: 'exact',
      });
      for (const frame of mine) {
        // A window is read for the data set that asked for it, so two data sets
        // looking at different parts of the same relation each get their own —
        // which is what a picture with an overview and a detail is made of.
        const input =
          windowOf(frame) === undefined
            ? own
            : await this.#chartInput(tableId, spec, wanted, windowOf(frame));
        built.set(frame.name, input === null ? empty(frame.name) : buildFrame(frame, input));
      }
      for (const [from, frames] of elsewhere) {
        for (const frame of frames) {
          // A box that is not open has nothing to read: reported as a data set
          // with no rows rather than as a failure, because the other data sets are
          // still worth drawing and the report says which one was empty.
          const input = await this.#chartInput(from, spec, wanted, windowOf(frame));
          built.set(frame.name, input === null ? empty(frame.name) : buildFrame(frame, input));
        }
      }
      return {
        data,
        // In the order the specification named them, whatever order they were
        // read in.
        frames: [
          reductionFrame(spec, data),
          ...named.flatMap((frame) => {
            const found = built.get(frame.name);
            return found === undefined ? [] : [found];
          }),
        ],
      };
    });
  }

  /**
   * Rows from one open table, bounded, as a chart's data sets read them.
   *
   * A window says which rows. Without one it is the beginning of the relation,
   * which is what every chart read before there were windows.
   */
  async #chartInput(
    tableId: EntityId,
    spec: ChartSpec,
    wanted: number,
    window?: ChartWindowSpec,
  ): Promise<ChartFrameInput | null> {
    const entry = this.#tables.get(tableId);
    if (entry === undefined) return null;
    const session = entry.session;
    const total = session.rowCount;
    const columns = session.schema.columns.map((column) => column.name);

    // A position window is the table's own mechanism: an offset and a count,
    // fetched the way a scrolled table fetches.
    const start = window?.by === 'position' ? Math.max(0, Math.trunc(window.from)) : 0;
    const asked = window?.by === 'position' ? Math.max(1, Math.trunc(window.count)) : wanted;
    const target = total === null ? asked : Math.max(0, Math.min(asked, total - start));

    // A value window is a range along a column. Read in order and stopped as soon
    // as the column passes the upper bound, which for a relation already in that
    // order — a statement with an `ORDER BY`, which is what a series is drawn from
    // — makes this a range read rather than a scan of everything. For a relation
    // in another order it is a bounded scan, and the answer says how far it got.
    const bound = window?.by === 'value' ? window : undefined;
    const boundAt = bound === undefined ? -1 : columns.indexOf(bound.column);
    const chunks: ResultChunk[] = [];
    let read = 0;
    let scanned = 0;
    let passed = false;
    // A bounded read stops when the column has passed the range, whatever it has
    // kept; an unbounded one stops when it has what it asked for.
    while (bound === undefined ? read < target : !passed) {
      if (bound !== undefined && scanned >= MAX_WINDOW_SCAN) break;
      const chunk = await session.fetch({
        startPosition: start + scanned,
        maxRows: Math.min(CHART_FETCH_ROWS, bound === undefined ? target - read : CHART_FETCH_ROWS),
      });
      if (chunk.rowCount === 0) break;
      scanned += chunk.rowCount;
      if (bound === undefined) {
        chunks.push(chunk);
        read += chunk.rowCount;
        continue;
      }
      const kept = withinRange(
        chunk,
        boundAt,
        bound.from,
        bound.to,
        session.schema.columns.map((column) => column.type),
      );
      if (kept !== null) {
        chunks.push(kept.chunk);
        read += kept.chunk.rowCount;
      }
      passed = kept?.passed === true || read >= MAX_FRAME_ROWS;
    }
    if (chunks.length === 0) return null;
    return {
      spec,
      columns,
      chunks,
      totalRows: total,
      ...(window === undefined ? {} : { window, scanned }),
    };
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

  async #connect(
    requestId: number,
    url: string,
    credentials: ExasolCredentials,
    via?: string,
  ): Promise<void> {
    const factory = this.#options.createConnection;
    if (factory === undefined) {
      this.#fail(requestId, new TableDataError('connection-failed', 'No connection factory'));
      return;
    }
    try {
      this.#connection = factory({
        url,
        credentials,
        ...(via === undefined ? {} : { via }),
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
