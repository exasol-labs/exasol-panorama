import { describe, expect, it } from 'vitest';
import type { ChartColumnHint, ChartSpec, TableEntity } from '@panorama/core';
import {
  PRIMARY_FRAME,
  chartFramesProblem,
  chartWindowProblem,
  shiftedWindow,
  CHART_AGGREGATES,
  CHART_CURVES,
  CHART_LEGENDS,
  CHART_ORIENTATIONS,
  CHART_SCALES,
  CHART_SORTS,
  CHART_TYPES,
  chartSupports,
  isCartesianChart,
  isBrokenDown,
  isCustomChart,
  parseChartExtra,
  DEFAULT_CHART_CATEGORIES,
  DEFAULT_CHART_ROWS,
  applyCommand,
  buildTableEntity,
  defaultChartSpec,
  derivedFromOf,
  describeChartSpec,
  describeCommand,
  emptyWorld,
  isChartSpecDrawable,
  isChartTable,
  isConfigurableTable,
  isSelectionTable,
  isQueryTable,
  tableDisplayName,
  unwrap,
} from '@panorama/core';
import { TEST_CONNECTION, makeTable, testIds } from './fixtures.js';

const ids = testIds(31);

const chartTable = (overrides: { spec?: ChartSpec; base?: string } = {}): TableEntity =>
  buildTableEntity(ids, {
    source: {
      kind: 'chart',
      connectionId: TEST_CONNECTION,
      spec: overrides.spec ?? {
        type: 'bar',
        category: 'COUNTRY',
        values: ['REVENUE'],
        aggregate: 'sum',
      },
      label: 'SALES.ORDERS · Chart',
      derivedFrom: (overrides.base ?? 'table:base') as never,
    },
    mode: 'editing',
    columns: [],
  });

describe('which part of a relation a data set reads', () => {
  it('has nothing to say about a window that makes sense', () => {
    expect(chartWindowProblem({ by: 'position', from: 0, count: 100 })).toBeNull();
    expect(
      chartWindowProblem({ by: 'value', column: 'T', from: '2026-01-01', to: '2026-02-01' }),
    ).toBeNull();
  });

  it('refuses a window that could not be read', () => {
    expect(chartWindowProblem({ by: 'position', from: -1, count: 10 })).toMatch(/starts at a row/u);
    expect(chartWindowProblem({ by: 'position', from: 0, count: 0 })).toMatch(/at least a row/u);
    expect(chartWindowProblem({ by: 'position', from: Number.NaN, count: 5 })).toMatch(
      /starts at a row/u,
    );
    expect(chartWindowProblem({ by: 'value', column: ' ', from: 1, to: 2 })).toMatch(
      /needs a column to bound/u,
    );
    expect(chartWindowProblem({ by: 'value', column: 'T', from: null, to: 2 })).toMatch(
      /needs both bounds/u,
    );
  });

  it('moves a window by whole windows, and never past the beginning', () => {
    const window = { by: 'position', from: 500, count: 500 } as const;
    expect(shiftedWindow(window, 1)).toEqual({ by: 'position', from: 1_000, count: 500 });
    expect(shiftedWindow(window, -1)).toEqual({ by: 'position', from: 0, count: 500 });
    // There is no row before the first, and no move is no change.
    expect(shiftedWindow(window, -5)).toEqual({ by: 'position', from: 0, count: 500 });
    expect(shiftedWindow(window, 0)).toBe(window);
  });

  it('will not move a window by value, because the data decides what is next', () => {
    expect(shiftedWindow({ by: 'value', column: 'T', from: 1, to: 2 }, 1)).toBeNull();
  });

  it('refuses a data set that says it reads a window it could not', () => {
    expect(
      chartFramesProblem([
        {
          name: 'r',
          kind: 'rows',
          columns: ['X'],
          window: { by: 'position', from: 0, count: 0 },
        },
      ]),
    ).toMatch(/at least a row/u);
  });

  it('refuses a resampling with nothing to plot', () => {
    expect(chartFramesProblem([{ name: 'l', kind: 'resample', x: ' ', values: ['V'] }])).toMatch(
      /needs a column along the axis/u,
    );
    expect(chartFramesProblem([{ name: 'l', kind: 'resample', x: 'T', values: [] }])).toMatch(
      /at least one column to measure/u,
    );
    expect(chartFramesProblem([{ name: 'l', kind: 'resample', x: 'T', values: ['V'] }])).toBeNull();
  });
});

describe('the data sets a specification may name', () => {
  const rows = { name: 'raw', kind: 'rows', columns: ['X'] } as const;

  it('has nothing to say about a list that is fine', () => {
    expect(chartFramesProblem([])).toBeNull();
    expect(chartFramesProblem([rows])).toBeNull();
  });

  it('refuses a name nothing could refer to, or two of the same', () => {
    // A name is how an option reaches a data set: two answering to one name is a
    // picture drawn from whichever won, and it cannot say which.
    expect(chartFramesProblem([{ ...rows, name: ' ' }])).toMatch(/needs a name/u);
    expect(chartFramesProblem([{ ...rows, name: PRIMARY_FRAME }])).toMatch(
      /is the name of the chart's own reduction/u,
    );
    expect(chartFramesProblem([rows, { ...rows, columns: ['Y'] }])).toMatch(
      /two data sets are called "raw"/u,
    );
  });

  it('refuses a data set that could not be built', () => {
    expect(chartFramesProblem([{ ...rows, columns: [] }])).toMatch(/names no columns/u);
    expect(
      chartFramesProblem([
        { name: 'g', kind: 'group', category: '  ', values: ['V'], aggregate: 'sum' },
      ]),
    ).toMatch(/needs a category to group by/u);
    expect(
      chartFramesProblem([
        { name: 'g', kind: 'group', category: 'C', values: [], aggregate: 'sum' },
      ]),
    ).toMatch(/needs a column to measure/u);
    // Counting rows needs no column, so that one is allowed.
    expect(
      chartFramesProblem([
        { name: 'g', kind: 'group', category: 'C', values: [], aggregate: 'count' },
      ]),
    ).toBeNull();
    expect(
      chartFramesProblem([{ name: 's', kind: 'scalar', column: ' ', aggregate: 'sum' }]),
    ).toMatch(/needs a column to reduce/u);
    // A key is one of the columns it reads, or it is nothing a mark can be traced
    // by — and being told so beats a heatmap that picks out and opens nothing.
    expect(chartFramesProblem([{ ...rows, key: 'ELSEWHERE' }])).toMatch(
      /says its key is ELSEWHERE, which it does not read/u,
    );
    expect(chartFramesProblem([{ ...rows, key: 'X' }])).toBeNull();
  });
});

describe('guessing a chart nobody has set up yet', () => {
  it('puts the first text column against the first measurement', () => {
    const columns: readonly ChartColumnHint[] = [
      { name: 'ORDER_ID', numeric: true },
      { name: 'COUNTRY', numeric: false },
      { name: 'REVENUE', numeric: true, measure: true },
    ];
    expect(defaultChartSpec(columns)).toEqual({
      type: 'bar',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    });
  });

  it('prefers a quantity to an identifier', () => {
    // Summing order numbers is a chart of nothing, so a column with decimal
    // places wins over a whole-number one even when the whole one comes first.
    const spec = defaultChartSpec([
      { name: 'CATEGORY', numeric: false },
      { name: 'ID', numeric: true },
      { name: 'AMOUNT', numeric: true, measure: true },
    ]);
    expect(spec.values).toEqual(['AMOUNT']);
  });

  it('takes an identifier when that is all there is', () => {
    const spec = defaultChartSpec([
      { name: 'CATEGORY', numeric: false },
      { name: 'ID', numeric: true },
    ]);
    expect(spec.values).toEqual(['ID']);
  });

  it('counts rows for a table with no numbers in it at all', () => {
    const spec = defaultChartSpec([
      { name: 'NAME', numeric: false },
      { name: 'CODE', numeric: false },
    ]);
    expect(spec).toMatchObject({ category: 'NAME', values: [], aggregate: 'count' });
    // Counting needs no measure, so this is drawable as it stands.
    expect(isChartSpecDrawable(spec)).toBe(true);
  });

  it('falls back to the only column there is, numeric or not', () => {
    expect(defaultChartSpec([{ name: 'N', numeric: true }])).toMatchObject({
      category: 'N',
      values: ['N'],
    });
  });

  it('has nothing to say about a table with no columns', () => {
    const spec = defaultChartSpec([]);
    expect(spec).toMatchObject({ category: '', values: [], aggregate: 'count' });
    expect(isChartSpecDrawable(spec)).toBe(false);
  });

  it('is not drawable without a measure, unless it is counting', () => {
    const base = { type: 'bar', category: 'C', values: [], aggregate: 'sum' } as const;
    expect(isChartSpecDrawable(base)).toBe(false);
    expect(isChartSpecDrawable({ ...base, aggregate: 'count' })).toBe(true);
    expect(isChartSpecDrawable({ ...base, values: ['V'] })).toBe(true);
  });
});

describe('describing a chart in one line', () => {
  it('names the measure and the dimension', () => {
    expect(
      describeChartSpec({
        type: 'bar',
        category: 'COUNTRY',
        values: ['REVENUE'],
        aggregate: 'sum',
      }),
    ).toBe('bar: sum of REVENUE by COUNTRY');
  });

  it('does not pretend a row count is a measure of a column', () => {
    expect(
      describeChartSpec({ type: 'pie', category: 'COUNTRY', values: [], aggregate: 'count' }),
    ).toBe('pie: count by COUNTRY');
  });

  it('lists every series it draws', () => {
    expect(
      describeChartSpec({ type: 'line', category: 'D', values: ['A', 'B'], aggregate: 'average' }),
    ).toBe('line: average of A, B by D');
  });

  it('offers the types and reductions the controls list', () => {
    // Five assembled from the controls, and one written out.
    expect(CHART_TYPES).toEqual(['bar', 'line', 'area', 'scatter', 'pie', 'custom']);
    expect(CHART_AGGREGATES).toEqual(['sum', 'average', 'count', 'min', 'max']);
    expect(DEFAULT_CHART_ROWS).toBeGreaterThan(0);
    expect(DEFAULT_CHART_CATEGORIES).toBeGreaterThan(0);
  });
});

describe('a chart-backed table', () => {
  it('is a chart, is configurable, and is not a query', () => {
    const chart = chartTable();
    expect(isChartTable(chart)).toBe(true);
    expect(isQueryTable(chart)).toBe(false);
    expect(isConfigurableTable(chart)).toBe(true);
  });

  it('is titled by its label rather than a schema and table', () => {
    expect(tableDisplayName(chartTable())).toBe('SALES.ORDERS · Chart');
  });

  it('names what it was built on, the same way a query does', () => {
    expect(derivedFromOf(chartTable({ base: 'table:x' }))).toBe('table:x');
    expect(derivedFromOf(makeTable(ids))).toBeUndefined();
  });

  it('is neither a chart nor configurable when it is a stored relation', () => {
    const plain = makeTable(ids);
    expect(isChartTable(plain)).toBe(false);
    expect(isConfigurableTable(plain)).toBe(false);
  });
});

describe('SetChartSpec', () => {
  it('replaces the whole specification in one commit', () => {
    const chart = chartTable();
    const world = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: chart }));
    const spec: ChartSpec = {
      type: 'pie',
      category: 'REGION',
      values: ['TOTAL'],
      aggregate: 'average',
      stacked: true,
    };
    const next = unwrap(applyCommand(world, { type: 'SetChartSpec', tableId: chart.id, spec }));
    const before = world.entities.get(chart.id) as TableEntity;
    const stored = next.entities.get(chart.id) as TableEntity;
    expect(stored.source).toMatchObject({ kind: 'chart', spec });
    // Everything else is untouched.
    expect(stored.transform).toEqual(before.transform);
    expect(stored.mode).toBe(before.mode);
  });

  it('refuses a table that is not a chart', () => {
    const plain = makeTable(ids);
    const world = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: plain }));
    const result = applyCommand(world, {
      type: 'SetChartSpec',
      tableId: plain.id,
      spec: { type: 'bar', category: 'C', values: [], aggregate: 'count' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('not-a-chart');
  });

  it('refuses a table that is not there', () => {
    const result = applyCommand(emptyWorld(), {
      type: 'SetChartSpec',
      tableId: 'table:gone' as never,
      spec: { type: 'bar', category: 'C', values: [], aggregate: 'count' },
    });
    expect(result.ok).toBe(false);
  });

  it('describes itself for the history view', () => {
    expect(
      describeCommand({
        type: 'SetChartSpec',
        tableId: 'table:1' as never,
        spec: { type: 'bar', category: 'C', values: ['V'], aggregate: 'sum' },
      }),
    ).toBe('Set up chart (bar: sum of V by C)');
  });
});

describe('SetTableMode on a chart', () => {
  it('switches a chart between its setup and its picture', () => {
    const chart = chartTable();
    const world = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: chart }));
    const shown = unwrap(
      applyCommand(world, { type: 'SetTableMode', tableId: chart.id, mode: 'result' }),
    );
    expect((shown.entities.get(chart.id) as TableEntity).mode).toBe('result');
  });

  it('refuses a stored relation, which has nothing to configure', () => {
    const plain = makeTable(ids);
    const world = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: plain }));
    const result = applyCommand(world, {
      type: 'SetTableMode',
      tableId: plain.id,
      mode: 'editing',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toMatch(/nothing to configure/);
  });
});

describe('which settings mean something for which chart', () => {
  it('stacks bars and areas, and nothing else', () => {
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'stack'))).toEqual(['bar', 'area']);
  });

  it('turns only bars on their side', () => {
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'orientation'))).toEqual(['bar']);
  });

  it('curves and marks only what has a line', () => {
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'curve'))).toEqual(['line', 'area']);
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'points'))).toEqual(['line', 'area']);
  });

  it('puts a hole only in a pie', () => {
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'hole'))).toEqual(['pie']);
  });

  it('scales and rules only what has axes', () => {
    const cartesian = ['bar', 'line', 'area', 'scatter'];
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'scale'))).toEqual(cartesian);
    expect(CHART_TYPES.filter((type) => chartSupports(type, 'grid'))).toEqual(cartesian);
    expect(CHART_TYPES.filter(isCartesianChart)).toEqual(cartesian);
  });

  it('offers every list the controls draw from', () => {
    expect(CHART_SORTS).toEqual(['size', 'name', 'natural']);
    expect(CHART_CURVES).toEqual(['straight', 'smooth', 'stepped']);
    expect(CHART_ORIENTATIONS).toEqual(['vertical', 'horizontal']);
    expect(CHART_SCALES).toEqual(['linear', 'log']);
    expect(CHART_LEGENDS).toEqual(['auto', 'always', 'never']);
  });
});

describe('the escape hatch', () => {
  it('is nothing at all when it is empty', () => {
    expect(parseChartExtra(undefined)).toEqual({});
    expect(parseChartExtra('')).toEqual({});
    expect(parseChartExtra('   \n ')).toEqual({});
  });

  it('parses an object', () => {
    expect(parseChartExtra('{"yAxis":{"name":"money"}}')).toEqual({
      option: { yAxis: { name: 'money' } },
    });
  });

  it('reports what is wrong rather than swallowing it', () => {
    // A chart whose extra settings do not parse should still draw without them,
    // and should say why — which is more use than a blank box or a silent field.
    const broken = parseChartExtra('{oops');
    expect(broken.option).toBeUndefined();
    expect(broken.error).toBeDefined();
  });

  it('insists on an object, because that is what an option is', () => {
    for (const text of ['[1,2]', '"a string"', '42', 'null']) {
      expect(parseChartExtra(text).error).toBeDefined();
    }
  });
});

describe('SetTableSource', () => {
  it('replaces a table source, which is how a drill-down is marked', () => {
    const plain = makeTable(ids);
    const world = unwrap(applyCommand(emptyWorld(), { type: 'CreateTableEntity', entity: plain }));
    const source = { ...plain.source, selectionOf: 'table:chart' as never };
    const next = unwrap(applyCommand(world, { type: 'SetTableSource', tableId: plain.id, source }));
    const stored = next.entities.get(plain.id) as TableEntity;
    expect(stored.source).toEqual(source);
    expect(isSelectionTable(stored)).toBe(true);
    expect(derivedFromOf(stored)).toBe('table:chart');
  });

  it('is not a drill-down until it says whose selection it shows', () => {
    expect(isSelectionTable(makeTable(ids))).toBe(false);
    expect(isSelectionTable(chartTable())).toBe(false);
  });

  it('refuses a table that is not there', () => {
    const result = applyCommand(emptyWorld(), {
      type: 'SetTableSource',
      tableId: 'table:gone' as never,
      source: makeTable(ids).source,
    });
    expect(result.ok).toBe(false);
  });

  it('describes itself for the history view', () => {
    expect(
      describeCommand({
        type: 'SetTableSource',
        tableId: 'table:1' as never,
        source: {
          kind: 'relation',
          connectionId: TEST_CONNECTION,
          schema: 'SALES',
          table: 'ORDERS',
        },
      }),
    ).toBe('Retarget table to SALES.ORDERS');
  });
});

describe('a chart whose option was written', () => {
  const custom = (extra?: string): ChartSpec => ({
    type: 'custom',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    ...(extra === undefined ? {} : { extra }),
  });

  it('is not one of the assembled kinds, and supports none of their settings', () => {
    expect(isCustomChart('custom')).toBe(true);
    expect(isCustomChart('bar')).toBe(false);
    // Whatever axes it has are in the option, and nothing here has an opinion.
    expect(isCartesianChart('custom')).toBe(false);
    for (const feature of [
      'stack',
      'orientation',
      'curve',
      'points',
      'hole',
      'scale',
      'grid',
    ] as const) {
      expect(chartSupports('custom', feature)).toBe(false);
    }
  });

  it('is drawable once the option parses, whatever columns it names', () => {
    // The option is the chart: a gauge of one number reads no column at all.
    expect(isChartSpecDrawable(custom('{"series":[{"type":"gauge"}]}'))).toBe(true);
    expect(
      isChartSpecDrawable({
        type: 'custom',
        category: '',
        values: [],
        aggregate: 'count',
        extra: '{"series":[]}',
      }),
    ).toBe(true);
    // And is not a chart until something has been written.
    expect(isChartSpecDrawable(custom())).toBe(false);
    expect(isChartSpecDrawable(custom('  '))).toBe(false);
    expect(isChartSpecDrawable(custom('{oh dear'))).toBe(false);
  });

  it('describes itself by what the option asks for', () => {
    expect(describeChartSpec(custom('{"series":[{"type":"radar"}]}'))).toBe('custom: radar');
    // Several series, named once each, in the order they were written.
    expect(
      describeChartSpec(custom('{"series":[{"type":"graph"},{"type":"lines"},{"type":"graph"}]}')),
    ).toBe('custom: graph, lines');
    // A single series is an object as often as it is a list of one.
    expect(describeChartSpec(custom('{"series":{"type":"sankey"}}'))).toBe('custom: sankey');
    // Nothing to name yet, which is what an empty box looks like.
    expect(describeChartSpec(custom())).toBe('custom chart');
    expect(describeChartSpec(custom('{"series":[{"data":[1]}]}'))).toBe('custom chart');
    expect(describeChartSpec(custom('{"grid":{}}'))).toBe('custom chart');
  });
});

describe('a chart split by a second column', () => {
  const split = (overrides: Partial<ChartSpec> = {}): ChartSpec => ({
    type: 'bar',
    category: 'CLAIM_TYPE',
    values: ['AMOUNT'],
    aggregate: 'sum',
    breakdown: 'DECILE',
    ...overrides,
  });

  it('is a cross-tabulation only when the second column is a different one', () => {
    expect(isBrokenDown(split())).toBe(true);
    expect(isBrokenDown(split({ breakdown: 'CLAIM_TYPE' }))).toBe(false);
    expect(isBrokenDown(split({ breakdown: '' }))).toBe(false);
    const plain: ChartSpec = { type: 'bar', category: 'C', values: [], aggregate: 'count' };
    expect(isBrokenDown(plain)).toBe(false);
  });

  it('says both dimensions in its one-line description', () => {
    expect(describeChartSpec(split())).toBe('bar: sum of AMOUNT by CLAIM_TYPE × DECILE');
    expect(describeChartSpec(split({ breakdown: 'CLAIM_TYPE' }))).toBe(
      'bar: sum of AMOUNT by CLAIM_TYPE',
    );
  });
});
