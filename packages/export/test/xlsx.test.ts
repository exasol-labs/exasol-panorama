import { describe, expect, it } from 'vitest';
import {
  ZipWriter,
  assertEntrySize,
  collectingSink,
  columnLetters,
  createXlsxEncoder,
  crc32,
  dateSerial,
  dosDateTime,
  escapeXml,
  finishCrc32,
  isExportError,
  sheetName,
} from '@panorama/export';
import { BOOLEAN, DATE, DOUBLE, MONEY, TIMESTAMP, VARCHAR, chunkOf, schemaOf } from './fixtures.js';

const TEXT = new TextDecoder();

/**
 * A minimal ZIP reader over the *central directory*, which is the part every
 * real reader trusts. Reading the archive back this way is what proves the data
 * descriptors and offsets are right, rather than merely self-consistent.
 */
const readZip = (file: Uint8Array): Map<string, Uint8Array> => {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  let end = file.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06_05_4b_50) end -= 1;
  if (end < 0) throw new Error('No end-of-central-directory record');
  const count = view.getUint16(end + 10, true);
  let cursor = view.getUint32(end + 16, true);
  const entries = new Map<string, Uint8Array>();
  for (let index = 0; index < count; index += 1) {
    if (view.getUint32(cursor, true) !== 0x02_01_4b_50) throw new Error('Bad central header');
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressed = view.getUint32(cursor + 20, true);
    const uncompressed = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const name = TEXT.decode(file.slice(cursor + 46, cursor + 46 + nameLength));
    // Follow the local header to the data, as a reader does.
    if (view.getUint32(localOffset, true) !== 0x04_03_4b_50) throw new Error('Bad local header');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = file.slice(start, start + compressed);
    if (method !== 0 && method !== 8) throw new Error(`Unexpected method ${method}`);
    entries.set(name, { raw, crc, uncompressed, method } as unknown as Uint8Array);
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
};

interface ZipEntry {
  readonly raw: Uint8Array;
  readonly crc: number;
  readonly uncompressed: number;
  readonly method: number;
}

const inflate = async (entry: ZipEntry): Promise<Uint8Array> => {
  if (entry.method === 0) return entry.raw;
  const stream = new DecompressionStream('deflate-raw');
  const writer = stream.writable.getWriter();
  void writer.write(entry.raw.slice());
  void writer.close();
  const parts: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done === true) break;
    parts.push(value);
  }
  const joined = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    joined.set(part, offset);
    offset += part.length;
  }
  return joined;
};

const readWorkbook = async (
  file: Uint8Array,
): Promise<{ parts: Map<string, string>; entries: Map<string, ZipEntry> }> => {
  const entries = readZip(file) as unknown as Map<string, ZipEntry>;
  const parts = new Map<string, string>();
  for (const [name, entry] of entries) {
    const bytes = await inflate(entry);
    // The recorded checksum and size must describe the *uncompressed* data.
    expect(bytes.length).toBe(entry.uncompressed);
    expect(finishCrc32(crc32(bytes))).toBe(entry.crc);
    parts.set(name, TEXT.decode(bytes));
  }
  return { parts, entries };
};

const workbookOf = async (
  schema: ReturnType<typeof schemaOf>,
  columns: ReadonlyArray<readonly unknown[]>,
  options: { compress?: boolean } = {},
): Promise<{ parts: Map<string, string>; entries: Map<string, ZipEntry> }> => {
  const sink = collectingSink();
  const encoder = createXlsxEncoder({ schema, sink, ...options });
  await encoder.begin();
  await encoder.write(chunkOf(schema, columns));
  await encoder.finish();
  return readWorkbook(sink.bytes());
};

describe('crc32', () => {
  it('matches the checksum every ZIP reader computes', () => {
    // The standard test vector for CRC-32 of "123456789".
    expect(finishCrc32(crc32(new TextEncoder().encode('123456789')))).toBe(0xcb_f4_39_26);
    expect(finishCrc32(crc32(new Uint8Array()))).toBe(0);
  });

  it('can be fed in pieces', () => {
    const all = new TextEncoder().encode('123456789');
    const first = crc32(all.slice(0, 4));
    expect(finishCrc32(crc32(all.slice(4), first))).toBe(0xcb_f4_39_26);
  });
});

describe('dosDateTime', () => {
  it('packs a date into the two 16-bit fields a ZIP records', () => {
    const stamp = dosDateTime(new Date(2026, 7, 24, 13, 45, 31));
    expect(stamp.date).toBe(((2026 - 1980) << 9) | (8 << 5) | 24);
    // Two-second resolution: 31 seconds becomes 15.
    expect(stamp.time).toBe((13 << 11) | (45 << 5) | 15);
  });

  it('clamps below the format own epoch of 1980', () => {
    expect(dosDateTime(new Date(1970, 0, 1)).date >> 9).toBe(0);
  });
});

describe('escapeXml', () => {
  it('escapes the markup characters', () => {
    expect(escapeXml('a & b < c > d "e"')).toBe('a &amp; b &lt; c &gt; d &quot;e&quot;');
  });

  it('spells a carriage return out, because XML would rewrite it', () => {
    expect(escapeXml('a\rb')).toBe('a&#13;b');
    // Tab and newline survive as themselves.
    expect(escapeXml('a\tb\nc')).toBe('a\tb\nc');
  });

  it('drops the characters XML cannot represent at all', () => {
    expect(escapeXml('bellend')).toBe('bellend');
  });
});

describe('columnLetters', () => {
  it('counts in the base-26 spreadsheets use', () => {
    expect(columnLetters(0)).toBe('A');
    expect(columnLetters(25)).toBe('Z');
    expect(columnLetters(26)).toBe('AA');
    expect(columnLetters(51)).toBe('AZ');
    expect(columnLetters(52)).toBe('BA');
    expect(columnLetters(701)).toBe('ZZ');
    expect(columnLetters(702)).toBe('AAA');
    // The last column of the grid.
    expect(columnLetters(16_383)).toBe('XFD');
  });
});

describe('sheetName', () => {
  it('removes what Excel reserves and trims to the length it allows', () => {
    expect(sheetName('ORDERS')).toBe('ORDERS');
    expect(sheetName('a/b\\c:d?e*f[g]')).toBe('a_b_c_d_e_f_g_');
    expect(sheetName('x'.repeat(40))).toHaveLength(31);
    expect(sheetName('')).toBe('Sheet1');
  });
});

describe('dateSerial', () => {
  it('counts days the way Excel does, fictional leap day included', () => {
    expect(dateSerial('1900-01-01')).toBe(1);
    expect(dateSerial('1900-02-28')).toBe(59);
    expect(dateSerial('1900-03-01')).toBe(61);
    expect(dateSerial('1970-01-01')).toBe(25_569);
    expect(dateSerial('2026-08-24')).toBe(46_258);
  });

  it('refuses what Excel calendar has no room for', () => {
    expect(dateSerial('1899-12-31')).toBeNull();
    // A year below 100 is a real year, not an abbreviation for one in the 1900s.
    expect(dateSerial('0042-01-01')).toBeNull();
  });

  it('refuses anything that is not an ISO date', () => {
    expect(dateSerial('24/08/2026')).toBeNull();
    expect(dateSerial('')).toBeNull();
  });
});

describe('the XLSX encoder', () => {
  it('writes the parts a spreadsheet needs, and nothing else', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const { parts } = await workbookOf(schema, [['a']]);
    expect([...parts.keys()]).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/workbook.xml',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    // Every part the content types promise is actually in the archive.
    for (const name of parts.keys()) {
      if (name.endsWith('.rels') || name === '[Content_Types].xml') continue;
      expect(parts.get('[Content_Types].xml')).toContain(`/${name}`);
    }
  });

  it('names the sheet after the table', async () => {
    const schema = schemaOf([['NAME', VARCHAR]], 'ORDERS');
    const { parts } = await workbookOf(schema, [['a']]);
    expect(parts.get('xl/workbook.xml')).toContain('name="ORDERS"');
  });

  it('deflates the sheet, and stores it when told not to compress', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const rows = Array.from({ length: 200 }, () => 'repeated');
    const compressed = await workbookOf(schema, [rows]);
    const stored = await workbookOf(schema, [rows], { compress: false });
    const sheet = 'xl/worksheets/sheet1.xml';
    expect(compressed.entries.get(sheet)?.method).toBe(8);
    expect(stored.entries.get(sheet)?.method).toBe(0);
    // Sheet XML is repetitive, so this is a large saving rather than a token one.
    const deflated = compressed.entries.get(sheet)?.raw.length ?? 0;
    const raw = stored.entries.get(sheet)?.raw.length ?? 0;
    expect(deflated).toBeLessThan(raw / 4);
    expect(compressed.parts.get(sheet)).toBe(stored.parts.get(sheet));
  });

  it('writes a bold header row and freezes it', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['SCORE', DOUBLE],
    ]);
    const { parts } = await workbookOf(schema, [['a'], [1]]);
    const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr"><is><t>NAME</t></is></c>');
    expect(sheet).toContain('<c r="B1" s="1" t="inlineStr"><is><t>SCORE</t></is></c>');
  });

  it('gives each value the cell type it deserves', async () => {
    const schema = schemaOf([
      ['NAME', VARCHAR],
      ['SCORE', DOUBLE],
      ['OK', BOOLEAN],
      ['WHEN', DATE],
      ['STAMP', TIMESTAMP],
    ]);
    const { parts } = await workbookOf(schema, [
      ['text', 'more'],
      [2.5, 3],
      [true, false],
      ['2026-08-24', '2026-08-25'],
      ['2026-08-24 12:00:00.000', '2026-08-25 12:00:00.000'],
    ]);
    const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t>text</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>2.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<c r="C3" t="b"><v>0</v></c>');
    // A date becomes a serial with the date style; a timestamp stays text.
    expect(sheet).toContain('<c r="D2" s="2"><v>46258</v></c>');
    expect(sheet).toContain('<c r="E2" t="inlineStr"><is><t>2026-08-24 12:00:00.000</t></is></c>');
  });

  it('keeps a date Excel calendar cannot hold as the text it arrived as', async () => {
    const schema = schemaOf([['WHEN', DATE]]);
    const { parts } = await workbookOf(schema, [['1899-12-31']]);
    expect(parts.get('xl/worksheets/sheet1.xml')).toContain(
      '<c r="A2" t="inlineStr"><is><t>1899-12-31</t></is></c>',
    );
  });

  it('stamps the archive with the time it is given', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const sink = collectingSink();
    const encoder = createXlsxEncoder({
      schema,
      sink,
      compress: false,
      modified: new Date(2026, 7, 24, 13, 45, 30),
    });
    await encoder.begin();
    await encoder.finish();
    const view = new DataView(sink.bytes().buffer);
    // The time and date fields of the first local header, at offsets 10 and 12.
    expect(view.getUint16(10, true)).toBe((13 << 11) | (45 << 5) | 15);
    expect(view.getUint16(12, true)).toBe(((2026 - 1980) << 9) | (8 << 5) | 24);
  });

  it('writes a blank cell for a NULL, so every row is the same width', async () => {
    const schema = schemaOf([
      ['A', VARCHAR],
      ['B', VARCHAR],
    ]);
    const { parts } = await workbookOf(schema, [
      ['x', null],
      [null, null],
    ]);
    const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('<row r="2"><c r="A2" t="inlineStr"><is><t>x</t></is></c><c r="B2"/>');
    expect(sheet).toContain('<row r="3"><c r="A3"/><c r="B3"/></row>');
  });

  it('preserves the padding of a fixed-width value', async () => {
    const schema = schemaOf([['CODE', VARCHAR]]);
    const { parts } = await workbookOf(schema, [['DE ']]);
    expect(parts.get('xl/worksheets/sheet1.xml')).toContain('xml:space="preserve"');
  });

  it('keeps a high-precision decimal as digits, since a double would lose them', async () => {
    const schema = schemaOf([['BIG', MONEY]]);
    // Delivered as text, the way Exasol delivers what a double cannot hold.
    const { parts } = await workbookOf(schema, [['123456789012345678.99']]);
    expect(parts.get('xl/worksheets/sheet1.xml')).toContain(
      '<c r="A2" t="inlineStr"><is><t>123456789012345678.99</t></is></c>',
    );
  });

  it('writes a value Excel has no number for as text', async () => {
    const schema = schemaOf([['SCORE', DOUBLE]]);
    const { parts } = await workbookOf(schema, [[Number.POSITIVE_INFINITY]]);
    expect(parts.get('xl/worksheets/sheet1.xml')).toContain('<t>Infinity</t>');
  });

  it('writes only the header when the result set is empty', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const sink = collectingSink();
    const encoder = createXlsxEncoder({ schema, sink, compress: false });
    await encoder.begin();
    // A batch that turned out to have no rows must add nothing to the sheet.
    await encoder.write(chunkOf(schema, [[]]));
    await encoder.finish();
    const { parts } = await readWorkbook(sink.bytes());
    const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('<row r="1">');
    expect(sheet).not.toContain('<row r="2">');
  });

  it('numbers rows across batches without a gap', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const sink = collectingSink();
    const encoder = createXlsxEncoder({ schema, sink, compress: false });
    await encoder.begin();
    await encoder.write(chunkOf(schema, [['a', 'b']]));
    await encoder.write(chunkOf(schema, [['c']], 2));
    await encoder.finish();
    const { parts } = await readWorkbook(sink.bytes());
    const sheet = parts.get('xl/worksheets/sheet1.xml') ?? '';
    expect(sheet).toContain('<row r="2">');
    expect(sheet).toContain('<row r="3">');
    expect(sheet).toContain('<row r="4">');
    expect(sheet.endsWith('</sheetData></worksheet>')).toBe(true);
  });

  it('refuses a result wider than the spreadsheet grid, before writing a byte', () => {
    const columns = Array.from(
      { length: 16_385 },
      (_value, index) => [`C${index}`, VARCHAR] as const,
    );
    const sink = collectingSink();
    let error: unknown = null;
    try {
      createXlsxEncoder({ schema: schemaOf(columns), sink });
    } catch (reason: unknown) {
      error = reason;
    }
    expect(isExportError(error)).toBe(true);
    expect(isExportError(error) ? error.code : '').toBe('column-limit');
    expect(sink.position).toBe(0);
  });

  it('refuses more rows than the grid has, naming the formats that can hold them', async () => {
    const schema = schemaOf([['NAME', VARCHAR]]);
    const sink = collectingSink();
    const encoder = createXlsxEncoder({ schema, sink, compress: false });
    await encoder.begin();
    // One chunk claiming more rows than the grid holds, without building them.
    const chunk = { ...chunkOf(schema, [['a']]), rowCount: 1_048_576 };
    await expect(encoder.write(chunk)).rejects.toThrow(/Parquet or CSV/u);
  });
});

describe('assertEntrySize', () => {
  it('accepts anything a 32-bit field can hold, and refuses more', () => {
    expect(() => assertEntrySize('a.xml', 0xff_ff_ff_ff)).not.toThrow();
    let error: unknown = null;
    try {
      assertEntrySize('a.xml', 0x1_00_00_00_00);
    } catch (reason: unknown) {
      error = reason;
    }
    expect(isExportError(error) ? error.code : '').toBe('row-limit');
    expect(error instanceof Error ? error.message : '').toContain('4 GB');
  });
});

describe('the ZIP writer', () => {
  it('records a stored entry a reader can find from the directory', async () => {
    const sink = collectingSink();
    const zip = new ZipWriter({ sink, compress: false, modified: new Date(2026, 0, 2, 3, 4, 5) });
    await zip.addText('a.txt', 'hello');
    await zip.add('b.bin', async (write) => {
      await write(new Uint8Array([1, 2]));
      await write(new Uint8Array([3]));
    });
    await zip.finish();
    const entries = readZip(sink.bytes()) as unknown as Map<string, ZipEntry>;
    expect([...entries.keys()]).toEqual(['a.txt', 'b.bin']);
    expect(TEXT.decode(entries.get('a.txt')?.raw)).toBe('hello');
    expect([...(entries.get('b.bin')?.raw ?? [])]).toEqual([1, 2, 3]);
    expect(entries.get('b.bin')?.uncompressed).toBe(3);
  });

  it('leaves nothing behind when a producer fails mid-entry', async () => {
    const sink = collectingSink();
    const zip = new ZipWriter({ sink });
    const failure = new Error('source died');
    await expect(
      zip.add('a.bin', async (write) => {
        await write(new Uint8Array([1]));
        throw failure;
      }),
    ).rejects.toBe(failure);
  });
});
