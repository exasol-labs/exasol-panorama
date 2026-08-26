import type { ColumnDataType } from '@panorama/core';
import type { CellValue } from './result-chunk.js';

/**
 * What a column looks like, in numbers.
 *
 * The questions worth answering before you read a single row are always the
 * same ones: how much of this is missing, how many different things are in it,
 * how far does it spread, and what is in it most often. So they are answered
 * once, in one shape, for every column type — and the shape says which of its
 * parts are filled in rather than each type having a summary of its own.
 *
 * Every number here is a *fact about a set of rows*, and which set that was is
 * part of the answer: a summary of the first hundred thousand rows of a
 * ten-billion-row table is a useful thing and a misleading thing depending
 * entirely on whether it says so. Hence `basis`.
 */

/** Whether the numbers describe the whole result set or only part of it. */
export type SummaryBasis = 'exact' | 'sampled';

/**
 * How a column's distribution is best drawn, and what to draw it from.
 *
 * `frequency` is a bar per value — right when there are few enough values to
 * name them, which is most text, every boolean, and plenty of dates.
 * `histogram` is a bar per range — right when there are too many values to name
 * and they have an order to be spread along, which is what a wide numeric column
 * is. `none` is honest about a column that has neither.
 *
 * It carries the bars rather than only naming the kind, so that whoever draws
 * them has them in hand: there is no second look at the summary that could
 * disagree with this decision, and no case to defend against that cannot happen.
 */
export type SummaryChart =
  | { readonly kind: 'frequency'; readonly frequencies: readonly SummaryValueCount[] }
  | { readonly kind: 'histogram'; readonly bins: readonly SummaryBin[] }
  | { readonly kind: 'none' };

/** One named value and how often it appeared. */
export interface SummaryValueCount {
  readonly value: CellValue;
  readonly count: number;
}

/** One range of a histogram, and how many values fell inside it. */
export interface SummaryBin {
  readonly from: number;
  readonly to: number;
  readonly count: number;
}

export interface ColumnSummary {
  readonly column: string;
  /** Rows the numbers were taken from; `basis` says whether that was all of them. */
  readonly rows: number;
  readonly nulls: number;
  readonly basis: SummaryBasis;
  /**
   * Different non-null values, or `null` when there were more than were worth
   * counting. Absent knowledge is not a count of zero.
   */
  readonly distinct: number | null;
  /** Set for every type that can be ordered, which is most of them. */
  readonly min?: CellValue;
  readonly max?: CellValue;
  /** Numbers only; the others have no mean worth taking. */
  readonly mean?: number;
  /**
   * A bar per value, most frequent first — or, when they are all here, in the
   * column's own order so that dates and numbers read as a series.
   */
  readonly frequencies?: readonly SummaryValueCount[];
  /** A bar per range, for a column with more values than can be named. */
  readonly bins?: readonly SummaryBin[];
  /** True when `frequencies` names every value there is, not just the top few. */
  readonly frequenciesComplete?: boolean;
}

/** Values named individually before a column is called too varied to name. */
export const MAX_NAMED_VALUES = 8;

/** Ranges a histogram is cut into. Enough to show a shape, few enough to read. */
export const HISTOGRAM_BINS = 24;

/** Distinct values counted before the count is given up as not worth having. */
export const MAX_TRACKED_DISTINCT = 10_000;

const NUMERIC: ReadonlySet<ColumnDataType['kind']> = new Set(['decimal', 'double']);

/**
 * Whether a type has an order to spread a histogram along.
 *
 * Dates and timestamps do, but Exasol delivers them as text and their bins
 * would have to be cut with date arithmetic that differs between databases —
 * so they are named rather than binned, which for a date column is usually the
 * more useful answer anyway.
 */
export const isNumericType = (type: ColumnDataType): boolean => NUMERIC.has(type.kind);

/**
 * Whether a type reads in its own order rather than by popularity.
 *
 * A bar chart of dates or numbers wants to be a series; one of country names
 * wants the biggest bar first.
 */
export const isOrderedType = (type: ColumnDataType): boolean =>
  NUMERIC.has(type.kind) ||
  type.kind === 'date' ||
  type.kind === 'timestamp' ||
  type.kind === 'boolean';

/** How to draw a column, given how varied it turned out to be. */
export const summaryChart = (summary: ColumnSummary): SummaryChart => {
  // Nothing but nulls has no distribution to draw, whatever bars a source may
  // have sent along with it.
  if (summary.rows === summary.nulls) return { kind: 'none' };
  const frequencies = summary.frequencies;
  if (frequencies !== undefined && frequencies.length > 0) {
    return { kind: 'frequency', frequencies };
  }
  const bins = summary.bins;
  if (bins !== undefined && bins.length > 0) return { kind: 'histogram', bins };
  return { kind: 'none' };
};

/**
 * Builds a summary a value at a time.
 *
 * Used by any source that has to look at the rows to answer — the generated demo
 * relations do, and a database with `GROUP BY` does not. Values are buffered
 * only for a numeric column, and only to cut its bins at the end: the range
 * cannot be known until the last value has been seen, and a second pass over a
 * result set is a second pass over a network.
 */
export class ColumnSummaryBuilder {
  readonly #column: string;
  readonly #type: ColumnDataType;
  readonly #counts = new Map<string, { value: CellValue; count: number }>();
  readonly #numbers: number[] = [];
  #rows = 0;
  #nulls = 0;
  #min: CellValue = null;
  #max: CellValue = null;
  #total = 0;
  #overflowed = false;

  constructor(column: string, type: ColumnDataType) {
    this.#column = column;
    this.#type = type;
  }

  add(value: CellValue): void {
    this.#rows += 1;
    if (value === null) {
      this.#nulls += 1;
      return;
    }
    if (this.#min === null || compareValues(value, this.#min) < 0) this.#min = value;
    if (this.#max === null || compareValues(value, this.#max) > 0) this.#max = value;
    if (isNumericType(this.#type)) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        this.#total += numeric;
        this.#numbers.push(numeric);
      }
    }
    const key = String(value);
    const seen = this.#counts.get(key);
    if (seen !== undefined) {
      seen.count += 1;
    } else if (this.#counts.size < MAX_TRACKED_DISTINCT) {
      this.#counts.set(key, { value, count: 1 });
    } else {
      // Past here the distinct count is no longer knowable from this pass, and
      // saying so is better than reporting the number of values that happened
      // to fit.
      this.#overflowed = true;
    }
  }

  finish(basis: SummaryBasis): ColumnSummary {
    const present = this.#rows - this.#nulls;
    const distinct = this.#overflowed ? null : this.#counts.size;
    const base: ColumnSummary = {
      column: this.#column,
      rows: this.#rows,
      nulls: this.#nulls,
      basis,
      distinct,
      ...(this.#min === null ? {} : { min: this.#min }),
      ...(this.#max === null ? {} : { max: this.#max }),
      ...(isNumericType(this.#type) && this.#numbers.length > 0
        ? { mean: this.#total / this.#numbers.length }
        : {}),
    };
    if (present === 0) return base;

    // Few enough values to name them: that *is* the distribution, exactly.
    if (!this.#overflowed && this.#counts.size <= MAX_NAMED_VALUES) {
      return {
        ...base,
        frequencies: orderFrequencies([...this.#counts.values()], this.#type),
        frequenciesComplete: true,
      };
    }
    if (isNumericType(this.#type)) {
      return { ...base, bins: binNumbers(this.#numbers) };
    }
    return {
      ...base,
      frequencies: [...this.#counts.values()]
        .sort((a, b) => b.count - a.count)
        .slice(0, MAX_NAMED_VALUES),
      frequenciesComplete: false,
    };
  }
}

/** Orders a complete set of bars: as a series where the type has one. */
const orderFrequencies = (
  counts: readonly SummaryValueCount[],
  type: ColumnDataType,
): readonly SummaryValueCount[] =>
  isOrderedType(type)
    ? [...counts].sort((a, b) => compareValues(a.value, b.value))
    : [...counts].sort((a, b) => b.count - a.count);

/** Total order over cell values, so min and max mean something for every type. */
export const compareValues = (a: CellValue, b: CellValue): number => {
  // Null is not a value and has no place in the middle of a series; it goes to
  // the end, deliberately, rather than wherever the word "null" happens to sort.
  if (a === null || b === null) return Number(a === null) - Number(b === null);
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean' || typeof b === 'boolean') {
    return Number(a === true) - Number(b === true);
  }
  const left = String(a);
  const right = String(b);
  // Digits sent as text compare as numbers, which is what they are: a
  // high-precision DECIMAL arrives as a string and must not sort like one.
  const leftNumber = Number(left);
  const rightNumber = Number(right);
  if (left !== '' && right !== '' && Number.isFinite(leftNumber) && Number.isFinite(rightNumber)) {
    return leftNumber - rightNumber;
  }
  return left < right ? -1 : left > right ? 1 : 0;
};

/** Cuts values into equal ranges over their own span. */
export const binNumbers = (values: readonly number[], bins = HISTOGRAM_BINS): SummaryBin[] => {
  if (values.length === 0) return [];
  let low = values[0] as number;
  let high = low;
  for (const value of values) {
    if (value < low) low = value;
    if (value > high) high = value;
  }
  // Every value the same: one bar, which is the truthful picture of that.
  if (high === low) return [{ from: low, to: low, count: values.length }];
  const width = (high - low) / bins;
  const counts = new Array<number>(bins).fill(0);
  for (const value of values) {
    const index = Math.min(bins - 1, Math.floor((value - low) / width));
    counts[index] = (counts[index] as number) + 1;
  }
  return counts.map((count, index) => ({
    from: low + index * width,
    to: low + (index + 1) * width,
    count,
  }));
};
