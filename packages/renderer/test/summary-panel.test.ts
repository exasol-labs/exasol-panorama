import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import type { EntityId } from '@panorama/core';
import type { ColumnSummary } from '@panorama/table';
import type { SummaryPanelColumn, SummaryPanelRequest } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  SUMMARY_PANEL_GAP,
  SUMMARY_PANEL_MAX_WIDTH,
  SUMMARY_PANEL_MIN_WIDTH,
  buildSummaryPanels,
  compactCount,
  formatNullShare,
  formatStatistic,
  layoutSummaryPanels,
} from '@panorama/renderer';

const VARCHAR = dataType('varchar', 'VARCHAR(64)', { size: 64 });
const DOUBLE = dataType('double', 'DOUBLE');

const theme = DEFAULT_TABLE_THEME;

const column = (overrides: Partial<SummaryPanelColumn> = {}): SummaryPanelColumn => ({
  name: 'COUNTRY',
  type: VARCHAR,
  summary: undefined,
  note: undefined,
  ...overrides,
});

const summary = (overrides: Partial<ColumnSummary> = {}): ColumnSummary => ({
  column: 'COUNTRY',
  rows: 100,
  nulls: 0,
  basis: 'exact',
  distinct: 2,
  ...overrides,
});

const request = (overrides: Partial<SummaryPanelRequest> = {}): SummaryPanelRequest => ({
  columnId: 'column:1' as EntityId,
  x: 0,
  width: 240,
  column: column(),
  ...overrides,
});

const draw = (
  requests: readonly SummaryPanelRequest[],
): ReturnType<typeof buildSummaryPanels> & { readonly labels: readonly string[] } => {
  const painted = buildSummaryPanels(layoutSummaryPanels(requests, 400), theme);
  return { ...painted, labels: painted.texts.map((run) => run.text) };
};

describe('shortening a count', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [9_999, '9,999'],
    [10_000, '10K'],
    [125_000, '125K'],
    [3_400_000, '3.4M'],
    [8_200_000_000, '8.2B'],
    [1.5e12, '1.5T'],
  ])('shortens %s', (value, expected) => {
    expect(compactCount(value)).toBe(expected);
  });
});

describe('saying how much is missing', () => {
  it.each([
    [0, 0, 'no rows'],
    [0, 100, 'no nulls'],
    [100, 100, 'all null'],
    [12, 100, '12% null'],
    [1, 1_000, '<1% null'],
  ])('reports %s of %s', (nulls, rows, expected) => {
    // Words where words are clearer: "no nulls" is what someone wants to read,
    // not "0% null", and a rounded "0%" would be a lie about a column that has
    // one missing value in a thousand.
    expect(formatNullShare(nulls, rows)).toBe(expected);
  });
});

describe('showing a figure', () => {
  it.each([
    [0, '0'],
    [3, '3'],
    [3.14159, '3.14'],
    [12_345.6, '12,345.6'],
    [1e9, '1.00e+9'],
    [0.000_012, '1.20e-5'],
  ])('formats %s', (value, expected) => {
    expect(formatStatistic(value)).toBe(expected);
  });
});

describe('laying panels out under their columns', () => {
  it('hangs a panel below the table, aligned to its column', () => {
    const [panel] = layoutSummaryPanels([request({ x: 120 })], 400);
    expect(panel?.x).toBe(120);
    expect(panel?.y).toBe(400 + SUMMARY_PANEL_GAP);
  });

  it('widens a narrow column and narrows a very wide one', () => {
    const narrow = layoutSummaryPanels([request({ width: 40 })], 0);
    const wide = layoutSummaryPanels([request({ width: 900 })], 0);
    expect(narrow[0]?.width).toBe(SUMMARY_PANEL_MIN_WIDTH);
    expect(wide[0]?.width).toBe(SUMMARY_PANEL_MAX_WIDTH);
  });

  it('pushes a panel along rather than letting it cover its neighbour', () => {
    const panels = layoutSummaryPanels(
      [
        request({ columnId: 'column:a' as EntityId, x: 0, width: 60 }),
        request({ columnId: 'column:b' as EntityId, x: 70, width: 60 }),
      ],
      0,
    );
    const [first, second] = panels;
    expect(first?.x).toBe(0);
    // Its own column starts at 70, but the panel before it reaches past that.
    expect(second?.x).toBe(SUMMARY_PANEL_MIN_WIDTH + SUMMARY_PANEL_GAP);
  });

  it('lays them out left to right whatever order they arrive in', () => {
    const panels = layoutSummaryPanels(
      [
        request({ columnId: 'column:right' as EntityId, x: 400, width: 60 }),
        request({ columnId: 'column:left' as EntityId, x: 0, width: 60 }),
      ],
      0,
    );
    expect(panels.map((panel) => panel.columnId)).toEqual(['column:left', 'column:right']);
  });

  it('goes above the table rather than onto the one parked below it', () => {
    const below = { x: 0, y: 420, width: 600, height: 300 };
    const [panel] = layoutSummaryPanels([request({ x: 0, width: 60 })], 400, [below]);
    // Hanging upwards from the top edge, so the row lines up along the edge it
    // belongs to rather than along its own ragged top.
    expect(panel?.y).toBe(-SUMMARY_PANEL_GAP - (panel?.height ?? 0));
  });

  it('stays below when there is room below', () => {
    const elsewhere = { x: 2_000, y: 2_000, width: 100, height: 100 };
    const [panel] = layoutSummaryPanels([request()], 400, [elsewhere]);
    expect(panel?.y).toBe(400 + SUMMARY_PANEL_GAP);
  });

  it('goes below when both sides are taken, which is where it belongs', () => {
    const above = { x: 0, y: -400, width: 600, height: 380 };
    const below = { x: 0, y: 420, width: 600, height: 300 };
    const [panel] = layoutSummaryPanels([request()], 400, [above, below]);
    expect(panel?.y).toBe(400 + SUMMARY_PANEL_GAP);
  });

  it('only counts a table the panels would actually reach', () => {
    // Beside the table, not under it: nothing to get out of the way of.
    const beside = { x: 900, y: 420, width: 300, height: 300 };
    const [panel] = layoutSummaryPanels([request({ x: 0, width: 60 })], 400, [beside]);
    expect(panel?.y).toBe(400 + SUMMARY_PANEL_GAP);
  });

  it('is as tall as what it has to say', () => {
    const waiting = layoutSummaryPanels([request()], 0)[0];
    const full = layoutSummaryPanels(
      [
        request({
          column: column({
            summary: summary({
              frequencies: [
                { value: 'DE', count: 60 },
                { value: 'US', count: 40 },
              ],
              frequenciesComplete: true,
            }),
          }),
        }),
      ],
      0,
    )[0];
    expect(full?.height).toBeGreaterThan(waiting?.height ?? 0);
  });
});

describe('a panel with no answer yet', () => {
  it('says it is reading rather than showing an empty chart', () => {
    const { labels } = draw([request()]);
    expect(labels).toEqual(['COUNTRY', 'VARCHAR(64)', 'Reading…']);
  });

  it('says why instead, when there is a reason', () => {
    const { labels } = draw([request({ column: column({ note: 'No statistics here' }) })]);
    expect(labels).toContain('No statistics here');
  });
});

describe('a panel drawing a set of named values', () => {
  const named = summary({
    nulls: 10,
    distinct: 3,
    min: 'DE',
    max: 'US',
    frequencies: [
      { value: 'DE', count: 50 },
      { value: 'US', count: 30 },
      { value: null, count: 10 },
    ],
    frequenciesComplete: true,
  });

  it('names each value, bars it and counts it', () => {
    const { labels } = draw([request({ column: column({ summary: named }) })]);
    expect(labels).toContain('DE');
    expect(labels).toContain('50');
    // Null formats to nothing, so it is named rather than left as a bare bar.
    expect(labels).toContain('(null)');
    expect(labels).toContain('10% null');
    expect(labels).toContain('3 distinct');
  });

  it('leaves out the extremes the bars have already named', () => {
    const { labels } = draw([request({ column: column({ summary: named }) })]);
    expect(labels).not.toContain('range');
  });

  it('names them when the bars are only the top few', () => {
    const { labels } = draw([
      request({
        column: column({
          summary: summary({
            min: 'AD',
            max: 'ZW',
            distinct: 240,
            frequencies: [{ value: 'DE', count: 50 }],
            frequenciesComplete: false,
          }),
        }),
      }),
    ]);
    expect(labels).toContain('range');
    expect(labels).toContain('AD … ZW');
  });

  it('shows one value rather than a range where both ends are the same', () => {
    const { labels } = draw([
      request({
        column: column({
          summary: summary({
            min: 'DE',
            max: 'DE',
            distinct: 40,
            frequencies: [{ value: 'DE', count: 50 }],
            frequenciesComplete: false,
          }),
        }),
      }),
    ]);
    expect(labels).toContain('DE');
    expect(labels).not.toContain('DE … DE');
  });

  it('tells the empty string apart from a missing value', () => {
    const { labels } = draw([
      request({
        column: column({
          summary: summary({
            frequencies: [
              { value: '', count: 5 },
              { value: null, count: 5 },
            ],
            frequenciesComplete: true,
          }),
        }),
      }),
    ]);
    expect(labels).toContain('(empty)');
    expect(labels).toContain('(null)');
  });

  it('draws a track behind every bar, so a short bar still reads as a share', () => {
    const { quads } = draw([request({ column: column({ summary: named }) })]);
    const tracks = quads.filter((quad) => quad.color === theme.summaryBarTrack);
    // One per value, plus the one behind the null share at the top.
    expect(tracks).toHaveLength(4);
    expect(quads.filter((quad) => quad.color === theme.summaryBar)).toHaveLength(3);
  });

  it('gives a bar to a value nobody has, rather than a chart of nothing', () => {
    const { quads } = draw([
      request({
        column: column({
          summary: summary({
            nulls: 100,
            distinct: 1,
            frequencies: [{ value: 'DE', count: 0 }],
            frequenciesComplete: true,
          }),
        }),
      }),
    ]);
    expect(quads.filter((quad) => quad.color === theme.summaryBar)).toHaveLength(0);
  });
});

describe('a panel drawing a distribution', () => {
  const spread = summary({
    column: 'REVENUE',
    distinct: 900,
    min: 0,
    max: 120,
    mean: 41.5,
    bins: [
      { from: 0, to: 40, count: 10 },
      { from: 40, to: 80, count: 0 },
      { from: 80, to: 120, count: 30 },
    ],
  });

  it('draws a bar per range and labels the ends', () => {
    const { labels, quads } = draw([
      request({ column: column({ name: 'REVENUE', type: DOUBLE, summary: spread }) }),
    ]);
    expect(quads.filter((quad) => quad.color === theme.summaryBar)).toHaveLength(2);
    expect(labels).toContain('0');
    expect(labels).toContain('120');
    expect(labels).toContain('mean');
    expect(labels).toContain('41.5');
  });

  it('keeps a place for an empty range, because a gap is part of the shape', () => {
    const { quads } = draw([
      request({ column: column({ name: 'REVENUE', type: DOUBLE, summary: spread }) }),
    ]);
    const tracks = quads.filter((quad) => quad.color === theme.summaryBarTrack);
    // Three ranges plus the null-share bar: the empty middle one still has a
    // sliver of track under it.
    expect(tracks).toHaveLength(4);
  });

  it('does not repeat the range it has already labelled', () => {
    const { labels } = draw([
      request({ column: column({ name: 'REVENUE', type: DOUBLE, summary: spread }) }),
    ]);
    expect(labels).not.toContain('range');
  });

  it('draws no bars at all when every range is empty', () => {
    const { quads } = draw([
      request({
        column: column({
          type: DOUBLE,
          summary: summary({ nulls: 100, bins: [{ from: 0, to: 1, count: 0 }] }),
        }),
      }),
    ]);
    expect(quads.filter((quad) => quad.color === theme.summaryBar)).toHaveLength(0);
  });
});

describe('a panel of numbers', () => {
  const revenue = summary({
    column: 'REVENUE',
    distinct: 900,
    min: -40,
    max: 120,
    mean: 41.5,
    sum: 4_150,
    stdDev: 12.25,
    bins: [{ from: -40, to: 120, count: 100 }],
  });

  /**
   * One line each, rather than the single `range` a column of words gets. Which
   * end is which stops being obvious as soon as the values are negative, and
   * these figures are read down a row of panels as a block.
   */
  it('names every figure it has', () => {
    const { labels } = draw([
      request({ column: column({ name: 'REVENUE', type: DOUBLE, summary: revenue }) }),
    ]);
    expect(labels).toEqual(
      expect.arrayContaining(['min', 'max', 'sum', 'mean', 'std dev', '-40', '120', '12.25']),
    );
    expect(labels).not.toContain('range');
  });

  /**
   * The min sits directly under a histogram axis labelled with the same number.
   * Two renderings of one figure, one above the other, reads as a bug.
   */
  it('writes its ends the same way the axis above them does', () => {
    const wide = summary({
      column: 'REVENUE',
      distinct: 900,
      min: 32_547.09,
      max: 32_682.72,
      sum: 3_261_490.5,
      bins: [{ from: 32_547.09, to: 32_682.72, count: 100 }],
    });
    const { labels } = draw([
      request({ column: column({ name: 'REVENUE', type: DOUBLE, summary: wide }) }),
    ]);
    // Once for the axis and once for the figure, and the same both times.
    expect(labels.filter((text) => text === '32,547.09')).toHaveLength(2);
    expect(labels).not.toContain('32547.09');
  });

  it('says nothing about a deviation it does not have', () => {
    const { labels } = draw([
      request({
        column: column({
          name: 'REVENUE',
          type: DOUBLE,
          // One row: a sum and a mean, but nothing to deviate from.
          summary: summary({ rows: 1, distinct: 1, min: 7, max: 7, mean: 7, sum: 7 }),
        }),
      }),
    ]);
    expect(labels).toContain('sum');
    expect(labels).not.toContain('std dev');
  });

  it('gives a column of words a range and no arithmetic', () => {
    const { labels } = draw([
      request({
        column: column({
          type: VARCHAR,
          summary: summary({ distinct: 40, min: 'Denmark', max: 'Poland' }),
        }),
      }),
    ]);
    expect(labels).toContain('range');
    expect(labels).toContain('Denmark … Poland');
    for (const figure of ['min', 'max', 'sum', 'mean', 'std dev']) {
      expect(labels).not.toContain(figure);
    }
  });
});

describe('a panel that knows it is not looking at everything', () => {
  it('says so, in the colour reserved for what must not be skimmed past', () => {
    const { labels, texts } = draw([
      request({
        column: column({
          summary: summary({
            basis: 'sampled',
            rows: 200_000,
            frequencies: [{ value: 'DE', count: 1 }],
            frequenciesComplete: true,
          }),
        }),
      }),
    ]);
    expect(labels).toContain('sampled');
    expect(labels).toContain('first 200K rows');
    const warning = texts.find((run) => run.text === 'sampled');
    expect(warning?.color).toBe(theme.summaryNullBar);
  });

  it('reports no distinct count rather than a count of what fit', () => {
    const { labels } = draw([
      request({ column: column({ summary: summary({ distinct: null }) }) }),
    ]);
    expect(labels).toContain('many values');
  });
});

describe('a panel that has nothing to chart', () => {
  it('shows the counts for a column that is entirely null', () => {
    const { labels, quads } = draw([
      request({ column: column({ summary: summary({ nulls: 100, distinct: 0 }) }) }),
    ]);
    expect(labels).toContain('all null');
    expect(labels).toContain('0 distinct');
    expect(quads.filter((quad) => quad.color === theme.summaryBar)).toHaveLength(0);
  });

  it('draws no null bar for a column with no rows in it', () => {
    const { labels, quads } = draw([
      request({ column: column({ summary: summary({ rows: 0, nulls: 0, distinct: 0 }) }) }),
    ]);
    expect(labels).toContain('no rows');
    expect(quads.filter((quad) => quad.color === theme.summaryNullBar)).toHaveLength(0);
  });
});

describe('the panel surface', () => {
  it('is its own surface, bordered, and clips what it holds', () => {
    const { quads, texts } = draw([request()]);
    expect(quads[0]?.color).toBe(theme.summaryPanelBorder);
    expect(quads[1]?.color).toBe(theme.summaryPanelBackground);
    // Every glyph is clipped to the panel, so a long value cannot run out
    // across the canvas.
    for (const run of texts) {
      expect(run.clip).toEqual({
        x: quads[0]?.x,
        y: quads[0]?.y,
        width: quads[0]?.width,
        height: quads[0]?.height,
      });
    }
  });

  it('draws nothing at all when nothing is picked out', () => {
    expect(draw([])).toMatchObject({ quads: [], texts: [] });
  });
});
