import type { ChartLegend, ChartSpec } from '@panorama/core';
import { chartSupports, isCartesianChart, isCustomChart, parseChartExtra } from '@panorama/core';
import type { ChartData, ChartFrame, ChartTheme, ChartTypography } from '@panorama/chart';
import { frameScalar } from '@panorama/chart';
import { toCssColour } from './colour.js';

/**
 * The question, put the way ECharts asks it.
 *
 * A plain object and nothing more — no ECharts import, so this file is testable
 * as data. The theme is Panorama's, converted to the CSS colours ECharts wants,
 * so a chart looks like the rest of the canvas rather than like a chart library.
 *
 * Every setting here comes from a control somebody can see, and every control is
 * offered only where `chartSupports` says it means something. That pairing is the
 * whole design: one list decides what the form shows and what this applies, so
 * they cannot drift into offering a dial that turns nothing.
 */

export type Option = Record<string, unknown>;

const legendVisible = (legend: ChartLegend | undefined, series: number): boolean => {
  if (legend === 'always') return true;
  if (legend === 'never') return false;
  // Once there is more than one series there is something to tell apart.
  return series > 1;
};

/**
 * Merges the escape hatch over what the controls produced.
 *
 * Deep, so that setting one property of the legend does not throw away the rest
 * of it — a shallow merge would make the raw field an all-or-nothing replacement
 * of whole branches, which is exactly the surprise nobody wants from an override.
 *
 * Lists merge element by element, which is how ECharts' own option merging
 * behaves and the only way the commonest override there is can work: `series: [{
 * itemStyle: { color: 'red' } }]` has to mean "recolour the first series", not
 * "replace both series with this one thing that is not a series at all". A longer
 * list than the base's adds to it.
 */
export const mergeOption = (base: unknown, over: unknown): unknown => {
  if (Array.isArray(base) && Array.isArray(over)) {
    const merged = [...(base as unknown[])];
    (over as unknown[]).forEach((value, index) => {
      merged[index] = index < base.length ? mergeOption(merged[index], value) : value;
    });
    return merged;
  }
  if (
    typeof base !== 'object' ||
    base === null ||
    Array.isArray(base) ||
    typeof over !== 'object' ||
    over === null ||
    Array.isArray(over)
  ) {
    return over;
  }
  const merged: Option = { ...(base as Option) };
  for (const [key, value] of Object.entries(over as Option)) {
    merged[key] = key in merged ? mergeOption(merged[key], value) : value;
  }
  return merged;
};

/**
 * The three settings that are not preferences.
 *
 * Forced last, over anything written. The geometry is read back once per change
 * rather than driven by a frame loop, so an animation would be captured as a
 * still frame of itself. A tooltip is a DOM overlay that does not survive this
 * seam at all, so one that was asked for would simply never appear. And the text
 * is drawn from a glyph atlas of one font, so another family would be measured in
 * ours and drawn in ours — laid out to fit a font nobody sees. None of the three
 * is a taste to be respected: they are properties of how the drawing is read.
 */
const seamed = (option: Option, typography: ChartTypography): Option => ({
  ...option,
  animation: false,
  tooltip: { show: false },
  textStyle: {
    ...(typeof option['textStyle'] === 'object' && option['textStyle'] !== null
      ? (option['textStyle'] as Option)
      : {}),
    fontFamily: typography.fontFamily,
  },
});

/** The label written on each mark, when the chart is one to quote from. */
const valueLabel = (spec: ChartSpec, theme: ChartTheme): Option =>
  spec.showValues === true
    ? { show: true, color: toCssColour(theme.text), fontSize: theme.fontSize }
    : { show: false };

const categoryAxis = (data: ChartData, theme: ChartTheme, text: string): Option => ({
  type: 'category',
  data: [...data.categories],
  axisLine: { lineStyle: { color: toCssColour(theme.axis) } },
  axisTick: { show: false },
  // Hidden rather than turned on its side: rotated labels would need the glyph
  // batch to rotate with them, and a label that cannot be drawn truthfully is
  // better left out than drawn in the wrong place. Bars along the side are the
  // real answer for long names, which is what the orientation control is for.
  axisLabel: { color: text, fontSize: theme.fontSize, hideOverlap: true, rotate: 0 },
  splitLine: { show: false },
});

const valueAxis = (spec: ChartSpec, theme: ChartTheme, text: string): Option => ({
  type: spec.scale === 'log' ? 'log' : 'value',
  axisLine: { show: false },
  axisLabel: { color: text, fontSize: theme.fontSize },
  splitLine:
    spec.showGrid === false ? { show: false } : { lineStyle: { color: toCssColour(theme.grid) } },
});

/** The one axis a scatter has no categories for. */
const scatterAxis = (theme: ChartTheme, text: string): Option => ({
  type: 'value',
  axisLine: { lineStyle: { color: toCssColour(theme.axis) } },
  axisLabel: { color: text, fontSize: theme.fontSize },
  splitLine: { show: false },
});

const seriesFor = (spec: ChartSpec, data: ChartData, theme: ChartTheme): readonly Option[] => {
  const label = valueLabel(spec, theme);
  const scatter = spec.type === 'scatter';
  const line = spec.type === 'line' || spec.type === 'area';
  return data.series.map((series) => ({
    name: series.name,
    type: spec.type === 'area' ? 'line' : spec.type,
    label,
    ...(spec.type === 'area' ? { areaStyle: {} } : {}),
    ...(line
      ? {
          smooth: spec.curve === 'smooth',
          ...(spec.curve === 'stepped' ? { step: 'middle' } : {}),
          symbol: spec.showPoints === false ? 'none' : 'circle',
          symbolSize: 5,
        }
      : {}),
    ...(spec.stacked === true && chartSupports(spec.type, 'stack') ? { stack: 'total' } : {}),
    data: scatter ? series.values.map((value, index) => [index, value]) : [...series.values],
  }));
};

/** The name the reduced rows are offered under. */
export const PRIMARY_DATASET = 'primary';

/**
 * The data sets, as ECharts takes them.
 *
 * Dimensions declared rather than written as a header row: a data set that says
 * what its columns are called is one an `encode` can be checked against, and the
 * resolution report reads the same declaration to say what a series resolved to.
 */
export const datasetsFor = (frames: readonly ChartFrame[]): readonly Option[] =>
  frames.map((frame) => ({
    id: frame.name,
    dimensions: [...frame.dimensions],
    source: frame.rows.map((row) => [...row]),
  }));

/** How a written option asks for a number a data set worked out. */
const PARAM_KEY = '$param';

/**
 * Puts the scalars where a written option asked for them.
 *
 * `{"$param": "baserate"}` anywhere in an option becomes the number that data set
 * reduced to. The one piece of grammar Panorama adds, and it exists because
 * ECharts has no equivalent: a reference line's value is a literal in the option,
 * so a base rate typed into one goes quietly out of date the moment the query
 * behind it changes.
 *
 * A name nothing answers to is left exactly as it was rather than guessed at — a
 * marker left in the option is reported by the resolution report, and a nought
 * substituted for it would be a line somebody believes.
 */
export const resolveParams = (value: unknown, frames: readonly ChartFrame[]): unknown => {
  if (Array.isArray(value)) return value.map((entry) => resolveParams(entry, frames));
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Option;
  const asked = record[PARAM_KEY];
  if (typeof asked === 'string' && Object.keys(record).length === 1) {
    const frame = frames.find((entry) => entry.name === asked);
    if (frame === undefined) return record;
    const scalar = frameScalar(frame);
    return scalar === null ? record : scalar;
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, resolveParams(entry, frames)]),
  );
};

export const chartOption = (
  spec: ChartSpec,
  data: ChartData,
  frames: readonly ChartFrame[],
  theme: ChartTheme,
  typography: ChartTypography,
): Option => {
  const text = toCssColour(theme.text);
  const legend = legendVisible(spec.legend, data.series.length);
  // Offered to every chart, assembled or written: a `markLine` merged over a bar
  // chart is as entitled to a base rate as a written option is.
  const datasets = datasetsFor(frames.length === 0 ? [] : frames);
  const canvas: Option = {
    backgroundColor: 'transparent',
    color: theme.series.map(toCssColour),
    textStyle: { color: text, fontFamily: typography.fontFamily, fontSize: theme.fontSize },
  };
  const base: Option = {
    ...canvas,
    animation: false,
    tooltip: { show: false },
    legend: legend
      ? { show: true, top: 0, textStyle: { color: text, fontSize: theme.fontSize } }
      : { show: false },
  };

  /**
   * A written option, with nothing of ours over the top of it.
   *
   * Only what the canvas needs to look like the canvas — the palette, the font, a
   * transparent background — and the reduced rows in a dataset it may use. No
   * axes, no grid, no series, no legend: those are the author's, and supplying
   * one of ours would be a setting they then have to find out about and undo.
   */
  if (isCustomChart(spec.type)) {
    const authored = parseChartExtra(spec.extra).option ?? {};
    // Shallow, unlike the escape hatch: what is underneath is not a chart being
    // adjusted, it is a handful of defaults being offered. A written `dataset`
    // replaces ours rather than merging row by row with it — declining an offer
    // should not leave half of it behind.
    return seamed(
      {
        ...canvas,
        // Every data set, by name: the reduction under `primary` and whatever
        // else the specification asked for. A written `dataset` replaces the lot
        // rather than merging with it — declining an offer should not leave half
        // of it behind.
        dataset: datasets,
        ...(resolveParams(authored, frames) as Option),
      },
      typography,
    );
  }

  const built: Option = isCartesianChart(spec.type)
    ? {
        ...base,
        grid: { left: 8, right: 12, top: legend ? 26 : 12, bottom: 6, containLabel: true },
        // Swapped, not re-implemented: bars along the side are the same series
        // measured against the same axes, with the axes the other way round.
        ...(spec.type === 'scatter'
          ? { xAxis: scatterAxis(theme, text), yAxis: valueAxis(spec, theme, text) }
          : spec.orientation === 'horizontal' && chartSupports(spec.type, 'orientation')
            ? { xAxis: valueAxis(spec, theme, text), yAxis: categoryAxis(data, theme, text) }
            : { xAxis: categoryAxis(data, theme, text), yAxis: valueAxis(spec, theme, text) }),
        series: seriesFor(spec, data, theme),
      }
    : {
        ...base,
        series: [
          {
            type: 'pie',
            radius: spec.hole === false ? ['0%', '68%'] : ['38%', '68%'],
            center: ['50%', legend ? '56%' : '50%'],
            label: {
              color: text,
              fontSize: theme.fontSize,
              ...(spec.showValues === true ? { formatter: '{b}: {c}' } : {}),
            },
            labelLine: { lineStyle: { color: toCssColour(theme.axis) } },
            data: data.categories.map((name, index) => ({
              name,
              value: data.series[0]?.values[index] ?? 0,
            })),
          },
        ],
      };

  // The escape hatch last, so it wins. A failure to parse is the form's business
  // to report; here it simply means the chart draws as the controls asked.
  const extra = parseChartExtra(spec.extra).option;
  // The data sets sit beside an assembled chart rather than in it: every series
  // it builds carries its own values, so nothing here reads them — but the escape
  // hatch may, and a `$param` in it resolves the same way it does in a written
  // option.
  const offered: Option = datasets.length === 0 ? built : { ...built, dataset: datasets };
  return seamed(
    extra === undefined ? offered : (mergeOption(offered, resolveParams(extra, frames)) as Option),
    typography,
  );
};
