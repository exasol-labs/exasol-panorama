import type { ResultChunk, TableSchema } from '@panorama/table';
import type { ByteSink } from './sink.js';
import { ExportError } from './format.js';

/**
 * The one thing every format has in common: a preamble, a run of batches, a
 * trailer.
 *
 * Everything format-specific lives behind this — which is also the seam a
 * WebAssembly encoder would slot into unchanged, should one of these ever want
 * to be someone else's compiled library rather than this one's TypeScript.
 */
export interface RowEncoder {
  /** Writes whatever precedes the first row: a header, a magic number. */
  begin(): Promise<void>;
  /** Appends one chunk of rows, in result order. */
  write(batch: ResultChunk): Promise<void>;
  /** Writes the trailer. The sink is the caller's to close. */
  finish(): Promise<void>;
}

export interface EncoderOptions {
  readonly schema: TableSchema;
  readonly sink: ByteSink;
}

/**
 * Asserts that a batch has one vector per column, once per batch rather than
 * once per cell.
 *
 * Every encoder then reads `batch.columns[index]` as a vector without checking,
 * which is the difference between one comparison per batch and one per cell of a
 * ten-billion-row export. It should never fire: a session's chunks are built
 * from the same schema the encoder was given.
 */
export const requireVectors = (batch: ResultChunk, columns: number): void => {
  if (batch.columns.length !== columns) {
    throw new ExportError(
      'no-columns',
      `The result set delivered ${batch.columns.length} columns where the schema declares ${columns}`,
    );
  }
};
