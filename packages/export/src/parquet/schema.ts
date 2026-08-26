import type { ColumnDataType } from '@panorama/core';
import type { TableColumnSchema } from '@panorama/table';

/**
 * How a database column becomes a Parquet column.
 *
 * The rule is one sentence: **Parquet gets the type the database declared
 * wherever that mapping is exact, and the text the database sent wherever it is
 * not.**
 *
 * So booleans, doubles, decimals and dates are written as Parquet's own
 * BOOLEAN, DOUBLE, DECIMAL and DATE — a reader gets numbers it can sum and
 * dates it can compare, and a DECIMAL(36,2) keeps every one of its digits
 * because Parquet, unlike a spreadsheet, has an exact decimal of its own.
 * Timestamps, intervals, geometries and hashes stay strings: Exasol delivers
 * them as text, their meaning is bound up in a session's time zone or in a
 * spatial reference the file has no room for, and a string is at least exactly
 * what the database said. Reinterpreting them would be guessing, and guessing
 * quietly is the one thing an export must not do.
 *
 * Unlike the spreadsheet encoder, this mapping is fixed *per column* before the
 * first row is read. It has to be: a Parquet column has one physical type for
 * the whole file, while the vectors arriving from the driver may represent the
 * same DECIMAL column as numbers in one batch and digits in the next.
 */

/** `Type` in parquet.thrift. */
export const PHYSICAL_BOOLEAN = 0;
export const PHYSICAL_INT32 = 1;
export const PHYSICAL_INT64 = 2;
export const PHYSICAL_DOUBLE = 5;
export const PHYSICAL_BYTE_ARRAY = 6;
export const PHYSICAL_FIXED_LEN_BYTE_ARRAY = 7;

/** `ConvertedType`, the pre-2018 spelling every reader still understands. */
export const CONVERTED_UTF8 = 0;
export const CONVERTED_DECIMAL = 5;
export const CONVERTED_DATE = 6;

/** Field ids of the `LogicalType` union. */
export const LOGICAL_STRING_FIELD = 1;
export const LOGICAL_DECIMAL_FIELD = 5;
export const LOGICAL_DATE_FIELD = 6;

export type ParquetLogical = 'none' | 'string' | 'decimal' | 'date';

export interface ParquetColumn {
  readonly name: string;
  readonly physical: number;
  /** Set only for FIXED_LEN_BYTE_ARRAY. */
  readonly typeLength?: number;
  readonly logical: ParquetLogical;
  readonly precision?: number;
  readonly scale?: number;
}

/** Largest precision Parquet's DECIMAL is universally read at. */
const MAX_DECIMAL_PRECISION = 38;
/** Above this an exact integer needs more than the 64 bits of an INT64. */
const MAX_INT64_PRECISION = 18;

const LOG2_10 = Math.log2(10);

/**
 * Smallest two's-complement width that holds every value of a given precision:
 * the digits, plus one bit for the sign, rounded up to whole bytes.
 */
export const decimalByteWidth = (precision: number): number =>
  Math.ceil((precision * LOG2_10 + 1) / 8);

const stringColumn = (name: string): ParquetColumn => ({
  name,
  physical: PHYSICAL_BYTE_ARRAY,
  logical: 'string',
});

const decimalColumn = (name: string, precision: number, scale: number): ParquetColumn => {
  if (precision <= MAX_INT64_PRECISION) {
    return { name, physical: PHYSICAL_INT64, logical: 'decimal', precision, scale };
  }
  return {
    name,
    physical: PHYSICAL_FIXED_LEN_BYTE_ARRAY,
    typeLength: decimalByteWidth(precision),
    logical: 'decimal',
    precision,
    scale,
  };
};

export const parquetColumn = (name: string, type: ColumnDataType): ParquetColumn => {
  switch (type.kind) {
    case 'boolean':
      return { name, physical: PHYSICAL_BOOLEAN, logical: 'none' };
    case 'double':
      return { name, physical: PHYSICAL_DOUBLE, logical: 'none' };
    case 'decimal': {
      const precision = type.precision;
      // A DECIMAL whose precision the database did not state cannot be given
      // one here: a guess that is too small corrupts the largest values. The
      // digits it sent are kept instead.
      if (precision === undefined || precision > MAX_DECIMAL_PRECISION) return stringColumn(name);
      return decimalColumn(name, precision, type.scale ?? 0);
    }
    case 'date':
      return { name, physical: PHYSICAL_INT32, logical: 'date' };
    default:
      return stringColumn(name);
  }
};

export const parquetColumns = (columns: readonly TableColumnSchema[]): readonly ParquetColumn[] =>
  columns.map((column) => parquetColumn(column.name, column.type));
