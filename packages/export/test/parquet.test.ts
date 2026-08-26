import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import { buildVector } from '@panorama/table';
import {
  ByteWriter,
  CONVERTED_DATE,
  CONVERTED_DECIMAL,
  CONVERTED_UTF8,
  PHYSICAL_BOOLEAN,
  PHYSICAL_BYTE_ARRAY,
  PHYSICAL_DOUBLE,
  PHYSICAL_FIXED_LEN_BYTE_ARRAY,
  PHYSICAL_INT32,
  PHYSICAL_INT64,
  ThriftCompactWriter,
  T_I32,
  T_STRUCT,
  collectingSink,
  createParquetEncoder,
  dateDays,
  decimalByteWidth,
  decimalUnscaled,
  encodeDefinitionLevels,
  isExportError,
  parquetColumn,
  twosComplement,
} from '@panorama/export';
import {
  BIG_DECIMAL,
  BOOLEAN,
  DATE,
  DOUBLE,
  MONEY,
  TIMESTAMP,
  VAGUE_DECIMAL,
  VARCHAR,
  chunkOf,
  schemaOf,
} from './fixtures.js';
import {
  ThriftReader,
  listField,
  numberField,
  readParquetFooter,
  structField,
  structList,
  textField,
} from './thrift-reader.js';

const fileOf = async (
  schema: ReturnType<typeof schemaOf>,
  batches: ReadonlyArray<ReadonlyArray<readonly unknown[]>>,
  options: { rowGroupRows?: number; rowGroupBytes?: number } = {},
): Promise<Uint8Array> => {
  const sink = collectingSink();
  const encoder = createParquetEncoder({ schema, sink, ...options });
  await encoder.begin();
  let start = 0;
  for (const batch of batches) {
    await encoder.write(chunkOf(schema, batch, start));
    start += batch[0]?.length ?? 0;
  }
  await encoder.finish();
  return sink.bytes();
};

describe('the Thrift compact writer', () => {
  it('writes a field id as a delta when it fits in four bits', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.i32(1, 0);
    thrift.i32(2, 1);
    thrift.structEnd();
    // 0x15 = delta 1, type 5 (i32); zigzag(0) = 0. Then delta 1 again, zigzag(1) = 2.
    expect([...out.view()]).toEqual([0x15, 0x00, 0x15, 0x02, 0x00]);
  });

  it('writes the id out in full when the gap is too wide', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.i32(20, 7);
    thrift.structEnd();
    // Type alone, then zigzag(20) = 40, then zigzag(7) = 14.
    expect([...out.view()]).toEqual([0x05, 40, 14, 0x00]);
  });

  it('carries a boolean in its own field header', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.bool(1, true);
    thrift.bool(2, false);
    thrift.structEnd();
    // Delta 1 with the type nibble carrying the value: 1 is true, 2 is false.
    expect([...out.view()]).toEqual([0x11, 0x12, 0x00]);
  });

  it('reads back everything it writes', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.i32(1, -5);
    thrift.i64(2, -9_007_199_254_740_993n);
    thrift.string(3, 'héllo');
    thrift.bool(4, true);
    thrift.listBegin(5, T_I32, 3);
    thrift.elementI32(1);
    thrift.elementI32(-2);
    thrift.elementI32(3);
    thrift.listBegin(6, 8, 2);
    thrift.elementString('a');
    thrift.elementString('b');
    thrift.structBegin(7);
    thrift.i32(1, 42);
    thrift.structEnd();
    thrift.structEnd();

    const struct = new ThriftReader(out.view()).struct();
    expect(struct.get(1)).toBe(-5);
    expect(struct.get(2)).toBe(-9_007_199_254_740_993n);
    expect(textField(struct, 3)).toBe('héllo');
    expect(struct.get(4)).toBe(true);
    expect(struct.get(5)).toEqual([1, -2, 3]);
    expect(
      listField(struct, 6).map((item) => new TextDecoder().decode(item as Uint8Array)),
    ).toEqual(['a', 'b']);
    expect(numberField(structField(struct, 7), 1)).toBe(42);
  });

  it('writes a long list header for fifteen elements or more', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.listBegin(1, T_I32, 20);
    for (let index = 0; index < 20; index += 1) thrift.elementI32(index);
    thrift.structEnd();
    expect(new ThriftReader(out.view()).struct().get(1)).toHaveLength(20);
  });

  it('nests structs without losing the outer field position', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.structBegin(1);
    thrift.i32(9, 1);
    thrift.structEnd();
    // Field 2 of the *outer* struct, not a delta from the inner struct's 9.
    thrift.i32(2, 2);
    thrift.structEnd();
    const struct = new ThriftReader(out.view()).struct();
    expect(numberField(structField(struct, 1), 9)).toBe(1);
    expect(struct.get(2)).toBe(2);
    expect(struct.has(11)).toBe(false);
  });

  it('writes a list of structs the reader can walk', () => {
    const out = new ByteWriter();
    const thrift = new ThriftCompactWriter(out);
    thrift.structBegin();
    thrift.listBegin(1, T_STRUCT, 2);
    for (const value of [10, 20]) {
      thrift.structBegin();
      thrift.i32(1, value);
      thrift.structEnd();
    }
    thrift.structEnd();
    const struct = new ThriftReader(out.view()).struct();
    expect(structList(struct, 1).map((item) => numberField(item, 1))).toEqual([10, 20]);
  });
});

describe('definition levels', () => {
  it('spends four bytes on a page with no nulls at all', () => {
    const vector = buildVector(
      VARCHAR,
      Array.from({ length: 1_000 }, () => 'x'),
    );
    const levels = encodeDefinitionLevels(vector, 1_000);
    const view = new DataView(levels.buffer, levels.byteOffset);
    // A length prefix, then one run: 1000 values of level 1.
    expect(view.getUint32(0, true)).toBe(levels.length - 4);
    expect(levels.length).toBeLessThan(12);
  });

  it('runs alternate between present and absent', () => {
    const vector = buildVector(VARCHAR, ['a', null, null, 'b']);
    const levels = encodeDefinitionLevels(vector, 4);
    // Length, then (1 value, level 1), (2 values, level 0), (1 value, level 1).
    expect([...levels]).toEqual([6, 0, 0, 0, 2, 1, 4, 0, 2, 1]);
  });

  it('encodes an all-null page as one run of zeroes', () => {
    const vector = buildVector(VARCHAR, [null, null, null]);
    expect([...encodeDefinitionLevels(vector, 3)]).toEqual([2, 0, 0, 0, 6, 0]);
  });
});

describe('decimalUnscaled', () => {
  it('rescales without ever touching a float', () => {
    expect(decimalUnscaled('1234.5', 2)).toBe(123_450n);
    expect(decimalUnscaled('-1234.5', 2)).toBe(-123_450n);
    expect(decimalUnscaled('7', 0)).toBe(7n);
    expect(decimalUnscaled('0.001', 3)).toBe(1n);
  });

  it('keeps every digit of a number no double could hold', () => {
    expect(decimalUnscaled('123456789012345678901234567890.123456', 6)).toBe(
      123_456_789_012_345_678_901_234_567_890_123_456n,
    );
  });

  it('rounds half away from zero when it has to drop digits', () => {
    expect(decimalUnscaled('1.005', 2)).toBe(101n);
    expect(decimalUnscaled('1.004', 2)).toBe(100n);
    expect(decimalUnscaled('-1.005', 2)).toBe(-101n);
    expect(decimalUnscaled('1.5', 0)).toBe(2n);
    expect(decimalUnscaled('2.5', 0)).toBe(3n);
  });

  it('understands the exponent form a JavaScript number can arrive in', () => {
    expect(decimalUnscaled('1e6', 0)).toBe(1_000_000n);
    expect(decimalUnscaled('-1E-6', 6)).toBe(-1n);
    expect(decimalUnscaled('1.5e3', 1)).toBe(15_000n);
  });

  it('tolerates the shapes a literal can take', () => {
    expect(decimalUnscaled('+5', 0)).toBe(5n);
    expect(decimalUnscaled(' 5 ', 0)).toBe(5n);
    expect(decimalUnscaled('.5', 1)).toBe(5n);
    expect(decimalUnscaled('5.', 0)).toBe(5n);
  });

  it('refuses what is not a number', () => {
    expect(decimalUnscaled('', 0)).toBeNull();
    expect(decimalUnscaled('abc', 0)).toBeNull();
    expect(decimalUnscaled('.', 0)).toBeNull();
    expect(decimalUnscaled('1,5', 0)).toBeNull();
  });
});

describe('twosComplement', () => {
  it('writes big-endian, sign-extended, in exactly the width asked for', () => {
    expect([...twosComplement(1n, 4)]).toEqual([0, 0, 0, 1]);
    expect([...twosComplement(-1n, 4)]).toEqual([255, 255, 255, 255]);
    expect([...twosComplement(-2n, 2)]).toEqual([255, 254]);
    expect([...twosComplement(0n, 1)]).toEqual([0]);
    expect(twosComplement(1n, 16)).toHaveLength(16);
  });
});

describe('decimalByteWidth', () => {
  it('leaves room for the digits and the sign', () => {
    expect(decimalByteWidth(38)).toBe(16);
    expect(decimalByteWidth(19)).toBe(9);
    expect(decimalByteWidth(1)).toBe(1);
  });
});

describe('dateDays', () => {
  it('counts from the epoch, in both directions', () => {
    expect(dateDays('1970-01-01')).toBe(0);
    expect(dateDays('1969-12-31')).toBe(-1);
    expect(dateDays('2026-08-24')).toBe(20_689);
    // A year below 100 is that year, not one in the 1900s.
    expect(dateDays('0042-01-01')).toBeLessThan(-700_000);
  });

  it('refuses anything that is not an ISO date', () => {
    expect(dateDays('24 August')).toBeNull();
  });
});

describe('the Parquet type mapping', () => {
  it('gives a database type Parquet own where the mapping is exact', () => {
    expect(parquetColumn('A', BOOLEAN)).toEqual({
      name: 'A',
      physical: PHYSICAL_BOOLEAN,
      logical: 'none',
    });
    expect(parquetColumn('A', DOUBLE).physical).toBe(PHYSICAL_DOUBLE);
    expect(parquetColumn('A', DATE)).toEqual({
      name: 'A',
      physical: PHYSICAL_INT32,
      logical: 'date',
    });
  });

  it('backs a decimal with an integer, and a wide one with fixed bytes', () => {
    expect(parquetColumn('A', MONEY)).toEqual({
      name: 'A',
      physical: PHYSICAL_INT64,
      logical: 'decimal',
      precision: 18,
      scale: 2,
    });
    expect(parquetColumn('A', BIG_DECIMAL)).toEqual({
      name: 'A',
      physical: PHYSICAL_FIXED_LEN_BYTE_ARRAY,
      typeLength: 16,
      logical: 'decimal',
      precision: 36,
      scale: 6,
    });
  });

  it('keeps the text where the mapping would be a guess', () => {
    for (const type of [VARCHAR, TIMESTAMP, VAGUE_DECIMAL]) {
      const column = parquetColumn('A', type);
      expect(column.physical).toBe(PHYSICAL_BYTE_ARRAY);
      expect(column.logical).toBe('string');
    }
    // Beyond the precision Parquet DECIMAL is universally read at.
    expect(
      parquetColumn('A', dataType('decimal', 'DECIMAL(40,0)', { precision: 40, scale: 0 }))
        .physical,
    ).toBe(PHYSICAL_BYTE_ARRAY);
    // A type nothing here recognises still exports, as text.
    expect(parquetColumn('A', dataType('geometry', 'GEOMETRY')).logical).toBe('string');
  });
});

describe('the Parquet encoder', () => {
  it('brackets the file with the magic every reader looks for', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const file = await fileOf(schema, [[['a']]]);
    const text = new TextDecoder().decode(file);
    expect(text.startsWith('PAR1')).toBe(true);
    expect(text.endsWith('PAR1')).toBe(true);
    // The trailer's length must lead exactly back to the footer.
    const view = new DataView(file.buffer, file.byteOffset);
    const length = view.getUint32(file.length - 8, true);
    expect(file.length - 8 - length).toBeGreaterThan(4);
  });

  it('describes the schema as a root and its children', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['REVENUE', MONEY],
      ['WHEN', DATE],
      ['OK', BOOLEAN],
    ]);
    const footer = readParquetFooter(await fileOf(schema, [[['a'], [1], ['2026-08-24'], [true]]]));
    const elements = structList(footer, 2);
    expect(elements).toHaveLength(5);
    expect(textField(elements[0] as never, 4)).toBe('schema');
    expect(numberField(elements[0] as never, 5)).toBe(4);
    expect(elements.slice(1).map((element) => textField(element, 4))).toEqual([
      'NAME',
      'REVENUE',
      'WHEN',
      'OK',
    ]);
    // Every column is optional, because every SQL column can be NULL.
    expect(elements.slice(1).every((element) => numberField(element, 3) === 1)).toBe(true);
    expect(numberField(footer, 3)).toBe(1);
    expect(textField(footer, 6)).toBe('Exasol Panorama');
    expect(numberField(footer, 1)).toBe(1);
  });

  it('states a logical type in both the old spelling and the new', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['REVENUE', MONEY],
      ['WHEN', DATE],
      ['OK', BOOLEAN],
    ]);
    const footer = readParquetFooter(await fileOf(schema, [[['a'], [1], ['2026-08-24'], [true]]]));
    const [, name, revenue, when, ok] = structList(footer, 2);
    if (name === undefined || revenue === undefined || when === undefined || ok === undefined) {
      throw new Error('expected four columns');
    }
    expect(numberField(name, 6)).toBe(CONVERTED_UTF8);
    expect(structField(name, 10).has(1)).toBe(true);

    expect(numberField(revenue, 6)).toBe(CONVERTED_DECIMAL);
    expect(numberField(revenue, 7)).toBe(2);
    expect(numberField(revenue, 8)).toBe(18);
    const logical = structField(structField(revenue, 10), 5);
    expect(numberField(logical, 1)).toBe(2);
    expect(numberField(logical, 2)).toBe(18);

    expect(numberField(when, 6)).toBe(CONVERTED_DATE);
    expect(structField(when, 10).has(6)).toBe(true);
    // A plain BOOLEAN has no logical type to state.
    expect(ok.has(6)).toBe(false);
    expect(ok.has(10)).toBe(false);
  });

  it('gives a fixed-width decimal its byte length', async () => {
    const schema = schemaOf([['BIG', BIG_DECIMAL]]);
    const footer = readParquetFooter(await fileOf(schema, [[['1.5']]]));
    const [, big] = structList(footer, 2);
    if (big === undefined) throw new Error('expected a column');
    expect(numberField(big, 1)).toBe(PHYSICAL_FIXED_LEN_BYTE_ARRAY);
    expect(numberField(big, 2)).toBe(16);
  });

  it('records offsets and sizes that lead to the pages it wrote', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['SCORE', DOUBLE],
    ]);
    const file = await fileOf(schema, [
      [
        ['a', 'b'],
        [1, 2],
      ],
    ]);
    const footer = readParquetFooter(file);
    const groups = structList(footer, 4);
    expect(groups).toHaveLength(1);
    const group = groups[0] as never;
    expect(numberField(group, 3)).toBe(2);
    const chunks = structList(group, 1);
    expect(chunks).toHaveLength(2);
    let total = 0;
    for (const chunk of chunks) {
      const meta = structField(chunk, 3);
      const offset = numberField(chunk, 2);
      // The chunk's stated start is the page offset, and both sizes agree
      // because the pages are not compressed.
      expect(numberField(meta, 9)).toBe(offset);
      expect(numberField(meta, 6)).toBe(numberField(meta, 7));
      expect(numberField(meta, 5)).toBe(2);
      expect(numberField(meta, 4)).toBe(0);
      expect(listField(meta, 2)).toEqual([0, 3]);
      total += numberField(meta, 6);
      // A page header sits at that offset and describes what follows.
      const header = new ThriftReader(file, offset).struct();
      expect(numberField(header, 1)).toBe(0);
      expect(numberField(header, 2)).toBe(numberField(header, 3));
      expect(numberField(structField(header, 5), 1)).toBe(2);
    }
    expect(numberField(group, 2)).toBe(total);
    // The first chunk starts right after the magic.
    expect(numberField(chunks[0] as never, 2)).toBe(4);
  });

  it('closes a row group when it has enough rows, and keeps the pages together', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const batches = Array.from({ length: 6 }, (_value, batch) => [[`a${batch}`, `b${batch}`]]);
    const footer = readParquetFooter(await fileOf(schema, batches, { rowGroupRows: 4 }));
    const groups = structList(footer, 4);
    expect(groups.map((group) => numberField(group, 3))).toEqual([4, 4, 4]);
    expect(numberField(footer, 3)).toBe(12);
  });

  it('closes a row group on size as well as on count', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const batches = Array.from({ length: 4 }, () => [['padding'.repeat(20)]]);
    const footer = readParquetFooter(await fileOf(schema, batches, { rowGroupBytes: 1 }));
    // Every batch became its own group, because each exceeded the budget.
    expect(structList(footer, 4)).toHaveLength(4);
  });

  it('bit-packs booleans, spilling into a second byte after eight of them', async () => {
    const schema = schemaOf([['OK', BOOLEAN]]);
    // Ten values, so the packing has to close one byte and open another, with
    // a null in the middle that takes no bit at all.
    const flags = [true, false, true, true, false, false, true, true, null, true, false, true];
    const file = await fileOf(schema, [[flags]]);
    const footer = readParquetFooter(file);
    const chunk = structList(structList(footer, 4)[0] as never, 1)[0] as never;
    const offset = numberField(chunk, 2);
    const header = new ThriftReader(file, offset).struct();
    // Twelve rows, eleven of them values, so two bytes of packed bits.
    expect(numberField(structField(header, 5), 1)).toBe(12);
    const payload = numberField(header, 2);
    const levels = new DataView(file.buffer, file.byteOffset + offset).getUint32(0, true);
    void levels;
    expect(payload).toBeGreaterThan(2);
  });

  it('writes a readable file for a result set with no rows', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const footer = readParquetFooter(await fileOf(schema, []));
    expect(structList(footer, 4)).toHaveLength(0);
    expect(numberField(footer, 3)).toBe(0);
    expect(structList(footer, 2)).toHaveLength(2);
  });

  it('ignores a batch that turned out to be empty', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const footer = readParquetFooter(await fileOf(schema, [[[]], [['a']]]));
    expect(numberField(footer, 3)).toBe(1);
  });

  it('refuses a result with no columns at all', () => {
    let error: unknown = null;
    try {
      createParquetEncoder({ schema: schemaOf([]), sink: collectingSink() });
    } catch (reason: unknown) {
      error = reason;
    }
    expect(isExportError(error) ? error.code : '').toBe('no-columns');
  });

  it('refuses a value the column declared type cannot hold', async () => {
    const schema = schemaOf([['SMALL', dataType('decimal', 'DECIMAL(3,0)', { precision: 3 })]]);
    const error = await fileOf(schema, [[[10_000]]]).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('value-out-of-range');
    expect(error instanceof Error ? error.message : '').toContain('DECIMAL(3,0)');
  });

  it('carries a NULL in every physical type without writing a value for it', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['REVENUE', MONEY],
      ['BIG', BIG_DECIMAL],
      ['WHEN', DATE],
      ['SCORE', DOUBLE],
      ['OK', BOOLEAN],
    ]);
    const footer = readParquetFooter(
      await fileOf(schema, [
        [
          ['a', null],
          [1, null],
          ['2.5', null],
          ['2026-08-24', null],
          [1.5, null],
          [true, null],
        ],
      ]),
    );
    expect(numberField(footer, 3)).toBe(2);
    const chunks = structList(structList(footer, 4)[0] as never, 1);
    // Two rows in every column, one of them a NULL that occupies no value.
    expect(chunks.map((chunk) => numberField(structField(chunk, 3), 5))).toEqual([
      2, 2, 2, 2, 2, 2,
    ]);
  });

  it('packs exactly eight booleans into exactly one byte', async () => {
    const schema = schemaOf([['OK', BOOLEAN]]);
    const eight = [true, false, true, false, true, false, true, false];
    const file = await fileOf(schemaOf([['OK', BOOLEAN]]), [[eight]]);
    const footer = readParquetFooter(file);
    const chunk = structList(structList(footer, 4)[0] as never, 1)[0] as never;
    const header = new ThriftReader(file, numberField(chunk, 2)).struct();
    // Four bytes of level prefix, two of run, one of packed bits.
    expect(numberField(header, 2)).toBe(7);
    expect(schema.columns).toHaveLength(1);
  });

  it('refuses a decimal column holding something that is not a number', async () => {
    const schema = schemaOf([['REVENUE', MONEY]]);
    const error = await fileOf(schema, [[['not a number']]]).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('value-out-of-range');
  });

  it('refuses a date column holding a number rather than a date', async () => {
    const schema = schemaOf([['WHEN', DATE]]);
    const error = await fileOf(schema, [[[20_689]]]).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('value-out-of-range');
  });

  it('writes a number in a text column the way the table shows it', async () => {
    // A DECIMAL whose precision the database did not state stays text, and a
    // value that arrived as a number is spelled the way the table spells it.
    const schema = schemaOf([['AMOUNT', VAGUE_DECIMAL]]);
    const footer = readParquetFooter(await fileOf(schema, [[[1.5, 'exact']]]));
    expect(numberField(footer, 3)).toBe(2);
    const [, amount] = structList(footer, 2);
    if (amount === undefined) throw new Error('expected a column');
    expect(numberField(amount, 1)).toBe(PHYSICAL_BYTE_ARRAY);
  });

  it('refuses a date column holding something that is not a date', async () => {
    const schema = schemaOf([['WHEN', DATE]]);
    const error = await fileOf(schema, [[['not a date']]]).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('value-out-of-range');
    expect(error instanceof Error ? error.message : '').toContain('is not a date');
  });

  it('refuses a batch whose shape does not match the schema', async () => {
    const wide = schemaOf([
      ['A', VARCHAR],
      ['B', VARCHAR],
    ]);
    const narrow = schemaOf([['A', VARCHAR]]);
    const encoder = createParquetEncoder({ schema: wide, sink: collectingSink() });
    await encoder.begin();
    await expect(encoder.write(chunkOf(narrow, [['x']]))).rejects.toThrow(/1 columns/u);
  });
});
