/**
 * The file formats a table can be exported as.
 *
 * A format is described rather than hard-coded into the UI: the halo, the file
 * dialog's suggested name, the progress panel and the encoders all read the
 * same descriptor, so adding a fourth format is one entry and one encoder.
 */

export type ExportFormat = 'csv' | 'xlsx' | 'parquet';

/**
 * What a file dialog needs to know about a format, whatever the format is of.
 *
 * A table's formats and a chart's have nothing else in common, and a save dialog
 * needs nothing else from either.
 */
export interface FileFormatDescriptor {
  readonly label: string;
  readonly extension: string;
  readonly mimeType: string;
}

export interface ExportFormatDescriptor extends FileFormatDescriptor {
  readonly format: ExportFormat;
  /**
   * Rows the *format* cannot exceed, header row included, or `null` when only
   * patience limits it. This is a property of the file format, not a budget
   * Panorama chose: a spreadsheet has a last row and Parquet does not.
   */
  readonly maxRows: number | null;
  readonly maxColumns: number | null;
}

/**
 * Excel's grid is finite — 2^20 rows by 2^14 columns — and it has been since
 * 2007. Exceeding it does not produce a large spreadsheet, it produces a file
 * Excel refuses, so the limit is checked before a byte is written.
 */
const XLSX_MAX_ROWS = 1_048_576;
const XLSX_MAX_COLUMNS = 16_384;

export const EXPORT_FORMATS: Readonly<Record<ExportFormat, ExportFormatDescriptor>> = Object.freeze(
  {
    csv: Object.freeze({
      format: 'csv',
      label: 'CSV',
      extension: '.csv',
      mimeType: 'text/csv',
      maxRows: null,
      maxColumns: null,
    }),
    xlsx: Object.freeze({
      format: 'xlsx',
      label: 'Excel',
      extension: '.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      maxRows: XLSX_MAX_ROWS,
      maxColumns: XLSX_MAX_COLUMNS,
    }),
    parquet: Object.freeze({
      format: 'parquet',
      label: 'Parquet',
      extension: '.parquet',
      mimeType: 'application/vnd.apache.parquet',
      maxRows: null,
      maxColumns: null,
    }),
  },
);

export const EXPORT_FORMAT_ORDER: readonly ExportFormat[] = Object.freeze([
  'csv',
  'xlsx',
  'parquet',
]);

export const describeFormat = (format: ExportFormat): ExportFormatDescriptor =>
  EXPORT_FORMATS[format];

/** Rows of *data* the format has room for, once the header has taken one. */
export const maxDataRows = (format: ExportFormat): number | null => {
  const limit = EXPORT_FORMATS[format].maxRows;
  return limit === null ? null : limit - 1;
};

/**
 * Characters no filesystem agrees on, plus the ones a shell would reinterpret.
 * Replaced rather than stripped so `SALES.ORDERS` stays two readable words.
 */
const UNSAFE_FILENAME = /[^\p{L}\p{N}._-]+/gu;

/**
 * A filename for a table's export, e.g. `SALES.ORDERS.parquet`.
 *
 * Only ever a *suggestion*: the save dialog is the user's, and they rename
 * whatever they like. It exists so the common case needs no typing.
 */
export const exportFileName = (displayName: string, format: ExportFormat): string => {
  const cleaned = displayName.replace(UNSAFE_FILENAME, '_').replace(/^_+|_+$/gu, '');
  const stem = cleaned === '' ? 'export' : cleaned;
  return `${stem}${EXPORT_FORMATS[format].extension}`;
};

export type ExportErrorCode =
  'no-columns' | 'row-limit' | 'column-limit' | 'value-out-of-range' | 'aborted';

/**
 * A failure that belongs to the export rather than to the database.
 *
 * Separate from `TableDataError` on purpose: a row limit or an out-of-range
 * decimal says nothing about the connection, and the UI reports it as a
 * property of the file the user asked for.
 */
export class ExportError extends Error {
  readonly code: ExportErrorCode;

  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

export const isExportError = (value: unknown): value is ExportError => value instanceof ExportError;
