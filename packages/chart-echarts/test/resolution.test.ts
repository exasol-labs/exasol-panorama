import { describe, expect, it } from 'vitest';
import type { ChartDrawList } from '@panorama/chart';
import { EMPTY_CHART_DRAW_LIST } from '@panorama/chart';
import { resolveOption, seriesDatasets } from '@panorama/chart-echarts';

/**
 * What an option turned out to read.
 *
 * The one piece of chart feedback whose job is to be true when the picture is
 * wrong, so these are mostly tests about wrongness: a channel naming a column
 * that is not there, a series reading no data set at all, a header row that is
 * not a header. Every one of them draws a chart that looks plausible.
 */

const drawn = (marks: readonly (readonly [number, number])[]): ChartDrawList => ({
  polygons: marks.map(([series, data]) => ({
    corners: [0, 0, 1, 0, 1, 1, 0, 1] as const,
    color: [0, 0, 0, 1] as const,
    mark: { series, data },
  })),
  texts: [],
});

describe('reading a data set', () => {
  it('takes the names from a header row and does not count it as data', () => {
    const resolution = resolveOption(
      {
        dataset: {
          id: 'primary',
          source: [
            ['COUNTRY', 'REVENUE'],
            ['Denmark', 12],
            ['France', 9],
          ],
        },
        series: [{ type: 'bar' }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.datasets).toEqual([
      { name: 'primary', dimensions: ['COUNTRY', 'REVENUE'], rows: 2 },
    ]);
  });

  it('takes declared dimensions over a header row, and then every row is data', () => {
    const resolution = resolveOption(
      {
        dataset: {
          id: 'matrix',
          dimensions: ['BAND', 'TYPE', 'PCT'],
          source: [
            ['A', 'motor', 4],
            ['B', 'motor', 6],
          ],
        },
        series: [{ type: 'heatmap' }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.datasets).toEqual([
      { name: 'matrix', dimensions: ['BAND', 'TYPE', 'PCT'], rows: 2 },
    ]);
  });

  it('says a data set has no names when its first row is data', () => {
    // A source of numbers has no header, and reporting its first row as the
    // dimension names would be inventing three columns.
    const resolution = resolveOption(
      {
        dataset: {
          source: [
            [1, 2],
            [3, 4],
          ],
        },
        series: [{ type: 'scatter' }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.datasets).toEqual([{ dimensions: [], rows: 1 }]);
  });

  it('reads dimensions declared as objects, which is a shape ECharts allows', () => {
    const resolution = resolveOption(
      {
        dataset: { dimensions: [{ name: 'BAND' }, 'PCT', 7], source: [['A', 4, 1]] },
        series: [{ type: 'bar', encode: { x: 'BAND' } }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    // The nameless one is reported as nameless rather than guessed at.
    expect(resolution.datasets[0]?.dimensions).toEqual(['BAND', 'PCT', '']);
    expect(resolution.unresolved).toEqual([]);
  });

  it('reports a dimension object with no name, and a source of objects, as nameless', () => {
    const objects = resolveOption(
      { dataset: { dimensions: [{}], source: [[1]] }, series: [{ type: 'bar' }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(objects.datasets[0]?.dimensions).toEqual(['']);
    // A source of objects — ECharts takes those too — carries its names inside
    // each row, which is not something a header row can be read out of.
    const rows = resolveOption(
      { dataset: { source: [{ BAND: 'A' }] }, series: [{ type: 'bar' }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(rows.datasets[0]?.dimensions).toEqual([]);
  });

  it('says a half-string first row is data, not a header', () => {
    const resolution = resolveOption(
      {
        dataset: {
          source: [
            ['BAND', 4],
            ['A', 5],
          ],
        },
        series: [{ type: 'bar' }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.datasets).toEqual([{ dimensions: [], rows: 1 }]);
  });

  it('names the data set as nameless when it has no name to give', () => {
    const resolution = resolveOption(
      {
        dataset: { source: [['BAND'], ['A']] },
        series: [{ type: 'bar', encode: { x: 'MISSING' } }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.unresolved).toEqual([
      'series[0].encode.x names MISSING, which the data set has not got — it has BAND',
    ]);
  });

  it('reports a data set with nothing in it rather than refusing to read it', () => {
    const resolution = resolveOption(
      { dataset: {}, series: [{ type: 'bar' }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.datasets).toEqual([{ dimensions: [], rows: 0 }]);
  });

  it('reads a list of data sets as well as a single one', () => {
    const resolution = resolveOption(
      {
        dataset: [
          { id: 'a', source: [['X'], [1]] },
          { id: 'b', source: [['Y'], [2]] },
        ],
        series: [{ type: 'bar', datasetId: 'b' }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.datasets.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(resolution.series[0]?.dataset).toBe('b');
  });
});

describe('which data set a series read', () => {
  const datasets = [
    {
      id: 'first',
      source: [
        ['X', 'Y'],
        [1, 2],
      ],
    },
    {
      id: 'second',
      source: [
        ['P', 'Q'],
        [3, 4],
      ],
    },
  ];

  it('follows a name, an index, or the first one when it says neither', () => {
    const named = resolveOption(
      { dataset: datasets, series: [{ type: 'bar', datasetId: 'second' }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(named.series[0]?.dataset).toBe('second');

    const indexed = resolveOption(
      { dataset: datasets, series: [{ type: 'bar', datasetIndex: 1 }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(indexed.series[0]?.dataset).toBe('second');

    const implied = resolveOption(
      { dataset: datasets, series: [{ type: 'bar' }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(implied.series[0]?.dataset).toBe('first');
  });

  it('says none where a series carries its own data', () => {
    // Which is every chart Panorama builds itself: the series hold their values,
    // so claiming they read the data set would be inventing a link.
    const resolution = resolveOption(
      { dataset: datasets, series: [{ type: 'bar', data: [1, 2, 3] }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.dataset).toBeUndefined();
  });

  it('says none where the name is one no data set has', () => {
    const resolution = resolveOption(
      { dataset: datasets, series: [{ type: 'bar', datasetId: 'third', encode: { x: 'X' } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.dataset).toBeUndefined();
    expect(resolution.unresolved).toEqual([
      'series[0].encode.x names X, but the series reads no data set',
    ]);
  });
});

describe('what each channel resolved to', () => {
  const dataset = {
    id: 'primary',
    source: [
      ['BAND', 'TYPE', 'PCT'],
      ['A', 'motor', 4],
    ],
  };

  it('reports a channel named outright, and one given as a dimension number', () => {
    const resolution = resolveOption(
      {
        dataset,
        series: [{ type: 'heatmap', encode: { x: 'BAND', y: 1, value: 'PCT' } }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.encode).toEqual({ x: 'BAND', y: 'TYPE', value: 'PCT' });
    expect(resolution.unresolved).toEqual([]);
  });

  it('names a channel pointing at a column the data set has not got', () => {
    // The failure that looks like success: the chart lays out, draws nothing for
    // that channel, and says nothing about why.
    const resolution = resolveOption(
      { dataset, series: [{ type: 'heatmap', encode: { value: 'FRAUD_KUSD' } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.unresolved).toEqual([
      'series[0].encode.value names FRAUD_KUSD, which data set "primary" has not got — it has BAND, TYPE, PCT',
    ]);
  });

  it('checks every dimension of a channel that takes several', () => {
    const resolution = resolveOption(
      { dataset, series: [{ type: 'bar', encode: { tooltip: ['BAND', 'MISSING'] } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.encode).toEqual({ tooltip: 'BAND, MISSING' });
    expect(resolution.unresolved).toHaveLength(1);
  });

  it('says nothing about a data set whose columns it cannot know', () => {
    // No names means nothing to check against, and a warning nobody can act on
    // is worse than silence.
    const resolution = resolveOption(
      { dataset: { source: [[1, 2]] }, series: [{ type: 'scatter', encode: { x: 0, y: 1 } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.encode).toEqual({ x: 'dimension 0', y: 'dimension 1' });
    expect(resolution.unresolved).toEqual([]);
  });

  it('ignores a channel whose every entry it cannot read', () => {
    const resolution = resolveOption(
      { dataset, series: [{ type: 'bar', encode: { tooltip: [{ deep: true }] } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.encode).toBeUndefined();
  });

  it('ignores a channel it cannot read at all', () => {
    const resolution = resolveOption(
      { dataset, series: [{ type: 'bar', encode: { x: { deep: true } } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.series[0]?.encode).toBeUndefined();
    expect(resolution.unresolved).toEqual([]);
  });
});

describe('marks', () => {
  it('counts distinct marks per series, not pieces of geometry', () => {
    // A bar is a dozen triangles; a count of triangles is not a fact about data.
    const resolution = resolveOption(
      {
        series: [
          { type: 'bar', data: [1, 2] },
          { type: 'line', data: [3] },
        ],
      },
      drawn([
        [0, 0],
        [0, 0],
        [0, 1],
        [1, 0],
      ]),
    );
    expect(resolution.series.map((series) => series.marks)).toEqual([2, 1]);
  });

  it('counts only geometry that belongs to a mark', () => {
    // Axes, grid lines and the legend's frame belong to no mark, and counting
    // them would report a chart's furniture as data.
    const resolution = resolveOption(
      { series: [{ type: 'bar', data: [1] }] },
      {
        polygons: [{ corners: [0, 0, 1, 0, 1, 1, 0, 1] as const, color: [0, 0, 0, 1] as const }],
        texts: [
          {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
            text: 'COUNTRY',
            color: [0, 0, 0, 1] as const,
            align: 'left' as const,
            fontSize: 10,
          },
        ],
      },
    );
    expect(resolution.series[0]?.marks).toBe(0);
  });

  it('counts a label as part of the mark it belongs to', () => {
    const resolution = resolveOption(
      { series: [{ type: 'bar' }] },
      {
        polygons: [],
        texts: [
          {
            x: 0,
            y: 0,
            width: 4,
            height: 4,
            text: '12',
            color: [0, 0, 0, 1] as const,
            align: 'left' as const,
            fontSize: 10,
            mark: { series: 0, data: 3 },
          },
        ],
      },
    );
    expect(resolution.series[0]?.marks).toBe(1);
  });

  it('reports nought for a series that drew nothing', () => {
    const resolution = resolveOption({ series: [{ type: 'sankey' }] }, EMPTY_CHART_DRAW_LIST);
    expect(resolution.series[0]).toMatchObject({ index: 0, type: 'sankey', marks: 0 });
  });
});

describe('which data set each series reads', () => {
  it('says nothing about an option it cannot read', () => {
    // The stamping asks this once per layout; an option that is not an object has
    // no series to stamp.
    expect(seriesDatasets(null)).toEqual([]);
    expect(
      seriesDatasets({ dataset: { id: 'a', source: [['X'], [1]] }, series: [{ type: 'bar' }] }),
    ).toEqual(['a']);
  });
});

describe('whether a picture can be pointed at', () => {
  it('is true where anything drawn carries a mark', () => {
    expect(resolveOption({ series: [{ type: 'bar' }] }, drawn([[0, 0]])).pickable).toBe(true);
  });

  it('is false where shapes were drawn and none of them carry one', () => {
    // A calendar heatmap: its cells are drawn by the calendar component and carry
    // no row index anywhere in the display list, so there is nothing to find. A
    // correct picture that is inert, and it says so rather than looking like a
    // chart nobody had pointed at yet.
    const furniture: ChartDrawList = {
      polygons: [{ corners: [0, 0, 1, 0, 1, 1, 0, 1] as const, color: [0, 0, 0, 1] as const }],
      texts: [],
    };
    expect(resolveOption({ series: [{ type: 'heatmap' }] }, furniture).pickable).toBe(false);
  });

  it('counts a label as something that can be pointed at', () => {
    const labelled: ChartDrawList = {
      polygons: [],
      texts: [
        {
          x: 0,
          y: 0,
          width: 4,
          height: 4,
          text: '12',
          color: [0, 0, 0, 1] as const,
          align: 'left' as const,
          fontSize: 10,
          mark: { series: 0, data: 0 },
        },
      ],
    };
    expect(resolveOption({ series: [{ type: 'bar' }] }, labelled).pickable).toBe(true);
  });
});

describe('a number nothing answered for', () => {
  it('is named by the data set the option asked for', () => {
    // The marker is left in the option on purpose, so this is where it is found.
    const resolution = resolveOption(
      {
        series: [{ type: 'line', markLine: { data: [{ yAxis: { $param: 'baserate' } }] } }],
      },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.unresolved).toEqual([
      'series[0].markLine.data[0].yAxis asks for the number from data set "baserate", which there is no such data set for',
    ]);
  });

  it('names a data set a list asked for and did not get', () => {
    const resolution = resolveOption(
      { series: [{ type: 'graph', links: { $rows: 'edges' } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.unresolved).toEqual([
      'series[0].links asks for the rows of data set "edges", which there is no such data set for',
    ]);
  });

  it('says nothing where every number was resolved', () => {
    const resolution = resolveOption(
      { series: [{ type: 'line', markLine: { data: [{ yAxis: 4.91 }] } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.unresolved).toEqual([]);
  });

  it('leaves an object that merely has a $param among other keys alone', () => {
    // A marker is a lone key. Anything else is somebody's own option.
    const resolution = resolveOption(
      { series: [{ type: 'line', extra: { $param: 'x', andSomethingElse: 1 } }] },
      EMPTY_CHART_DRAW_LIST,
    );
    expect(resolution.unresolved).toEqual([]);
  });
});

describe('an option it cannot read', () => {
  it('reports nothing rather than guessing', () => {
    expect(resolveOption(null, EMPTY_CHART_DRAW_LIST)).toEqual({
      datasets: [],
      series: [],
      unresolved: [],
      pickable: false,
    });
    expect(resolveOption({ series: 'a bar chart' }, EMPTY_CHART_DRAW_LIST).series).toEqual([]);
    expect(resolveOption({}, EMPTY_CHART_DRAW_LIST).datasets).toEqual([]);
  });

  it('says a series type it was not given is unknown rather than assuming one', () => {
    const resolution = resolveOption({ series: [{ data: [1] }] }, EMPTY_CHART_DRAW_LIST);
    expect(resolution.series[0]?.type).toBe('unknown');
  });
});
