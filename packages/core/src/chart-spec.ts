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

/**
 * Rows a data set of unreduced rows carries before it says it has not read them
 * all.
 *
 * Far below the row limit, and for a reason that is not the database: every row
 * of an unreduced data set becomes elements in a layout, and the layout is walked
 * per element in JavaScript to read its geometry back. The engine will happily
 * return a million; the walk is what cannot.
 */
export const DEFAULT_FRAME_ROWS = 5_000;

/** The most an unreduced data set will carry however much is asked for. */
export const MAX_FRAME_ROWS = 20_000;

/** The name the chart's own reduction is always offered under. */
export const PRIMARY_FRAME = 'primary';

/**
 * Which part of a relation a data set reads.
 *
 * The answer to "a series longer than the screen". A chart of a billion points is
 * a chart of a few hundred pixels' worth of them, and which few hundred is a
 * question the picture asks as somebody moves along it — so a data set says where
 * it is looking rather than always starting at the beginning.
 *
 * Two ways to say where, because they answer different questions. A *position*
 * window is the table's own mechanism — a row offset and a count — and is right
 * when the relation is already in the order the axis is in, which for a series
 * means `ORDER BY` in the statement behind it. A *value* window says which values
 * of a column it wants, which is what survives a change of scope: position four
 * billion means nothing after a filter, and "the first of March to the eighth"
 * means the same thing whatever else moved.
 */
export type ChartWindowSpec =
  | { readonly by: 'position'; readonly from: number; readonly count: number }
  | {
      readonly by: 'value';
      readonly column: string;
      readonly from: CellLike;
      readonly to: CellLike;
    };

/** What a window's bounds may be: whatever a cell of that column can hold. */
export type CellLike = string | number | boolean | null;

/** How a series longer than the screen is reduced to fit it. */
export type ChartResampleMethod = 'extremes' | 'mean' | 'lttb';

export const CHART_RESAMPLE_METHODS: readonly ChartResampleMethod[] = Object.freeze([
  'extremes',
  'mean',
  'lttb',
]);

/** Points a resampled data set carries when nothing said how many. */
export const DEFAULT_RESAMPLE_POINTS = 600;

/** The most any resampling will carry: more points than a box has pixels is waste. */
export const MAX_RESAMPLE_POINTS = 4_000;

/**
 * A named data set a chart reads, beyond the reduction it always gets.
 *
 * The reduction — a category, its measures, and one row per group — is the shape
 * a bar chart wants and the only shape there was. It cannot express a matrix with
 * a third column to colour by, a scatter whose points are sized by a fourth, or
 * anything at all that is not one row per category. So a specification may name
 * data sets of its own, each shaped the way the picture needs, and a written
 * option reads them by name.
 *
 * Every kind reads the same relation the chart was opened on. Reading *another*
 * box is a binding, which is a fact about the document rather than about the
 * picture, and is not this.
 */
export type ChartFrameSpec =
  /**
   * A reduction, as the chart's own is: one row per category, a column per
   * measure — or `[category, breakdown, value]` triples where a second grouping
   * column makes it a cross-tabulation.
   */
  | {
      readonly name: string;
      readonly kind: 'group';
      readonly category: string;
      readonly values: readonly string[];
      readonly aggregate: ChartAggregate;
      readonly breakdown?: string;
      readonly sort?: ChartSort;
      readonly categoryLimit?: number;
      /** Decimal places its figures are read to; see `ChartSpec.precision`. */
      readonly precision?: number;
    }
  /**
   * Rows as they are, projected to the columns named.
   *
   * The shape a heatmap, a scatter with a size channel, a graph's edges and a
   * tree's parents all need, and the one thing a reduction can never be.
   */
  | {
      readonly name: string;
      readonly kind: 'rows';
      readonly columns: readonly string[];
      /**
       * The column that says which rows a drawn mark stands for.
       *
       * What makes a picked mark mean something. Without it a heatmap cell can be
       * hovered and picked out like anything else, and there is nothing to open
       * the rows behind it with — the cell knows where it is in a data set and
       * nothing about the relation the data set came from.
       *
       * One column, not several: `x AND y` is two predicates, and a row filter is
       * one. A cell of a matrix therefore drills down on whichever of its axes is
       * named here, which is a partial answer that says so rather than a whole one
       * that is not available yet.
       */
      readonly key?: string;
      readonly rowLimit?: number;
      readonly window?: ChartWindowSpec;
    }
  /**
   * A long series, reduced to fit the pixels it will be drawn in.
   *
   * The one kind that exists for a reason that is not the database: a million
   * points is nothing to an engine and impossible for a layout, which walks every
   * element in JavaScript to read its geometry back. So the reduction happens
   * where the rows are and what crosses is a few hundred points.
   *
   * `extremes` keeps the highest and lowest of each bucket, which is the honest
   * default for a series: a mean of a bucket hides the spike that was the reason
   * to look. `mean` is for a trend. `lttb` keeps the points that make the shape.
   */
  | {
      readonly name: string;
      readonly kind: 'resample';
      /** The column along the axis — usually a time. */
      readonly x: string;
      /** The columns measured against it. */
      readonly values: readonly string[];
      readonly method?: ChartResampleMethod;
      /** Points to carry; a box's width in pixels is a good number. */
      readonly points?: number;
      readonly window?: ChartWindowSpec;
      readonly key?: string;
    }
  /**
   * One number, for a reference line or a threshold.
   *
   * Read through `{"$param": "name"}` anywhere in a written option, because a
   * base rate typed into a `markLine` is an annotation that goes quietly out of
   * date the moment the query behind it changes.
   */
  | {
      readonly name: string;
      readonly kind: 'scalar';
      readonly column: string;
      readonly aggregate: ChartAggregate;
    };

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
  /**
   * Decimal places the measured figures are read to.
   *
   * For a chart somebody quotes from: a sum of money wants two places whatever
   * the addition came out as. Left out, figures carry twelve significant digits —
   * enough for anything this could have measured, and short of the noise binary
   * addition leaves behind.
   */
  readonly precision?: number;
  /**
   * Data sets of the chart's own, beyond the reduction it always gets.
   *
   * Absent for every chart the controls can produce, which is why nothing about
   * the simple path changes: a bar chart of a category and a measure needs no
   * data set it has to name.
   */
  readonly frames?: readonly ChartFrameSpec[];

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
/** The kinds of data set a specification may name. */
export const CHART_FRAME_KINDS: readonly ChartFrameSpec['kind'][] = Object.freeze([
  'group',
  'rows',
  'resample',
  'scalar',
]);

/** What is wrong with a window, or `null` where nothing is. */
export const chartWindowProblem = (window: ChartWindowSpec): string | null => {
  if (window.by === 'position') {
    if (!Number.isFinite(window.from) || window.from < 0) return 'a window starts at a row, from 0';
    if (!Number.isFinite(window.count) || window.count < 1) return 'a window covers at least a row';
    return null;
  }
  if (window.column.trim() === '') return 'a window by value needs a column to bound';
  if (window.from === null || window.to === null) return 'a window by value needs both bounds';
  return null;
};

/**
 * The same window, moved along by whole windows.
 *
 * Only a position window can be moved without knowing the data: a value window's
 * next page is whatever the axis says comes next, and only the picture knows that.
 */
export const shiftedWindow = (window: ChartWindowSpec, pages: number): ChartWindowSpec | null => {
  if (window.by !== 'position') return null;
  const from = Math.max(0, Math.round(window.from + pages * window.count));
  return from === window.from ? window : { ...window, from };
};

/**
 * What is wrong with a list of data sets, or `null` where nothing is.
 *
 * One check, used by the boundary that reads a specification from an agent and by
 * the reduction that builds the data sets: a name nothing can refer to, or two
 * data sets answering to one name, is a picture that draws from the wrong numbers
 * and cannot say so.
 */
export const chartFramesProblem = (frames: readonly ChartFrameSpec[]): string | null => {
  const seen = new Set<string>();
  for (const frame of frames) {
    if (frame.name.trim() === '') return 'a data set needs a name to be read by';
    if (frame.name === PRIMARY_FRAME) {
      return `"${PRIMARY_FRAME}" is the name of the chart's own reduction; a data set needs another`;
    }
    if (seen.has(frame.name)) return `two data sets are called "${frame.name}"`;
    seen.add(frame.name);
    if (frame.kind === 'rows' && frame.columns.length === 0) {
      return `data set "${frame.name}" names no columns to read`;
    }
    if (frame.kind === 'rows' && frame.key !== undefined && !frame.columns.includes(frame.key)) {
      return `data set "${frame.name}" says its key is ${frame.key}, which it does not read`;
    }
    if (frame.kind === 'resample') {
      if (frame.x.trim() === '') return `data set "${frame.name}" needs a column along the axis`;
      if (frame.values.length === 0) {
        return `data set "${frame.name}" needs at least one column to measure`;
      }
    }
    if (frame.kind !== 'group' && frame.kind !== 'scalar' && frame.window !== undefined) {
      const problem = chartWindowProblem(frame.window);
      if (problem !== null) return `data set "${frame.name}": ${problem}`;
    }
    if (frame.kind === 'group' && frame.category.trim() === '') {
      return `data set "${frame.name}" needs a category to group by`;
    }
    if (frame.kind === 'group' && frame.aggregate !== 'count' && frame.values.length === 0) {
      return `data set "${frame.name}" needs a column to measure, or the count aggregate`;
    }
    if (frame.kind === 'scalar' && frame.column.trim() === '') {
      return `data set "${frame.name}" needs a column to reduce to a number`;
    }
  }
  return null;
};

/** The data sets a specification names, which is none for almost every chart. */
export const chartFramesOf = (spec: ChartSpec): readonly ChartFrameSpec[] => spec.frames ?? [];

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
