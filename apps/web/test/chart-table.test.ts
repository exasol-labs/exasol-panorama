import { describe, expect, it } from 'vitest';
import type { ChartMetrics } from '@panorama/renderer';
import type { ChartSpec, EntityId, TableEntity } from '@panorama/core';
import { isChartTable, isTableEntity } from '@panorama/core';
import { EMPTY_CHART_DRAW_LIST } from '@panorama/chart';
import { EChartsSurface } from '@panorama/chart-echarts';
import { createAppHarness, firstTableId } from './harness.js';
import { refusalReason } from '../src/panorama/workspace.js';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';

const metrics: ChartMetrics = {
  measureText: (text, fontSize) => text.length * fontSize * 0.56,
  fontFamily: 'sans-serif',
};

const openTable = async (
  options: Parameters<typeof createAppHarness>[0] = {},
): Promise<{ harness: ReturnType<typeof createAppHarness>; baseId: EntityId }> => {
  const harness = createAppHarness({ chartSurface: new EChartsSurface(), ...options });
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  await harness.settle();
  return { harness, baseId: firstTableId(harness) };
};

const chartEntity = (
  harness: ReturnType<typeof createAppHarness>,
  id: EntityId,
): TableEntity & { readonly source: { readonly spec: unknown } } => {
  const entity = harness.workspace.core.world.entities.get(id);
  if (entity === undefined || !isTableEntity(entity) || !isChartTable(entity)) {
    throw new Error('expected a chart');
  }
  return entity;
};

describe('the chart action', () => {
  it('is offered for every table, sample relations included', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: DEMO_SCHEMA, table: 'SAMPLE_100' });
    // A chart runs no SQL of its own: it reads rows through the table it is of,
    // so a sample relation can be charted where it cannot be queried.
    expect(harness.workspace.disabledActionsFor(firstTableId(harness))).toEqual(['sql']);
  });

  it('refuses to chart a chart', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await expect(harness.workspace.openChart(tableId)).rejects.toThrow(/cannot be charted/);
  });

  it('refuses a table that is not there', async () => {
    const { harness } = await openTable();
    await expect(harness.workspace.openChart('table:gone' as EntityId)).rejects.toThrow(/No table/);
  });
});

describe('opening a chart', () => {
  it('creates a box in setup mode, connected to its source', async () => {
    const { harness, baseId } = await openTable();
    const { tableId, bindingId } = await harness.workspace.openChart(baseId);
    await harness.settle();

    const entity = chartEntity(harness, tableId);
    expect(entity.mode).toBe('editing');
    expect(entity.columns).toEqual([]);
    expect(harness.workspace.core.world.bindings.get(bindingId)).toMatchObject({
      fromId: baseId,
      toId: tableId,
      meta: { kind: 'chart' },
      label: 'bar: sum of REVENUE by COUNTRY',
    });
  });

  it('guesses a chart that draws something the moment it opens', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();

    // A dimension against a measurement, not against an identifier.
    expect(harness.workspace.chartDraft(tableId)).toEqual({
      type: 'bar',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    });
    expect(harness.workspace.chartState(tableId)?.status).toBe('ready');
  });

  it('offers the base table columns to choose between', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    // No semantic layer here, so every label is the column's own name.
    expect(harness.workspace.chartColumns(tableId)).toEqual([
      { name: 'ORDER_ID', type: 'DECIMAL(18,0)', numeric: true, label: 'ORDER_ID' },
      { name: 'COUNTRY', type: 'VARCHAR(64)', numeric: false, label: 'COUNTRY' },
      { name: 'ORDER_DATE', type: 'DATE', numeric: false, label: 'ORDER_DATE' },
      {
        name: 'REVENUE',
        type: 'DECIMAL(18,2)',
        numeric: true,
        measure: true,
        label: 'REVENUE',
      },
    ]);
  });

  it('has nothing to offer for anything that is not a chart', async () => {
    const { harness, baseId } = await openTable();
    expect(harness.workspace.chartColumns(baseId)).toEqual([]);
    expect(harness.workspace.chartDraft(baseId)).toBeNull();
    expect(harness.workspace.chartColumns('table:gone' as EntityId)).toEqual([]);
  });

  it('lists the charts being set up', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    expect(harness.workspace.editingCharts()).toEqual([tableId]);
    harness.workspace.showChart(tableId);
    expect(harness.workspace.editingCharts()).toEqual([]);
  });
});

describe('setting a chart up', () => {
  it('redraws as the controls move, without touching history', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    const commits = harness.workspace.core.history.commits.size;

    harness.workspace.setChartDraft(tableId, {
      type: 'pie',
      category: 'ORDER_DATE',
      values: ['REVENUE'],
      aggregate: 'average',
    });
    await harness.settle();

    expect(harness.workspace.chartState(tableId)?.status).toBe('ready');
    expect(harness.workspace.chartDraft(tableId)?.type).toBe('pie');
    // Turning a dial is not an edit; committing the setup is.
    expect(harness.workspace.core.history.commits.size).toBe(commits);
    expect(chartEntity(harness, tableId).source.spec).toMatchObject({ type: 'bar' });
  });

  it('reads another box where an arrow says to, and says which', async () => {
    const { harness, baseId } = await openTable();
    const { tableId: chartId } = await harness.workspace.openChart(baseId);
    // A second box for the data set to read: the same relation opened again is
    // enough, because what is being tested is which box the rows came from.
    const second = await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    harness.workspace.setChartDraft(chartId, {
      type: 'custom',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      frames: [{ name: 'matrix', kind: 'rows', columns: ['COUNTRY', 'REVENUE'] }],
      extra: '{"series":[{"type":"heatmap","datasetId":"matrix"}]}',
    });
    await harness.settle();
    // With no arrow it reads the chart's own box: raw rows, not the four
    // categories the reduction beside it folded them into.
    const own = harness.workspace
      .chartState(chartId)
      ?.frames?.find((frame) => frame.name === 'matrix');
    expect(own?.from).toBeUndefined();
    expect(own?.rows).toBeGreaterThan(4);

    const bound = harness.workspace.core.dispatch({
      type: 'CreateBinding',
      binding: {
        id: harness.workspace.core.ids.binding(),
        kind: 'data',
        fromId: second,
        toId: chartId,
        from: { mode: 'auto' },
        to: { mode: 'auto' },
        directed: true,
        label: 'matrix',
      },
    });
    expect(bound.ok ? 'ok' : bound.error.message).toBe('ok');
    // Nothing fired the reload: the frame tick notices the arrow is new.
    harness.workspace.update(16);
    await harness.settle();
    const reported = harness.workspace
      .chartState(chartId)
      ?.frames?.find((frame) => frame.name === 'matrix');
    expect(reported?.from).toBe(second);
    expect(reported?.dimensions).toEqual(['COUNTRY', 'REVENUE']);
  });

  it('waits rather than drawing when nothing has been chosen', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    harness.workspace.setChartDraft(tableId, {
      type: 'bar',
      category: '',
      values: [],
      aggregate: 'sum',
    });
    await harness.settle();
    expect(harness.workspace.chartState(tableId)?.status).toBe('unset');
  });

  it('ignores a draft for anything that is not a chart', async () => {
    const { harness, baseId } = await openTable();
    expect(() =>
      harness.workspace.setChartDraft(baseId, {
        type: 'bar',
        category: 'C',
        values: [],
        aggregate: 'count',
      }),
    ).not.toThrow();
  });

  it('commits the whole setup in one entry, and retitles the line', async () => {
    const { harness, baseId } = await openTable();
    const { tableId, bindingId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    const before = harness.workspace.core.history.commits.size;

    harness.workspace.setChartDraft(tableId, {
      type: 'pie',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'average',
    });
    harness.workspace.showChart(tableId);

    // Three: the specification, the switch to showing it, and the line's label —
    // which is document state too, and would otherwise describe a chart the box
    // no longer draws.
    expect(harness.workspace.core.history.commits.size).toBe(before + 3);
    expect(chartEntity(harness, tableId).mode).toBe('result');
    expect(harness.workspace.core.world.bindings.get(bindingId)?.label).toBe(
      'pie: average of REVENUE by COUNTRY',
    );
  });

  it('refuses to show a chart with nothing chosen', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    harness.workspace.setChartDraft(tableId, {
      type: 'bar',
      category: '',
      values: [],
      aggregate: 'sum',
    });
    expect(() => harness.workspace.showChart(tableId)).toThrow(/Choose a column/);
  });

  it('refuses to show something that is not a chart at all', async () => {
    const { harness, baseId } = await openTable();
    expect(() => harness.workspace.showChart(baseId)).toThrow(/No chart/);
  });

  it('goes back and forth between the setup and the picture', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    harness.workspace.showChart(tableId);
    expect(chartEntity(harness, tableId).mode).toBe('result');
    harness.workspace.editChart(tableId);
    expect(chartEntity(harness, tableId).mode).toBe('editing');
    expect(() => harness.workspace.editChart('table:gone' as EntityId)).toThrow();
  });

  it('is driven by the halo button in both directions', async () => {
    const { harness, baseId } = await openTable();
    await harness.workspace.performAction(baseId, 'chart');
    await harness.settle();
    const chartId = harness.workspace.editingCharts()[0] as EntityId;
    expect(chartId).toBeDefined();

    await harness.workspace.performAction(chartId, 'edit');
    expect(chartEntity(harness, chartId).mode).toBe('result');
    await harness.workspace.performAction(chartId, 'edit');
    expect(chartEntity(harness, chartId).mode).toBe('editing');
  });
});

describe('what the renderer is handed', () => {
  it('lays the chart out for the body it is given, and says what it read', async () => {
    // Few enough rows that the chart reads all of them, so there is no caveat.
    const { harness, baseId } = await openTable({ rowCount: 500 });
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;

    const view = harness.workspace.chartFor(entity, 400, 260, metrics);
    expect(view?.chart.polygons.length).toBeGreaterThan(0);
    expect(view?.note).toMatch(/rows/u);
    // Ten thousand rows read out of ten thousand: no caveat.
    expect(view?.caution).toBeUndefined();
  });

  it('reuses the geometry until the size or the numbers change', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;

    const first = harness.workspace.chartFor(entity, 400, 260, metrics);
    expect(harness.workspace.chartFor(entity, 400, 260, metrics)?.chart).toBe(first?.chart);
    expect(harness.workspace.chartFor(entity, 300, 260, metrics)?.chart).not.toBe(first?.chart);
  });

  it('says what it is waiting for rather than drawing an empty picture', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    harness.workspace.setChartDraft(tableId, {
      type: 'bar',
      category: '',
      values: [],
      aggregate: 'sum',
    });
    const entity = chartEntity(harness, tableId) as TableEntity;
    const view = harness.workspace.chartFor(entity, 400, 260, metrics);
    expect(view?.chart).toBe(EMPTY_CHART_DRAW_LIST);
    expect(view?.note).toBe('Choose a column to chart');
  });

  it('warns when the picture is of a beginning rather than of everything', async () => {
    const { harness, baseId } = await openTable({ rowCount: 100_000 });
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    harness.workspace.setChartDraft(tableId, {
      type: 'bar',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      rowLimit: 500,
    });
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;
    const view = harness.workspace.chartFor(entity, 400, 260, metrics);
    expect(view?.note).toMatch(/first 500 rows/u);
    expect(view?.caution).toBe(true);
  });

  it('reports a failure in the words the source used', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    harness.client.chartData = (): Promise<never> => Promise.reject(new Error('no chart for you'));
    harness.workspace.setChartDraft(tableId, {
      type: 'line',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    });
    await harness.settle();

    const entity = chartEntity(harness, tableId) as TableEntity;
    const view = harness.workspace.chartFor(entity, 400, 260, metrics);
    expect(view?.note).toBe('no chart for you');
    expect(view?.caution).toBe(true);
  });

  it('says so when the table it reads had no rows to give', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    harness.client.chartData = (): Promise<null> => Promise.resolve(null);
    harness.workspace.setChartDraft(tableId, {
      type: 'area',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    });
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;
    expect(harness.workspace.chartFor(entity, 400, 260, metrics)?.note).toBe('No rows to chart');
  });

  it('says it is reading before there is anything to draw', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    // Not settled: the answer is still on its way.
    const entity = chartEntity(harness, tableId) as TableEntity;
    expect(harness.workspace.chartState(tableId)?.status).toBe('loading');
    expect(harness.workspace.chartFor(entity, 400, 260, metrics)?.note).toBe('Reading…');
  });

  it('says how many categories it left out, and warns about it', async () => {
    const { harness, baseId } = await openTable();
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    harness.workspace.setChartDraft(tableId, {
      type: 'bar',
      category: 'ORDER_DATE',
      values: ['REVENUE'],
      aggregate: 'sum',
      categoryLimit: 2,
    });
    await harness.settle();

    const entity = chartEntity(harness, tableId) as TableEntity;
    const view = harness.workspace.chartFor(entity, 400, 260, metrics);
    // Gathered rather than dropped, and said so rather than quietly truncated.
    expect(view?.note).toMatch(/more categories not shown/u);
    expect(view?.caution).toBe(true);
  });

  it('says "category" in the singular when it left out exactly one', async () => {
    const { harness, baseId } = await openTable({ rowCount: 300 });
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    harness.workspace.setChartDraft(tableId, {
      type: 'bar',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      categoryLimit: 4,
    });
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;
    expect(harness.workspace.chartFor(entity, 400, 260, metrics)?.note).toMatch(
      /1 more category not shown/u,
    );
  });

  it('has nothing to say about a box that is not a chart', async () => {
    const { harness, baseId } = await openTable();
    const base = harness.workspace.core.world.entities.get(baseId) as TableEntity;
    expect(harness.workspace.chartFor(base, 400, 260, metrics)).toBeUndefined();
  });

  it('draws nothing at all with no chart library wired in', async () => {
    const harness = createAppHarness();
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;
    expect(harness.workspace.chartFor(entity, 400, 260, metrics)).toBeUndefined();
  });
});

describe('a chart in a chain', () => {
  it('is redrawn when the table it reads is re-run', async () => {
    const { harness, baseId } = await openTable();
    const { tableId: queryId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(queryId, 'SELECT COUNTRY, REVENUE FROM derived_table');
    await harness.settle();
    const { tableId: chartId } = await harness.workspace.openChart(queryId);
    await harness.settle();
    const before = harness.workspace.chartState(chartId);

    // Driven, because refreshing the chart means reading rows again and the
    // scheduler in these tests is a manual one.
    await harness.drive(
      harness.workspace.runQuery(queryId, 'SELECT COUNTRY, REVENUE FROM derived_table'),
    );
    await harness.settle();

    // A fresh answer, not the one it had: the rows behind it may have changed.
    expect(harness.workspace.chartState(chartId)?.status).toBe('ready');
    expect(harness.workspace.chartState(chartId)).not.toBe(before);
  });

  it('closes with the table it charts', async () => {
    const { harness, baseId } = await openTable();
    const { tableId: chartId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    await harness.workspace.closeTable(baseId);
    expect(harness.workspace.core.world.entities.has(chartId)).toBe(false);
  });
});

describe('exporting a chart as a picture', () => {
  const written = (): { bytes: Uint8Array[]; requests: unknown[]; closed: number } => {
    const state = { bytes: [] as Uint8Array[], requests: [] as unknown[], closed: 0 };
    return state;
  };

  const openWithSink = async (
    state: ReturnType<typeof written>,
    options: { readonly dismiss?: boolean; readonly failWrite?: boolean } = {},
  ): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    chartId: EntityId;
  }> => {
    const harness = createAppHarness({
      chartSurface: new EChartsSurface(),
      openExportSink: async (request) => {
        state.requests.push(request);
        if (options.dismiss === true) return null;
        return {
          position: 0,
          write: async (bytes: Uint8Array) => {
            if (options.failWrite === true) throw new Error('disk full');
            state.bytes.push(bytes);
          },
          close: async () => {
            state.closed += 1;
          },
        };
      },
      rasteriseSvg: async (svg) => new TextEncoder().encode(`PNG:${svg.length}`),
    });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    // Laid out once, which is what puts the geometry within reach of an export.
    const entity = chartEntity(harness, tableId) as TableEntity;
    harness.workspace.chartFor(entity, 400, 240, metrics);
    return { harness, chartId: tableId };
  };

  it('writes an SVG document, named after what it is a chart of', async () => {
    const state = written();
    const { harness, chartId } = await openWithSink(state);
    await harness.workspace.exportChart(chartId, 'svg');

    expect(state.requests[0]).toMatchObject({
      tableId: chartId,
      fileName: 'PANORAMA_TEST.SALES_Chart.svg',
      format: { label: 'SVG', mimeType: 'image/svg+xml' },
    });
    const svg = new TextDecoder().decode(state.bytes[0]);
    expect(svg.startsWith('<?xml')).toBe(true);
    // The box, not just the plot.
    expect(svg).toContain('PANORAMA_TEST.SALES · Chart');
    expect(svg).toMatch(/rows/u);
    expect(state.closed).toBe(1);
  });

  it('writes a PDF a reader will open', async () => {
    const state = written();
    const { harness, chartId } = await openWithSink(state);
    await harness.workspace.exportChart(chartId, 'pdf');
    const pdf = String.fromCharCode(...(state.bytes[0] as Uint8Array));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf).toContain('%%EOF');
  });

  it('writes a PNG by handing the SVG to whatever can rasterise', async () => {
    const state = written();
    const { harness, chartId } = await openWithSink(state);
    await harness.workspace.exportChart(chartId, 'png');
    // The PNG is that SVG drawn once, so the two cannot disagree about the chart.
    expect(new TextDecoder().decode(state.bytes[0]).startsWith('PNG:')).toBe(true);
  });

  it('writes nothing when the dialog was dismissed', async () => {
    const state = written();
    const { harness, chartId } = await openWithSink(state, { dismiss: true });
    await expect(harness.workspace.exportChart(chartId, 'svg')).resolves.toBeUndefined();
    expect(state.bytes).toEqual([]);
  });

  it('abandons a half-written file rather than leaving one behind', async () => {
    const state = written();
    const { harness, chartId } = await openWithSink(state, { failWrite: true });
    await expect(harness.workspace.exportChart(chartId, 'pdf')).rejects.toThrow(/disk full/);
    expect(state.closed).toBe(0);
  });

  it('refuses anything that is not a chart', async () => {
    const state = written();
    const { harness } = await openWithSink(state);
    await expect(harness.workspace.exportChart(firstTableId(harness), 'svg')).rejects.toThrow(
      /No chart/,
    );
  });

  it('refuses before there is a picture to export', async () => {
    const harness = createAppHarness({ chartSurface: new EChartsSurface() });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    // Never laid out, so there is no geometry to write.
    await expect(harness.workspace.exportChart(tableId, 'svg')).rejects.toThrow(/no chart/i);
  });

  it('greys the formats out until there is a picture, and lights them after', async () => {
    const state = written();
    const harness = createAppHarness({ chartSurface: new EChartsSurface() });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    expect(harness.workspace.disabledActionsFor(tableId)).toEqual([
      'export',
      'export-svg',
      'export-png',
      'export-pdf',
    ]);
    harness.workspace.chartFor(chartEntity(harness, tableId) as TableEntity, 400, 240, metrics);
    expect(harness.workspace.disabledActionsFor(tableId)).toEqual([]);
    void state;
  });

  it('says so rather than writing nothing when the shell cannot save', async () => {
    const harness = createAppHarness({ chartSurface: new EChartsSurface() });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    harness.workspace.chartFor(chartEntity(harness, tableId) as TableEntity, 400, 240, metrics);
    await expect(harness.workspace.exportChart(tableId, 'svg')).rejects.toThrow(/cannot save/);
  });

  it('says so rather than writing nothing when the shell cannot rasterise', async () => {
    const state = written();
    const harness = createAppHarness({
      chartSurface: new EChartsSurface(),
      openExportSink: async () => ({
        position: 0,
        write: async (bytes: Uint8Array) => {
          state.bytes.push(bytes);
        },
        close: async () => undefined,
      }),
    });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    harness.workspace.chartFor(chartEntity(harness, tableId) as TableEntity, 400, 240, metrics);
    await expect(harness.workspace.exportChart(tableId, 'png')).rejects.toThrow(
      /cannot write a PNG/,
    );
  });

  it('says so rather than writing nothing when the library has no drawing', async () => {
    const state = written();
    const harness = createAppHarness({
      // A surface that lays out but cannot hand over an SVG.
      chartSurface: {
        update: () => undefined,
        point: () => undefined,
        draw: () => ({
          polygons: [{ corners: [0, 0, 1, 0, 1, 1, 0, 1], color: [0, 0, 0, 1] }],
          texts: [],
        }),
        resolution: () => ({ datasets: [], series: [], unresolved: [] }),
        toSvg: () => null,
        dispose: () => undefined,
      },
      openExportSink: async () => ({
        position: 0,
        write: async (bytes: Uint8Array) => {
          state.bytes.push(bytes);
        },
        close: async () => undefined,
      }),
    });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    const { tableId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    harness.workspace.chartFor(chartEntity(harness, tableId) as TableEntity, 400, 240, metrics);
    await expect(harness.workspace.exportChart(tableId, 'svg')).rejects.toThrow(/no chart/i);
    // A PDF needs no SVG, so it still works.
    await expect(harness.workspace.exportChart(tableId, 'pdf')).resolves.toBeUndefined();
  });

  it('is driven by the halo, which discloses the formats first', async () => {
    const state = written();
    const { harness, chartId } = await openWithSink(state);
    await harness.workspace.performAction(chartId, 'export');
    expect(harness.workspace.core.session.expandedAction).toMatchObject({
      entityId: chartId,
      action: 'export',
    });

    await harness.workspace.performAction(chartId, 'export-pdf');
    // Folded away before the dialog opens, so the halo is not left hanging.
    expect(harness.workspace.core.session.expandedAction).toBeNull();
    expect(state.bytes).toHaveLength(1);
  });
});

describe('pointing at a chart and picking parts of it out', () => {
  const laidOut = async (): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    chartId: EntityId;
    entity: TableEntity;
  }> => {
    const { harness, baseId } = await openTable({ rowCount: 500 });
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;
    harness.workspace.chartFor(entity, 400, 240, metrics);
    return { harness, chartId: tableId, entity };
  };

  /** Sweeps across the picture to find a point that lands on a mark. */
  const findMark = (
    harness: ReturnType<typeof createAppHarness>,
    chartId: EntityId,
  ): { x: number; y: number; mark: { series: number; data: number } } => {
    for (let y = 40; y < 260; y += 8) {
      for (let x = 10; x < 400; x += 4) {
        const mark = harness.workspace.chartMarkAt(chartId, x, y);
        if (mark !== null) return { x, y, mark };
      }
    }
    throw new Error('no mark anywhere in the picture');
  };

  it('finds a mark under a point in the box own coordinates', async () => {
    const { harness, chartId } = await laidOut();
    const found = findMark(harness, chartId);
    expect(found.mark.series).toBe(0);
    expect(found.mark.data).toBeGreaterThanOrEqual(0);
  });

  it('finds nothing outside the picture', async () => {
    const { harness, chartId } = await laidOut();
    expect(harness.workspace.chartMarkAt(chartId, -50, -50)).toBeNull();
    expect(harness.workspace.chartMarkAt(chartId, 10_000, 10_000)).toBeNull();
  });

  it('finds nothing in a box that is not a chart, or has not drawn', async () => {
    const { harness, baseId } = await openTable();
    expect(harness.workspace.chartMarkAt(baseId, 10, 10)).toBeNull();
    expect(harness.workspace.chartMarkAt('table:gone' as EntityId, 10, 10)).toBeNull();
  });

  it('lifts the mark under the pointer without moving it', async () => {
    const { harness, chartId, entity } = await laidOut();
    const plain = harness.workspace.chartFor(entity, 400, 240, metrics)?.chart;
    const found = findMark(harness, chartId);
    harness.workspace.core.dispatchSession({
      type: 'SetHoveredMark',
      target: { entityId: chartId, ...found.mark },
    });
    const lit = harness.workspace.chartFor(entity, 400, 240, metrics)?.chart;

    expect(lit).not.toBe(plain);
    expect(lit?.polygons.map((polygon) => polygon.corners)).toEqual(
      plain?.polygons.map((polygon) => polygon.corners),
    );
  });

  it('fades what was not picked out', async () => {
    const { harness, chartId, entity } = await laidOut();
    const found = findMark(harness, chartId);
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: [{ entityId: chartId, ...found.mark }],
    });
    const picked = harness.workspace.chartFor(entity, 400, 240, metrics)?.chart;
    const faded = picked?.polygons.filter(
      (polygon) => polygon.mark !== undefined && polygon.color[3] < 1,
    );
    expect(faded?.length).toBeGreaterThan(0);
  });

  it('reuses the emphasised geometry until the pointer crosses a boundary', async () => {
    const { harness, chartId, entity } = await laidOut();
    const found = findMark(harness, chartId);
    harness.workspace.core.dispatchSession({
      type: 'SetHoveredMark',
      target: { entityId: chartId, ...found.mark },
    });
    const first = harness.workspace.chartFor(entity, 400, 240, metrics)?.chart;
    expect(harness.workspace.chartFor(entity, 400, 240, metrics)?.chart).toBe(first);

    harness.workspace.core.dispatchSession({ type: 'SetHoveredMark', target: null });
    expect(harness.workspace.chartFor(entity, 400, 240, metrics)?.chart).not.toBe(first);
  });

  it('exports the chart as it is, not as the pointer left it', async () => {
    // A file should not carry whatever happened to be under the pointer when it
    // was written.
    const { harness, chartId, entity } = await laidOut();
    const found = findMark(harness, chartId);
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: [{ entityId: chartId, ...found.mark }],
    });
    harness.workspace.chartFor(entity, 400, 240, metrics);
    const figure = harness.workspace.chartFigure(chartEntity(harness, chartId) as never);
    expect(figure?.chart.polygons.every((polygon) => polygon.color[3] === 1)).toBe(true);
  });

  it('lets go of the marks when the chart is set up differently', async () => {
    // The third bar of a chart sorted by size is not the third bar of one sorted
    // by name, so a choice made in one picture does not follow into another.
    const { harness, chartId } = await laidOut();
    const found = findMark(harness, chartId);
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: [{ entityId: chartId, ...found.mark }],
    });
    harness.workspace.setChartDraft(chartId, {
      type: 'bar',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      sort: 'name',
    });
    expect(harness.workspace.core.session.selectedMarks).toEqual([]);
  });

  it('lets go of them when the chart closes', async () => {
    const { harness, chartId } = await laidOut();
    const found = findMark(harness, chartId);
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: [{ entityId: chartId, ...found.mark }],
    });
    harness.workspace.core.dispatchSession({
      type: 'SetHoveredMark',
      target: { entityId: chartId, ...found.mark },
    });
    await harness.workspace.closeTable(chartId);
    expect(harness.workspace.core.session.selectedMarks).toEqual([]);
    expect(harness.workspace.core.session.hoveredMark).toBeNull();
  });

  it('leaves another chart marks alone when one is set up differently', async () => {
    const { harness, chartId } = await laidOut();
    const other = { entityId: 'table:elsewhere' as EntityId, series: 0, data: 0 };
    harness.workspace.core.dispatchSession({ type: 'SetSelectedMarks', targets: [other] });
    harness.workspace.setChartDraft(chartId, {
      type: 'line',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    });
    expect(harness.workspace.core.session.selectedMarks).toEqual([other]);
  });
});

describe('moving along a series longer than the screen', () => {
  it('keeps the picture it had while the next window is being read', async () => {
    // The constraint the whole design answers to does not get an exception for
    // charts: rows may arrive late and the canvas may not respond late. Blanking
    // on every step is the one thing a person moving along a series cannot use.
    const { harness, baseId } = await openTable({ rowCount: 5_000 });
    const { tableId: chartId } = await harness.workspace.openChart(baseId);
    const windowed = (from: number): ChartSpec => ({
      type: 'custom',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      frames: [
        {
          name: 'line',
          kind: 'resample',
          x: 'ORDER_ID',
          values: ['REVENUE'],
          points: 40,
          window: { by: 'position', from, count: 500 },
        },
      ],
      extra: '{"xAxis":{},"yAxis":{},"series":[{"type":"line","datasetId":"line"}]}',
    });
    harness.workspace.setChartDraft(chartId, windowed(0));
    await harness.settle();
    const entity = chartEntity(harness, chartId) as TableEntity;
    const first = harness.workspace.chartFor(entity, 400, 240, metrics);
    expect(first?.chart.polygons.length ?? 0).toBeGreaterThan(0);
    const drawn = first?.chart.polygons.length ?? 0;

    // The next window, asked for and not yet arrived.
    harness.workspace.setChartDraft(chartId, windowed(500));
    expect(harness.workspace.chartState(chartId)?.status).toBe('loading');
    const holding = harness.workspace.chartFor(entity, 400, 240, metrics);
    expect(holding?.chart.polygons.length).toBe(drawn);
    // And it says what is happening, so nobody reads the old picture as the new.
    expect(holding?.note).toContain('reading…');

    await harness.settle();
    const settled = harness.workspace.chartState(chartId);
    expect(settled?.status).toBe('ready');
    const page = settled?.frames?.find((frame) => frame.name === 'line');
    expect(page?.window).toEqual({ by: 'position', from: 500, count: 500 });
  });
});

describe('the rows behind a chart selection', () => {
  const laidOut = async (): Promise<{
    harness: ReturnType<typeof createAppHarness>;
    chartId: EntityId;
    entity: TableEntity;
  }> => {
    const { harness, baseId } = await openTable({ rowCount: 500 });
    const { tableId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    const entity = chartEntity(harness, tableId) as TableEntity;
    harness.workspace.chartFor(entity, 400, 240, metrics);
    return { harness, chartId: tableId, entity };
  };

  const firstMark = (
    harness: ReturnType<typeof createAppHarness>,
    chartId: EntityId,
  ): { series: number; data: number } => {
    for (let y = 40; y < 260; y += 8) {
      for (let x = 10; x < 400; x += 4) {
        const mark = harness.workspace.chartMarkAt(chartId, x, y);
        if (mark !== null) return mark;
      }
    }
    throw new Error('no mark anywhere in the picture');
  };

  const pick = async (
    harness: ReturnType<typeof createAppHarness>,
    chartId: EntityId,
    marks: readonly { series: number; data: number }[],
  ): Promise<void> => {
    harness.workspace.core.dispatchSession({
      type: 'SetSelectedMarks',
      targets: marks.map((mark) => ({ entityId: chartId, ...mark })),
    });
    harness.workspace.update(16);
    await harness.settle();
  };

  it('opens beside the chart, empty, connected by a line of its own', async () => {
    const { harness, chartId } = await laidOut();
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();

    // Nothing picked out, so nothing to show: a filter over no values matches
    // none, which is the honest reading of "the rows behind nothing".
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount).toBe(0);
    const binding = [...harness.workspace.core.world.bindings.values()].find(
      (entry) => entry.toId === rowsId,
    );
    expect(binding).toMatchObject({ fromId: chartId, meta: { kind: 'rows' } });
  });

  it('fills in as marks are picked out, and empties as they are let go of', async () => {
    const { harness, chartId } = await laidOut();
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    const mark = firstMark(harness, chartId);

    await pick(harness, chartId, [mark]);
    const one = harness.workspace.viewOfTable(rowsId)?.rowCount ?? 0;
    expect(one).toBeGreaterThan(0);

    await pick(harness, chartId, [mark, { series: mark.series, data: mark.data + 1 }]);
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount ?? 0).toBeGreaterThan(one);

    await pick(harness, chartId, []);
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount).toBe(0);
  });

  it('opens the rows behind a cell of a written heatmap, keyed as it said', async () => {
    // The point of the whole stage. Before this, a picked mark meant something
    // only inside the built-in reduction: a heatmap drew beautifully, picked
    // cleanly, and had nothing to open the rows behind it with.
    const { harness, chartId } = await laidOut();
    harness.workspace.setChartDraft(chartId, {
      type: 'custom',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      frames: [
        {
          name: 'cells',
          kind: 'rows',
          columns: ['COUNTRY', 'ORDER_DATE', 'REVENUE'],
          key: 'COUNTRY',
          rowLimit: 30,
        },
      ],
      extra: JSON.stringify({
        xAxis: { type: 'category' },
        yAxis: { type: 'category' },
        visualMap: { min: 0, max: 500 },
        series: [
          {
            type: 'heatmap',
            datasetId: 'cells',
            encode: { x: 'COUNTRY', y: 'ORDER_DATE', value: 'REVENUE' },
          },
        ],
      }),
    });
    await harness.settle();
    const entity = chartEntity(harness, chartId) as TableEntity;
    harness.workspace.chartFor(entity, 400, 240, metrics);
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();

    const mark = firstMark(harness, chartId);
    // The mark says which data set and which row of it, and the data set says
    // which column those rows are found by.
    expect(harness.workspace.markMeaning(chartId, mark)).toMatchObject({
      frame: 'cells',
      column: 'COUNTRY',
    });
    await pick(harness, chartId, [mark]);
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount ?? 0).toBeGreaterThan(0);
  });

  it('picks a cell out and finds nothing to open where nothing keyed the data set', async () => {
    const { harness, chartId } = await laidOut();
    harness.workspace.setChartDraft(chartId, {
      type: 'custom',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
      // No key: pickable, not traceable, and it says so rather than guessing that
      // the first column is the subject.
      frames: [{ name: 'cells', kind: 'rows', columns: ['COUNTRY', 'REVENUE'], rowLimit: 30 }],
      extra: JSON.stringify({
        xAxis: { type: 'category' },
        yAxis: { type: 'value' },
        series: [{ type: 'bar', datasetId: 'cells', encode: { x: 'COUNTRY', y: 'REVENUE' } }],
      }),
    });
    await harness.settle();
    harness.workspace.chartFor(chartEntity(harness, chartId) as TableEntity, 400, 240, metrics);
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    const mark = firstMark(harness, chartId);
    expect(harness.workspace.markMeaning(chartId, mark)).toBeNull();
    await pick(harness, chartId, [mark]);
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount).toBe(0);
  });

  it('shows only the rows of the categories picked out', async () => {
    const { harness, chartId } = await laidOut();
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    const mark = firstMark(harness, chartId);
    await pick(harness, chartId, [mark]);

    const state = harness.workspace.chartState(chartId);
    const wanted = state?.status === 'ready' ? state.data.values[mark.data] : null;
    const request = harness.sourceRequests.at(-1);
    // One predicate over the category's own value, not over its label.
    expect(request?.filter).toEqual({
      column: 'COUNTRY',
      values: [wanted],
      type: expect.objectContaining({ name: 'VARCHAR(64)' }),
    });
  });

  it('asks once for a selection that has not changed', async () => {
    const { harness, chartId } = await laidOut();
    await harness.workspace.openChartRows(chartId);
    await harness.settle();
    await pick(harness, chartId, [firstMark(harness, chartId)]);
    const asked = harness.sourceRequests.length;

    harness.workspace.update(16);
    harness.workspace.update(16);
    await harness.settle();
    expect(harness.sourceRequests.length).toBe(asked);
  });

  it('counts a category once however many of its marks are picked', async () => {
    const { harness, chartId } = await laidOut();
    await harness.workspace.openChartRows(chartId);
    await harness.settle();
    const mark = firstMark(harness, chartId);
    // The rows behind a category are the same rows whichever measure was clicked.
    await pick(harness, chartId, [mark, { series: 1, data: mark.data }]);
    expect(harness.sourceRequests.at(-1)?.filter?.values).toHaveLength(1);
  });

  it('brings the existing table back rather than opening a second', async () => {
    const { harness, chartId } = await laidOut();
    const first = await harness.workspace.openChartRows(chartId);
    const again = await harness.workspace.openChartRows(chartId);
    expect(again).toBe(first);
    expect(harness.workspace.core.session.selection).toEqual([first]);
  });

  it('closes with the chart it drills into', async () => {
    const { harness, chartId } = await laidOut();
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    await harness.workspace.closeTable(chartId);
    expect(harness.workspace.core.world.entities.has(rowsId)).toBe(false);
  });

  it('is driven by the halo button', async () => {
    const { harness, chartId } = await laidOut();
    await harness.workspace.performAction(chartId, 'rows');
    await harness.settle();
    expect(
      [...harness.workspace.core.world.bindings.values()].some(
        (binding) => binding.meta?.['kind'] === 'rows',
      ),
    ).toBe(true);
  });

  it('refuses anything that is not a chart', async () => {
    const { harness, baseId } = await openTable();
    await expect(harness.workspace.openChartRows(baseId)).rejects.toThrow(/No chart/);
  });

  it('empties when the chart it drills into is taken away underneath it', async () => {
    const { harness, chartId } = await laidOut();
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    await pick(harness, chartId, [firstMark(harness, chartId)]);
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount ?? 0).toBeGreaterThan(0);

    // Removed without the workspace's own cascade, which is what an agent
    // editing the document directly would do.
    harness.workspace.core.dispatch({ type: 'RemoveEntities', ids: [chartId] });
    harness.workspace.update(16);
    await harness.settle();
    // Nothing left to name a category, so nothing to show.
    expect(harness.workspace.viewOfTable(rowsId)?.rowCount).toBe(0);
  });

  it('filters without a type when the charted column can no longer be found', async () => {
    const { harness, chartId, entity } = await laidOut();
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    await pick(harness, chartId, [firstMark(harness, chartId)]);

    // The charted column named by a chart whose base has gone: nothing left to
    // say what type it was, so the literal is formed from the value alone.
    harness.workspace.core.dispatch({
      type: 'RemoveEntities',
      ids: [(entity.source as { readonly derivedFrom: EntityId }).derivedFrom],
    });
    harness.workspace.update(16);
    await harness.settle();
    expect(harness.workspace.core.world.entities.has(rowsId)).toBe(true);
  });

  it('keeps its chrome when the rows cannot be read', async () => {
    // The mock refuses to scan millions of rows to filter them, which is exactly
    // the failure a real source has when a drill-down is too expensive.
    const { harness, baseId } = await openTable({ rowCount: 4_000_000 });
    const { tableId: chartId } = await harness.workspace.openChart(baseId);
    await harness.settle();
    harness.workspace.chartFor(chartEntity(harness, chartId) as TableEntity, 400, 240, metrics);
    const rowsId = await harness.workspace.openChartRows(chartId);
    await harness.settle();
    await pick(harness, chartId, [firstMark(harness, chartId)]);

    // Still on the canvas, showing nothing; the next selection tries again.
    expect(harness.workspace.core.world.entities.has(rowsId)).toBe(true);
    expect(harness.workspace.viewOfTable(rowsId)).toBeUndefined();
  });

  it('refuses a chart of a written statement, which has no relation to drill into', async () => {
    const { harness, baseId } = await openTable();
    const { tableId: queryId } = await harness.workspace.openQuery(baseId);
    await harness.workspace.runQuery(queryId, 'SELECT COUNTRY, REVENUE FROM derived_table');
    await harness.settle();
    const { tableId: chartId } = await harness.workspace.openChart(queryId);
    await harness.settle();
    await expect(harness.workspace.openChartRows(chartId)).rejects.toThrow(/stored table/);
  });
});

/**
 * The reason a refusal is shown in words rather than as a code.
 *
 * The codes are the model's and machine-readable; a person reading a greyed-out
 * control wants the *why*. The two a live model actually produced are spelled
 * out, and anything else falls back to the code — a plausible sentence invented
 * for a code nobody has seen would be worse than the code itself.
 */
describe('putting a refusal into words', () => {
  it.each([
    ['ONE_TO_MANY_ATTRIBUTION_UNSUPPORTED', 'which would multiply it'],
    ['NO_SAFE_JOIN_PATH', 'no join path the model can prove'],
    ['SOMETHING_NEW', 'SOMETHING_NEW'],
  ])('says %s as %s', (code, expected) => {
    expect(refusalReason({ code })).toContain(expected);
  });
});
