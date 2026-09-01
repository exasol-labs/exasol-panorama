import type { JsonColumnView } from '@panorama/core';
import type { ColumnSummary } from './summary.js';

/**
 * What is in a property, across all the rows.
 *
 * The existing panel answers "how are this column's values distributed", and for
 * a property spread across several typed branches that is the wrong question
 * asked of the wrong column: a histogram of `value` describes the rows that
 * happened to be integers and says nothing about the ones that were strings, and
 * it cannot mention the three kinds of emptiness at all.
 *
 * So the first question is *what is in here*. How many rows used each branch, how
 * many were explicitly `null`, how many were an empty string, how many had no
 * such property. Then, underneath, the ordinary distribution of the branch the
 * column is named for — which is worth having, and worth being clear is a
 * statement about some of the rows rather than all of them.
 */

/** One branch, and how many rows arrived on it. */
export interface BranchCount {
  /** The contract's name for the type, or the column's own for the primary. */
  readonly name: string;
  readonly count: number;
  /** True for the branch the column is named after. */
  readonly primary?: boolean;
}

export interface JsonColumnSummary {
  readonly rows: number;
  /** A count per branch, in the order a value is looked for. */
  readonly branches: readonly BranchCount[];
  /** Present, and explicitly `null`. */
  readonly explicitNulls: number;
  /** Present, and an empty string. */
  readonly emptyStrings: number;
  /**
   * Not present at all.
   *
   * Worked out rather than counted: the rows no branch and no mask accounted
   * for. There is no column that says "this property was absent" — absence is
   * exactly the thing the storage cannot write down — so this is a subtraction,
   * and it is the number the whole document view exists to be able to show.
   */
  readonly missing: number;
  /** The distribution of the branch the column is named for, where it has one. */
  readonly dominant?: ColumnSummary;
}

/** How many rows of a summarised column held something. */
const held = (summary: ColumnSummary | null | undefined): number =>
  summary === null || summary === undefined ? 0 : summary.rows - summary.nulls;

/**
 * How many rows a boolean mask is true in.
 *
 * A mask is `TRUE` or NULL — never `FALSE` — in every family either loader
 * writes, so the count of non-nulls is the count of trues. Read from the named
 * frequencies where they are there, because a source that reports them is more
 * trustworthy than an inference, and fall back to the non-null count where it
 * does not.
 */
const maskTrue = (summary: ColumnSummary | null | undefined): number => {
  if (summary === null || summary === undefined) return 0;
  const named = summary.frequencies?.find((entry) => entry.value === true);
  return named?.count ?? held(summary);
};

/** What each physical column a property reads was summarised as. */
export interface JsonSummaryParts {
  /** By result-set index, so the caller need not know which is which. */
  readonly byIndex: ReadonlyMap<number, ColumnSummary | null>;
}

/**
 * Puts the pieces together into an answer about the property.
 *
 * Every count comes from a summary of one physical column; nothing here reads a
 * row. Which is what makes it testable, and what keeps the arithmetic — the
 * subtraction that produces `missing` — in one readable place.
 */
export const jsonColumnSummary = (
  json: JsonColumnView,
  parts: JsonSummaryParts,
  columnName: string,
): JsonColumnSummary => {
  const at = (index: number | undefined): ColumnSummary | null | undefined =>
    index === undefined ? undefined : parts.byIndex.get(index);

  const valued: BranchCount[] = json.branches.map((branch, position) => ({
    name: branch.branch ?? columnName,
    count: held(at(branch.index)),
    ...(position === 0 && branch.branch === undefined ? { primary: true } : {}),
  }));
  // A nested value is a branch too: what varies is the type, and one of the
  // types needing a second table to hold it does not make it a different answer
  // to "what is in here".
  if (json.objectLink !== undefined) {
    valued.push({ name: 'object', count: held(at(json.objectLink)) });
  }
  if (json.arrayCount !== undefined) {
    valued.push({ name: 'array', count: held(at(json.arrayCount)) });
  }

  const explicitNulls = maskTrue(at(json.nullMask));
  const emptyStrings = maskTrue(at(json.emptyMask));
  // However many rows anything at all was read from. Every summary is of the
  // same result set, so they agree — and taking the largest rather than the
  // first means a branch nothing could be said about does not shrink the total.
  const rows = Math.max(0, ...[...parts.byIndex.values()].map((summary) => summary?.rows ?? 0));
  const accounted =
    valued.reduce((total, branch) => total + branch.count, 0) + explicitNulls + emptyStrings;
  return {
    rows,
    branches: valued,
    explicitNulls,
    emptyStrings,
    // Never negative: a source that double-counts should not produce a negative
    // number of absent properties, which would be read as data.
    missing: Math.max(0, rows - accounted),
    ...(at(json.branches[0]?.index) === null || at(json.branches[0]?.index) === undefined
      ? {}
      : { dominant: at(json.branches[0]?.index) as ColumnSummary }),
  };
};

/** True where the breakdown says something a single distribution could not. */
export const worthBreakingDown = (json: JsonColumnView): boolean =>
  json.branches.length > 1 ||
  json.nullMask !== undefined ||
  json.emptyMask !== undefined ||
  json.objectLink !== undefined ||
  json.arrayCount !== undefined;
