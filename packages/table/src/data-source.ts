import type { ResultChunk } from './result-chunk.js';
import type { TableSchema } from './schema.js';

/**
 * The renderer-independent data contract.
 *
 * Nothing above this interface knows that Exasol exists; nothing below it
 * knows that Babylon exists. `MockTableDataSource` and `ExasolTableDataSource`
 * are interchangeable, which is what makes deterministic interaction and cache
 * testing possible.
 */

export interface FetchRequest {
  /** Zero-based position within the result set. */
  readonly startPosition: number;
  /**
   * Number of rows to return. Implementations must return exactly this many
   * rows unless the result set ends first; a source that speaks a byte-budget
   * protocol loops internally rather than pushing partial blocks upwards.
   */
  readonly maxRows: number;
  /** Optional hint for protocols that budget responses in bytes. */
  readonly approximateBytes?: number;
}

export interface TableDataSession {
  readonly schema: TableSchema;
  /** Total rows in the result set, or `null` when the source cannot report it. */
  readonly rowCount: number | null;
  fetch(request: FetchRequest, signal?: AbortSignal): Promise<ResultChunk>;
  close(): Promise<void>;
}

export interface TableDataSource {
  open(): Promise<TableDataSession>;
  close(): Promise<void>;
}

export type TableDataErrorCode =
  | 'connection-failed'
  | 'connection-lost'
  | 'authentication-failed'
  | 'not-found'
  | 'permission-denied'
  | 'result-set-expired'
  | 'fetch-failed'
  | 'session-closed'
  | 'aborted'
  | 'protocol-error';

/**
 * Errors that cross the data-source boundary. The code is what the UI switches
 * on: a fetch failure retries one block, an expired result set reopens the
 * table, a lost connection is connection-level.
 */
export class TableDataError extends Error {
  readonly code: TableDataErrorCode;
  override readonly cause: unknown;

  constructor(code: TableDataErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'TableDataError';
    this.code = code;
    this.cause = cause;
  }
}

export const isTableDataError = (value: unknown): value is TableDataError =>
  value instanceof TableDataError;

/** True for failures where retrying the same block is worthwhile. */
export const isRetryable = (error: unknown): boolean =>
  isTableDataError(error) && (error.code === 'fetch-failed' || error.code === 'connection-lost');
