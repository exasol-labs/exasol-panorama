import type { ChartSpec } from '@panorama/core';
import type { CellValue } from '@panorama/table';
import type { ChartFrame } from './frame.js';

/**
 * What a chart hands the renderer.
 *
 * Geometry, not pixels, and deliberately the same two shapes the table renderer
 * already speaks: filled polygons and runs of text. A chart is then drawn by the
 * same two batches as everything else, which is what lets it be legible at any
 * zoom, exist in a headset, and cost nothing extra per frame.
 *
 * These types are Panorama's own rather than any library's. Whatever draws the
 * chart — the ECharts adapter today, something else tomorrow — meets Panorama
 * here, and nothing on the far side of this file knows which it was.
 */

/** Linear RGBA in `[0, 1]`, matching the renderer's own colour convention. */
export type ChartRgba = readonly [number, number, number, number];

/**
 * Which piece of the data a piece of geometry belongs to.
 *
 * Carried on the geometry rather than looked up afterwards, because a bar is a
 * dozen triangles and the only moment anything knows they are all the same bar is
 * the moment they are read out of the layout. With it, pointing at a chart is
 * ordinary hit testing against ordinary geometry — the same as pointing at a
 * column header or a connector's marker — and works the same under a finger and
 * along an XR ray as it does under a mouse.
 */
export interface ChartMark {
  readonly series: number;
  readonly data: number;
  /**
   * Where the mark's numbers came from: the data set, and which of its rows.
   *
   * Carried rather than worked out afterwards, for the same reason the series and
   * the data index are: the moment the geometry is read out of a layout is the
   * only moment anything knows which row a triangle belongs to. With it, a picked
   * heatmap cell, sankey ribbon or treemap tile can be traced back to the
   * relation — which is what makes selection and drilling in mean the same thing
   * for every kind of chart instead of only for the ones built from the reduction.
   *
   * Absent where a series reads no data set, which is nothing Panorama builds and
   * only a written option that carries its own numbers.
   */
  readonly frame?: string;
  readonly row?: number;
}

export const sameChartMark = (
  left: ChartMark | null | undefined,
  right: ChartMark | null | undefined,
): boolean =>
  left === right ||
  (left !== null &&
    left !== undefined &&
    right !== null &&
    right !== undefined &&
    left.series === right.series &&
    left.data === right.data);

export interface ChartPolygon {
  /**
   * Four corners, wound consistently: `x0,y0, x1,y1, x2,y2, x3,y3`. A triangle
   * repeats its last corner, which is how the quad batch already takes them.
   */
  readonly corners: readonly [number, number, number, number, number, number, number, number];
  readonly color: ChartRgba;
  /** Absent for the chart's furniture: axes, grid lines, the legend's frame. */
  readonly mark?: ChartMark;
}

export type ChartTextAlign = 'left' | 'right' | 'center';

export interface ChartText {
  /**
   * Chart-local, origin top-left, +y downwards — as the draw list has it. `x` is
   * the left edge and `width` the measured width, so the box is exactly the text:
   * a renderer can align inside it however it likes and get the same answer, and
   * an exporter with different font metrics can re-place the run from whichever
   * edge `align` says was the anchored one.
   */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly text: string;
  readonly color: ChartRgba;
  readonly align: ChartTextAlign;
  readonly fontSize: number;
  readonly bold?: boolean;
  readonly mark?: ChartMark;
}

export interface ChartDrawList {
  readonly polygons: readonly ChartPolygon[];
  readonly texts: readonly ChartText[];
}

export const EMPTY_CHART_DRAW_LIST: ChartDrawList = Object.freeze({
  polygons: Object.freeze([]),
  texts: Object.freeze([]),
});

/**
 * How a chart is measured and drawn, by whatever is drawing it.
 *
 * `measureText` is the hinge. The library laying the chart out has to agree with
 * Panorama's glyph atlas about how wide a label is, or its axis labels will be
 * spaced and rotated for text of a different size than the text that appears —
 * so the atlas's own measurement is passed *in* rather than the library's
 * measurement being worked around afterwards.
 */
export interface ChartTypography {
  measureText(text: string, fontSize: number, bold: boolean): number;
  readonly fontFamily: string;
}

export interface ChartTheme {
  readonly background: ChartRgba;
  readonly text: ChartRgba;
  readonly axis: ChartRgba;
  readonly grid: ChartRgba;
  readonly series: readonly ChartRgba[];
  readonly fontSize: number;
}

/**
 * One data set a chart was offered, as the chart understood it.
 *
 * Named because a name is what an author refers to it by, and dimensioned because
 * a column that is not there is the commonest reason a series draws nothing.
 */
export interface ChartDatasetResolution {
  /** The name the option refers to it by, where it has one. */
  readonly name?: string;
  readonly dimensions: readonly string[];
  readonly rows: number;
}

/**
 * What one series turned out to be reading.
 *
 * The counterpart of the geometry read-back, for correctness rather than for
 * layout: geometry says a picture came out the right shape, and this says it came
 * out of the right numbers. Without it a written option that quietly read the
 * wrong column draws a chart that is beautiful and false, and nothing at the far
 * end of a pipe can tell.
 */
export interface ChartSeriesResolution {
  readonly index: number;
  /** The series type, as the option asked for it. */
  readonly type: string;
  /** The data set it read, by name where it had one. */
  readonly dataset?: string;
  /** Which dimension each visual channel resolved to: `x`, `y`, `value`, … */
  readonly encode?: Readonly<Record<string, string>>;
  /** Marks drawn for it, counted from the geometry rather than from the option. */
  readonly marks: number;
}

/**
 * What a laid-out chart resolved to, in Panorama's own terms.
 *
 * `unresolved` is the point of it: a channel naming a dimension its data set has
 * not got is the failure that looks like success. Reported as sentences because
 * whoever reads them cannot look at the chart.
 */
export interface ChartResolution {
  readonly datasets: readonly ChartDatasetResolution[];
  readonly series: readonly ChartSeriesResolution[];
  readonly unresolved: readonly string[];
  /**
   * Whether anything drawn can be pointed at.
   *
   * A mark is found in the geometry, so picking works for any series the library
   * links back to its rows — which is most of them and not all of them. A
   * calendar heatmap is the known counterexample: its cells are drawn by the
   * calendar component and carry no row index anywhere in the display list, so
   * there is nothing to find. That is not something an author can fix by writing
   * the option differently, so it is reported as a property of the picture rather
   * than as a mistake in it: a correct chart that is inert.
   */
  readonly pickable: boolean;
}

export const EMPTY_CHART_RESOLUTION: ChartResolution = Object.freeze({
  datasets: Object.freeze([]),
  series: Object.freeze([]),
  unresolved: Object.freeze([]),
  pickable: false,
});

/**
 * A chart that can be laid out, pointed at, and read as geometry.
 *
 * Stateful on purpose: the thing that knows a tooltip is open, or a legend entry
 * switched off, is the library — and asking it what it looks like now is cheaper
 * and more truthful than reimplementing its state machine.
 */
export interface ChartSurface {
  /** Lays the chart out afresh for a specification, its rows, and a size. */
  update(input: ChartSurfaceInput): void;
  /**
   * The chart as a standalone SVG document, or `null` before it has been laid
   * out.
   *
   * Asked of the library rather than built from the draw list on purpose: the
   * draw list is triangles and text, which is exactly right for a GPU and quite
   * wrong for a file somebody is going to open in a drawing program. The library
   * still has the arcs and the curves, so for this one format it is worth asking
   * it to write them down.
   */
  toSvg(): string | null;
  /**
   * Reports where the pointer is, in chart-local units, so that highlighting and
   * tooltips are the library's business rather than ours.
   */
  point(x: number | null, y: number | null): void;
  draw(): ChartDrawList;
  /**
   * What the last layout read, and what it could not find.
   *
   * Asked of whatever laid the chart out, because it is the only thing that knows
   * how a written option's channels were matched against the data — and a written
   * option is exactly the case where nobody can see the answer.
   */
  resolution(): ChartResolution;
  dispose(): void;
}

/**
 * The look of a chart on Panorama's canvas.
 *
 * Muted axes, a light grid, and a series palette that reads at a glance without
 * shouting — the same restraint as the tables, because a chart beside a table
 * should look like part of the same document.
 */
export const DEFAULT_CHART_THEME: ChartTheme = Object.freeze({
  background: Object.freeze([1, 1, 1, 1]) as ChartRgba,
  text: Object.freeze([0.46, 0.5, 0.54, 1]) as ChartRgba,
  axis: Object.freeze([0.73, 0.75, 0.78, 1]) as ChartRgba,
  grid: Object.freeze([0.89, 0.9, 0.92, 1]) as ChartRgba,
  series: Object.freeze([
    Object.freeze([0.18, 0.44, 0.93, 1]) as ChartRgba,
    Object.freeze([0.84, 0.48, 0.18, 1]) as ChartRgba,
    Object.freeze([0.21, 0.66, 0.44, 1]) as ChartRgba,
    Object.freeze([0.54, 0.27, 0.78, 1]) as ChartRgba,
    Object.freeze([0.86, 0.24, 0.35, 1]) as ChartRgba,
    Object.freeze([0.13, 0.6, 0.71, 1]) as ChartRgba,
  ]),
  fontSize: 10,
});

export interface ChartSurfaceInput {
  /**
   * How to draw it. Kept apart from the numbers on purpose: the specification is
   * the question the user asked, the data is what came back, and the two change
   * for different reasons — a colour is not a reason to read the rows again.
   */
  readonly spec: ChartSpec;
  readonly data: ChartData;
  /**
   * The data sets the chart was given, the reduction first.
   *
   * Beside `data` rather than instead of it: the assembled charts are built from
   * the reduction directly, and a written option reads whichever of these it
   * names. One read of the rows produced both.
   */
  readonly frames: readonly ChartFrame[];
  readonly width: number;
  readonly height: number;
  readonly theme: ChartTheme;
  /**
   * Passed in with every layout rather than configured once, so there is no
   * order to get wrong and no hidden global deciding how wide a label is.
   */
  readonly typography: ChartTypography;
}

/** Values for one series, one per category, with gaps where there were none. */
export interface ChartSeries {
  readonly name: string;
  readonly values: readonly (number | null)[];
}

/**
 * The rows a chart draws, already reduced.
 *
 * Reduced before it crosses the worker boundary, because a chart of ten billion
 * rows is a few dozen numbers and sending the rows to find that out would be
 * sending the whole table to draw a picture of it.
 */
export interface ChartData {
  readonly categories: readonly string[];
  /**
   * The same categories as the values they came from, not as their labels.
   *
   * A label is for reading; a value is for filtering. `String(7)` names the
   * category a bar stands for perfectly well and cannot be compared against a
   * numeric column, so both are kept and each is used for what it is.
   */
  readonly values: readonly CellValue[];
  readonly series: readonly ChartSeries[];
  /** Rows the numbers came from, and whether that was all of them. */
  readonly rows: number;
  readonly basis: 'exact' | 'sampled';
  /** Set when categories beyond the limit were gathered into one. */
  readonly gathered?: number;
}
