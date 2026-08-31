import { describe, expect, it } from 'vitest';
import type { ChartSpec } from '@panorama/core';
import type { ChartFrame, ChartTypography } from '@panorama/chart';
import { DEFAULT_CHART_THEME, reductionFrame } from '@panorama/chart';
import { EChartsSurface } from '@panorama/chart-echarts';

/**
 * The claims `docs/AGENT-SKILL-CHARTS.md` makes, checked against the seam.
 *
 * That page tells agents which ECharts options come out drawn, which come out
 * inert, and which are silently dropped — and every one of those is a fact about
 * this integration rather than about the library, so none of them is in the
 * library's own documentation and none would survive a version bump on its own.
 * A page that told an agent a named colour works would cost a round trip every
 * time, and the round trip would end in a chart that laid out perfectly and drew
 * nothing, which is the hardest failure here to read.
 *
 * So the page is a document with a test under it. What is asserted is the
 * *behaviour the page describes*, not the mechanism producing it: if ECharts
 * starts drawing dashed lines through a display list, this fails and the
 * paragraph about dashed lines should go.
 */

const typography: ChartTypography = {
  measureText: (text, fontSize, bold) => text.length * fontSize * (bold ? 0.62 : 0.56),
  fontFamily: 'sans-serif',
};

const frame = (
  name: string,
  dimensions: readonly string[],
  rows: readonly unknown[][],
): ChartFrame => ({ name, dimensions, rows }) as unknown as ChartFrame;

const primary = frame(
  'primary',
  ['CAT', 'VAL'],
  [
    ['Sweden', 652352],
    ['France', 401200],
    ['Denmark', 98000],
  ],
);

const NOTHING = { categories: [], values: [], series: [], rows: 0, basis: 'exact' } as never;

interface Laid {
  readonly polygons: number;
  readonly labels: readonly string[];
  readonly marks: number;
  readonly pickable: boolean;
}

/** Lays a written option out and reports what came of it. */
const draw = (
  extra: unknown,
  frames: readonly ChartFrame[] = [primary],
  size: { width: number; height: number } = { width: 460, height: 300 },
): Laid => {
  const spec: ChartSpec = {
    type: 'custom',
    category: 'CAT',
    values: ['VAL'],
    aggregate: 'sum',
    extra: JSON.stringify(extra),
  };
  return lay(spec, frames, NOTHING, size);
};

const lay = (
  spec: ChartSpec,
  frames: readonly ChartFrame[],
  data: unknown,
  size: { width: number; height: number },
): Laid => {
  const surface = new EChartsSurface();
  try {
    surface.update({
      spec,
      data: data as never,
      frames,
      width: size.width,
      height: size.height,
      theme: DEFAULT_CHART_THEME,
      typography,
    });
    const list = surface.draw();
    const resolution = surface.resolution();
    return {
      polygons: list.polygons.length,
      labels: list.texts.map((run) => run.text),
      marks: resolution.series.reduce((total, series) => total + series.marks, 0),
      pickable: resolution.pickable,
    };
  } finally {
    surface.dispose();
  }
};

const cartesian = { xAxis: { type: 'category' }, yAxis: { type: 'value' } };
const bar = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  ...cartesian,
  series: [{ type: 'bar', datasetId: 'primary', encode: { x: 'CAT', y: 'VAL' }, ...over }],
});

describe('the colours that reach the canvas', () => {
  /**
   * The one that costs a round trip if it is not written down: the chart lays
   * out, the axes are right, the labels are right, and the bars are simply not
   * there. Nothing about the option is wrong in ECharts' terms.
   */
  it('drops a mark whose colour is a name or an hsl(), and keeps hex and rgba', () => {
    expect(draw(bar({ itemStyle: { color: 'red' } })).marks).toBe(0);
    expect(draw(bar({ itemStyle: { color: 'hsl(0,100%,50%)' } })).marks).toBe(0);
    expect(draw(bar({ itemStyle: { color: '#cc0000' } })).marks).toBe(3);
    expect(draw(bar({ itemStyle: { color: 'rgba(204,0,0,0.5)' } })).marks).toBe(3);
  });

  it('flattens a gradient to its first stop rather than dropping it', () => {
    const gradient = {
      type: 'linear',
      x: 0,
      y: 0,
      x2: 0,
      y2: 1,
      colorStops: [
        { offset: 0, color: '#cc0000' },
        { offset: 1, color: '#0000cc' },
      ],
    };
    expect(draw(bar({ itemStyle: { color: gradient } })).marks).toBe(3);
  });
});

describe('the labels that reach the canvas', () => {
  /**
   * A rotated glyph run cannot be placed truthfully by a renderer that draws
   * every label upright, so it is left out rather than drawn in the wrong place.
   * Which is right, and invisible: the chart is complete apart from the axis
   * nobody can read.
   */
  it('draws no category label at all once the axis rotates them', () => {
    expect(draw(bar()).labels).toContain('Sweden');
    const rotated = draw({
      ...bar(),
      xAxis: { type: 'category', axisLabel: { rotate: 45 } },
    });
    expect(rotated.labels).not.toContain('Sweden');
    // The rest of the picture is untouched, which is what makes it hard to spot.
    expect(rotated.marks).toBe(3);
  });

  it('truncates to a width, which is the answer that keeps them', () => {
    const long = frame(
      'l',
      ['CAT', 'VAL'],
      [
        ['A very long category name indeed', 5],
        ['Another extremely long one here', 8],
      ],
    );
    const truncated = draw(
      {
        xAxis: { type: 'category', axisLabel: { width: 60, overflow: 'truncate' } },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', datasetId: 'l', encode: { x: 'CAT', y: 'VAL' } }],
      },
      [primary, long],
    );
    expect(truncated.labels.some((label) => label.includes('...'))).toBe(true);
  });
});

describe('what draws and what is inert', () => {
  it('draws and can be pointed at, for every series the page lists as such', () => {
    const drawable: readonly (readonly [string, unknown])[] = [
      ['bar', bar()],
      ['line', { ...cartesian, series: [{ type: 'line', datasetId: 'primary' }] }],
      ['scatter', { ...cartesian, series: [{ type: 'scatter', datasetId: 'primary' }] }],
      ['pictorialBar', { ...cartesian, series: [{ type: 'pictorialBar', datasetId: 'primary' }] }],
      [
        'pie',
        {
          series: [
            { type: 'pie', datasetId: 'primary', encode: { itemName: 'CAT', value: 'VAL' } },
          ],
        },
      ],
      [
        'funnel',
        {
          series: [
            { type: 'funnel', datasetId: 'primary', encode: { itemName: 'CAT', value: 'VAL' } },
          ],
        },
      ],
      ['gauge', { series: [{ type: 'gauge', data: [{ value: 42 }] }] }],
      [
        'treemap',
        {
          series: [
            {
              type: 'treemap',
              data: [{ name: 'a', value: 5, children: [{ name: 'b', value: 3 }] }],
            },
          ],
        },
      ],
      [
        'sunburst',
        {
          series: [
            {
              type: 'sunburst',
              data: [{ name: 'a', value: 5, children: [{ name: 'b', value: 3 }] }],
            },
          ],
        },
      ],
      [
        'sankey',
        {
          series: [
            {
              type: 'sankey',
              data: [{ name: 'a' }, { name: 'b' }],
              links: [{ source: 'a', target: 'b', value: 4 }],
            },
          ],
        },
      ],
      [
        'graph',
        {
          series: [
            {
              type: 'graph',
              layout: 'force',
              data: [
                { name: 'a', value: 1 },
                { name: 'b', value: 2 },
              ],
              links: [{ source: 'a', target: 'b' }],
            },
          ],
        },
      ],
      ['tree', { series: [{ type: 'tree', data: [{ name: 'r', children: [{ name: 'a' }] }] }] }],
      [
        'radar',
        {
          radar: {
            indicator: [
              { name: 'a', max: 10 },
              { name: 'b', max: 10 },
              { name: 'c', max: 10 },
            ],
          },
          series: [{ type: 'radar', data: [{ value: [3, 5, 8], name: 'x' }] }],
        },
      ],
      [
        'boxplot',
        {
          xAxis: { type: 'category', data: ['a', 'b'] },
          yAxis: { type: 'value' },
          series: [
            {
              type: 'boxplot',
              data: [
                [1, 2, 3, 4, 5],
                [2, 3, 4, 5, 6],
              ],
            },
          ],
        },
      ],
      [
        'candlestick',
        {
          xAxis: { type: 'category', data: ['a', 'b'] },
          yAxis: { type: 'value' },
          series: [
            {
              type: 'candlestick',
              data: [
                [20, 30, 15, 35],
                [30, 25, 22, 38],
              ],
            },
          ],
        },
      ],
      [
        'heatmap',
        {
          xAxis: { type: 'category' },
          yAxis: { type: 'category' },
          visualMap: { min: 0, max: 10, inRange: { color: ['#eeeeee', '#cc0000'] } },
          series: [
            {
              type: 'heatmap',
              data: [
                [0, 0, 3],
                [1, 0, 7],
                [0, 1, 9],
              ],
            },
          ],
        },
      ],
      [
        'polar bar',
        {
          polar: {},
          angleAxis: { type: 'category', data: ['a', 'b', 'c'] },
          radiusAxis: {},
          series: [{ type: 'bar', coordinateSystem: 'polar', data: [3, 5, 8] }],
        },
      ],
    ];
    for (const [name, option] of drawable) {
      const laid = draw(option);
      expect(laid.marks, `${name} drew no marks`).toBeGreaterThan(0);
      expect(laid.pickable, `${name} cannot be pointed at`).toBe(true);
    }
  });

  /**
   * A calendar's cells are drawn by the calendar component and carry no row
   * anywhere in the display list. Correct, and inert — the one picture here that
   * nothing about the option can make pickable.
   */
  it('draws a calendar heatmap that nothing can be pointed at', () => {
    const laid = draw(
      {
        calendar: { range: '2024-01' },
        visualMap: { min: 0, max: 10, dimension: 'V', inRange: { color: ['#eeeeee', '#cc0000'] } },
        series: [
          {
            type: 'heatmap',
            coordinateSystem: 'calendar',
            datasetId: 'c',
            encode: { x: 'D', value: 'V' },
          },
        ],
      },
      [
        primary,
        frame(
          'c',
          ['D', 'V'],
          [
            ['2024-01-05', 3],
            ['2024-01-06', 9],
          ],
        ),
      ],
    );
    expect(laid.polygons).toBeGreaterThan(0);
    expect(laid.pickable).toBe(false);
  });

  it('refuses a heatmap with no visualMap outright, rather than drawing nothing', () => {
    // A different failure from an unresolved channel, and the page says so: this
    // one never produces geometry at all, so `drawn` stays null.
    expect(() =>
      draw({ ...cartesian, series: [{ type: 'heatmap', datasetId: 'primary' }] }),
    ).toThrow(/visualMap/u);
  });

  it('has no reach at all for a series that needs a function', () => {
    // `renderItem` is a function and an option is JSON. There is no writing this
    // one, which is worth saying once rather than being discovered.
    expect(() =>
      draw({ ...cartesian, series: [{ type: 'custom', datasetId: 'primary' }] }),
    ).toThrow(/render is required/u);
  });
});

describe('the settings that are quietly dropped', () => {
  it('draws nothing for a raster, and draws a path', () => {
    const plain = draw(bar()).polygons;
    expect(
      draw({ ...bar(), graphic: [{ type: 'image', style: { image: 'data:,', width: 9 } }] })
        .polygons,
    ).toBe(plain);
    expect(
      draw({
        ...bar(),
        graphic: [
          {
            type: 'rect',
            left: 4,
            top: 4,
            shape: { width: 20, height: 8 },
            style: { fill: '#cc0000' },
          },
        ],
      }).polygons,
    ).toBeGreaterThan(plain);
    expect(draw(bar({ type: 'scatter', symbol: 'image://x.png' })).marks).toBe(0);
    expect(draw(bar({ type: 'scatter', symbol: 'path://M0,0L10,0L5,10Z' })).marks).toBe(3);
  });

  it('draws a dashed line as a solid one', () => {
    const line = { ...cartesian, series: [{ type: 'line', datasetId: 'primary' }] };
    const solid = draw(line).polygons;
    const dashed = draw({
      ...cartesian,
      series: [{ type: 'line', datasetId: 'primary', lineStyle: { type: 'dashed' } }],
    }).polygons;
    // Same geometry: the dash is applied when painting, and nothing here paints.
    expect(dashed).toBe(solid);
  });

  it('leaves a line unpickable once its symbols are off, and large off entirely', () => {
    expect(draw({ ...cartesian, series: [{ type: 'line', datasetId: 'primary' }] }).marks).toBe(3);
    expect(
      draw({ ...cartesian, series: [{ type: 'line', datasetId: 'primary', symbol: 'none' }] })
        .marks,
    ).toBe(0);
    // `large` is an optimisation for a canvas painter this is not: it costs the
    // marks and buys nothing.
    expect(draw(bar({ type: 'scatter', large: true, largeThreshold: 1 })).marks).toBe(0);
  });
});

describe('the data sets an option can reach', () => {
  /**
   * The custom path is a shallow merge, so a written `dataset` replaces
   * Panorama's — which makes `fromDatasetId: "primary"` a reference to nothing,
   * and the layout says so by failing rather than by drawing an empty chart.
   */
  it('loses Panorama data sets to a written dataset, and gets them back with $rows', () => {
    const transform = {
      type: 'sort',
      config: { dimension: 'VAL', order: 'desc' },
    };
    expect(() =>
      draw({
        ...cartesian,
        dataset: [{ id: 'top', fromDatasetId: 'primary', transform }],
        series: [{ type: 'bar', datasetId: 'top', encode: { x: 'CAT', y: 'VAL' } }],
      }),
    ).toThrow();

    const rescued = draw({
      ...cartesian,
      dataset: [
        { id: 'src', source: { $rows: 'primary' } },
        { id: 'top', fromDatasetId: 'src', transform },
      ],
      series: [{ type: 'bar', datasetId: 'top', encode: { x: 'CAT', y: 'VAL' } }],
    });
    expect(rescued.marks).toBe(3);
    expect(rescued.labels).toContain('Sweden');
  });

  /**
   * The assembled path merges lists element by element, which is the whole of
   * why "an ordinary chart with one thing added" is one short option rather than
   * a rewritten one.
   */
  it('adds a data set and a series to an assembled chart without losing the built ones', () => {
    const data = {
      categories: ['Sweden', 'France', 'Denmark'],
      values: ['Sweden', 'France', 'Denmark'],
      series: [{ name: 'VAL', values: [652352, 401200, 98000] }],
      rows: 3,
      basis: 'exact',
    };
    const spec: ChartSpec = {
      type: 'bar',
      category: 'CAT',
      values: ['VAL'],
      aggregate: 'sum',
      extra: JSON.stringify({
        dataset: [
          {},
          {
            id: 'top',
            fromDatasetId: 'primary',
            transform: { type: 'sort', config: { dimension: 'VAL', order: 'desc' } },
          },
        ],
        series: [{}, { type: 'line', datasetId: 'top', encode: { x: 'CAT', y: 'VAL' } }],
      }),
    };
    const laid = lay(spec, [reductionFrame(spec, data as never)], data, {
      width: 460,
      height: 300,
    });
    // Both series drew: the bar the controls built, and the line the option added
    // over a data set derived from the one they were built from.
    expect(laid.marks).toBe(6);
  });
});

describe('the scale the page quotes', () => {
  /**
   * Not a benchmark — a ceiling. The page says the limit is the layout rather
   * than the database, and that 20,000 unreduced rows is usable; what would make
   * that untrue is the walk becoming superlinear, which this would catch.
   */
  it('lays out and walks twenty thousand points', () => {
    const points = frame(
      'p',
      ['X', 'Y'],
      Array.from({ length: 20_000 }, (_, index) => [index % 500, (index * 37) % 991]),
    );
    const laid = draw(
      {
        xAxis: { type: 'value' },
        yAxis: { type: 'value' },
        series: [{ type: 'scatter', datasetId: 'p', encode: { x: 'X', y: 'Y' }, symbolSize: 4 }],
      },
      [primary, points],
    );
    expect(laid.marks).toBe(20_000);
  });
});
