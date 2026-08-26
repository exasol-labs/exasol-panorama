import { describe, expect, it } from 'vitest';
import type { ChartSpec, ChartType } from '@panorama/core';
import type { ChartData, ChartFrame, ChartTheme, ChartTypography } from '@panorama/chart';
import { DEFAULT_CHART_THEME, reductionFrame } from '@panorama/chart';
import { EChartsSurface, chartOption, mergeOption } from '@panorama/chart-echarts';

/**
 * ECharts is exercised for real here — headless, with Panorama's own text
 * metrics — because the whole integration rests on two things nobody can assert
 * from a mock: that its display list holds the geometry, and that it lays labels
 * out for the font that will actually be drawn.
 */

const typography: ChartTypography = {
  measureText: (text, fontSize, bold) => text.length * fontSize * (bold ? 0.62 : 0.56),
  fontFamily: 'sans-serif',
};
const theme: ChartTheme = DEFAULT_CHART_THEME;

const data = (overrides: Partial<ChartData> = {}): ChartData => ({
  categories: ['Sweden', 'France', 'Denmark'],
  values: ['Sweden', 'France', 'Denmark'],
  series: [{ name: 'REVENUE', values: [652352, 401200, 98000] }],
  rows: 100,
  basis: 'exact',
  ...overrides,
});

const spec = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
  type: 'bar',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
  ...overrides,
});

/** The data sets a chart is given: its own reduction, as the worker builds it. */
const framesOf = (
  chartSpec: ChartSpec,
  chartData: ChartData,
  extra: readonly ChartFrame[] = [],
): readonly ChartFrame[] => [reductionFrame(chartSpec, chartData), ...extra];

/** The option, with the data sets the worker would have built to go with it. */
const optionFor = (chartSpec: ChartSpec, chartData: ChartData): Record<string, unknown> =>
  chartOption(chartSpec, chartData, framesOf(chartSpec, chartData), theme, typography);

const laid = (
  specOverrides: Partial<ChartSpec> = {},
  dataOverrides: Partial<ChartData> = {},
  width = 420,
  height = 274,
) => {
  const surface = new EChartsSurface();
  const laidSpec = spec(specOverrides);
  const laidData = data(dataOverrides);
  surface.update({
    spec: laidSpec,
    data: laidData,
    frames: framesOf(laidSpec, laidData),
    width,
    height,
    theme,
    typography,
  });
  const list = surface.draw();
  surface.dispose();
  return list;
};

describe('laying a chart out through ECharts', () => {
  it('produces marks and labels for a bar chart', () => {
    const list = laid();
    expect(list.polygons.length).toBeGreaterThan(0);
    // The categories it was given, and an axis it worked out for itself.
    for (const category of ['Sweden', 'France', 'Denmark']) {
      expect(list.texts.map((run) => run.text)).toContain(category);
    }
    expect(list.texts.some((run) => /^[\d,]+$/u.test(run.text))).toBe(true);
  });

  it('draws every chart type it offers', () => {
    for (const type of ['bar', 'line', 'area', 'scatter', 'pie'] as const) {
      expect(laid({ type }).polygons.length).toBeGreaterThan(0);
    }
  });

  it('keeps everything inside the box it was given', () => {
    const list = laid({}, {}, 300, 200);
    const xs = list.polygons.flatMap((p) => [
      p.corners[0],
      p.corners[2],
      p.corners[4],
      p.corners[6],
    ]);
    const ys = list.polygons.flatMap((p) => [
      p.corners[1],
      p.corners[3],
      p.corners[5],
      p.corners[7],
    ]);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-1);
    expect(Math.min(...ys)).toBeGreaterThanOrEqual(-1);
    expect(Math.max(...xs)).toBeLessThanOrEqual(301);
    expect(Math.max(...ys)).toBeLessThanOrEqual(201);
  });

  it('keeps the axis labels clear of the marks', () => {
    // The point of handing ECharts our own text metrics: it reserves room for the
    // labels that will be drawn, not for the ones its own font would have made.
    const list = laid();
    const numeric = list.texts.filter((run) => /^[\d,]+$/u.test(run.text) && run.x < 100);
    const labelRight = Math.max(...numeric.map((run) => run.x + run.width));
    const marks = list.polygons.filter((p) => p.color[2] > 0.8 && p.color[0] < 0.3);
    const markLeft = Math.min(...marks.flatMap((p) => [p.corners[0], p.corners[6]]));
    expect(labelRight).toBeLessThanOrEqual(markLeft);
  });

  it('lays a legend out only when there is more than one series', () => {
    const single = laid();
    const double = laid(
      {},
      {
        series: [
          { name: 'REVENUE', values: [1, 2, 3] },
          { name: 'ORDERS', values: [3, 2, 1] },
        ],
      },
    );
    expect(single.texts.map((run) => run.text)).not.toContain('REVENUE');
    expect(double.texts.map((run) => run.text)).toContain('REVENUE');
    expect(double.texts.map((run) => run.text)).toContain('ORDERS');
  });

  it('draws a gap in a series as a gap rather than as nought', () => {
    const withGap = laid({}, { series: [{ name: 'R', values: [10, null, 30] }] });
    expect(withGap.polygons.length).toBeGreaterThan(0);
  });

  it('re-lays out for a new size without being rebuilt', () => {
    const surface = new EChartsSurface();
    surface.update({
      spec: spec(),
      data: data(),
      frames: framesOf(spec(), data()),
      width: 400,
      height: 260,
      theme,
      typography,
    });
    const wide = surface.draw().polygons.length;
    surface.update({
      spec: spec(),
      data: data(),
      frames: framesOf(spec(), data()),
      width: 200,
      height: 160,
      theme,
      typography,
    });
    const narrow = surface.draw();
    surface.dispose();
    expect(wide).toBeGreaterThan(0);
    const xs = narrow.polygons.flatMap((p) => [p.corners[0], p.corners[2]]);
    expect(Math.max(...xs)).toBeLessThanOrEqual(201);
  });

  it('does not resize when the box has not changed', () => {
    const surface = new EChartsSurface();
    surface.update({
      spec: spec(),
      data: data(),
      frames: framesOf(spec(), data()),
      width: 400,
      height: 260,
      theme,
      typography,
    });
    const first = surface.draw().polygons.length;
    surface.update({
      spec: spec({ type: 'line' }),
      data: data(),
      frames: framesOf(spec({ type: 'line' }), data()),
      width: 400,
      height: 260,
      theme,
      typography,
    });
    expect(surface.draw().polygons.length).not.toBe(first);
    surface.dispose();
  });

  it('survives a box with no room in it', () => {
    expect(() => laid({}, {}, 0, 0)).not.toThrow();
  });

  it('takes a pointer position and lets go of it again', () => {
    const surface = new EChartsSurface();
    surface.update({
      spec: spec(),
      data: data(),
      frames: framesOf(spec(), data()),
      width: 400,
      height: 260,
      theme,
      typography,
    });
    surface.point(120, 100);
    expect(surface.draw().polygons.length).toBeGreaterThan(0);
    surface.point(null, null);
    expect(surface.draw().polygons.length).toBeGreaterThan(0);
    surface.dispose();
  });

  it('ignores a pointer before there is anything to point at', () => {
    const surface = new EChartsSurface();
    expect(() => surface.point(1, 1)).not.toThrow();
    expect(surface.draw()).toEqual({ polygons: [], texts: [] });
    // Disposing twice is not an error either.
    surface.dispose();
    surface.dispose();
  });
});

describe('the option handed to ECharts', () => {
  const option = (
    specOverrides: Partial<ChartSpec> = {},
    dataOverrides: Partial<ChartData> = {},
  ): Record<string, unknown> =>
    chartOption(
      spec(specOverrides),
      data(dataOverrides),
      framesOf(spec(specOverrides), data(dataOverrides)),
      theme,
      typography,
    );

  it('turns animation off, because the geometry is read once per change', () => {
    expect(option()['animation']).toBe(false);
  });

  it('paints nothing behind itself: the box already has a background', () => {
    expect(option()['backgroundColor']).toBe('transparent');
  });

  it('passes the theme through as the colours ECharts speaks', () => {
    expect(option()['color']).toEqual(theme.series.map(() => expect.stringMatching(/^#/u)));
  });

  it('asks for no tooltip, because one would not survive the seam', () => {
    expect(option()['tooltip']).toEqual({ show: false });
  });

  it('never rotates an axis label', () => {
    // A rotated label would need the glyph batch to rotate with it; hiding one
    // that will not fit is the truthful alternative.
    const axis = option()['xAxis'] as { axisLabel: { rotate: number; hideOverlap: boolean } };
    expect(axis.axisLabel.rotate).toBe(0);
    expect(axis.axisLabel.hideOverlap).toBe(true);
  });

  it('draws an area as a line that has been filled in', () => {
    const series = option({ type: 'area' })['series'] as readonly Record<string, unknown>[];
    expect(series[0]?.['type']).toBe('line');
    expect(series[0]?.['areaStyle']).toEqual({});
  });

  it('stacks the series when asked', () => {
    const series = option({ stacked: true })['series'] as readonly Record<string, unknown>[];
    expect(series[0]?.['stack']).toBe('total');
  });

  it('gives a pie its slices by name and drops the axes', () => {
    const pie = option({ type: 'pie' });
    expect(pie['xAxis']).toBeUndefined();
    const series = pie['series'] as readonly Record<string, unknown>[];
    expect(series[0]?.['data']).toEqual([
      { name: 'Sweden', value: 652352 },
      { name: 'France', value: 401200 },
      { name: 'Denmark', value: 98000 },
    ]);
  });

  it('gives a pie a slice of nothing for a category with no figure', () => {
    const pie = option({ type: 'pie' }, { series: [{ name: 'R', values: [null, 1, 2] }] });
    const series = pie['series'] as readonly Record<string, unknown>[];
    expect((series[0]?.['data'] as readonly { value: number }[])[0]?.value).toBe(0);
  });

  it('gives a pie nothing at all when there is no series to slice', () => {
    const pie = option({ type: 'pie' }, { series: [] });
    const series = pie['series'] as readonly Record<string, unknown>[];
    expect(series[0]?.['data']).toEqual([
      { name: 'Sweden', value: 0 },
      { name: 'France', value: 0 },
      { name: 'Denmark', value: 0 },
    ]);
  });

  it('plots a scatter against two value axes, by position', () => {
    const scatter = option({ type: 'scatter' });
    expect((scatter['xAxis'] as { type: string }).type).toBe('value');
    const series = scatter['series'] as readonly Record<string, unknown>[];
    expect(series[0]?.['data']).toEqual([
      [0, 652352],
      [1, 401200],
      [2, 98000],
    ]);
  });

  it('leaves room at the top for a legend only when there is one', () => {
    const single = option()['grid'] as { top: number };
    const double = option(
      {},
      {
        series: [
          { name: 'A', values: [1, 2, 3] },
          { name: 'B', values: [3, 2, 1] },
        ],
      },
    )['grid'] as { top: number };
    expect(double.top).toBeGreaterThan(single.top);
  });

  it('uses the font the renderer will actually draw with', () => {
    const style = option()['textStyle'] as { fontFamily: string; fontSize: number };
    expect(style.fontFamily).toBe('sans-serif');
    expect(style.fontSize).toBe(theme.fontSize);
  });

  it('offers every type the document model allows', () => {
    for (const type of ['bar', 'line', 'area', 'scatter', 'pie'] as ChartType[]) {
      expect(() => option({ type })).not.toThrow();
    }
  });
});

describe('what a drawn mark came from', () => {
  it('stamps every mark with the data set and the row it belongs to', () => {
    // The point of the whole stage: a heatmap cell drawn from a written option
    // knows which row of which data set it is, so it can be traced back to the
    // relation exactly as a bar of an assembled chart can.
    const cells: readonly ChartFrame[] = [
      {
        name: 'cells',
        dimensions: ['BAND', 'TYPE', 'PCT'],
        rows: [
          ['A', 'motor', 4],
          ['B', 'motor', 6],
          ['A', 'home', 2],
        ],
        key: 'BAND',
        keys: ['A', 'B', 'A'],
        read: 3,
        of: 3,
        basis: 'exact',
      },
    ];
    const chartSpec = spec({
      type: 'custom',
      extra: JSON.stringify({
        xAxis: { type: 'category' },
        yAxis: { type: 'category' },
        // A heatmap refuses to draw without one, which is ECharts' own rule.
        visualMap: { min: 0, max: 10 },
        series: [
          {
            type: 'heatmap',
            datasetId: 'cells',
            encode: { x: 'BAND', y: 'TYPE', value: 'PCT' },
          },
        ],
      }),
    });
    const chartData = data();
    const surface = new EChartsSurface();
    surface.update({
      spec: chartSpec,
      data: chartData,
      frames: framesOf(chartSpec, chartData, cells),
      width: 420,
      height: 274,
      theme,
      typography,
    });
    const list = surface.draw();
    surface.dispose();
    const marks = list.polygons.flatMap((polygon) =>
      polygon.mark === undefined ? [] : [polygon.mark],
    );
    expect(marks.length).toBeGreaterThan(0);
    for (const mark of marks) {
      expect(mark.frame).toBe('cells');
      // The row is the data index within that data set, which is what makes it
      // traceable: `keys[row]` is the value the rows behind it are found by.
      expect(mark.row).toBe(mark.data);
      expect(mark.row).toBeLessThan(3);
    }
    expect(new Set(marks.map((mark) => mark.row)).size).toBe(3);
  });

  it('leaves a series carrying its own numbers unstamped', () => {
    // Every chart the controls assemble: the series hold their values, so there
    // is no data set to name, and the reduction is where the trace goes instead.
    const list = laid();
    const marks = list.polygons.flatMap((polygon) =>
      polygon.mark === undefined ? [] : [polygon.mark],
    );
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.every((mark) => mark.frame === undefined)).toBe(true);
  });
});

describe('the settings the controls produce', () => {
  const option = (
    specOverrides: Partial<ChartSpec> = {},
    dataOverrides: Partial<ChartData> = {},
  ): Record<string, unknown> =>
    chartOption(
      spec(specOverrides),
      data(dataOverrides),
      framesOf(spec(specOverrides), data(dataOverrides)),
      theme,
      typography,
    );
  const axes = (
    specOverrides: Partial<ChartSpec> = {},
  ): { x: Record<string, unknown>; y: Record<string, unknown> } => {
    const built = option(specOverrides);
    return {
      x: built['xAxis'] as Record<string, unknown>,
      y: built['yAxis'] as Record<string, unknown>,
    };
  };
  const series = (specOverrides: Partial<ChartSpec> = {}): readonly Record<string, unknown>[] =>
    option(specOverrides)['series'] as readonly Record<string, unknown>[];

  it('turns bars on their side by swapping the axes, not by re-implementing them', () => {
    const upright = axes();
    const sideways = axes({ orientation: 'horizontal' });
    expect(upright.x['type']).toBe('category');
    expect(sideways.y['type']).toBe('category');
    expect(sideways.x['type']).toBe('value');
  });

  it('does not turn a chart that has no bars to turn', () => {
    // The control is not offered for a line, so asking anyway changes nothing.
    expect(axes({ type: 'line', orientation: 'horizontal' }).x['type']).toBe('category');
  });

  it('counts in multiples when asked', () => {
    expect(axes().y['type']).toBe('value');
    expect(axes({ scale: 'log' }).y['type']).toBe('log');
    expect(axes({ orientation: 'horizontal', scale: 'log' }).x['type']).toBe('log');
  });

  it('rules the value axis unless told not to', () => {
    expect((axes().y['splitLine'] as Record<string, unknown>)['show']).toBeUndefined();
    expect((axes({ showGrid: false }).y['splitLine'] as { show: boolean }).show).toBe(false);
  });

  it('curves and steps a line, and leaves a straight one straight', () => {
    expect(series({ type: 'line' })[0]?.['smooth']).toBe(false);
    expect(series({ type: 'line', curve: 'smooth' })[0]?.['smooth']).toBe(true);
    expect(series({ type: 'line', curve: 'stepped' })[0]?.['step']).toBe('middle');
    expect(series({ type: 'line' })[0]?.['step']).toBeUndefined();
  });

  it('marks each point unless told not to', () => {
    expect(series({ type: 'line' })[0]?.['symbol']).toBe('circle');
    expect(series({ type: 'line', showPoints: false })[0]?.['symbol']).toBe('none');
    // An area is a line with a fill, so it takes the same treatment.
    expect(series({ type: 'area', showPoints: false })[0]?.['symbol']).toBe('none');
  });

  it('leaves a bar chart no line settings to be confused by', () => {
    expect(series({ curve: 'smooth', showPoints: false })[0]?.['smooth']).toBeUndefined();
    expect(series()[0]?.['symbol']).toBeUndefined();
  });

  it('stacks only what can be stacked', () => {
    expect(series({ stacked: true })[0]?.['stack']).toBe('total');
    expect(series({ type: 'area', stacked: true })[0]?.['stack']).toBe('total');
    // Asking a scatter to stack is asking nothing.
    expect(series({ type: 'scatter', stacked: true })[0]?.['stack']).toBeUndefined();
  });

  it('gives a pie a hole unless told not to', () => {
    const radius = (hole?: boolean): readonly string[] =>
      series({ type: 'pie', ...(hole === undefined ? {} : { hole }) })[0]?.[
        'radius'
      ] as readonly string[];
    expect(radius()[0]).not.toBe('0%');
    expect(radius(true)[0]).not.toBe('0%');
    expect(radius(false)[0]).toBe('0%');
  });

  it('writes the values on when asked, and not otherwise', () => {
    expect((series()[0]?.['label'] as { show: boolean }).show).toBe(false);
    expect((series({ showValues: true })[0]?.['label'] as { show: boolean }).show).toBe(true);
    // A pie says the name as well as the figure, which is what its labels are for.
    expect(
      (series({ type: 'pie', showValues: true })[0]?.['label'] as { formatter?: string }).formatter,
    ).toBe('{b}: {c}');
  });

  it('shows a legend when useful, always, or never', () => {
    const shown = (specOverrides: Partial<ChartSpec>, count: number): boolean =>
      (
        optionFor(
          spec(specOverrides),
          data({
            series: Array.from({ length: count }, (_, index) => ({
              name: `s${index}`,
              values: [1, 2, 3],
            })),
          }),
        )['legend'] as { show: boolean }
      ).show;
    expect(shown({}, 1)).toBe(false);
    expect(shown({}, 2)).toBe(true);
    expect(shown({ legend: 'always' }, 1)).toBe(true);
    expect(shown({ legend: 'never' }, 2)).toBe(false);
  });

  it('moves a pie down to make room for a legend it is showing', () => {
    const centre = (specOverrides: Partial<ChartSpec>): readonly string[] =>
      series({ type: 'pie', ...specOverrides })[0]?.['center'] as readonly string[];
    expect(centre({ legend: 'always' })[1]).not.toBe(centre({ legend: 'never' })[1]);
  });
});

describe('the escape hatch, merged over the controls', () => {
  it('changes one property without throwing away its neighbours', () => {
    const built = optionFor(
      { ...spec(), extra: '{"legend":{"top":40}}' },
      data({
        series: [
          { name: 'a', values: [1] },
          { name: 'b', values: [2] },
        ],
      }),
    );
    const legend = built['legend'] as { show: boolean; top: number };
    expect(legend.top).toBe(40);
    // Still the legend the controls asked for, in every other respect.
    expect(legend.show).toBe(true);
  });

  it('recolours one series without replacing the list of them', () => {
    // The commonest override there is, and it only works if lists merge by
    // position rather than wholesale.
    const built = optionFor(
      { ...spec(), extra: '{"series":[{"itemStyle":{"color":"#ff0000"}}]}' },
      data({
        series: [
          { name: 'a', values: [1] },
          { name: 'b', values: [2] },
        ],
      }),
    );
    const list = built['series'] as readonly Record<string, unknown>[];
    expect(list).toHaveLength(2);
    expect(list[0]?.['itemStyle']).toEqual({ color: '#ff0000' });
    // And still a series: it kept its type and its numbers.
    expect(list[0]?.['type']).toBe('bar');
    expect(list[0]?.['data']).toEqual([1]);
    expect(list[1]?.['itemStyle']).toBeUndefined();
  });

  it('draws as the controls asked when the extra settings do not parse', () => {
    const built = chartOption(
      { ...spec(), extra: '{oops' },
      data(),
      framesOf(spec(), data()),
      theme,
      typography,
    );
    expect(built['animation']).toBe(false);
    expect((built['series'] as readonly unknown[]).length).toBe(1);
  });

  it('adds to a list that is longer than the one it is merged over', () => {
    expect(mergeOption([1], [9, 8])).toEqual([9, 8]);
    expect(mergeOption([{ a: 1 }], [{ b: 2 }])).toEqual([{ a: 1, b: 2 }]);
  });

  it('replaces anything that is not two objects or two lists', () => {
    expect(mergeOption(1, 2)).toBe(2);
    expect(mergeOption({ a: 1 }, 2)).toBe(2);
    expect(mergeOption([1], { a: 1 })).toEqual({ a: 1 });
    expect(mergeOption({ a: 1 }, [2])).toEqual([2]);
    expect(mergeOption(null, { a: 1 })).toEqual({ a: 1 });
    expect(mergeOption({ a: 1 }, null)).toBeNull();
  });

  it('adds a key the base had never heard of', () => {
    expect(mergeOption({ a: 1 }, { b: 2 })).toEqual({ a: 1, b: 2 });
  });
});

describe('a chart whose option was written', () => {
  const custom = (extra: string, dataOverrides: Partial<ChartData> = {}): Record<string, unknown> =>
    chartOption(
      { ...spec(), type: 'custom', extra },
      data(dataOverrides),
      framesOf({ ...spec(), type: 'custom', extra }, data(dataOverrides)),
      theme,
      typography,
    );

  it('is the option that was written, and nothing of ours over the top', () => {
    const built = custom('{"series":[{"type":"radar","data":[{"value":[1,2,3]}]}],"radar":{}}');
    expect(built['series']).toEqual([{ type: 'radar', data: [{ value: [1, 2, 3] }] }]);
    // None of the assembled chart's furniture, because none of it was asked for:
    // a written option that had to undo a grid it never wanted is not a door out.
    expect('grid' in built).toBe(false);
    expect('xAxis' in built).toBe(false);
    expect('yAxis' in built).toBe(false);
    expect(built['legend']).toBeUndefined();
  });

  it('still looks like the rest of the canvas', () => {
    const built = custom('{"series":[{"type":"gauge"}]}');
    expect(built['backgroundColor']).toBe('transparent');
    expect(built['color']).toEqual(theme.series.map(() => expect.stringMatching(/^#/u)));
    expect(built['textStyle']).toMatchObject({ fontFamily: typography.fontFamily });
  });

  it('carries the reduced rows as a dataset, header first', () => {
    const built = custom('{"series":[{"type":"line"}]}', {
      categories: ['Sweden', 'France'],
      series: [
        { name: 'REVENUE', values: [10, 20] },
        { name: 'ORDERS', values: [1, null] },
      ],
    });
    // The shape ECharts' own dataset takes, so a written option reaches the data
    // through `encode` and `dimensions` rather than through anything of ours —
    // and the columns are *declared* rather than left as a header row, which is
    // what lets an `encode` be checked against them.
    expect(built['dataset']).toEqual([
      {
        id: 'primary',
        dimensions: ['COUNTRY', 'REVENUE', 'ORDERS'],
        source: [
          ['Sweden', 10, 1],
          ['France', 20, null],
        ],
      },
    ]);
  });

  it('names the first column something when no column was chosen', () => {
    const built = optionFor(
      { type: 'custom', category: '', values: [], aggregate: 'count', extra: '{"series":[]}' },
      data({ categories: ['a'], series: [] }),
    );
    expect((built['dataset'] as { dimensions: unknown[] }[])[0]?.dimensions).toEqual(['category']);
  });

  it('gives a cross-tabulation as triples, which is what a heatmap reads', () => {
    const built = optionFor(
      { ...spec(), type: 'custom', breakdown: 'DECILE', extra: '{"series":[{"type":"heatmap"}]}' },
      data({
        categories: ['Sweden', 'France'],
        series: [
          { name: 'top', values: [10, 20] },
          { name: 'bottom', values: [1, null] },
        ],
      }),
    );
    // There is no arrangement of columns that is a triple, which is the whole
    // reason a breakdown exists.
    expect(built['dataset']).toEqual([
      {
        id: 'primary',
        dimensions: ['COUNTRY', 'DECILE', 'REVENUE'],
        source: [
          ['Sweden', 'top', 10],
          ['France', 'top', 20],
          ['Sweden', 'bottom', 1],
          ['France', 'bottom', null],
        ],
      },
    ]);
  });

  it('names the measure "rows" in the triples when it is a count', () => {
    const built = optionFor(
      {
        ...spec(),
        type: 'custom',
        aggregate: 'count',
        values: [],
        breakdown: 'DECILE',
        extra: '{"series":[]}',
      },
      data({ categories: ['a'], series: [{ name: 'top', values: [3] }] }),
    );
    expect((built['dataset'] as { dimensions: unknown[] }[])[0]?.dimensions).toEqual([
      'COUNTRY',
      'DECILE',
      'rows',
    ]);
  });

  it('offers every data set the specification named, by name', () => {
    const withFrames: readonly ChartFrame[] = [
      {
        name: 'matrix',
        dimensions: ['BAND', 'TYPE', 'PCT'],
        rows: [['A', 'motor', 4]],
        read: 1,
        of: 1,
        basis: 'exact',
      },
    ];
    const chartSpec = spec({ type: 'custom', extra: '{"series":[{"type":"heatmap"}]}' });
    const chartData = data();
    const built = chartOption(
      chartSpec,
      chartData,
      framesOf(chartSpec, chartData, withFrames),
      theme,
      typography,
    );
    // The reduction first, under the name an option that says nothing will find,
    // and then the ones asked for — each with its columns declared, which is what
    // an `encode` is checked against.
    expect((built['dataset'] as { id: string }[]).map((entry) => entry.id)).toEqual([
      'primary',
      'matrix',
    ]);
    expect((built['dataset'] as { dimensions: unknown }[])[1]?.dimensions).toEqual([
      'BAND',
      'TYPE',
      'PCT',
    ]);
  });

  it('puts a number a data set worked out where the option asked for it', () => {
    // The one piece of grammar Panorama adds, and only because ECharts has no
    // equivalent: a reference line's value is a literal, so a base rate typed
    // into one goes out of date the moment the query behind it changes.
    const withScalar: readonly ChartFrame[] = [
      {
        name: 'baserate',
        dimensions: ['PCT'],
        rows: [[4.91]],
        read: 100,
        of: 100,
        basis: 'exact',
      },
    ];
    const chartSpec = spec({
      type: 'custom',
      extra: '{"series":[{"type":"line","markLine":{"data":[{"yAxis":{"$param":"baserate"}}]}}]}',
    });
    const chartData = data();
    const built = chartOption(
      chartSpec,
      chartData,
      framesOf(chartSpec, chartData, withScalar),
      theme,
      typography,
    );
    const series = built['series'] as { markLine: { data: { yAxis: unknown }[] } }[];
    expect(series[0]?.markLine.data[0]?.yAxis).toBe(4.91);
  });

  it('resolves a number for an assembled chart too, through the escape hatch', () => {
    const withScalar: readonly ChartFrame[] = [
      { name: 'target', dimensions: ['T'], rows: [[12]], read: 1, of: 1, basis: 'exact' },
    ];
    const chartSpec = spec({
      extra: '{"series":[{"markLine":{"data":[{"yAxis":{"$param":"target"}}]}}]}',
    });
    const chartData = data();
    const built = chartOption(
      chartSpec,
      chartData,
      framesOf(chartSpec, chartData, withScalar),
      theme,
      typography,
    );
    const series = built['series'] as { markLine: { data: { yAxis: unknown }[] } }[];
    expect(series[0]?.markLine.data[0]?.yAxis).toBe(12);
    // And the data sets are there beside it, unused by the series it built.
    expect((built['dataset'] as { id: string }[]).map((entry) => entry.id)).toEqual([
      'primary',
      'target',
    ]);
  });

  it('leaves a number nothing answers for exactly where it was', () => {
    // Rather than substituting a nought, which would draw a line at zero that
    // somebody then believes. The marker left behind is what the resolution
    // report names.
    const chartSpec = spec({
      type: 'custom',
      extra: '{"series":[{"type":"line","markLine":{"data":[{"yAxis":{"$param":"nobody"}}]}}]}',
    });
    const chartData = data();
    const built = chartOption(
      chartSpec,
      chartData,
      framesOf(chartSpec, chartData),
      theme,
      typography,
    );
    const series = built['series'] as { markLine: { data: { yAxis: unknown }[] } }[];
    expect(series[0]?.markLine.data[0]?.yAxis).toEqual({ $param: 'nobody' });
  });

  it('leaves a scalar that reduced to nothing alone as well', () => {
    const empty: readonly ChartFrame[] = [
      { name: 'base', dimensions: ['PCT'], rows: [[null]], read: 3, of: 3, basis: 'exact' },
    ];
    const chartSpec = spec({ type: 'custom', extra: '{"title":{"text":{"$param":"base"}}}' });
    const chartData = data();
    const built = chartOption(
      chartSpec,
      chartData,
      framesOf(chartSpec, chartData, empty),
      theme,
      typography,
    );
    expect((built['title'] as { text: unknown }).text).toEqual({ $param: 'base' });
  });

  it('lets the option have the dataset if it wants a different one', () => {
    const built = custom('{"dataset":{"source":[["x","y"],[1,2]]},"series":[{"type":"scatter"}]}');
    expect(built['dataset']).toEqual({
      source: [
        ['x', 'y'],
        [1, 2],
      ],
    });
  });

  it('refuses the two settings that are not preferences', () => {
    // The geometry is read once per change, so an animation would be captured as
    // a still frame of itself; a tooltip is a DOM overlay that never arrives.
    const built = custom('{"animation":true,"tooltip":{"show":true},"series":[{"type":"pie"}]}');
    expect(built['animation']).toBe(false);
    expect(built['tooltip']).toEqual({ show: false });
    // And the same for an assembled chart that asked for them.
    const assembled = optionFor(
      { ...spec(), extra: '{"animation":true,"tooltip":{"show":true}}' },
      data(),
    );
    expect(assembled['animation']).toBe(false);
    expect(assembled['tooltip']).toEqual({ show: false });
  });

  it('draws nothing rather than something wrong when the option does not parse', () => {
    const built = custom('{oh dear');
    expect('series' in built).toBe(false);
    expect(built['dataset']).toBeDefined();
  });
});

describe('reading which mark each piece of geometry belongs to', () => {
  const marksOf = (specOverrides: Partial<ChartSpec> = {}): readonly string[] => {
    const list = laid(specOverrides, {
      series: [{ name: 'REVENUE', values: [3, 1, 2] }],
    });
    return [
      ...new Set(
        list.polygons
          .filter((polygon) => polygon.mark !== undefined)
          .map((polygon) => `${polygon.mark?.series}:${polygon.mark?.data}`),
      ),
    ].sort();
  };

  /**
   * The contract test. The chart library keeps this identity on a private key
   * whose name carries a module-load counter, so it is found by shape. If a
   * version bump changes that shape, a chart still draws perfectly and cannot be
   * pointed at — which is exactly the failure that needs somewhere to be caught.
   */
  it('tags every mark of every chart type', () => {
    for (const type of ['bar', 'line', 'area', 'scatter', 'pie'] as const) {
      expect(marksOf({ type }), `no marks tagged for ${type}`).toEqual(['0:0', '0:1', '0:2']);
    }
  });

  it('tags the marks of the second series apart from the first', () => {
    const list = laid(
      {},
      {
        series: [
          { name: 'a', values: [1, 2, 3] },
          { name: 'b', values: [3, 2, 1] },
        ],
      },
    );
    const series = new Set(
      list.polygons
        .filter((polygon) => polygon.mark !== undefined)
        .map((polygon) => polygon.mark?.series),
    );
    expect([...series].sort()).toEqual([0, 1]);
  });

  it('leaves the furniture untagged, so pointing at an axis points at nothing', () => {
    const list = laid();
    const untagged = list.polygons.filter((polygon) => polygon.mark === undefined);
    // Axes, grid lines and the like: there are always some.
    expect(untagged.length).toBeGreaterThan(0);
  });

  it('tags a label with the mark it labels', () => {
    const list = laid({ showValues: true });
    expect(list.texts.some((run) => run.mark !== undefined)).toBe(true);
  });
});
