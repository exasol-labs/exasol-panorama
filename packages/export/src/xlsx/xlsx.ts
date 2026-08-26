import { cellValue } from '@panorama/table';
import type { ColumnDataType } from '@panorama/core';
import type { ColumnVector, ResultChunk, TableColumnSchema } from '@panorama/table';
import type { EncoderOptions, RowEncoder } from '../encoder.js';
import { requireVectors } from '../encoder.js';
import { encodeUtf8 } from '../bytes.js';
import { ExportError, EXPORT_FORMATS, maxDataRows } from '../format.js';
import { ZipWriter } from './zip.js';

/**
 * SpreadsheetML — the `.xlsx` a spreadsheet opens.
 *
 * The sheet is written with *inline* strings rather than the shared-string
 * table Excel itself prefers. A shared table is smaller for repetitive data,
 * but it has to be complete before the sheet that references it can be written,
 * which means two passes over the rows or the whole result held in memory.
 * Inline strings cost nothing but bytes, and the archive deflates them away.
 *
 * A cell's type follows the *value* rather than the declared column type: what
 * arrived as a number is written as a number, and a high-precision DECIMAL —
 * which Exasol sends as digits precisely because a double would lose them —
 * stays text, because a spreadsheet has nothing more precise than a double to
 * put it in. Dates are the one conversion, into the serial numbers Excel counts
 * days in, so that sorting and date arithmetic work on them.
 *
 * A NULL is written as a cell with no value, which is exactly what a blank
 * spreadsheet cell is; an empty string is a cell whose value is empty text, so
 * the two stay distinguishable. The blank could have been left out altogether —
 * a sheet is allowed to be sparse — but then a row whose last columns are all
 * NULL would be *shorter* than the others, and a reader that takes the sheet's
 * width from its rows would quietly lose those columns. A rectangular sheet is
 * worth the few bytes, which deflate away to nothing.
 */

const XML_DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RELS_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const DOC_RELS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** Excel counts days from 1899-12-30, with one famous fictional leap day. */
const EXCEL_EPOCH_OFFSET = 25_569;
/** Serials below this predate Excel's imaginary 29 February 1900. */
const LEAP_BUG_SERIAL = 61;
const MS_PER_DAY = 86_400_000;

/** Style indices in `styles.xml` below: general, bold, and an ISO date. */
const STYLE_DEFAULT = 0;
const STYLE_HEADER = 1;
const STYLE_DATE = 2;

/**
 * Characters XML 1.0 cannot represent at all — not escaped, not as a character
 * reference. They are dropped, which is the one thing here that loses
 * information: OOXML has a `_xHHHH_` convention for them, but it is Excel's
 * rather than the format's, it is not understood by other readers, and it makes
 * every literal `_x0041_` in the data ambiguous. A control character in a
 * VARCHAR survives an export to CSV or to Parquet; it cannot survive one to XML.
 */
const FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/gu;

export const escapeXml = (text: string): string =>
  text
    .replace(FORBIDDEN, '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    // A literal carriage return is not preserved: XML requires a parser to
    // rewrite CR and CRLF as a plain LF, so the only way to keep one is to
    // spell it out as a character reference.
    .replaceAll('\r', '&#13;');

/** `0` is column A, `16383` is column XFD. */
export const columnLetters = (index: number): string => {
  let name = '';
  let remaining = index;
  for (;;) {
    name = String.fromCharCode(65 + (remaining % 26)) + name;
    remaining = Math.floor(remaining / 26) - 1;
    if (remaining < 0) return name;
  }
};

/**
 * A sheet name Excel will accept: at most 31 characters, none of the ones it
 * reserves for its own reference syntax.
 */
export const sheetName = (name: string): string => {
  const cleaned = name.replace(/[[\]:*?/\\]/gu, '_').slice(0, 31);
  return cleaned === '' ? 'Sheet1' : cleaned;
};

/**
 * Days from 1970-01-01 for a matched `YYYY-MM-DD`.
 *
 * Not `Date.UTC`, which reads a year below 100 as an abbreviation for one in
 * the 1900s — so a date in the year 0042 would silently become 1942. The year
 * is set explicitly instead, which has no such rule.
 */
const utcDays = (match: RegExpExecArray): number => {
  const date = new Date(0);
  date.setUTCFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Math.round(date.getTime() / MS_PER_DAY);
};

/**
 * An ISO date as Excel's day serial, or `null` for anything Excel's calendar
 * has no room for — which is every date before 1900.
 */
export const dateSerial = (text: string): number | null => {
  const match = /^(\d{4})-(\d{2})-(\d{2})/u.exec(text);
  if (match === null) return null;
  const days = utcDays(match) + EXCEL_EPOCH_OFFSET;
  // The correction has to come first: 1899-12-31 lands on 1 before it and 0
  // after, and 0 is not a date Excel has.
  const serial = days < LEAP_BUG_SERIAL ? days - 1 : days;
  return serial < 1 ? null : serial;
};

const CONTENT_TYPES =
  `${XML_DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
  `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
  `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
  `</Types>`;

const ROOT_RELS =
  `${XML_DECLARATION}<Relationships xmlns="${RELS_NS}">` +
  `<Relationship Id="rId1" Type="${DOC_RELS}/officeDocument" Target="xl/workbook.xml"/>` +
  `</Relationships>`;

const WORKBOOK_RELS =
  `${XML_DECLARATION}<Relationships xmlns="${RELS_NS}">` +
  `<Relationship Id="rId1" Type="${DOC_RELS}/worksheet" Target="worksheets/sheet1.xml"/>` +
  `<Relationship Id="rId2" Type="${DOC_RELS}/styles" Target="styles.xml"/>` +
  `</Relationships>`;

/**
 * The smallest stylesheet that is still a valid one: a normal font, a bold one
 * for the header, and a date format so a day serial reads as a date.
 */
const STYLES =
  `${XML_DECLARATION}<styleSheet xmlns="${MAIN_NS}">` +
  `<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font>` +
  `<font><b/><sz val="11"/><name val="Calibri"/></font></fonts>` +
  `<fills count="2"><fill><patternFill patternType="none"/></fill>` +
  `<fill><patternFill patternType="gray125"/></fill></fills>` +
  `<borders count="1"><border/></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
  `<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>` +
  `</styleSheet>`;

const workbookXml = (sheet: string): string =>
  `${XML_DECLARATION}<workbook xmlns="${MAIN_NS}" xmlns:r="${DOC_RELS}">` +
  `<sheets><sheet name="${escapeXml(sheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;

/** The header row is frozen, because a table of data is meant to be scrolled. */
const SHEET_PROLOGUE =
  `${XML_DECLARATION}<worksheet xmlns="${MAIN_NS}"><sheetViews>` +
  `<sheetView workbookViewId="0">` +
  `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
  `</sheetView></sheetViews><sheetData>`;
const SHEET_EPILOGUE = `</sheetData></worksheet>`;

const inlineString = (reference: string, style: number, text: string): string => {
  const escaped = escapeXml(text);
  // `xml:space` matters: without it a reader is entitled to collapse away the
  // padding of a CHAR(3). Decided from the original text, because escaping can
  // turn a trailing space into a character reference that no longer looks like
  // one.
  const attribute = text === text.trim() ? '' : ' xml:space="preserve"';
  const styling = style === STYLE_DEFAULT ? '' : ` s="${style}"`;
  return `<c r="${reference}"${styling} t="inlineStr"><is><t${attribute}>${escaped}</t></is></c>`;
};

const numberCell = (reference: string, style: number, value: number): string => {
  const styling = style === STYLE_DEFAULT ? '' : ` s="${style}"`;
  return `<c r="${reference}"${styling}><v>${value}</v></c>`;
};

/** One cell. A NULL becomes a cell with no value, which is a blank one. */
const cellXml = (
  reference: string,
  value: number | string | boolean | null,
  type: ColumnDataType,
): string => {
  if (value === null) return `<c r="${reference}"/>`;
  if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
  if (typeof value === 'number') {
    // Excel has no notation for infinity or NaN; the text is at least honest.
    return Number.isFinite(value)
      ? numberCell(reference, STYLE_DEFAULT, value)
      : inlineString(reference, STYLE_DEFAULT, String(value));
  }
  if (type.kind === 'date') {
    const serial = dateSerial(value);
    if (serial !== null) return numberCell(reference, STYLE_DATE, serial);
  }
  return inlineString(reference, STYLE_DEFAULT, value);
};

const headerRow = (columns: readonly TableColumnSchema[]): string => {
  const cells = columns
    .map((column, index) => inlineString(`${columnLetters(index)}1`, STYLE_HEADER, column.name))
    .join('');
  return `<row r="1">${cells}</row>`;
};

export interface XlsxOptions {
  /** Stamped on the archive's entries. */
  readonly modified?: Date;
  /** Off only in tests that read the ZIP by hand. */
  readonly compress?: boolean;
}

export const createXlsxEncoder = (options: EncoderOptions & XlsxOptions): RowEncoder => {
  const { schema, sink } = options;
  const columns = schema.columns;
  const columnLimit = EXPORT_FORMATS.xlsx.maxColumns as number;
  if (columns.length > columnLimit) {
    throw new ExportError(
      'column-limit',
      `A spreadsheet holds ${columnLimit.toLocaleString('en-US')} columns; this result has ` +
        `${columns.length.toLocaleString('en-US')}. Export as Parquet or CSV instead.`,
    );
  }
  const rowLimit = maxDataRows('xlsx') as number;

  const zip = new ZipWriter({
    sink,
    ...(options.modified === undefined ? {} : { modified: options.modified }),
    ...(options.compress === undefined ? {} : { compress: options.compress }),
  });
  const letters = columns.map((_column, index) => columnLetters(index));

  /**
   * The sheet is one ZIP entry written across many batches, so its producer
   * cannot be a function that runs to completion. It is handed the entry's
   * writer and then parked on a promise that `finish` resolves.
   */
  let emit: ((bytes: Uint8Array) => Promise<void>) | null = null;
  let sheetDone: (() => void) | null = null;
  let sheetEntry: Promise<void> | null = null;
  let written = 0;

  const write = async (text: string): Promise<void> => {
    await (emit as (bytes: Uint8Array) => Promise<void>)(encodeUtf8(text));
  };

  return {
    async begin(): Promise<void> {
      await zip.addText('[Content_Types].xml', CONTENT_TYPES);
      await zip.addText('_rels/.rels', ROOT_RELS);
      await zip.addText('xl/workbook.xml', workbookXml(sheetName(schema.table)));
      await zip.addText('xl/_rels/workbook.xml.rels', WORKBOOK_RELS);
      await zip.addText('xl/styles.xml', STYLES);

      await new Promise<void>((resolve) => {
        const parked = new Promise<void>((done) => {
          sheetDone = done;
        });
        sheetEntry = zip.add('xl/worksheets/sheet1.xml', async (writeBytes) => {
          emit = writeBytes;
          resolve();
          await parked;
        });
      });
      await write(SHEET_PROLOGUE);
      await write(headerRow(columns));
    },

    async write(batch: ResultChunk): Promise<void> {
      requireVectors(batch, columns.length);
      if (written + batch.rowCount > rowLimit) {
        throw new ExportError(
          'row-limit',
          `A spreadsheet holds ${rowLimit.toLocaleString('en-US')} rows of data. ` +
            `Export as Parquet or CSV instead.`,
        );
      }
      const rows: string[] = [];
      for (let row = 0; row < batch.rowCount; row += 1) {
        // Row 1 is the header, and a spreadsheet counts rows from 1.
        const number = written + row + 2;
        let cells = '';
        for (let index = 0; index < columns.length; index += 1) {
          cells += cellXml(
            `${letters[index] as string}${number}`,
            cellValue(batch.columns[index] as ColumnVector, row),
            (columns[index] as TableColumnSchema).type,
          );
        }
        rows.push(`<row r="${number}">${cells}</row>`);
      }
      written += batch.rowCount;
      if (rows.length > 0) await write(rows.join(''));
    },

    async finish(): Promise<void> {
      await write(SHEET_EPILOGUE);
      (sheetDone as () => void)();
      await (sheetEntry as Promise<void>);
      await zip.finish();
    },
  };
};
