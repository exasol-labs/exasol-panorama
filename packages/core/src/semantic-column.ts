import type { ChartAggregate } from './chart-spec.js';

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

/**
 * How a metric combines down a column, in the layer's own vocabulary.
 *
 * `SIMPLE` and `FILTERED` sum, average or count as their aggregation says.
 * `RATIO` and `DERIVED` do neither: a margin percentage has to be recomputed per
 * group, and summing one is arithmetic nobody asked for. That is why the
 * aggregation function is absent for them rather than defaulted — the metric
 * already says how it combines, and for these two the answer is "not like that".
 */
export type SemanticMetricKind = 'SIMPLE' | 'FILTERED' | 'RATIO' | 'DERIVED' | 'CUMULATIVE';

export interface SemanticColumnView {
  readonly kind: SemanticFieldKind;
  /**
   * How the layer refers to this field, and to the model it belongs to.
   *
   * Ids rather than names because that is how the model's own tables join, and
   * because a metric and a dimension may share a name. They are what makes a
   * *pairing* answerable: whether this metric may be broken down by that
   * dimension is a question about two fields of one model.
   */
  readonly modelId: number;
  readonly fieldId: number;
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
  /** For a metric: what kind of thing it is, and so whether it aggregates. */
  readonly metricKind?: SemanticMetricKind;
  /**
   * The function the metric declares — `SUM`, `AVG`, `COUNT` and so on.
   *
   * Absent where the metric declares none, which for a `RATIO` or a `DERIVED`
   * metric is the point rather than an omission.
   */
  readonly aggregation?: string;
}

/**
 * One pairing the model refuses, and why.
 *
 * The refusals are the interesting half: a pair the model says nothing about is
 * a pair nothing is known about — two fields of different objects, say — and
 * that is not the same as one it has ruled out.
 */
export interface SemanticPairing {
  readonly code: string;
  /** The path it tried and rejected, where the model recorded one. */
  readonly path?: string;
}

/**
 * The aggregate a chart should offer for a column, in Panorama's vocabulary.
 *
 * Three answers, and the third is the one worth having. A column the layer says
 * nothing about gets `undefined` — decide as before. A metric that declares a
 * function gets that function, so the editor opens on the model's own answer
 * rather than on `sum`. And a metric that declares none gets `null`: it must not
 * be aggregated at all, and offering `sum · average · count · min · max` on a
 * margin percentage invites exactly the arithmetic the model exists to prevent.
 */
export const semanticAggregate = (
  semantic: SemanticColumnView | undefined,
): ChartAggregate | null | undefined => {
  if (semantic === undefined || semantic.kind !== 'metric') return undefined;
  switch (semantic.aggregation?.toUpperCase()) {
    case 'SUM':
      return 'sum';
    case 'AVG':
    case 'AVERAGE':
      return 'average';
    case 'COUNT':
    case 'COUNT_DISTINCT':
      return 'count';
    case 'MIN':
      return 'min';
    case 'MAX':
      return 'max';
    default:
      // Declared nothing, or something Panorama has no equivalent for. Either
      // way the honest answer is not to pick one on the metric's behalf.
      return null;
  }
};

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
