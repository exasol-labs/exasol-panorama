import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import {
  DICTIONARY_MIN_ROWS,
  buildBoolVector,
  buildDictionaryVector,
  buildFloat64Vector,
  buildStringVector,
  buildTextVector,
  buildVector,
  cellValue,
  chunkByteSize,
  chunkTransferables,
  createResultChunk,
  isNull,
  vectorByteSize,
} from '@panorama/table';

const repeat = <T>(value: T, times: number): T[] => Array.from({ length: times }, () => value);

describe('float64 vectors', () => {
  it('stores numbers and marks nulls', () => {
    const vector = buildFloat64Vector([1, null, 3.5, undefined]);
    expect(vector.length).toBe(4);
    expect(cellValue(vector, 0)).toBe(1);
    expect(cellValue(vector, 1)).toBeNull();
    expect(cellValue(vector, 2)).toBe(3.5);
    expect(cellValue(vector, 3)).toBeNull();
    expect(isNull(vector, 1)).toBe(true);
  });

  it('coerces numeric strings and rejects non-numeric ones', () => {
    const vector = buildFloat64Vector(['42', 'abc']);
    expect(cellValue(vector, 0)).toBe(42);
    expect(cellValue(vector, 1)).toBeNull();
  });

  it('keeps a genuine NaN value present', () => {
    const vector = buildFloat64Vector([Number.NaN]);
    expect(isNull(vector, 0)).toBe(false);
    expect(Number.isNaN(cellValue(vector, 0) as number)).toBe(true);
  });
});

describe('bool vectors', () => {
  it('accepts the shapes the protocol may deliver', () => {
    const vector = buildBoolVector([true, false, 1, 0, 'true', null]);
    expect([0, 1, 2, 3, 4, 5].map((index) => cellValue(vector, index))).toEqual([
      true,
      false,
      true,
      false,
      true,
      null,
    ]);
  });
});

describe('text vectors', () => {
  it('concatenates into one blob with offsets', () => {
    const vector = buildTextVector(['alpha', null, 'beta', '']);
    expect(vector.data).toBe('alphabeta');
    expect(cellValue(vector, 0)).toBe('alpha');
    expect(cellValue(vector, 1)).toBeNull();
    expect(cellValue(vector, 2)).toBe('beta');
    expect(cellValue(vector, 3)).toBe('');
  });

  it('stringifies non-string values', () => {
    const vector = buildTextVector([123, true]);
    expect(cellValue(vector, 0)).toBe('123');
    expect(cellValue(vector, 1)).toBe('true');
  });
});

describe('dictionary vectors', () => {
  it('shares repeated values', () => {
    const vector = buildDictionaryVector(['DE', 'DK', 'DE', null, 'DE']);
    expect(vector.dictionary).toEqual(['DE', 'DK']);
    expect(cellValue(vector, 0)).toBe('DE');
    expect(cellValue(vector, 3)).toBeNull();
    expect(cellValue(vector, 4)).toBe('DE');
  });
});

describe('buildStringVector', () => {
  it('uses a text blob for short columns', () => {
    expect(buildStringVector(['a', 'b']).kind).toBe('text');
  });

  it('dictionary-encodes low-cardinality columns', () => {
    const values = repeat('Germany', DICTIONARY_MIN_ROWS);
    expect(buildStringVector(values).kind).toBe('dictionary');
  });

  it('falls back to text for high-cardinality columns', () => {
    const values = Array.from({ length: 64 }, (_, index) => `value-${index}`);
    expect(buildStringVector(values).kind).toBe('text');
  });

  it('ignores nulls when measuring cardinality', () => {
    const values = [...repeat(null, DICTIONARY_MIN_ROWS), 'x'];
    expect(buildStringVector(values).kind).toBe('dictionary');
  });
});

describe('buildVector', () => {
  it('maps declared types onto representations', () => {
    expect(buildVector(dataType('double', 'DOUBLE'), [1]).kind).toBe('float64');
    expect(buildVector(dataType('decimal', 'DECIMAL(9,0)'), [1]).kind).toBe('float64');
    expect(buildVector(dataType('boolean', 'BOOLEAN'), [true]).kind).toBe('bool');
    expect(buildVector(dataType('date', 'DATE'), ['2026-08-21']).kind).toBe('text');
  });

  it('keeps high-precision decimals textual', () => {
    const vector = buildVector(dataType('decimal', 'DECIMAL(36,0)'), [
      '123456789012345678901234567890',
    ]);
    expect(vector.kind).toBe('text');
    expect(cellValue(vector, 0)).toBe('123456789012345678901234567890');
  });
});

describe('cell access', () => {
  it('reads out-of-range indices as null', () => {
    const vector = buildFloat64Vector([1]);
    expect(cellValue(vector, -1)).toBeNull();
    expect(cellValue(vector, 5)).toBeNull();
    expect(isNull(vector, 5)).toBe(true);
  });
});

describe('byte accounting', () => {
  it('measures every representation', () => {
    expect(vectorByteSize(buildFloat64Vector([1, 2]))).toBe(2 + 16);
    expect(vectorByteSize(buildBoolVector([true, false]))).toBe(2 + 2);
    const text = buildTextVector(['ab', 'cd']);
    expect(vectorByteSize(text)).toBe(2 + text.offsets.byteLength + 8);
    const dict = buildDictionaryVector(['ab', 'ab']);
    expect(vectorByteSize(dict)).toBe(2 + dict.codes.byteLength + 4);
  });

  it('sums a chunk', () => {
    const columns = [buildFloat64Vector([1, 2]), buildTextVector(['a', 'b'])];
    const chunk = createResultChunk(1024, 2, columns);
    expect(chunk.startRow).toBe(1024);
    expect(chunk.rowCount).toBe(2);
    expect(chunk.byteSize).toBe(chunkByteSize(columns));
  });
});

describe('chunkTransferables', () => {
  it('lists every backing buffer exactly once per vector', () => {
    const chunk = createResultChunk(0, 2, [
      buildFloat64Vector([1, 2]),
      buildBoolVector([true, false]),
      buildTextVector(['a', 'b']),
      buildDictionaryVector(['x', 'x']),
    ]);
    const buffers = chunkTransferables(chunk);
    expect(buffers).toHaveLength(8);
    expect(new Set(buffers).size).toBe(8);
  });
});
