import type { ColumnDataType } from '@panorama/core';
import type { CellValue, ResultChunk } from './result-chunk.js';
import type { ColumnSummary } from './summary.js';
import type { TableSchema } from './schema.js';

/**
 * The renderer-independent data contract.
 *
 * Nothing above this interface knows that Exasol exists; nothing below it
 * knows that Babylon exists. `MockTableDataSource` and `ExasolTableDataSource`
 * are interchangeable, which is what makes deterministic interaction and cache
 * testing possible.
 */

/**
 * A membership predicate on one column: the rows where it is one of these.
 *
 * Not a filtering UI, and still not wanting one. It exists so that a *navigation*
 * act can narrow a result set — following a foreign key to the rows it points at,
 * or drilling into the marks somebody picked out of a chart. One value is the
 * ordinary case and the reason it is a list is the second one: picking three bars
 * out of a chart is one predicate over three values, not three predicates.
 *
 * An empty list matches nothing, deliberately. It is the honest reading of "the
 * rows behind nothing at all", and it is what lets a drill-down table exist and
 * be empty before anything has been chosen.
 */
export interface RowFilter {
  readonly column: string;
  readonly values: readonly CellValue[];
  /**
   * Type of the column being compared, so the literal is formed correctly. A
   * foreign key column and its referent are type-compatible by definition, so
   * the source column's type is the right one to pass.
   */
  readonly type?: ColumnDataType;
}

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
  /**
   * Describes one column: how much is missing, how varied it is, how it spreads.
   *
   * Optional because not every source can answer it, and the ones that can
   * answer it in very different ways — a database aggregates one column without
   * touching the others, while a generator has to walk its own rows. A source
   * that cannot say returns nothing at all rather than guessing from the rows
   * that happen to have been read for the screen, which would be a statement
   * about the scroll position dressed up as a statement about the data.
   */
  summarise?(column: string, signal?: AbortSignal): Promise<ColumnSummary>;
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
  /**
   * The statement was refused before it ran, and the refusal is the answer.
   *
   * A semantic layer that will not compile a query says why, names the object
   * the field actually belongs to, and offers what else would have worked. That
   * is a thing to show a reader, not a thing to retry — which is why it is its
   * own code rather than a protocol error.
   */
  | 'statement-refused'
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
