import type { TableDataSession } from '@panorama/table';
import type { CsvOptions } from './csv.js';
import { createCsvEncoder } from './csv.js';
import type { EncoderOptions, RowEncoder } from './encoder.js';
import type { ExportFormat } from './format.js';
import { ExportError } from './format.js';
import { batchRowsForColumns, readBatches } from './rows.js';
import type { ByteSink } from './sink.js';
import { abandon } from './sink.js';
import type { XlsxOptions } from './xlsx/xlsx.js';
import { createXlsxEncoder } from './xlsx/xlsx.js';
import type { ParquetOptions } from './parquet/writer.js';
import { createParquetEncoder } from './parquet/writer.js';

/**
 * Driving one export.
 *
 * Read a batch, encode it, write it, repeat. Everything interesting is in the
 * three things it composes — the session it reads from, the encoder it feeds and
 * the sink it writes to — which is why this is short, and why the same function
 * exports a live Exasol result set and a locally generated demo relation without
 * knowing which it has.
 */

export interface ExportProgress {
  readonly rows: number;
  readonly bytes: number;
  /** `null` when the source cannot say how many rows there are. */
  readonly totalRows: number | null;
}

export interface ExportResult {
  readonly rows: number;
  readonly bytes: number;
}

export interface ExportRequest {
  readonly format: ExportFormat;
  readonly session: TableDataSession;
  readonly sink: ByteSink;
  /** Overrides the width-derived default; tests use it to force many batches. */
  readonly batchRows?: number;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ExportProgress) => void;
  /** Progress is reported no more often than this, plus once at the end. */
  readonly progressIntervalMs?: number;
  readonly clock?: () => number;
  readonly csv?: CsvOptions;
  readonly xlsx?: XlsxOptions;
  readonly parquet?: ParquetOptions;
}

const DEFAULT_PROGRESS_INTERVAL_MS = 200;

export const createEncoder = (
  format: ExportFormat,
  options: EncoderOptions & { csv?: CsvOptions; xlsx?: XlsxOptions; parquet?: ParquetOptions },
): RowEncoder => {
  switch (format) {
    case 'csv':
      return createCsvEncoder({ ...options, ...options.csv });
    case 'xlsx':
      return createXlsxEncoder({ ...options, ...options.xlsx });
    case 'parquet':
      return createParquetEncoder({ ...options, ...options.parquet });
  }
};

export const runExport = async (request: ExportRequest): Promise<ExportResult> => {
  const { session, sink, format } = request;
  const schema = session.schema;
  if (schema.columns.length === 0) {
    throw new ExportError('no-columns', 'This table has no columns to export');
  }

  const clock = request.clock ?? ((): number => Date.now());
  const interval = request.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  const batchRows = request.batchRows ?? batchRowsForColumns(schema.columns.length);
  let rows = 0;
  let lastReport = clock();

  const report = (): void => {
    request.onProgress?.({ rows, bytes: sink.position, totalRows: session.rowCount });
  };

  try {
    const encoder = createEncoder(format, {
      schema,
      sink,
      ...(request.csv === undefined ? {} : { csv: request.csv }),
      ...(request.xlsx === undefined ? {} : { xlsx: request.xlsx }),
      ...(request.parquet === undefined ? {} : { parquet: request.parquet }),
    });
    await encoder.begin();
    for await (const batch of readBatches(session, batchRows, request.signal)) {
      await encoder.write(batch);
      rows += batch.rowCount;
      // Throttled, because a progress message per batch is a message per few
      // milliseconds on a fast connection, and the UI cannot use them.
      const now = clock();
      if (now - lastReport >= interval) {
        lastReport = now;
        report();
      }
    }
    await encoder.finish();
    const bytes = sink.position;
    await sink.close();
    report();
    return { rows, bytes };
  } catch (error) {
    // The file is discarded rather than left half-written under the name the
    // user chose: a truncated Parquet file has no footer and a truncated
    // archive has no directory, so neither would open.
    await abandon(sink, error);
    throw error;
  }
};
