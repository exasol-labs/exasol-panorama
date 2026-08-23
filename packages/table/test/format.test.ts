import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import { NULL_DISPLAY, formatCell } from '@panorama/table';

describe('formatCell', () => {
  const decimal2 = dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 });

  it('renders NULL as the configured text', () => {
    expect(formatCell(null, decimal2)).toBe(NULL_DISPLAY);
    expect(formatCell(null, decimal2, { nullText: 'NULL' })).toBe('NULL');
  });

  it('formats decimals to their declared scale', () => {
    expect(formatCell(183.2, decimal2, { locale: 'en-US' })).toBe('183.20');
    expect(formatCell(1_000_000, decimal2, { locale: 'en-US' })).toBe('1000000.00');
    expect(formatCell(5, dataType('decimal', 'DECIMAL(9,0)'), { locale: 'en-US' })).toBe('5');
  });

  it('formats without an explicit locale', () => {
    expect(formatCell(1.5, decimal2)).toMatch(/^1[.,]50$/);
  });

  it('reuses cached formatters', () => {
    expect(formatCell(1.5, decimal2, { locale: 'en-US' })).toBe('1.50');
    expect(formatCell(2.5, decimal2, { locale: 'en-US' })).toBe('2.50');
  });

  it('passes through strings, booleans and doubles', () => {
    expect(formatCell('Germany', dataType('varchar', 'VARCHAR(64)'))).toBe('Germany');
    expect(formatCell(true, dataType('boolean', 'BOOLEAN'))).toBe('true');
    expect(formatCell(false, dataType('boolean', 'BOOLEAN'))).toBe('false');
    expect(formatCell(0.1, dataType('double', 'DOUBLE'))).toBe('0.1');
  });

  it('renders non-finite numbers verbatim', () => {
    expect(formatCell(Number.POSITIVE_INFINITY, dataType('double', 'DOUBLE'))).toBe('Infinity');
    expect(formatCell(Number.NaN, decimal2)).toBe('NaN');
  });
});
