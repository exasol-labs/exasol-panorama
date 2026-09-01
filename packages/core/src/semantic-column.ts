/**
 * What a column *means*, where something has said so.
 *
 * Panorama knows a column's name, its SQL type, its foreign key, its comment and
 * its row count. None of that says what the number *is* — whether it is money,
 * whether it is a share of something else, whether anybody has vouched for it.
 * A semantic layer knows all of it, and `exasol-semantic-views` publishes it as
 * ordinary views anybody may read.
 *
 * Which is why this is in core and names no product. What a column view carries
 * is the *meaning*, in the few terms the rest of Panorama can act on: what to
 * call it, what it is for, how to write it down, and whether it is governed.
 * Where it came from is one string — the model that said so — because a number a
 * reader is being asked to trust should be able to say who vouched for it.
 *
 * Absent on every ordinary column, which is why nothing else in the model
 * changes. See `JsonColumnView` for the same arrangement one layer down: that one
 * says which *cells* a column reads, this one says what they mean.
 */

/**
 * A measure or a thing to group by.
 *
 * The distinction the semantic layer draws first, and the one that decides how a
 * column may be charted: a metric is summed down a column, a dimension is what it
 * is summed *by*. Panorama's chart editor does not know it yet — that is the next
 * slice — but a column that carries it can already say which it is.
 */
export type SemanticFieldKind = 'metric' | 'dimension';

export interface SemanticColumnView {
  readonly kind: SemanticFieldKind;
  /**
   * The model that says all this, by name.
   *
   * Kept because meaning has an author. Two models may describe the same physical
   * column differently and both be right for their own audience, and a reader
   * asking "says who?" deserves an answer that is not "the database".
   */
  readonly model: string;
  /**
   * What to call it: `Total Revenue`, not `TOTAL_REVENUE`.
   *
   * Absent where the model never set one, which is common — an author who names
   * a metric well often does not bother. The column's own name is then already
   * the best available answer and no worse than it was.
   */
  readonly displayName?: string;
  /** What it is, in the author's words. */
  readonly description?: string;
  /**
   * How to write the value down: `currency`, `percentage`, `month` and so on.
   *
   * Deliberately a string rather than a union. The vocabulary is the model
   * author's and the layer's docs describe it as open — "a display hint such as
   * currency, percentage, or count" — so a hint nobody recognises has to be a
   * hint that changes nothing, not a value that fails to parse.
   */
  readonly format?: string;
  /** What the number is counted in, where the format alone does not say. */
  readonly unit?: string;
  /**
   * Somebody has vouched for this one.
   *
   * Worth a mark of its own, because a governed number and a number somebody
   * derived this morning should not look identical on a canvas where they sit
   * side by side.
   */
  readonly certified?: boolean;
  /** How sensitive the model says this is; shown, and not yet enforced. */
  readonly sensitivity?: string;
}

/**
 * What to write at the top of the column.
 *
 * One function rather than a `??` at each of the places that draw a header, so
 * the canvas, the width estimate and anything later cannot disagree about what a
 * column is called.
 */
export const semanticHeader = (name: string, semantic?: SemanticColumnView): string =>
  semantic?.displayName ?? name;

/**
 * True where the header is showing something other than the column's own name.
 *
 * The condition for saying the real name somewhere else: a person writing SQL
 * against a box needs the identifier, and a display name that has quietly
 * replaced it is a display name that has hidden it. Equal names are the ordinary
 * case and change nothing.
 */
export const semanticRenames = (name: string, semantic?: SemanticColumnView): boolean =>
  semantic?.displayName !== undefined && semantic.displayName !== name;
