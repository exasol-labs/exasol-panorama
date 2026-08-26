import type { ChartLegend, ChartSpec } from '@panorama/core';
import {
  chartSupports,
  isBrokenDown,
  isCartesianChart,
  isCustomChart,
  parseChartExtra,
} from '@panorama/core';
import type { ChartData, ChartTheme, ChartTypography } from '@panorama/chart';
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

/**
 * The reduced rows, as an ECharts dataset.
 *
 * A header row and then a row per category, which is the shape ECharts' own
 * `dataset.source` takes — so a written option can reach the table's data
 * through `encode` and `dimensions` like any other ECharts chart, and needs no
 * Panorama-specific placeholder to do it. The reduction is the same one every
 * other chart type gets: a written option is still a picture of a few dozen
 * numbers rather than of a billion rows.
 */
export const datasetSource = (spec: ChartSpec, data: ChartData): readonly unknown[][] => {
  const category = spec.category === '' ? 'category' : spec.category;
  if (isBrokenDown(spec)) {
    // Long, because a cross-tabulation drawn as a matrix needs triples: a heatmap
    // reads `[x, y, value]` and there is no arrangement of columns that is one.
    const measure = spec.aggregate === 'count' ? 'rows' : (spec.values[0] ?? 'value');
    return [
      [category, spec.breakdown as string, measure],
      ...data.series.flatMap((series) =>
        data.categories.map((name, index) => [name, series.name, series.values[index] ?? null]),
      ),
    ];
  }
  return [
    [category, ...data.series.map((series) => series.name)],
    ...data.categories.map((name, index) => [
      name,
      ...data.series.map((series) => series.values[index] ?? null),
    ]),
  ];
};

export const chartOption = (
  spec: ChartSpec,
  data: ChartData,
  theme: ChartTheme,
  typography: ChartTypography,
): Option => {
  const text = toCssColour(theme.text);
  const legend = legendVisible(spec.legend, data.series.length);
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
      { ...canvas, dataset: { source: datasetSource(spec, data) }, ...authored },
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
  return seamed(extra === undefined ? built : (mergeOption(built, extra) as Option), typography);
};
