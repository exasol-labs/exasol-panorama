import { describe, expect, it } from 'vitest';
import type { CsvOptions } from '@panorama/export';
import { collectingSink, createCsvEncoder, csvField } from '@panorama/export';
import { BOOLEAN, DATE, DOUBLE, MONEY, VARCHAR, chunkOf, schemaOf } from './fixtures.js';

// `ignoreBOM`, because a plain decoder swallows the byte-order mark and the
// mark is one of the things being tested.
const decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

const write = async (
  schema: ReturnType<typeof schemaOf>,
  columns: unknown[][],
  options: CsvOptions = {},
): Promise<string> => {
  const sink = collectingSink();
  const encoder = createCsvEncoder({ schema, sink, ...options });
  await encoder.begin();
  await encoder.write(chunkOf(schema, columns));
  await encoder.finish();
  return decode(sink.bytes());
};

describe('csvField', () => {
  it('leaves an ordinary value alone', () => {
    expect(csvField('plain', ',')).toBe('plain');
  });

  it('quotes what CSV requires quoting, doubling the quotes', () => {
    expect(csvField('a,b', ',')).toBe('"a,b"');
    expect(csvField('say "hi"', ',')).toBe('"say ""hi"""');
    expect(csvField('line\nbreak', ',')).toBe('"line\nbreak"');
    expect(csvField('carriage\rreturn', ',')).toBe('"carriage\rreturn"');
  });

  it('follows the delimiter it is given', () => {
    expect(csvField('a,b', ';')).toBe('a,b');
    expect(csvField('a;b', ';')).toBe('"a;b"');
  });

  it('quotes the empty string, which is how a NULL stays distinguishable', () => {
    expect(csvField('', ',')).toBe('""');
  });
});

describe('the CSV encoder', () => {
  it('writes a BOM and a header, and ends every record with CRLF', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['SCORE', DOUBLE],
    ]);
    const text = await write(schema, [
      ['a', 'b'],
      [1, 2.5],
    ]);
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text.slice(1)).toBe('NAME,SCORE\r\na,1\r\nb,2.5\r\n');
  });

  it('leaves the BOM off when asked', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const text = await write(schema, [['a']], { byteOrderMark: false });
    expect(text).toBe('NAME\r\na\r\n');
  });

  it('tells a NULL from an empty string', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const text = await write(schema, [[null, '', 'x']], { byteOrderMark: false });
    // Nothing for the NULL, a quoted nothing for the empty string.
    expect(text).toBe('NAME\r\n\r\n""\r\nx\r\n');
  });

  it('keeps a decimal at its declared scale, with a decimal point', async () => {
    const schema = schemaOf([['REVENUE', MONEY]]);
    const text = await write(schema, [[1234.5, 0, -2]], { byteOrderMark: false });
    expect(text).toBe('REVENUE\r\n1234.50\r\n0.00\r\n-2.00\r\n');
  });

  it('writes booleans and dates the way the table shows them', async () => {
    const schema = schemaOf([
      ['OK', BOOLEAN],
      ['WHEN', DATE],
    ]);
    const text = await write(schema, [
      [true, false],
      ['2026-08-24', '1970-01-01'],
    ]);
    expect(text.slice(1)).toBe('OK,WHEN\r\ntrue,2026-08-24\r\nfalse,1970-01-01\r\n');
  });

  it('quotes a header that needs it', async () => {
    const schema = schemaOf([['A,B', VARCHAR]]);
    const text = await write(schema, [['x']], { byteOrderMark: false });
    expect(text).toBe('"A,B"\r\nx\r\n');
  });

  it('honours a different delimiter, for both header and values', async () => {
    const schema = schemaOf([
      ['A', VARCHAR],
      ['B', VARCHAR],
    ]);
    const text = await write(schema, [['x,y'], ['z']], { byteOrderMark: false, delimiter: ';' });
    expect(text).toBe('A;B\r\nx,y;z\r\n');
  });

  it('writes nothing for an empty batch', async () => {
    const schema = schemaOf([['A', VARCHAR]]);
    const text = await write(schema, [[]], { byteOrderMark: false });
    expect(text).toBe('A\r\n');
  });

  it('refuses a batch whose shape does not match the schema', async () => {
    const schema = schemaOf([
      ['A', VARCHAR],
      ['B', VARCHAR],
    ]);
    const narrow = schemaOf([['A', VARCHAR]]);
    const sink = collectingSink();
    const encoder = createCsvEncoder({ schema, sink });
    await encoder.begin();
    await expect(encoder.write(chunkOf(narrow, [['x']]))).rejects.toThrow(/1 columns/u);
  });
});
