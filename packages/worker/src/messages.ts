import type { EntityId } from '@panorama/core';
import type {
  DesiredBlock,
  ResultChunk,
  SchemaInfo,
  TableInfo,
  TableSchema,
} from '@panorama/table';
import type { TableDataErrorCode } from '@panorama/table';
import type { ExasolCredentials } from '@panorama/exasol';

/**
 * The main thread ↔ data worker protocol.
 *
 * Messages are deliberately coarse-grained: one message when a *block* is
 * wanted or arrives, never one per row and never one per frame of a scroll.
 *
 * Credentials appear exactly once, in `connect`, on their way into the
 * connection subsystem. They are never stored in the world model, the history
 * graph, or any status message coming back.
 */

export interface SerializedError {
  readonly code: TableDataErrorCode;
  readonly message: string;
}

export interface ConnectMessage {
  readonly type: 'connect';
  readonly requestId: number;
  readonly url: string;
  readonly credentials: ExasolCredentials;
}

export interface DisconnectMessage {
  readonly type: 'disconnect';
  readonly requestId: number;
}

export interface ListSchemasMessage {
  readonly type: 'listSchemas';
  readonly requestId: number;
}

export interface ListTablesMessage {
  readonly type: 'listTables';
  readonly requestId: number;
  readonly schema: string;
}

export interface DescribeTableMessage {
  readonly type: 'describeTable';
  readonly requestId: number;
  readonly schema: string;
  readonly table: string;
}

export interface OpenTableMessage {
  readonly type: 'openTable';
  readonly requestId: number;
  readonly tableId: EntityId;
  readonly schema: string;
  readonly table: string;
}

export interface CloseTableMessage {
  readonly type: 'closeTable';
  readonly requestId: number;
  readonly tableId: EntityId;
}

/** Reopens the result set after a reconnect; row positions start afresh. */
export interface ReopenTableMessage {
  readonly type: 'reopenTable';
  readonly requestId: number;
  readonly tableId: EntityId;
}

export interface RequestBlocksMessage {
  readonly type: 'requestBlocks';
  readonly tableId: EntityId;
  /** Rejects responses belonging to a superseded result set. */
  readonly generation: number;
  readonly blockSize: number;
  readonly blocks: readonly DesiredBlock[];
}

export type MainToWorkerMessage =
  | ConnectMessage
  | DisconnectMessage
  | ListSchemasMessage
  | ListTablesMessage
  | DescribeTableMessage
  | OpenTableMessage
  | CloseTableMessage
  | ReopenTableMessage
  | RequestBlocksMessage;

export interface OpenTableResult {
  readonly schema: TableSchema;
  readonly rowCount: number | null;
  readonly generation: number;
}

export interface ResultMessage {
  readonly type: 'result';
  readonly requestId: number;
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: SerializedError;
}

export interface RowsAvailableMessage {
  readonly type: 'rowsAvailable';
  readonly tableId: EntityId;
  readonly generation: number;
  readonly blockIndex: number;
  readonly chunk: ResultChunk;
}

export interface BlockFailedMessage {
  readonly type: 'blockFailed';
  readonly tableId: EntityId;
  readonly generation: number;
  readonly blockIndex: number;
  readonly error: SerializedError;
}

export interface ConnectionStatusMessage {
  readonly type: 'connectionStatus';
  readonly status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  readonly error?: SerializedError;
}

export type WorkerToMainMessage =
  ResultMessage | RowsAvailableMessage | BlockFailedMessage | ConnectionStatusMessage;

export type ListSchemasResult = readonly SchemaInfo[];
export type ListTablesResult = readonly TableInfo[];
export type DescribeTableResult = TableSchema;
