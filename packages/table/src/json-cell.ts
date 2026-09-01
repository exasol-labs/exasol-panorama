import type { ColumnDataType, JsonColumnView } from '@panorama/core';
import type { CellValue } from './result-chunk.js';

/**
 * What a cell of a presented column actually says.
 *
 * The whole point of the feature is in this file. A document distinguishes four
 * kinds of nothing — the property held a value, the property was there and its
 * value was `null`, the property was there and its value was an empty string, the
 * property was not there — and SQL has one NULL for all four. The source
 * therefore writes the difference into boolean columns beside the value, and
 * reading them is what turns four identical dashes back into four different
 * answers.
 *
 * One function, because the rule has to be the same everywhere it is asked. The
 * grid draws it, the statistics panel counts it, an export writes it and an agent
 * reads it; four implementations of "was this null or was it missing" would
 * disagree, and the disagreement would look like data.
 */

export type PresentedCell =
  /** A value, and which of the property's branches it arrived on. */
  | {
      readonly state: 'value';
      readonly value: CellValue;
      readonly type: ColumnDataType;
      readonly branch?: string;
    }
  /** Present, and explicitly `null`. */
  | { readonly state: 'null' }
  /** Present, and an empty string — which the database stored as NULL. */
  | { readonly state: 'empty' }
  /** Not present at all. */
  | { readonly state: 'missing' }
  /** A nested document, identified by the key that opens it. */
  | { readonly state: 'object'; readonly key: CellValue }
  /** A nested list, and how many elements it has. */
  | { readonly state: 'array'; readonly length: number }
  /**
   * Not yet read.
   *
   * Kept distinct from `missing`, and that distinction matters more than it
   * looks: a cell whose block has not arrived is a fact about the fetch, and
   * drawing it as an absent property would be a statement about the document
   * that the next frame contradicts. The grid draws its usual placeholder.
   */
  | { readonly state: 'pending' };

/** Reads one result-set column of the row being presented. */
export type ReadCell = (index: number) => CellValue | undefined;

const truthy = (value: CellValue | undefined): boolean => value === true;

/**
 * The cell a property shows, out of the several columns it is spread across.
 *
 * The order of the tests is the order the states exclude one another. A value
 * comes first because at most one branch is ever populated and finding it settles
 * everything; a mask is only consulted once every branch has come back empty,
 * which is what makes the masks descriptions of an absence rather than flags that
 * could contradict a value.
 */
export const presentCell = (json: JsonColumnView, read: ReadCell): PresentedCell => {
  let pending = false;

  for (const branch of json.branches) {
    const value = read(branch.index);
    if (value === undefined) {
      pending = true;
      continue;
    }
    if (value === null) continue;
    return {
      state: 'value',
      value,
      type: branch.type,
      ...(branch.branch === undefined ? {} : { branch: branch.branch }),
    };
  }

  if (json.objectLink !== undefined) {
    const key = read(json.objectLink);
    if (key === undefined) pending = true;
    // A link that is there is a document that is there. The marker is the child
    // row's key on a plain object property and `TRUE` on a polymorphic array
    // element, and either way its presence is the answer.
    else if (key !== null && key !== false) return { state: 'object', key };
  }

  if (json.arrayCount !== undefined) {
    const count = read(json.arrayCount);
    if (count === undefined) pending = true;
    else if (count !== null) {
      // Zero is a list that is there and empty, which is not the same as no list
      // — and is the reason this reads the marker rather than testing for truth.
      const length = Number(count);
      if (Number.isFinite(length)) return { state: 'array', length };
    }
  }

  // No value anywhere. Now the masks say which kind of nothing this is.
  if (json.nullMask !== undefined) {
    const mask = read(json.nullMask);
    if (mask === undefined) pending = true;
    else if (truthy(mask)) return { state: 'null' };
  }
  if (json.emptyMask !== undefined) {
    const mask = read(json.emptyMask);
    if (mask === undefined) pending = true;
    else if (truthy(mask)) return { state: 'empty' };
  }

  // Something this cell depends on has not arrived, so "missing" would be a
  // claim rather than a reading.
  return pending ? { state: 'pending' } : { state: 'missing' };
};

/** The token drawn for a state that is not a value. Not localised; these are literals. */
export const EXPLICIT_NULL_TEXT = 'null';
export const EMPTY_STRING_TEXT = '""';
export const MISSING_TEXT = '—';
export const OBJECT_TEXT = '{…}';

/** What an array's cell says: how many, or that it is there and empty. */
export const arrayText = (length: number): string =>
  length === 0 ? 'empty' : length === 1 ? '1 item' : `${length} items`;

/** True where a cell leads somewhere, which is what makes it read as a link. */
export const isFollowable = (json: JsonColumnView, cell: PresentedCell): boolean =>
  json.follow !== undefined &&
  (cell.state === 'object' || (cell.state === 'array' && cell.length > 0));
