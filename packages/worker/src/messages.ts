import type { ChartSpec, EntityId } from '@panorama/core';
import type { ChartData, ChartFrame } from '@panorama/chart';
import type {
  DesiredBlock,
  ResultChunk,
  RowFilter,
  SchemaInfo,
  TableInfo,
  TableSchema,
} from '@panorama/table';
import type { ColumnSummary, TableDataErrorCode } from '@panorama/table';
import type { ExasolCredentials } from '@panorama/exasol';
import type { ExportFormat } from '@panorama/export';

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

/** Everything needed to produce a table's rows. */
export interface OpenTableRequest {
  readonly tableId: EntityId;
  readonly schema: string;
  readonly table: string;
  /** Restricts the result set; set when following a foreign key. */
  readonly filter?: RowFilter;
  /**
   * Runs this statement instead of selecting from `table`; set for a query
   * table. `schema` and `table` then only label the result.
   */
  readonly sql?: string;
}

export interface OpenTableMessage extends OpenTableRequest {
  readonly type: 'openTable';
  readonly requestId: number;
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

/**
 * Writes a table to a file.
 *
 * The export is encoded *in the worker* — that is where the connection lives,
 * and encoding a gigabyte on the render thread would break the one promise
 * Panorama makes about frames. The encoded bytes come back as `exportChunk`
 * messages rather than the worker writing the file itself: the file handle
 * belongs to a save dialog, which is a main-thread affair, and posting a
 * transferred buffer costs nothing while `FileSystemFileHandle` cloning is not
 * something every browser can do.
 *
 * The export reads its *own* result set for the same statement. Sharing the one
 * the table is browsing would mean two readers seeking a single cursor against
 * each other — the export would drag the scroll about, and the scroll would
 * drag the export.
 */
export interface StartExportMessage {
  readonly type: 'startExport';
  readonly requestId: number;
  readonly exportId: number;
  readonly tableId: EntityId;
  readonly format: ExportFormat;
}

/**
 * Permission to send the next chunk.
 *
 * Without it the worker would encode as fast as it can read and queue the whole
 * file in the main thread's message port — an out-of-memory failure dressed up
 * as a fast export. One ack per chunk is one round trip per 64 KiB, which is
 * far more throughput than a disk or a database will ever supply.
 */
export interface ExportAckMessage {
  readonly type: 'exportAck';
  readonly exportId: number;
  readonly sequence: number;
}

/**
 * Describes one column of an open table.
 *
 * Asked for when a column is picked out, answered by whatever is behind the
 * table — a database aggregates the one column and leaves the others alone; a
 * generated relation walks its own rows and says how many it managed. Either
 * way it happens in the worker, because either way it is work the render thread
 * must not wait for.
 */
export interface SummariseColumnMessage {
  readonly type: 'summariseColumn';
  readonly requestId: number;
  readonly tableId: EntityId;
  readonly column: string;
}

/**
 * Asks for the few dozen numbers a chart draws.
 *
 * Reduced on this side of the boundary: a chart of a billion rows is a handful of
 * figures, and sending the rows over to work that out would be sending the whole
 * table to draw a picture of it. `tableId` names the table being charted, not the
 * chart — a chart has no result set of its own, it reads someone else's.
 */
export interface ChartDataMessage {
  readonly type: 'chartData';
  readonly requestId: number;
  readonly tableId: EntityId;
  readonly spec: ChartSpec;
  /**
   * Which open table each named data set reads, where it is not this one.
   *
   * From the chart's data bindings: the arrow on the canvas says where a data
   * set's rows come from, and this is that fact on the wire. A name absent here
   * reads the chart's own relation.
   */
  readonly sources?: Readonly<Record<string, EntityId>>;
}

export interface CancelExportMessage {
  readonly type: 'cancelExport';
  readonly requestId: number;
  readonly exportId: number;
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
  | RequestBlocksMessage
  | StartExportMessage
  | ExportAckMessage
  | CancelExportMessage
  | SummariseColumnMessage
  | ChartDataMessage;

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

export interface ExportChunkMessage {
  readonly type: 'exportChunk';
  readonly exportId: number;
  readonly sequence: number;
  /** Transferred, so the bytes are moved rather than copied. */
  readonly bytes: ArrayBuffer;
}

export interface ExportProgressMessage {
  readonly type: 'exportProgress';
  readonly exportId: number;
  readonly rows: number;
  readonly bytes: number;
  readonly totalRows: number | null;
}

export interface ConnectionStatusMessage {
  readonly type: 'connectionStatus';
  readonly status: 'disconnected' | 'connecting' | 'connected' | 'failed';
  readonly error?: SerializedError;
}

export type WorkerToMainMessage =
  | ResultMessage
  | RowsAvailableMessage
  | BlockFailedMessage
  | ExportChunkMessage
  | ExportProgressMessage
  | ConnectionStatusMessage;

/** What a completed export reports back. */
export interface ExportResultMessage {
  readonly rows: number;
  readonly bytes: number;
}

export type ListSchemasResult = readonly SchemaInfo[];
export type ListTablesResult = readonly TableInfo[];
export type DescribeTableResult = TableSchema;

/** What a column summary comes back as; `null` when the source cannot say. */
export type SummariseColumnResult = ColumnSummary | null;

/**
 * What a chart's rows came back as: the reduction, and every data set the
 * specification named.
 *
 * Both from one read of the rows. A chart that names three data sets is asking
 * three questions of the same result set, and fetching it three times would be
 * paying three times for one answer.
 *
 * `null` when the table is open but has no rows to read yet.
 */
export interface ChartReduction {
  readonly data: ChartData;
  readonly frames: readonly ChartFrame[];
}

export type ChartDataResult = ChartReduction | null;
