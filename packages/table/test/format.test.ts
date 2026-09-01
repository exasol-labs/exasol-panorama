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

/**
 * The display hints a semantic layer attaches to a column.
 *
 * A hint is a hint: the vocabulary belongs to whoever wrote the model, its own
 * documentation calls it open, and a live catalogue already carries `@` and
 * `text` among the values. So the rule these all check is that an unrecognised
 * hint changes nothing, and a recognised one changes only what it can do
 * exactly.
 */
describe('semantic format hints', () => {
  const money = dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 });

  it('groups currency and fixes it at two places', () => {
    expect(formatCell(12345678.9, money, { locale: 'en-US', hint: 'currency' })).toBe(
      '12,345,678.90',
    );
    expect(formatCell(-4.5, money, { locale: 'en-US', hint: 'currency' })).toBe('-4.50');
  });

  /**
   * A share of something, written as one. `gross_margin_pct` in the layer's own
   * reference model is `gross_margin / NULLIF(total_revenue, 0)` — a fraction —
   * and `0.4231` shown as `0.4231` is the number nobody asked for.
   */
  it('writes a fraction as a percentage', () => {
    expect(
      formatCell(0.4231, dataType('decimal', 'DECIMAL(18,6)', { precision: 18, scale: 6 }), {
        locale: 'en-US',
        hint: 'percentage',
      }),
    ).toBe('42.31%');
  });

  it('groups plain quantities without rounding them away', () => {
    const count = dataType('decimal', 'DECIMAL(18,0)');
    expect(formatCell(1234567, count, { locale: 'en-US', hint: 'number' })).toBe('1,234,567');
    expect(formatCell(1234567, count, { locale: 'en-US', hint: 'count' })).toBe('1,234,567');
    expect(formatCell(1234.5, count, { locale: 'en-US', hint: 'number' })).toBe('1,234.5');
  });

  it('shortens a date to its month', () => {
    expect(formatCell('2026-08-01', dataType('date', 'DATE'), { hint: 'month' })).toBe('2026-08');
    // Not a date, so not shortened: the hint applies to what it applies to.
    expect(formatCell('August', dataType('varchar', 'VARCHAR(16)'), { hint: 'month' })).toBe(
      'August',
    );
    expect(formatCell(8, dataType('decimal', 'DECIMAL(2,0)'), { hint: 'month' })).toBe('8');
  });

  it('leaves a hint it does not know alone', () => {
    // Both taken from a live catalogue.
    expect(formatCell(1234.5, money, { locale: 'en-US', hint: '@' })).toBe('1234.50');
    expect(formatCell('Nord', dataType('varchar', 'VARCHAR(8)'), { hint: 'text' })).toBe('Nord');
  });

  /**
   * Exasol sends a high-precision DECIMAL as a *string* so its digits survive
   * JSON. Grouping it means putting it through a double, which throws away the
   * digits the protocol went to the trouble of keeping — so it is shown as it
   * arrived instead: exact and ungrouped beats grouped and wrong at the end.
   */
  it('refuses to format a figure a double cannot hold exactly', () => {
    const huge = dataType('decimal', 'DECIMAL(36,2)', { precision: 36, scale: 2 });
    expect(formatCell('12345678901234567.89', huge, { locale: 'en-US', hint: 'currency' })).toBe(
      '12345678901234567.89',
    );
    // A string that is no kind of number is not one this can format either.
    expect(formatCell('n/a', huge, { hint: 'currency' })).toBe('n/a');
  });

  it('formats a decimal that arrived as a string but does fit', () => {
    expect(formatCell('1234.5', money, { locale: 'en-US', hint: 'currency' })).toBe('1,234.50');
  });

  it('says nothing about null and booleans, hint or no hint', () => {
    expect(formatCell(null, money, { hint: 'currency', nullText: '—' })).toBe('—');
    expect(formatCell(true, dataType('boolean', 'BOOLEAN'), { hint: 'currency' })).toBe('true');
  });

  it('reuses cached hint formatters', () => {
    expect(formatCell(1, money, { locale: 'en-US', hint: 'currency' })).toBe('1.00');
    expect(formatCell(2, money, { locale: 'en-US', hint: 'currency' })).toBe('2.00');
  });
});
