import { cellValue, formatCell } from '@panorama/table';
import type { ColumnVector, ResultChunk, TableColumnSchema } from '@panorama/table';
import type { EncoderOptions, RowEncoder } from './encoder.js';
import { encodeUtf8 } from './bytes.js';
import { requireVectors } from './encoder.js';

/**
 * RFC 4180 CSV.
 *
 * Two decisions are worth stating, because both are the kind of thing that
 * quietly corrupts a spreadsheet:
 *
 * **A NULL is nothing and an empty string is `""`.** They are different values
 * and a data file that renders them identically has thrown information away.
 * Quoting the empty string is the only way CSV has of telling them apart, so an
 * empty field is always quoted even though nothing forces it to be.
 *
 * **The locale is pinned.** `formatCell` is shared with the renderer so that
 * what the file says and what the screen says can never drift — but a decimal
 * comma beside a comma delimiter is not a formatting preference, it is an
 * unparseable file. A data file is read by a machine, so the machine's
 * convention wins and the separator is always a point.
 */

/** Not a display locale: the one that spells a decimal point as a point. */
const DATA_LOCALE = 'en-US';

const CRLF = '\r\n';

export interface CsvOptions {
  readonly delimiter?: string;
  /**
   * Prefixes the byte-order mark. Excel reads a BOM-less UTF-8 CSV as the
   * system code page and mangles every non-ASCII name in it, so this defaults
   * to on: the file's first job is to open correctly where it will be opened.
   */
  readonly byteOrderMark?: boolean;
}

const BOM = '﻿';

/**
 * Wraps a field in quotes when CSV requires it — or when it is empty, which is
 * how a NULL is kept distinct from an empty string.
 */
export const csvField = (text: string, delimiter: string): string => {
  if (text === '') return '""';
  const needsQuotes =
    text.includes(delimiter) || text.includes('"') || text.includes('\n') || text.includes('\r');
  return needsQuotes ? `"${text.replaceAll('"', '""')}"` : text;
};

export const createCsvEncoder = (options: EncoderOptions & CsvOptions): RowEncoder => {
  const { schema, sink } = options;
  const delimiter = options.delimiter ?? ',';
  const columns = schema.columns;

  const writeText = async (text: string): Promise<void> => {
    await sink.write(encodeUtf8(text));
  };

  return {
    async begin(): Promise<void> {
      const prefix = options.byteOrderMark === false ? '' : BOM;
      const header = columns.map((column) => csvField(column.name, delimiter)).join(delimiter);
      await writeText(`${prefix}${header}${CRLF}`);
    },

    async write(batch: ResultChunk): Promise<void> {
      requireVectors(batch, columns.length);
      // One string per batch rather than per cell: the whole batch is encoded
      // in a single pass, which is what keeps a wide relation from spending its
      // time in the text encoder.
      const lines: string[] = [];
      const fields: string[] = new Array<string>(columns.length);
      for (let row = 0; row < batch.rowCount; row += 1) {
        for (let index = 0; index < columns.length; index += 1) {
          const vector = batch.columns[index] as ColumnVector;
          const column = columns[index] as TableColumnSchema;
          const value = cellValue(vector, row);
          // A NULL is an empty field with no quotes; every other value gets
          // quoted when it is empty, so the two never look alike.
          fields[index] =
            value === null
              ? ''
              : csvField(formatCell(value, column.type, { locale: DATA_LOCALE }), delimiter);
        }
        lines.push(fields.join(delimiter));
      }
      if (lines.length > 0) await writeText(`${lines.join(CRLF)}${CRLF}`);
    },

    async finish(): Promise<void> {
      /* CSV has no trailer. */
    },
  };
};
