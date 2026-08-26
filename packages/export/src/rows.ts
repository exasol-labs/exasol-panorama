import type { ResultChunk, TableDataSession } from '@panorama/table';
import { TableDataError } from '@panorama/table';
import { ExportError } from './format.js';

/**
 * Reading a result set from the top, once.
 *
 * Browsing and exporting want opposite things from a result set. The viewport
 * jumps about, keeps a bounded cache and cancels what scrolled away; an export
 * walks the whole thing forwards exactly once and keeps nothing. So an export
 * reads through `TableDataSession` — the same interface the viewport uses, and
 * the reason a locally generated demo relation exports as readily as a real
 * Exasol table — but on its *own* session, so the two never fight over one
 * cursor's position.
 */

/** Target cells per batch, so a very wide relation does not fetch huge ones. */
const TARGET_CELLS_PER_BATCH = 131_072;
const MIN_BATCH_ROWS = 32;
const MAX_BATCH_ROWS = 16_384;

/**
 * Rows per batch for a given row width.
 *
 * Deliberately modest. An export shares one connection with whatever the user
 * is scrolling, and a single enormous fetch would park a scroll request behind
 * it — the database may cause data to arrive late, but an export should not be
 * the reason it does.
 */
export const batchRowsForColumns = (columnCount: number): number => {
  if (columnCount <= 0) return MAX_BATCH_ROWS;
  const rows = Math.floor(TARGET_CELLS_PER_BATCH / columnCount);
  return Math.max(MIN_BATCH_ROWS, Math.min(MAX_BATCH_ROWS, rows));
};

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted === true) throw new ExportError('aborted', 'Export cancelled');
};

/**
 * Yields the whole result set as consecutive chunks.
 *
 * Ends when the row count is reached, or — for a source that cannot report one —
 * when a fetch comes back short, which is the only end-of-set signal such a
 * source has.
 */
export async function* readBatches(
  session: TableDataSession,
  batchRows: number,
  signal?: AbortSignal,
): AsyncGenerator<ResultChunk> {
  const total = session.rowCount;
  let position = 0;

  while (total === null || position < total) {
    throwIfAborted(signal);
    const wanted = total === null ? batchRows : Math.min(batchRows, total - position);
    let chunk: ResultChunk;
    try {
      chunk = await session.fetch({ startPosition: position, maxRows: wanted }, signal);
    } catch (error) {
      // An abort surfaces as the data layer's own error; the export reports it
      // as a cancellation, which is what it was.
      if (error instanceof TableDataError && error.code === 'aborted') {
        throw new ExportError('aborted', 'Export cancelled');
      }
      throw error;
    }
    if (chunk.rowCount > 0) yield chunk;
    position += chunk.rowCount;
    if (chunk.rowCount < wanted) return;
  }
}
