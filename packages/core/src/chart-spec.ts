/**
 * What a chart is asked to draw.
 *
 * Document state, like a column width and like a query's statement: it is
 * authored content and belongs in history. The *rows* it draws are not — they are
 * a projection of a result set, exactly as a table's rows are, which is why a
 * chart entity carries a specification and never data.
 *
 * Deliberately small. A chart of a table answers "how does this measure vary
 * across that dimension", and everything here serves that one sentence. A
 * grammar of graphics belongs in the library that draws it, not in the document
 * model — what is stored is the question, not the drawing.
 */

/**
 * The kinds of chart.
 *
 * Five drawn from the controls, and one written out.
 *
 * `custom` is the door all the way out: the option is the author's, and Panorama
 * supplies only what the seam requires and the theme's colours and font, so the
 * whole of what ECharts can draw — radar, sankey, heatmap, gauge, a graph — is
 * reachable without a control per setting for each of them. It is in the form
 * because hiding it would be a lie about what the chart can do, but it is aimed
 * at an agent: writing an ECharts option by hand in a textarea is a poor use of a
 * person's afternoon and a very good use of a language model's.
 */
export type ChartType = 'bar' | 'line' | 'area' | 'scatter' | 'pie' | 'custom';

export const CHART_TYPES: readonly ChartType[] = Object.freeze([
  'bar',
  'line',
  'area',
  'scatter',
  'pie',
  'custom',
]);

/** True for a chart whose option was written rather than assembled. */
export const isCustomChart = (type: ChartType): boolean => type === 'custom';

/** How the measures are combined for each category. */
export type ChartAggregate = 'sum' | 'average' | 'count' | 'min' | 'max';

export const CHART_AGGREGATES: readonly ChartAggregate[] = Object.freeze([
  'sum',
  'average',
  'count',
  'min',
  'max',
]);

/**
 * The order the categories are drawn in.
 *
 * `size` puts the biggest first, which is what you want when you are looking for
 * the big ones. `name` is alphabetical, which is what you want when you are
 * looking up a particular one. `natural` keeps the order the rows arrived in,
 * which is the only truthful choice when the rows are already sorted — a query
 * with an `ORDER BY` has said something, and re-sorting throws it away.
 */
export type ChartSort = 'size' | 'name' | 'natural';

export const CHART_SORTS: readonly ChartSort[] = Object.freeze(['size', 'name', 'natural']);

/** How the line between two points is drawn. */
export type ChartCurve = 'straight' | 'smooth' | 'stepped';

export const CHART_CURVES: readonly ChartCurve[] = Object.freeze(['straight', 'smooth', 'stepped']);

/** Bars along the bottom, or along the side — which long category names need. */
export type ChartOrientation = 'vertical' | 'horizontal';

export const CHART_ORIENTATIONS: readonly ChartOrientation[] = Object.freeze([
  'vertical',
  'horizontal',
]);

/** A value axis that counts evenly, or one that counts in multiples. */
export type ChartScale = 'linear' | 'log';

export const CHART_SCALES: readonly ChartScale[] = Object.freeze(['linear', 'log']);

/**
 * When to name the series.
 *
 * `auto` shows a legend once there is more than one series to tell apart, which
 * is right almost always and is why it is the default rather than a choice
 * everybody has to make.
 */
export type ChartLegend = 'auto' | 'always' | 'never';

export const CHART_LEGENDS: readonly ChartLegend[] = Object.freeze(['auto', 'always', 'never']);

/** Rows a chart reads before it starts saying it has not read them all. */
export const DEFAULT_CHART_ROWS = 20_000;

/** Categories a chart draws before the rest are gathered into one. */
export const DEFAULT_CHART_CATEGORIES = 24;

export interface ChartSpec {
  readonly type: ChartType;
  /** The column whose values become the categories, or the horizontal axis. */
  readonly category: string;
  /**
   * The columns measured against them. More than one draws more than one series,
   * which is what makes a legend worth having.
   */
  readonly values: readonly string[];
  readonly aggregate: ChartAggregate;
  /**
   * A second column to group by, which turns one measure into a series each.
   *
   * The reduction is otherwise a category against one or more *columns*, and that
   * cannot express a cross-tabulation: claim type against decile is two columns
   * of data, not two measures. With a breakdown the series are the distinct
   * values of this column, so `claim type × decile` is a grouped bar chart, a
   * stacked one, or — for a custom chart, which gets the same numbers as
   * `[category, breakdown, value]` triples — a heatmap.
   *
   * One measure at a time: two measures broken down two ways is a cube, and a
   * cube is not a picture.
   */
  readonly breakdown?: string;
  readonly sort?: ChartSort;
  /** Rows read to build it. The chart says so when it did not read them all. */
  readonly rowLimit?: number;
  /** Categories kept; the remainder are gathered rather than dropped. */
  readonly categoryLimit?: number;

  /** Sums the series on top of each other rather than side by side. */
  readonly stacked?: boolean;
  readonly orientation?: ChartOrientation;
  readonly curve?: ChartCurve;
  /** A mark at each data point, for a line you want to read values off. */
  readonly showPoints?: boolean;
  /** A hole in the middle of a pie, which makes it easier to compare arcs. */
  readonly hole?: boolean;
  readonly scale?: ChartScale;
  /** The figure written on each mark, for a chart somebody has to quote from. */
  readonly showValues?: boolean;
  readonly showGrid?: boolean;
  readonly legend?: ChartLegend;
  /**
   * An ECharts option, as text.
   *
   * The door out of the curated controls, and how far out depends on the type.
   * For the five assembled kinds it is merged over what the controls produced:
   * every chart library has hundreds of settings, a form with hundreds of
   * controls is not a form, so the controls cover what people reach for and this
   * covers the rest. For a `custom` chart it *is* the chart.
   *
   * Kept as the text that was written rather than as the object it parses to,
   * because what somebody wants to come back to is what they typed.
   */
  readonly extra?: string;
}

/**
 * Something a chart can be told, that only some kinds of chart can be told.
 *
 * One list, read by the form to decide which controls to show and by the option
 * builder to decide which settings to apply. A control that appears where it
 * does nothing is worse than one that is not there, and the two must not be able
 * to disagree about which case this is.
 */
export type ChartFeature = 'stack' | 'orientation' | 'curve' | 'points' | 'hole' | 'scale' | 'grid';

/**
 * Chart types that place marks against a pair of axes.
 *
 * A custom chart is not one of them however it draws: what axes it has, if any,
 * are in the option that was written, and nothing here is entitled to an opinion
 * about them.
 */
const CARTESIAN: ReadonlySet<ChartType> = new Set<ChartType>(['bar', 'line', 'area', 'scatter']);

export const isCartesianChart = (type: ChartType): boolean => CARTESIAN.has(type);

const FEATURES: Readonly<Record<ChartFeature, ReadonlySet<ChartType>>> = Object.freeze({
  stack: new Set<ChartType>(['bar', 'area']),
  orientation: new Set<ChartType>(['bar']),
  curve: new Set<ChartType>(['line', 'area']),
  points: new Set<ChartType>(['line', 'area']),
  hole: new Set<ChartType>(['pie']),
  scale: CARTESIAN,
  grid: CARTESIAN,
});

export const chartSupports = (type: ChartType, feature: ChartFeature): boolean =>
  FEATURES[feature].has(type);

/**
 * Parses the escape hatch.
 *
 * Reported rather than thrown, and rather than swallowed: a chart whose extra
 * settings do not parse should still draw without them and should say why, which
 * is a great deal more use than either a blank box or a silently ignored field.
 */
export const parseChartExtra = (
  text: string | undefined,
): { readonly option?: Record<string, unknown>; readonly error?: string } => {
  const trimmed = text?.trim() ?? '';
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Extra settings must be a JSON object' };
  }
  return { option: parsed as Record<string, unknown> };
};

/**
 * A chart nobody has configured yet: the first column against the first number.
 *
 * A guess rather than an empty form, because a chart that draws something the
 * moment it opens tells the user what the controls do, and an empty one tells
 * them nothing at all.
 */
export interface ChartColumnHint {
  readonly name: string;
  readonly numeric: boolean;
  /**
   * True for a number that looks like a quantity rather than an identifier.
   *
   * A whole-number column is as likely to be a key as a measure, and summing
   * order numbers is a chart of nothing. A column with decimal places is a
   * measurement, so it is the better guess — and where there is no such column
   * the whole numbers are all that is on offer.
   */
  readonly measure?: boolean;
}

export const defaultChartSpec = (columns: readonly ChartColumnHint[]): ChartSpec => {
  const numeric = columns.filter((column) => column.numeric);
  const category = columns.find((column) => !column.numeric) ?? columns[0];
  const usable = numeric.filter((column) => column.name !== category?.name);
  const value = usable.find((column) => column.measure === true) ?? usable[0] ?? numeric[0];
  return {
    type: 'bar',
    category: category?.name ?? '',
    // Counting rows needs no measure at all, which is the honest fallback for a
    // table that has no numbers in it.
    values: value === undefined ? [] : [value.name],
    aggregate: value === undefined ? 'count' : 'sum',
  };
};

/** True where the series are the values of a column rather than the columns. */
export const isBrokenDown = (spec: ChartSpec): boolean =>
  spec.breakdown !== undefined && spec.breakdown !== '' && spec.breakdown !== spec.category;

/**
 * True once a spec names enough to draw.
 *
 * A custom chart names it in the option: there is nothing else to fill in, and a
 * written option that parses is a chart even when it reads no column at all — a
 * gauge of one number is a chart. What the columns then decide is what arrives in
 * the dataset beside it, which the option may use or ignore.
 */
export const isChartSpecDrawable = (spec: ChartSpec): boolean =>
  isCustomChart(spec.type)
    ? parseChartExtra(spec.extra).option !== undefined
    : spec.category !== '' && (spec.aggregate === 'count' || spec.values.length > 0);

/** The ECharts series types a written option asks for, in the order written. */
const seriesTypesOf = (spec: ChartSpec): readonly string[] => {
  const series = parseChartExtra(spec.extra).option?.['series'];
  const list = Array.isArray(series) ? (series as readonly unknown[]) : [series];
  return list.flatMap((entry) => {
    const type =
      typeof entry === 'object' && entry !== null
        ? (entry as Record<string, unknown>)['type']
        : undefined;
    return typeof type === 'string' ? [type] : [];
  });
};

/** A one-line description, for a title bar and a connector's label. */
export const describeChartSpec = (spec: ChartSpec): string => {
  if (isCustomChart(spec.type)) {
    // Named by what the option actually asks for, because "custom" on its own
    // says only that somebody wrote it, and a title bar has room for the answer.
    const types = seriesTypesOf(spec);
    return types.length === 0 ? 'custom chart' : `custom: ${[...new Set(types)].join(', ')}`;
  }
  const measure =
    spec.aggregate === 'count' ? 'count' : `${spec.aggregate} of ${spec.values.join(', ')}`;
  const by = isBrokenDown(spec) ? `${spec.category} × ${spec.breakdown ?? ''}` : spec.category;
  return `${spec.type}: ${measure} by ${by}`;
};
