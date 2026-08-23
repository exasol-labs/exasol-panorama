import type { ColumnDataType } from '@panorama/core';

/**
 * Column-oriented result chunks.
 *
 * Cached regions are never kept as arrays of row objects: a million-row cache
 * of `{ ORDER_ID, COUNTRY, REVENUE }` objects would allocate millions of small
 * objects and make memory unpredictable. Instead each column is one typed
 * array (or one shared string plus offsets), which is compact, cheap to
 * transfer between workers, and allocates per *visible* cell rather than per
 * cached cell.
 */

/** 1 = the value is present, 0 = SQL NULL. One byte per row keeps access branch-free. */
export type Validity = Uint8Array;

export interface Float64Vector {
  readonly kind: 'float64';
  readonly length: number;
  readonly values: Float64Array;
  readonly validity: Validity;
}

export interface BoolVector {
  readonly kind: 'bool';
  readonly length: number;
  readonly values: Uint8Array;
  readonly validity: Validity;
}

/** All strings concatenated once, with `length + 1` offsets into the blob. */
export interface TextVector {
  readonly kind: 'text';
  readonly length: number;
  readonly data: string;
  readonly offsets: Int32Array;
  readonly validity: Validity;
}

/** Low-cardinality strings: a shared dictionary plus one code per row. */
export interface DictionaryVector {
  readonly kind: 'dictionary';
  readonly length: number;
  readonly dictionary: readonly string[];
  readonly codes: Int32Array;
  readonly validity: Validity;
}

export type ColumnVector = Float64Vector | BoolVector | TextVector | DictionaryVector;

export type CellValue = number | string | boolean | null;

/** A contiguous, column-oriented range of an open result set. */
export interface ResultChunk {
  /** Zero-based position of the first row within the result set. */
  readonly startRow: number;
  readonly rowCount: number;
  /** One vector per result-set column, in schema order. */
  readonly columns: readonly ColumnVector[];
  /** Approximate retained size in bytes; used for cache accounting. */
  readonly byteSize: number;
}

const BYTES_PER_CHAR = 2;
const VALIDITY_BYTES_PER_ROW = 1;

/** Cardinality ratio below which a string column is dictionary-encoded. */
export const DICTIONARY_RATIO = 0.5;
/** Dictionary encoding is pointless for tiny columns. */
export const DICTIONARY_MIN_ROWS = 16;

export const vectorByteSize = (vector: ColumnVector): number => {
  const validity = vector.length * VALIDITY_BYTES_PER_ROW;
  switch (vector.kind) {
    case 'float64':
      return validity + vector.values.byteLength;
    case 'bool':
      return validity + vector.values.byteLength;
    case 'text':
      return validity + vector.offsets.byteLength + vector.data.length * BYTES_PER_CHAR;
    case 'dictionary':
      return (
        validity +
        vector.codes.byteLength +
        vector.dictionary.reduce((total, value) => total + value.length * BYTES_PER_CHAR, 0)
      );
  }
};

export const chunkByteSize = (columns: readonly ColumnVector[]): number =>
  columns.reduce((total, vector) => total + vectorByteSize(vector), 0);

export const createResultChunk = (
  startRow: number,
  rowCount: number,
  columns: readonly ColumnVector[],
): ResultChunk => ({
  startRow,
  rowCount,
  columns,
  byteSize: chunkByteSize(columns),
});

const isNullish = (value: unknown): boolean => value === null || value === undefined;

export const buildFloat64Vector = (values: readonly unknown[]): Float64Vector => {
  const length = values.length;
  const data = new Float64Array(length);
  const validity = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (isNullish(value)) continue;
    const numeric = typeof value === 'number' ? value : Number(value);
    if (Number.isNaN(numeric) && typeof value !== 'number') continue;
    data[index] = numeric;
    validity[index] = 1;
  }
  return { kind: 'float64', length, values: data, validity };
};

export const buildBoolVector = (values: readonly unknown[]): BoolVector => {
  const length = values.length;
  const data = new Uint8Array(length);
  const validity = new Uint8Array(length);
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (isNullish(value)) continue;
    data[index] = value === true || value === 1 || value === 'true' ? 1 : 0;
    validity[index] = 1;
  }
  return { kind: 'bool', length, values: data, validity };
};

const toText = (value: unknown): string => (typeof value === 'string' ? value : String(value));

export const buildTextVector = (values: readonly unknown[]): TextVector => {
  const length = values.length;
  const offsets = new Int32Array(length + 1);
  const validity = new Uint8Array(length);
  const parts: string[] = [];
  let cursor = 0;
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    offsets[index] = cursor;
    if (isNullish(value)) continue;
    const text = toText(value);
    parts.push(text);
    cursor += text.length;
    validity[index] = 1;
  }
  offsets[length] = cursor;
  return { kind: 'text', length, data: parts.join(''), offsets, validity };
};

export const buildDictionaryVector = (values: readonly unknown[]): DictionaryVector => {
  const length = values.length;
  const codes = new Int32Array(length);
  const validity = new Uint8Array(length);
  const dictionary: string[] = [];
  const lookup = new Map<string, number>();
  for (let index = 0; index < length; index += 1) {
    const value = values[index];
    if (isNullish(value)) continue;
    const text = toText(value);
    let code = lookup.get(text);
    if (code === undefined) {
      code = dictionary.length;
      dictionary.push(text);
      lookup.set(text, code);
    }
    codes[index] = code;
    validity[index] = 1;
  }
  return { kind: 'dictionary', length, dictionary, codes, validity };
};

/** Dictionary-encodes repetitive string columns and falls back to a text blob. */
export const buildStringVector = (values: readonly unknown[]): TextVector | DictionaryVector => {
  if (values.length < DICTIONARY_MIN_ROWS) return buildTextVector(values);
  const distinct = new Set<string>();
  for (const value of values) {
    if (isNullish(value)) continue;
    distinct.add(toText(value));
    if (distinct.size > values.length * DICTIONARY_RATIO) return buildTextVector(values);
  }
  return buildDictionaryVector(values);
};

/**
 * Chooses a vector representation for a column of raw protocol values.
 *
 * Exasol sends high-precision DECIMALs as strings to avoid losing digits in
 * JSON, so those stay textual rather than being forced through a float.
 */
export const buildVector = (type: ColumnDataType, values: readonly unknown[]): ColumnVector => {
  switch (type.kind) {
    case 'double':
      return buildFloat64Vector(values);
    case 'decimal':
      return values.some((value) => typeof value === 'string')
        ? buildStringVector(values)
        : buildFloat64Vector(values);
    case 'boolean':
      return buildBoolVector(values);
    default:
      return buildStringVector(values);
  }
};

export const isNull = (vector: ColumnVector, index: number): boolean =>
  index < 0 || index >= vector.length || vector.validity[index] !== 1;

/** Reads one cell. Out-of-range indices and SQL NULLs both read as `null`. */
export const cellValue = (vector: ColumnVector, index: number): CellValue => {
  if (isNull(vector, index)) return null;
  switch (vector.kind) {
    case 'float64':
      return vector.values[index] as number;
    case 'bool':
      return vector.values[index] === 1;
    case 'text': {
      const start = vector.offsets[index] as number;
      const end = vector.offsets[index + 1] as number;
      return vector.data.slice(start, end);
    }
    case 'dictionary':
      return vector.dictionary[vector.codes[index] as number] as string;
  }
};

/** Collects the transferable buffers of a chunk so worker hand-off avoids copies. */
export const chunkTransferables = (chunk: ResultChunk): ArrayBuffer[] => {
  const buffers: ArrayBuffer[] = [];
  for (const vector of chunk.columns) {
    buffers.push(vector.validity.buffer as ArrayBuffer);
    switch (vector.kind) {
      case 'float64':
      case 'bool':
        buffers.push(vector.values.buffer as ArrayBuffer);
        break;
      case 'text':
        buffers.push(vector.offsets.buffer as ArrayBuffer);
        break;
      case 'dictionary':
        buffers.push(vector.codes.buffer as ArrayBuffer);
        break;
    }
  }
  return buffers;
};
