import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { ChartSpec, TableEntity } from '@panorama/core';
import { buildTableEntity } from '@panorama/core';
import type { ChartDrawList, TableRenderInput } from '@panorama/renderer';
import {
  CHART_ACTIONS,
  CHART_EXPORT_ACTIONS,
  ROWS_ICON,
  DEFAULT_TABLE_THEME,
  EDITING_CHART_ACTIONS,
  actionsForTable,
  buildTableDrawList,
  chartBoxLayout,
  chartNoteHeight,
  connectorIconKind,
} from '@panorama/renderer';
import { TEST_CONNECTION, dataView, testIds } from './fixtures.js';

const SPEC: ChartSpec = {
  type: 'bar',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
};

const chartTable = (mode: 'editing' | 'result' = 'result'): TableEntity =>
  buildTableEntity(testIds(9), {
    source: {
      kind: 'chart',
      connectionId: TEST_CONNECTION,
      spec: SPEC,
      label: 'SALES.ORDERS · Chart',
      derivedFrom: 'table:base' as never,
    },
    mode,
    columns: [],
    size: { width: 420, height: 300 },
  });

/** A picture: one blue triangle and one label. */
const chart: ChartDrawList = {
  polygons: [{ corners: [0, 0, 10, 0, 10, 10, 10, 10], color: [0, 0, 1, 1] }],
  texts: [
    {
      x: 4,
      y: 20,
      width: 40,
      height: 12,
      text: 'Sweden',
      color: [0, 0, 0, 1],
      align: 'left',
      fontSize: 10,
    },
    // A bold run too: ECharts emits them for titles and emphasised labels.
    {
      x: 4,
      y: 34,
      width: 40,
      height: 12,
      text: 'REVENUE',
      color: [0, 0, 0, 1],
      align: 'left',
      fontSize: 10,
      bold: true,
    },
  ],
};

const draw = (
  overrides: Partial<TableRenderInput> = {},
  entity = chartTable(),
): ReturnType<typeof buildTableDrawList> =>
  buildTableDrawList({
    entity,
    layout: computeColumnLayout(entity.columns),
    theme: DEFAULT_TABLE_THEME,
    lod: 'full',
    scrollTop: 0,
    scrollLeft: 0,
    rowCount: 0,
    data: dataView(),
    ...overrides,
  });

describe('drawing a chart in the body of its box', () => {
  it('places the geometry inside the padded body, and nothing else', () => {
    const list = draw({ chart });
    const pad = DEFAULT_TABLE_THEME.editorPadding;
    const top = DEFAULT_TABLE_THEME.titleHeight + pad;
    expect(list.polygons).toHaveLength(1);
    expect(list.polygons[0]?.corners[0]).toBe(pad);
    expect(list.polygons[0]?.corners[1]).toBe(top);
    // No rows, no gutter, no header: a chart takes the body whole.
    expect(list.stats.visibleRows).toBe(0);
    expect(list.stats.visibleColumns).toBe(0);
  });

  it('carries a bold label through as bold', () => {
    expect(draw({ chart }).texts.find((run) => run.text === 'REVENUE')?.bold).toBe(true);
  });

  it('offsets and clips the labels to the same body', () => {
    const list = draw({ chart });
    const label = list.texts.find((run) => run.text === 'Sweden');
    const pad = DEFAULT_TABLE_THEME.editorPadding;
    expect(label?.x).toBe(pad + 4);
    expect(label?.y).toBe(DEFAULT_TABLE_THEME.titleHeight + pad + 20);
    expect(label?.clip?.x).toBe(pad);
  });

  it('says nothing about rows in the title, because a chart has none', () => {
    // "0 rows" beside a picture of a hundred thousand of them is worse than
    // saying nothing; what it read is said under the chart instead.
    expect(draw({ chart }).texts.some((run) => /rows/u.test(run.text))).toBe(false);
  });

  it('carries the note under the chart, and keeps room for it either way', () => {
    const withNote = draw({ chart, chartNote: '100 rows' });
    const withoutNote = draw({ chart });
    const note = withNote.texts.find((run) => run.text === '100 rows');
    expect(note).toBeDefined();
    expect(chartNoteHeight(DEFAULT_TABLE_THEME)).toBeGreaterThan(0);
    // The room is reserved whether or not it is used, so the picture is laid out
    // for the rectangle it is drawn into.
    const clipOf = (list: ReturnType<typeof draw>): number | undefined =>
      list.texts.find((run) => run.text === 'Sweden')?.clip?.height;
    expect(clipOf(withNote)).toBe(clipOf(withoutNote));
  });

  it('colours a caveat differently from a plain statement of fact', () => {
    const plain = draw({ chart, chartNote: '100 rows' });
    const caution = draw({ chart, chartNote: 'first 20,000 rows', chartNoteCaution: true });
    expect(plain.texts.find((run) => run.text === '100 rows')?.color).toBe(
      DEFAULT_TABLE_THEME.typeText,
    );
    expect(caution.texts.find((run) => run.text === 'first 20,000 rows')?.color).toBe(
      DEFAULT_TABLE_THEME.summaryNullBar,
    );
  });

  it('draws the picture beside the controls while it is being set up', () => {
    // The whole point of the split: a chart is configured while being looked at,
    // so the geometry is still drawn — just to the right of where the form goes.
    const editing = draw({ chart }, chartTable('editing'));
    const shown = draw({ chart });
    expect(editing.polygons.length).toBeGreaterThan(0);
    const editingLeft = editing.polygons[0]?.corners[0] ?? 0;
    const shownLeft = shown.polygons[0]?.corners[0] ?? 0;
    expect(editingLeft).toBeGreaterThan(shownLeft);
  });

  it('gives the controls a ground of their own, so the split reads in a headset', () => {
    const editing = draw({ chart }, chartTable('editing'));
    expect(editing.quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.editorBackground)).toBe(
      true,
    );
    expect(
      draw({ chart }).quads.some((quad) => quad.color === DEFAULT_TABLE_THEME.editorBackground),
    ).toBe(false);
  });

  it('gives the whole box to the controls when there is no room to split', () => {
    const narrow = buildTableEntity(testIds(11), {
      source: {
        kind: 'chart',
        connectionId: TEST_CONNECTION,
        spec: SPEC,
        label: 'S.T · Chart',
        derivedFrom: 'table:base' as never,
      },
      mode: 'editing',
      columns: [],
      size: { width: 200, height: 240 },
    });
    // Half a form beside a sliver of chart is neither.
    const layout = chartBoxLayout(200, 240, DEFAULT_TABLE_THEME, true);
    expect(layout.form.width).toBe(200);
    expect(draw({ chart }, narrow).polygons.length).toBeGreaterThan(0);
  });

  it('draws a box with no chart at all as an ordinary empty table', () => {
    const list = draw({}, chartTable());
    expect(list.polygons).toEqual([]);
  });

  it('is a plain impression at far zoom, like every other box', () => {
    const list = draw({ chart, lod: 'summary' });
    expect(list.polygons).toEqual([]);
    expect(list.quads.length).toBeGreaterThan(0);
  });
});

describe('what a chart offers in its halo', () => {
  it('offers its setup, its rows, a file, and the way out', () => {
    expect(actionsForTable(chartTable()).map((spec) => spec.action)).toEqual([
      'edit',
      'rows',
      'export',
      'close',
    ]);
    // The same slot in both directions, as it is for a query box: a pencil to
    // open the setup, and a way back once it is open.
    expect(actionsForTable(chartTable('editing')).map((spec) => spec.action)).toEqual([
      'edit',
      'rows',
      'export',
      'close',
    ]);
    expect(actionsForTable(chartTable('editing'))[0]?.icon).not.toBe(
      actionsForTable(chartTable())[0]?.icon,
    );
  });

  it('offers no further query and no chart of a chart', () => {
    for (const actions of [CHART_ACTIONS, EDITING_CHART_ACTIONS]) {
      expect(actions.map((spec) => spec.action)).not.toContain('sql');
      // Charting a picture is not a thing anybody means.
      expect(actions.map((spec) => spec.action)).not.toContain('chart');
    }
  });

  it("discloses a picture's formats, not a table's", () => {
    const disclosed = actionsForTable(chartTable(), 'export').map((spec) => spec.action);
    expect(disclosed).toEqual(['edit', 'rows', 'export-svg', 'export-png', 'export-pdf', 'close']);
    // In place, like a table's: what was not asked about stays where it was.
    expect(disclosed).not.toContain('export-csv');
    expect(CHART_EXPORT_ACTIONS.map((spec) => spec.action)).toEqual([
      'export-svg',
      'export-png',
      'export-pdf',
    ]);
  });
});

describe('the line to a chart', () => {
  it('carries the charting mark rather than a key', () => {
    const binding = {
      id: 'binding:1' as never,
      kind: 'connector' as const,
      fromId: 'a' as never,
      toId: 'b' as never,
      from: { mode: 'auto' } as const,
      to: { mode: 'auto' } as const,
      directed: true,
      meta: { kind: 'chart' },
    };
    expect(connectorIconKind(binding)).toBe('chart');
    expect(connectorIconKind({ ...binding, meta: { kind: 'rows' } })).toBe('rows');
    expect(connectorIconKind({ ...binding, meta: { kind: 'query' } })).toBe('sql');
    const { meta: _meta, ...unmarked } = binding;
    expect(connectorIconKind(unmarked)).toBe('key');
    expect(ROWS_ICON).not.toBe('');
  });
});
