import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import { buildTableEntity } from '@panorama/core';
import type { ActionSpec, HaloButton } from '@panorama/renderer';
import {
  CHART_ACTIONS,
  CHART_EXPORT_ACTIONS,
  EXPORT_FORMAT_ACTIONS,
  DERIVED_TABLE_ACTIONS,
  EDITING_CHART_ACTIONS,
  EDITING_TABLE_ACTIONS,
  DEFAULT_TABLE_THEME,
  actionsForTable,
  EMPTY_HALO,
  TABLE_ACTIONS,
  computeHalo,
  haloButtonAt,
  tableMetrics,
  withinHalo,
} from '@panorama/renderer';
import { TEST_CONNECTION, makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds());
const CLOSE_SPEC: ActionSpec = {
  action: 'close',
  icon: '×',
  label: 'Close table',
  tone: 'destructive',
  place: 'corner',
};
const EXPORT_SPEC: ActionSpec = {
  action: 'export',
  icon: '↓',
  label: 'Export',
  tone: 'neutral',
  place: 'top',
};
const EDIT_SPEC: ActionSpec = {
  action: 'edit',
  icon: '✎',
  label: 'Edit',
  tone: 'neutral',
  place: 'top',
};

const metrics = tableMetrics(table, computeColumnLayout(table.columns), 1_000, DEFAULT_TABLE_THEME);

const buttonFor = (halo: ReturnType<typeof computeHalo>, action: string): HaloButton => {
  const button = halo.buttons.find((candidate) => candidate.action === action);
  if (button === undefined) throw new Error(`expected a ${action} button`);
  return button;
};

describe('computeHalo', () => {
  const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);

  it('offers export, charting, query and close buttons', () => {
    expect(halo.buttons.map((button) => button.action)).toEqual([
      'chart',
      'export',
      'sql',
      'close',
    ]);
    expect(buttonFor(halo, 'close').label).toBe('Close table');
    expect(buttonFor(halo, 'close').tone).toBe('destructive');
    expect(halo.buttons[0]?.tone).toBe('neutral');
    expect(TABLE_ACTIONS).toHaveLength(4);
    // Every button in the resting halo is square: the two lines meet at the
    // corner, so a column of a different width to the row reads as lopsided.
    expect(halo.buttons.every((button) => button.width === button.size)).toBe(true);
  });

  it('puts close on the corner, diagonally out from the table', () => {
    const close = buttonFor(halo, 'close');
    // Past the right edge and above the top one: in neither line of buttons,
    // because it is the one action that is about the box as a whole.
    expect(close.x).toBeGreaterThan(metrics.width);
    expect(close.y + close.size).toBeLessThanOrEqual(0);
    expect(close.place).toBe('corner');
  });

  it('runs the buttons that make a new box down the right edge', () => {
    const close = buttonFor(halo, 'close');
    const side = halo.buttons.filter((button) => button.place === 'side');
    expect(side.map((button) => button.action)).toEqual(['chart', 'sql']);
    // Under the corner, in a column, in the order they were declared.
    for (const [index, button] of side.entries()) {
      expect(button.x).toBeCloseTo(close.x, 6);
      expect(button.y).toBeCloseTo(
        close.y + (index + 1) * (close.size + DEFAULT_TABLE_THEME.haloGap),
        6,
      );
    }
    // Beside the table rather than over it, so a column longer than the box has
    // room to be one without covering a single cell.
    expect(Math.min(...side.map((button) => button.x))).toBeGreaterThanOrEqual(metrics.width);
  });

  it('runs the buttons that act on this box along the top', () => {
    const close = buttonFor(halo, 'close');
    const top = halo.buttons.filter((button) => button.place === 'top');
    expect(top.map((button) => button.action)).toEqual(['export']);
    for (const button of top) {
      expect(button.y).toBeCloseTo(close.y, 6);
      // Above the table, so they never cover data either.
      expect(button.y + button.size).toBeLessThanOrEqual(0);
      // And short of the corner, which is not part of the row.
      expect(button.x + button.width).toBeLessThanOrEqual(close.x);
    }
  });

  it('keeps a constant screen size as the camera zooms', () => {
    const far = computeHalo(metrics, DEFAULT_TABLE_THEME, 0.25);
    expect(far.buttons[0]?.size).toBeCloseTo((halo.buttons[0]?.size ?? 0) * 4, 6);
    // Still hung on the same corner of the same table at any zoom: only the
    // distance out from it grows, because that is measured in screen pixels too.
    expect(buttonFor(far, 'close').x).toBeGreaterThan(metrics.width);
    expect(buttonFor(far, 'close').y + buttonFor(far, 'close').size).toBeLessThanOrEqual(0);
  });

  it('survives a degenerate scale', () => {
    expect(Number.isFinite(computeHalo(metrics, DEFAULT_TABLE_THEME, 0).buttons[0]?.size)).toBe(
      true,
    );
  });

  it('grows the top row leftwards, away from the corner', () => {
    // Adding an action must not shift the buttons already there: the row is
    // anchored where it meets the corner, not where it begins.
    const one = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [EXPORT_SPEC, CLOSE_SPEC]);
    const two = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [EDIT_SPEC, EXPORT_SPEC, CLOSE_SPEC]);
    expect(buttonFor(two, 'export').x).toBeCloseTo(buttonFor(one, 'export').x, 6);
    expect(buttonFor(two, 'edit').x).toBeLessThan(buttonFor(two, 'export').x);
    expect(buttonFor(two, 'export').x - buttonFor(two, 'edit').x).toBeCloseTo(
      DEFAULT_TABLE_THEME.haloButtonSize + DEFAULT_TABLE_THEME.haloGap,
      6,
    );
  });

  it('never starts left of the table, even when the row is wider', () => {
    const narrow = { ...metrics, width: 10 };
    expect(
      computeHalo(narrow, DEFAULT_TABLE_THEME, 1, actionsForTable(table, 'export')).buttons[0],
    ).toBeDefined();
    const row = computeHalo(
      narrow,
      DEFAULT_TABLE_THEME,
      1,
      actionsForTable(table, 'export'),
    ).buttons.filter((button) => button.place === 'top');
    expect(Math.min(...row.map((button) => button.x))).toBe(0);
  });

  it('reports bounds covering both lines and the corner', () => {
    const close = buttonFor(halo, 'close');
    const chart = buttonFor(halo, 'chart');
    const sql = buttonFor(halo, 'sql');
    expect(halo.bounds.y).toBeCloseTo(close.y, 6);
    // The column shares its inner edge with the corner and with the table's own
    // right edge, so a wider button in it reaches further out — and the bounds
    // are of the halo, not of its narrowest part.
    expect(chart.x).toBeCloseTo(close.x, 6);
    expect(halo.bounds.x + halo.bounds.width).toBeCloseTo(chart.x + chart.width, 6);
    expect(halo.bounds.y + halo.bounds.height).toBeCloseTo(sql.y + sql.size, 6);
  });

  it('ignores a width declared on a side action', () => {
    // A word can widen the row without spoiling it. Down the side it would make
    // the column ragged, and wider than the row it turns the corner from.
    const wide = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [
      CLOSE_SPEC,
      { ...EXPORT_SPEC, place: 'side', width: 68 },
    ]);
    expect(wide.buttons.every((button) => button.width === button.size)).toBe(true);
    // Along the top the same declaration is honoured.
    const row = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [
      CLOSE_SPEC,
      { ...EXPORT_SPEC, width: 68 },
    ]);
    expect(buttonFor(row, 'export').width).toBe(68);
  });

  it('gives every action exactly one mark', () => {
    // A mark is typed or it is drawn, never both and never neither: two ways to
    // say what a button means is two things to keep in step.
    for (const spec of [
      ...TABLE_ACTIONS,
      ...DERIVED_TABLE_ACTIONS,
      ...EDITING_TABLE_ACTIONS,
      ...CHART_ACTIONS,
      ...EDITING_CHART_ACTIONS,
      ...EXPORT_FORMAT_ACTIONS,
      ...CHART_EXPORT_ACTIONS,
    ]) {
      expect((spec.icon === undefined ? 0 : 1) + (spec.shape === undefined ? 0 : 1)).toBe(1);
    }
    // The charting mark is the drawn one, and it reaches the button that way.
    expect(buttonFor(halo, 'chart').shape).toBe('bars');
    expect(buttonFor(halo, 'chart').icon).toBeUndefined();
    expect(buttonFor(halo, 'close').icon).toBe('×');
    expect(buttonFor(halo, 'close').shape).toBeUndefined();
  });

  it('is empty when there are no actions', () => {
    expect(computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [])).toBe(EMPTY_HALO);
  });
});

describe('haloButtonAt', () => {
  const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);
  const button = buttonFor(halo, 'close');

  it('finds the button under a point', () => {
    expect(haloButtonAt(halo, button.x + 1, button.y + 1)?.action).toBe('close');
    expect(
      haloButtonAt(halo, button.x + button.size - 0.1, button.y + button.size - 0.1)?.action,
    ).toBe('close');
    // Its neighbours in both lines are their own actions, not this one twice.
    expect(haloButtonAt(halo, buttonFor(halo, 'export').x + 1, button.y + 1)?.action).toBe(
      'export',
    );
    expect(haloButtonAt(halo, button.x + 1, buttonFor(halo, 'chart').y + 1)?.action).toBe('chart');
  });

  it('misses outside the button', () => {
    expect(haloButtonAt(halo, button.x - 1, button.y + 1)).toBeNull();
    expect(haloButtonAt(halo, button.x + button.width, button.y + 1)).toBeNull();
    expect(haloButtonAt(halo, button.x + 1, button.y - 1)).toBeNull();
    // Between the corner and the button below it there is a gap and nothing else.
    expect(haloButtonAt(halo, button.x + 1, button.y + button.size + 1)).toBeNull();
    expect(haloButtonAt(EMPTY_HALO, 0, 0)).toBeNull();
  });

  it('leaves no two buttons on the same ground', () => {
    // Whole-halo rather than neighbour-by-neighbour, because the halo turns a
    // corner: a check that only compares along one axis cannot see a column
    // landing on the row it hangs from.
    const buttons = computeHalo(
      metrics,
      DEFAULT_TABLE_THEME,
      1,
      actionsForTable(table, 'export'),
    ).buttons;
    for (const a of buttons) {
      for (const b of buttons) {
        if (a === b) continue;
        const apart =
          a.x + a.width <= b.x ||
          b.x + b.width <= a.x ||
          a.y + a.size <= b.y ||
          b.y + b.size <= a.y;
        expect(apart).toBe(true);
      }
    }
  });
});

describe('withinHalo', () => {
  const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);
  const close = buttonFor(halo, 'close');
  const sql = buttonFor(halo, 'sql');

  it('spans the whole table width, not just the buttons', () => {
    // The pointer leaves the table wherever it likes. If the band were only as
    // wide as the buttons, any other path out would deactivate the table and
    // the buttons would vanish before they could be reached.
    expect(withinHalo(halo, 0, -1)).toBe(true);
    expect(withinHalo(halo, metrics.width / 2, -1)).toBe(true);
    expect(withinHalo(halo, metrics.width - 2, -1)).toBe(true);
  });

  it('covers the gap and the buttons, up to the table edge', () => {
    expect(withinHalo(halo, metrics.width - 2, halo.bounds.y)).toBe(true);
    expect(withinHalo(halo, metrics.width - 2, -0.5)).toBe(true);
  });

  it('turns the corner, so the column can be reached from the row', () => {
    // Every step of the journey: out to the corner above the right edge, and
    // then down the outside of the table to the last button in the column.
    expect(withinHalo(halo, close.x + close.width / 2, close.y + close.size / 2)).toBe(true);
    expect(withinHalo(halo, close.x + close.width / 2, 0)).toBe(true);
    expect(withinHalo(halo, metrics.width, sql.y + sql.size / 2)).toBe(true);
    expect(withinHalo(halo, sql.x + sql.width / 2, sql.y + sql.size / 2)).toBe(true);
  });

  it('excludes the table itself and anything beyond the bands', () => {
    // Inside the table is its own space; its hit testing owns that, and the
    // band is tried first — so a band that reached in would silence those cells.
    expect(withinHalo(halo, metrics.width / 2, 0)).toBe(false);
    expect(withinHalo(halo, metrics.width / 2, 1)).toBe(false);
    expect(withinHalo(halo, metrics.width - 1, sql.y + sql.size / 2)).toBe(false);
    expect(withinHalo(halo, metrics.width / 2, halo.bounds.y - 20)).toBe(false);
    expect(withinHalo(halo, -50, -1)).toBe(false);
    expect(withinHalo(halo, close.x + close.width + 40, -1)).toBe(false);
    // Below the column there is nothing left to reach for.
    expect(withinHalo(halo, close.x, sql.y + sql.size + 20)).toBe(false);
    expect(withinHalo(EMPTY_HALO, 0, 0)).toBe(false);
  });

  it('has no side band when nothing hangs below the corner', () => {
    // A halo of one corner button is all corner: the band down the right edge
    // would be a strip of nothing, and matches nothing.
    const cornerOnly = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [CLOSE_SPEC, EXPORT_SPEC]);
    expect(withinHalo(cornerOnly, metrics.width + 2, 10)).toBe(false);
    expect(withinHalo(cornerOnly, metrics.width + 2, -10)).toBe(true);
  });
});

describe('actionsForTable', () => {
  const ids = testIds(11);
  const chartTable = buildTableEntity(testIds(12), {
    source: {
      kind: 'chart',
      connectionId: TEST_CONNECTION,
      spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
      label: 'SALES.ORDERS · Chart',
      derivedFrom: ids.entity('table'),
    },
    mode: 'result',
    columns: [],
  });
  const derived = buildTableEntity(ids, {
    source: {
      kind: 'query',
      connectionId: TEST_CONNECTION,
      sql: 'SELECT 1',
      label: 'SALES.ORDERS · SQL',
    },
    mode: 'result',
    columns: [],
  });

  it('offers editing only where there is a statement to edit', () => {
    expect(actionsForTable(derived).map((spec) => spec.action)).toEqual([
      'edit',
      'chart',
      'export',
      'sql',
      'close',
    ]);
    // A stored relation has no statement, so no pencil.
    expect(actionsForTable(table).map((spec) => spec.action)).toEqual([
      'chart',
      'export',
      'sql',
      'close',
    ]);
  });

  it('replaces the export button with the formats when it is expanded', () => {
    expect(actionsForTable(table, 'export').map((spec) => spec.action)).toEqual([
      'chart',
      'export-csv',
      'export-xlsx',
      'export-parquet',
      'sql',
      'close',
    ]);
    // In place: everything that was not asked about stays where it was.
    expect(actionsForTable(derived, 'export').map((spec) => spec.action)).toEqual([
      'edit',
      'chart',
      'export-csv',
      'export-xlsx',
      'export-parquet',
      'sql',
      'close',
    ]);
    // Expanding something the table does not offer changes nothing.
    expect(actionsForTable(table, 'close')).toBe(actionsForTable(table));
    expect(actionsForTable(table, null)).toBe(TABLE_ACTIONS);
  });

  it('spells the formats out on wider buttons', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, actionsForTable(table, 'export'));
    const formats = halo.buttons.filter((button) => button.action.startsWith('export-'));
    expect(formats.map((button) => button.icon)).toEqual(['CSV', 'XLSX', 'PARQUET']);
    expect(formats.every((button) => button.width > button.size)).toBe(true);
    // Laid out from the widths, so a word never overlaps its neighbour, and the
    // row still ends where it meets the corner.
    for (let index = 1; index < formats.length; index += 1) {
      const previous = formats[index - 1];
      const current = formats[index];
      if (previous === undefined || current === undefined) throw new Error('expected buttons');
      expect(current.x).toBeCloseTo(previous.x + previous.width + DEFAULT_TABLE_THEME.haloGap, 6);
    }
    const close = buttonFor(halo, 'close');
    expect((formats.at(-1)?.x ?? 0) + (formats.at(-1)?.width ?? 0)).toBeCloseTo(
      close.x - DEFAULT_TABLE_THEME.haloGap,
      6,
    );
  });

  it('hit-tests a wide button across its whole width', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, actionsForTable(table, 'export'));
    const parquet = halo.buttons.find((button) => button.action === 'export-parquet');
    if (parquet === undefined) throw new Error('expected a Parquet button');
    expect(haloButtonAt(halo, parquet.x + parquet.width - 0.1, parquet.y + 1)?.action).toBe(
      'export-parquet',
    );
    expect(haloButtonAt(halo, parquet.x + parquet.width, parquet.y + 1)?.action).not.toBe(
      'export-parquet',
    );
  });

  it('keeps the halo the same shape while the statement is open', () => {
    const editing = { ...derived, mode: 'editing' as const };
    // Same slots, same order — only the first one's face changes.
    expect(actionsForTable(editing).map((spec) => spec.action)).toEqual(
      actionsForTable(derived).map((spec) => spec.action),
    );
    expect(actionsForTable(editing)[0]?.icon).not.toBe(actionsForTable(derived)[0]?.icon);
    expect(actionsForTable(editing)).toBe(EDITING_TABLE_ACTIONS);
  });

  it('gives every set exactly one corner, and it is close', () => {
    for (const actions of [
      TABLE_ACTIONS,
      DERIVED_TABLE_ACTIONS,
      EDITING_TABLE_ACTIONS,
      CHART_ACTIONS,
      EDITING_CHART_ACTIONS,
    ]) {
      const corners = actions.filter((spec) => spec.place === 'corner');
      expect(corners.map((spec) => spec.action)).toEqual(['close']);
      expect(corners[0]?.tone).toBe('destructive');
      expect(
        actions.filter((spec) => spec.place !== 'corner').every((s) => s.tone === 'neutral'),
      ).toBe(true);
    }
    expect(DERIVED_TABLE_ACTIONS[0]?.action).toBe('edit');
  });

  it('sends every action that makes a new box to the right edge', () => {
    // The rule, stated once: a button belongs on the side exactly when pressing
    // it leaves a new box joined to this one by a line.
    const creates: readonly string[] = ['sql', 'chart', 'rows'];
    for (const actions of [
      TABLE_ACTIONS,
      DERIVED_TABLE_ACTIONS,
      EDITING_TABLE_ACTIONS,
      CHART_ACTIONS,
      EDITING_CHART_ACTIONS,
      ...[table, chartTable].map((entity) => actionsForTable(entity, 'export')),
    ]) {
      for (const spec of actions) {
        expect(spec.place).toBe(
          spec.action === 'close' ? 'corner' : creates.includes(spec.action) ? 'side' : 'top',
        );
      }
    }
  });

  it('lays the derived halo out in two lines around the corner', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, actionsForTable(derived));
    expect(halo.buttons).toHaveLength(5);
    const close = buttonFor(halo, 'close');
    // The pencil and the export button along the top; the chart and the query
    // button down the side; close on the corner between them.
    expect(halo.buttons.filter((button) => button.y === close.y).map((b) => b.action)).toEqual([
      'edit',
      'export',
      'close',
    ]);
    expect(halo.buttons.filter((button) => button.x === close.x).map((b) => b.action)).toEqual([
      'chart',
      'sql',
      'close',
    ]);
  });
});
