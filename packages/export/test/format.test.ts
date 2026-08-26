import { describe, expect, it } from 'vitest';
import {
  EXPORT_FORMATS,
  EXPORT_FORMAT_ORDER,
  ExportError,
  describeFormat,
  exportFileName,
  isExportError,
  maxDataRows,
} from '@panorama/export';

describe('export formats', () => {
  it('describes every format it offers, and offers every one it describes', () => {
    expect([...EXPORT_FORMAT_ORDER]).toEqual(['csv', 'xlsx', 'parquet']);
    for (const format of EXPORT_FORMAT_ORDER) {
      const descriptor = describeFormat(format);
      expect(descriptor.format).toBe(format);
      expect(descriptor.extension.startsWith('.')).toBe(true);
      expect(descriptor.mimeType).not.toBe('');
      expect(descriptor.label).not.toBe('');
    }
    expect(Object.keys(EXPORT_FORMATS).sort()).toEqual([...EXPORT_FORMAT_ORDER].sort());
  });

  it('records the spreadsheet grid as a limit and leaves the others unbounded', () => {
    expect(describeFormat('xlsx').maxRows).toBe(1_048_576);
    expect(describeFormat('xlsx').maxColumns).toBe(16_384);
    expect(describeFormat('csv').maxRows).toBeNull();
    expect(describeFormat('parquet').maxRows).toBeNull();
    // The header takes one of the spreadsheet's rows.
    expect(maxDataRows('xlsx')).toBe(1_048_575);
    expect(maxDataRows('csv')).toBeNull();
    expect(maxDataRows('parquet')).toBeNull();
  });
});

describe('exportFileName', () => {
  it('keeps a qualified name readable and adds the extension', () => {
    expect(exportFileName('SALES.ORDERS', 'parquet')).toBe('SALES.ORDERS.parquet');
    expect(exportFileName('SALES.ORDERS', 'csv')).toBe('SALES.ORDERS.csv');
    expect(exportFileName('SALES.ORDERS', 'xlsx')).toBe('SALES.ORDERS.xlsx');
  });

  it('replaces what a filesystem or a shell would object to', () => {
    expect(exportFileName('SALES.ORDERS · SQL', 'csv')).toBe('SALES.ORDERS_SQL.csv');
    expect(exportFileName('a/b\\c:d*e?f', 'csv')).toBe('a_b_c_d_e_f.csv');
    expect(exportFileName('  spaced  out  ', 'csv')).toBe('spaced_out.csv');
  });

  it('keeps letters and digits from any script', () => {
    expect(exportFileName('KØBENHAVN_2026', 'csv')).toBe('KØBENHAVN_2026.csv');
  });

  it('falls back to a name when nothing usable is left', () => {
    expect(exportFileName('///', 'csv')).toBe('export.csv');
    expect(exportFileName('', 'csv')).toBe('export.csv');
  });
});

describe('ExportError', () => {
  it('carries a code the UI can switch on', () => {
    const error = new ExportError('row-limit', 'too many');
    expect(error.code).toBe('row-limit');
    expect(error.name).toBe('ExportError');
    expect(error.message).toBe('too many');
    expect(isExportError(error)).toBe(true);
    expect(isExportError(new Error('too many'))).toBe(false);
  });
});
