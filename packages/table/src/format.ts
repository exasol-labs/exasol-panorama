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

export const formatCell = (
  value: CellValue,
  type: ColumnDataType,
  options: FormatOptions = {},
): string => {
  if (value === null) return options.nullText ?? NULL_DISPLAY;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return value;
  if (!Number.isFinite(value)) return String(value);
  if (type.kind === 'decimal') {
    return decimalFormatter(options.locale, type.scale ?? 0).format(value);
  }
  return String(value);
};
