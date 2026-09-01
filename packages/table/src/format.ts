import type { ColumnDataType } from '@panorama/core';
import type { CellValue } from './result-chunk.js';

/**
 * Cell display formatting.
 *
 * Kept next to the data rather than in the renderer so that text measurement,
 * the GPU renderer and any future exporter agree on what a cell says.
 */

export const NULL_DISPLAY = '';

export interface FormatOptions {
  /** Text shown for SQL NULL. Empty by default; the renderer styles it instead. */
  readonly nullText?: string;
  readonly locale?: string;
  /**
   * How a semantic layer says to write this column down: `currency`,
   * `percentage`, `month` and the like. See `SemanticColumnView.format`.
   *
   * A hint and not an instruction. The vocabulary belongs to whoever wrote the
   * model and its own documentation calls it open — "a display hint such as
   * currency, percentage, or count" — and a live catalogue already carries `@`
   * and `text` among the values. So a hint this does not recognise must change
   * nothing at all, which is why `applyHint` returns `undefined` rather than
   * guessing.
   */
  readonly hint?: string;
}

const decimalFormatters = new Map<string, Intl.NumberFormat>();

const decimalFormatter = (locale: string | undefined, scale: number): Intl.NumberFormat => {
  const key = `${locale ?? ''}:${scale}`;
  let formatter = decimalFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: scale,
      maximumFractionDigits: scale,
      useGrouping: false,
    });
    decimalFormatters.set(key, formatter);
  }
  return formatter;
};

const hintFormatters = new Map<string, Intl.NumberFormat>();

/**
 * A fixed-point formatter, grouped, cached like the decimal one above.
 *
 * Grouping is the whole point of a hint: `12345678.90` and `12,345,678.90` carry
 * the same digits and only one of them can be read at a glance, which is why the
 * unhinted path deliberately leaves it off and this one puts it on.
 */
const hintFormatter = (
  locale: string | undefined,
  minimum: number,
  maximum: number,
): Intl.NumberFormat => {
  const key = `${locale ?? ''}:${minimum}:${maximum}`;
  let formatter = hintFormatters.get(key);
  if (formatter === undefined) {
    formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: minimum,
      maximumFractionDigits: maximum,
    });
    hintFormatters.set(key, formatter);
  }
  return formatter;
};

const MONEY_PLACES = 2;
/**
 * As many fraction digits as a plain number turns out to have, up to a limit.
 *
 * `number` and `count` say "this is a quantity", not "this is an integer" — so
 * grouping is added and nothing is rounded away. The limit is only there because
 * `Intl` insists on one.
 */
const PLAIN_PLACES = 6;
const DATE_TEXT = /^\d{4}-\d{2}-\d{2}/u;
const MONTH_LENGTH = 7;

/**
 * The value as a double, where saying it as one loses nothing.
 *
 * Exasol sends a high-precision `DECIMAL` as a *string* precisely so its digits
 * survive JSON, and putting it through a double here would throw away what the
 * protocol went to the trouble of keeping — an eighteen-digit figure has more
 * digits than a double can hold. So a value that will not survive the round trip
 * is not formatted at all: it is shown as it arrived, which is exact and
 * ungrouped, rather than grouped and quietly wrong in its last few digits.
 */
const exactly = (value: number | string): number | undefined => {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return undefined;
  return Number.isSafeInteger(Math.trunc(numeric)) ? numeric : undefined;
};

/**
 * The hint applied, or `undefined` where it does not apply.
 *
 * `percentage` multiplies by a hundred, which is the one judgement call here. It
 * is what the word means everywhere a format string is written — Excel's `0.00%`
 * does exactly this — and it is what the semantic layer's own reference model
 * stores: `gross_margin_pct` is `gross_margin / NULLIF(total_revenue, 0)`, a
 * fraction. A model that stored 42 and called it a percentage would be shown as
 * 4,200%, and it would be visibly wrong rather than quietly wrong.
 */
const applyHint = (value: number | string, hint: string, locale?: string): string | undefined => {
  if (hint === 'month') {
    return typeof value === 'string' && DATE_TEXT.test(value)
      ? value.slice(0, MONTH_LENGTH)
      : undefined;
  }
  const numeric = exactly(value);
  if (numeric === undefined) return undefined;
  switch (hint) {
    case 'currency':
      return hintFormatter(locale, MONEY_PLACES, MONEY_PLACES).format(numeric);
    case 'percentage':
      return `${hintFormatter(locale, MONEY_PLACES, MONEY_PLACES).format(numeric * 100)}%`;
    case 'number':
    case 'count':
      return hintFormatter(locale, 0, PLAIN_PLACES).format(numeric);
    default:
      return undefined;
  }
};

export const formatCell = (
  value: CellValue,
  type: ColumnDataType,
  options: FormatOptions = {},
): string => {
  if (value === null) return options.nullText ?? NULL_DISPLAY;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (options.hint !== undefined) {
    const hinted = applyHint(value, options.hint, options.locale);
    if (hinted !== undefined) return hinted;
  }
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return String(value);
  if (type.kind === 'decimal') {
    return decimalFormatter(options.locale, type.scale ?? 0).format(value);
  }
  return String(value);
};
