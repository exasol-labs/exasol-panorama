import type { ChartSpec, EntityId } from '@panorama/core';
import type {
  DesiredBlock,
  ResultChunk,
  SchemaInfo,
  TableInfo,
  TableSchema,
} from '@panorama/table';
import { TableDataError } from '@panorama/table';
import type { ExasolCredentials, WrapperView } from '@panorama/exasol';
import type { ByteSink, ExportFormat } from '@panorama/export';
import { abandon } from '@panorama/export';
import type { WorkerEndpoint } from './endpoint.js';
import type {
  ExportResultMessage,
  MainToWorkerMessage,
  OpenTableRequest,
  OpenTableResult,
  SerializedError,
  SummariseColumnResult,
  ChartDataResult,
  WorkerToMainMessage,
} from './messages.js';

/**
 * The main-thread half of the data worker.
 *
 * Turns the message protocol back into promises and callbacks. Nothing here
 * touches Exasol or blocks the render thread.
 */

export interface RowsAvailable {
  readonly tableId: EntityId;
  readonly generation: number;
  readonly blockIndex: number;
  readonly chunk: ResultChunk;
}

export interface BlockFailure {
  readonly tableId: EntityId;
  readonly generation: number;
  readonly blockIndex: number;
  readonly error: SerializedError;
}

export interface ConnectionStatusEvent {
  readonly status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  readonly error?: SerializedError;
}

export interface ExportProgressEvent {
  readonly exportId: number;
  readonly rows: number;
  readonly bytes: number;
  readonly totalRows: number | null;
}

export interface ExportRequest {
  readonly tableId: EntityId;
  readonly format: ExportFormat;
  /** Where the bytes go. Closed on success, aborted on failure or cancellation. */
  readonly sink: ByteSink;
  readonly onProgress?: (progress: ExportProgressEvent) => void;
}

export interface RunningExportHandle {
  readonly exportId: number;
  /** Resolves when the file is complete; rejects if it failed or was cancelled. */
  readonly done: Promise<ExportResultMessage>;
  cancel(): void;
}

/** The narrow surface a table controller needs; keeps controllers testable. */
export interface TableDataGateway {
  openTable(request: OpenTableRequest): Promise<OpenTableResult>;
  reopenTable(tableId: EntityId): Promise<OpenTableResult>;
  closeTable(tableId: EntityId): Promise<void>;
  requestBlocks(
    tableId: EntityId,
    generation: number,
    blockSize: number,
    blocks: readonly DesiredBlock[],
  ): void;
  onRows(listener: (event: RowsAvailable) => void): () => void;
  onBlockFailed(listener: (event: BlockFailure) => void): () => void;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

interface ExportSinkState {
  readonly sink: ByteSink;
  readonly onProgress?: (progress: ExportProgressEvent) => void;
  /** Records a write failure so the export's promise rejects with it. */
  readonly fail: (error: unknown) => void;
}

export const deserializeError = (error: SerializedError): TableDataError =>
  new TableDataError(error.code, error.message);

export class DataWorkerClient implements TableDataGateway {
  readonly #endpoint: WorkerEndpoint;
  readonly #pending = new Map<number, Pending>();
  readonly #rowListeners = new Set<(event: RowsAvailable) => void>();
  readonly #failureListeners = new Set<(event: BlockFailure) => void>();
  readonly #statusListeners = new Set<(event: ConnectionStatusEvent) => void>();
  readonly #listener = (event: { data: unknown }): void => {
    this.#receive(event.data as WorkerToMainMessage);
  };
  readonly #exportSinks = new Map<number, ExportSinkState>();
  #nextRequestId = 1;
  #nextExportId = 1;
  #disposed = false;

  constructor(endpoint: WorkerEndpoint) {
    this.#endpoint = endpoint;
    endpoint.addEventListener('message', this.#listener);
  }

  #receive(message: WorkerToMainMessage): void {
    switch (message.type) {
      case 'result': {
        const pending = this.#pending.get(message.requestId);
        if (pending === undefined) return;
        this.#pending.delete(message.requestId);
        if (message.ok) pending.resolve(message.value);
        else
          pending.reject(
            deserializeError(message.error ?? { code: 'protocol-error', message: 'Unknown error' }),
          );
        return;
      }
      case 'rowsAvailable':
        for (const listener of [...this.#rowListeners]) {
          listener({
            tableId: message.tableId,
            generation: message.generation,
            blockIndex: message.blockIndex,
            chunk: message.chunk,
          });
        }
        return;
      case 'blockFailed':
        for (const listener of [...this.#failureListeners]) {
          listener({
            tableId: message.tableId,
            generation: message.generation,
            blockIndex: message.blockIndex,
            error: message.error,
          });
        }
        return;
      case 'exportChunk': {
        const state = this.#exportSinks.get(message.exportId);
        const bytes = new Uint8Array(message.bytes);
        // Acknowledged only once the bytes are on their way to the file, which
        // is what stops the worker from running ahead of the disk.
        void (async (): Promise<void> => {
          try {
            await state?.sink.write(bytes);
          } catch (error) {
            state?.fail(error);
          }
          if (!this.#disposed) {
            this.#endpoint.postMessage({
              type: 'exportAck',
              exportId: message.exportId,
              sequence: message.sequence,
            } satisfies MainToWorkerMessage);
          }
        })();
        return;
      }
      case 'exportProgress': {
        this.#exportSinks.get(message.exportId)?.onProgress?.({
          exportId: message.exportId,
          rows: message.rows,
          bytes: message.bytes,
          totalRows: message.totalRows,
        });
        return;
      }
      case 'connectionStatus':
        for (const listener of [...this.#statusListeners]) {
          listener({
            status: message.status,
            ...(message.error === undefined ? {} : { error: message.error }),
          });
        }
    }
  }

  #request<TResult>(build: (requestId: number) => MainToWorkerMessage): Promise<TResult> {
    if (this.#disposed) {
      return Promise.reject(new TableDataError('session-closed', 'Data worker client disposed'));
    }
    const requestId = this.#nextRequestId++;
    return new Promise<TResult>((resolve, reject) => {
      this.#pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      this.#endpoint.postMessage(build(requestId));
    });
  }

  connect(
    url: string,
    credentials: ExasolCredentials,
    /** Where to open the socket, if not the database's own URL. See `ConnectMessage`. */
    via?: string,
  ): Promise<{
    connectionId: string;
    /** What the database called itself at login, where it said. */
    database?: string;
    version?: string;
    sessionId?: number;
  }> {
    return this.#request((requestId) => ({
      type: 'connect',
      requestId,
      url,
      credentials,
      ...(via === undefined ? {} : { via }),
    }));
  }

  disconnect(): Promise<void> {
    return this.#request((requestId) => ({ type: 'disconnect', requestId }));
  }

  listSchemas(): Promise<readonly SchemaInfo[]> {
    return this.#request((requestId) => ({ type: 'listSchemas', requestId }));
  }

  listTables(schema: string): Promise<readonly TableInfo[]> {
    return this.#request((requestId) => ({ type: 'listTables', requestId, schema }));
  }

  /**
   * The JSON wrapper packages installed on the connection.
   *
   * A list rather than the map, because a `Map` does not survive being posted
   * between a worker and a page; the caller rebuilds it. Empty where nothing is
   * installed, which is most connections.
   */
  wrapperSurface(): Promise<readonly WrapperView[]> {
    return this.#request((requestId) => ({ type: 'wrapperSurface', requestId }));
  }

  describeTable(schema: string, table: string): Promise<TableSchema> {
    return this.#request((requestId) => ({ type: 'describeTable', requestId, schema, table }));
  }

  /**
   * Describes one column of an open table, or resolves `null` when whatever is
   * behind the table has no way to say.
   */
  summariseColumn(tableId: EntityId, column: string): Promise<SummariseColumnResult> {
    return this.#request((requestId) => ({
      type: 'summariseColumn',
      requestId,
      tableId,
      column,
    }));
  }

  /**
   * The numbers a chart draws, reduced beside the rows they came from.
   *
   * `tableId` is the table being charted: a chart has no result set of its own.
   */
  chartData(
    tableId: EntityId,
    spec: ChartSpec,
    sources?: Readonly<Record<string, EntityId>>,
  ): Promise<ChartDataResult> {
    return this.#request((requestId) => ({
      type: 'chartData',
      requestId,
      tableId,
      spec,
      ...(sources === undefined || Object.keys(sources).length === 0 ? {} : { sources }),
    }));
  }

  openTable(request: OpenTableRequest): Promise<OpenTableResult> {
    return this.#request((requestId) => ({ type: 'openTable', requestId, ...request }));
  }

  reopenTable(tableId: EntityId): Promise<OpenTableResult> {
    return this.#request((requestId) => ({ type: 'reopenTable', requestId, tableId }));
  }

  closeTable(tableId: EntityId): Promise<void> {
    return this.#request((requestId) => ({ type: 'closeTable', requestId, tableId }));
  }

  requestBlocks(
    tableId: EntityId,
    generation: number,
    blockSize: number,
    blocks: readonly DesiredBlock[],
  ): void {
    if (this.#disposed) return;
    this.#endpoint.postMessage({
      type: 'requestBlocks',
      tableId,
      generation,
      blockSize,
      blocks,
    } satisfies MainToWorkerMessage);
  }

  /**
   * Starts an export and returns a handle to it.
   *
   * The sink is this side's: the worker encodes and this thread writes, so the
   * file dialog's handle never has to leave the thread that opened it. Whichever
   * way the export ends, the sink is finished here — closed on success, abandoned
   * otherwise, because a truncated Parquet file or ZIP is not a partial result
   * but an unopenable one.
   */
  startExport(request: ExportRequest): RunningExportHandle {
    const exportId = this.#nextExportId++;
    let failure: unknown = null;
    this.#exportSinks.set(exportId, {
      sink: request.sink,
      ...(request.onProgress === undefined ? {} : { onProgress: request.onProgress }),
      fail: (error): void => {
        failure = failure ?? error;
      },
    });

    const done = this.#request<ExportResultMessage>((requestId) => ({
      type: 'startExport',
      requestId,
      exportId,
      tableId: request.tableId,
      format: request.format,
    }))
      .then(async (result) => {
        if (failure !== null) throw failure;
        await request.sink.close();
        return result;
      })
      .catch(async (error: unknown) => {
        await abandon(request.sink, error);
        throw error;
      })
      .finally(() => {
        this.#exportSinks.delete(exportId);
      });

    return {
      exportId,
      done,
      cancel: (): void => {
        if (this.#disposed) return;
        this.#endpoint.postMessage({
          type: 'cancelExport',
          requestId: this.#nextRequestId++,
          exportId,
        } satisfies MainToWorkerMessage);
      },
    };
  }

  onRows(listener: (event: RowsAvailable) => void): () => void {
    this.#rowListeners.add(listener);
    return (): void => {
      this.#rowListeners.delete(listener);
    };
  }

  onBlockFailed(listener: (event: BlockFailure) => void): () => void {
    this.#failureListeners.add(listener);
    return (): void => {
      this.#failureListeners.delete(listener);
    };
  }

  onConnectionStatus(listener: (event: ConnectionStatusEvent) => void): () => void {
    this.#statusListeners.add(listener);
    return (): void => {
      this.#statusListeners.delete(listener);
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#endpoint.removeEventListener('message', this.#listener);
    for (const pending of this.#pending.values()) {
      pending.reject(new TableDataError('session-closed', 'Data worker client disposed'));
    }
    this.#pending.clear();
    this.#exportSinks.clear();
    this.#rowListeners.clear();
    this.#failureListeners.clear();
    this.#statusListeners.clear();
  }
}
