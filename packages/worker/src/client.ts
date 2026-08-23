import type { EntityId } from '@panorama/core';
import type {
  DesiredBlock,
  ResultChunk,
  RowFilter,
  SchemaInfo,
  TableInfo,
  TableSchema,
} from '@panorama/table';
import { TableDataError } from '@panorama/table';
import type { ExasolCredentials } from '@panorama/exasol';
import type { WorkerEndpoint } from './endpoint.js';
import type {
  MainToWorkerMessage,
  OpenTableResult,
  SerializedError,
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

/** The narrow surface a table controller needs; keeps controllers testable. */
export interface TableDataGateway {
  openTable(
    tableId: EntityId,
    schema: string,
    table: string,
    filter?: RowFilter,
  ): Promise<OpenTableResult>;
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
  #nextRequestId = 1;
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

  connect(url: string, credentials: ExasolCredentials): Promise<{ connectionId: string }> {
    return this.#request((requestId) => ({ type: 'connect', requestId, url, credentials }));
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

  describeTable(schema: string, table: string): Promise<TableSchema> {
    return this.#request((requestId) => ({ type: 'describeTable', requestId, schema, table }));
  }

  openTable(
    tableId: EntityId,
    schema: string,
    table: string,
    filter?: RowFilter,
  ): Promise<OpenTableResult> {
    return this.#request((requestId) => ({
      type: 'openTable',
      requestId,
      tableId,
      schema,
      table,
      ...(filter === undefined ? {} : { filter }),
    }));
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
    this.#rowListeners.clear();
    this.#failureListeners.clear();
    this.#statusListeners.clear();
  }
}
