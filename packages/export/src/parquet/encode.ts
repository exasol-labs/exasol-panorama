import type { ColumnDataType } from '@panorama/core';
import type { CellValue, ColumnVector } from '@panorama/table';
import { cellValue, formatCell, isNull } from '@panorama/table';
import { ByteWriter, encodeUtf8 } from '../bytes.js';
import { ExportError } from '../format.js';
import type { ParquetColumn } from './schema.js';
import {
  PHYSICAL_BOOLEAN,
  PHYSICAL_DOUBLE,
  PHYSICAL_FIXED_LEN_BYTE_ARRAY,
  PHYSICAL_INT32,
  PHYSICAL_INT64,
} from './schema.js';

/**
 * Turning vectors into Parquet's PLAIN encoding, and nulls into definition
 * levels.
 *
 * Only PLAIN is emitted. Dictionary and delta encodings would make the file
 * smaller, but the rows here have already crossed a network once and the useful
 * compression — of the pages themselves — is a codec's job rather than an
 * encoding's. PLAIN is also the one encoding every reader has supported since
 * the format existed, which for an export is worth more than a smaller file.
 */

/** Same reasoning as CSV: a data file spells a decimal point as a point. */
const DATA_LOCALE = 'en-US';

const MS_PER_DAY = 86_400_000;

/**
 * Definition levels for one column of a page.
 *
 * Every exported column is `optional`, because every SQL column can be NULL, so
 * each row carries a level: 1 for a value, 0 for a NULL. The levels are written
 * with Parquet's RLE/bit-packing hybrid, which for a one-bit width is simply a
 * run length and the repeated bit — and real data is overwhelmingly runs, so a
 * page of a million non-null values spends about four bytes saying so.
 *
 * The four-byte length prefix is part of a v1 data page's layout, not of the RLE
 * encoding itself.
 */
export const encodeDefinitionLevels = (vector: ColumnVector, rowCount: number): Uint8Array => {
  const runs = new ByteWriter(64);
  let index = 0;
  while (index < rowCount) {
    const level = isNull(vector, index) ? 0 : 1;
    let length = 1;
    while (index + length < rowCount && (isNull(vector, index + length) ? 0 : 1) === level) {
      length += 1;
    }
    // An RLE run: the length, shifted left to leave room for the flag bit that
    // distinguishes it from a bit-packed run, then the value in one byte.
    runs.varint(length << 1);
    runs.u8(level);
    index += length;
  }
  const out = new ByteWriter(runs.length + 4);
  out.u32(runs.length);
  out.bytes(runs.view());
  return out.view().slice();
};

const DECIMAL_PATTERN = /^([+-]?)(\d*)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/u;

/**
 * A decimal literal as the unscaled integer Parquet stores, or `null` when the
 * text is not a number at all.
 *
 * Exasol sends a high-precision DECIMAL as digits rather than as a JSON number,
 * specifically so that none of them are lost on the way — throwing them into a
 * double here would undo that, so the digits are rescaled with integer
 * arithmetic and never touch a float. Rescaling *down* rounds half away from
 * zero, which is what every database and every spreadsheet does.
 */
export const decimalUnscaled = (text: string, scale: number): bigint | null => {
  const match = DECIMAL_PATTERN.exec(text.trim());
  if (match === null) return null;
  const [, sign, whole = '', fraction = '', exponent = '0'] = match;
  const digits = `${whole}${fraction}`;
  if (digits === '') return null;
  const shift = Number(exponent) - fraction.length + scale;
  let unscaled = BigInt(digits);
  if (shift >= 0) {
    unscaled *= 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    const quotient = unscaled / divisor;
    unscaled = (unscaled % divisor) * 2n >= divisor ? quotient + 1n : quotient;
  }
  return sign === '-' ? -unscaled : unscaled;
};

const decimalOf = (value: CellValue, column: ParquetColumn, scale: number): bigint => {
  const text = typeof value === 'string' ? value : String(value);
  const unscaled = decimalUnscaled(text, scale);
  const precision = column.precision as number;
  if (unscaled === null || (unscaled < 0n ? -unscaled : unscaled) >= 10n ** BigInt(precision)) {
    throw new ExportError(
      'value-out-of-range',
      `${column.name}: ${text} does not fit the column's declared DECIMAL(${precision},${scale})`,
    );
  }
  return unscaled;
};

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/u;

/**
 * An ISO date as the day count from 1970-01-01 that Parquet's DATE is.
 *
 * The year is set explicitly rather than passed to `Date.UTC`, which reads a
 * year below 100 as an abbreviation for one in the 1900s — so a date in the year
 * 0042 would silently become 1942.
 */
export const dateDays = (text: string): number | null => {
  const match = DATE_PATTERN.exec(text);
  if (match === null) return null;
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round(date.getTime() / MS_PER_DAY);
};

const dateOf = (value: CellValue, column: ParquetColumn): number => {
  const days = typeof value === 'string' ? dateDays(value) : null;
  if (days === null) {
    throw new ExportError('value-out-of-range', `${column.name}: ${String(value)} is not a date`);
  }
  return days;
};

/** Two's complement, big-endian, in exactly `width` bytes. */
export const twosComplement = (value: bigint, width: number): Uint8Array => {
  const bytes = new Uint8Array(width);
  let remaining = value < 0n ? value + (1n << BigInt(width * 8)) : value;
  for (let index = width - 1; index >= 0; index -= 1) {
    bytes[index] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return bytes;
};

/**
 * Appends a vector's non-null values to `out` in PLAIN encoding.
 *
 * Read through `cellValue` rather than off the typed arrays directly: the same
 * logical column arrives as a float vector in one batch and a dictionary in the
 * next, and a Parquet column has one physical type for the whole file. Going
 * through the value keeps that difference where it belongs — in the vector — and
 * out of every branch here.
 */
export const encodeValues = (
  column: ParquetColumn,
  type: ColumnDataType,
  vector: ColumnVector,
  rowCount: number,
  out: ByteWriter,
): void => {
  if (column.physical === PHYSICAL_BOOLEAN) {
    // Bit-packed, least significant bit first, over the non-null values only.
    let bits = 0;
    let filled = 0;
    for (let index = 0; index < rowCount; index += 1) {
      if (isNull(vector, index)) continue;
      if (cellValue(vector, index) === true) bits |= 1 << filled;
      filled += 1;
      if (filled === 8) {
        out.u8(bits);
        bits = 0;
        filled = 0;
      }
    }
    if (filled > 0) out.u8(bits);
    return;
  }

  for (let index = 0; index < rowCount; index += 1) {
    if (isNull(vector, index)) continue;
    const value = cellValue(vector, index);
    switch (column.physical) {
      case PHYSICAL_DOUBLE:
        out.f64(Number(value));
        break;
      case PHYSICAL_INT64:
        out.i64(decimalOf(value, column, column.scale as number));
        break;
      case PHYSICAL_INT32:
        out.i32(dateOf(value, column));
        break;
      case PHYSICAL_FIXED_LEN_BYTE_ARRAY:
        out.bytes(
          twosComplement(
            decimalOf(value, column, column.scale as number),
            column.typeLength as number,
          ),
        );
        break;
      default: {
        // BYTE_ARRAY: a four-byte length and then the UTF-8.
        const bytes = encodeUtf8(
          typeof value === 'string' ? value : formatCell(value, type, { locale: DATA_LOCALE }),
        );
        out.u32(bytes.length);
        out.bytes(bytes);
      }
    }
  }
};
