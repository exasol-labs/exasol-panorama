import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { TableHitInput } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  computeHalo,
  hitTestTable,
  rowNumberGutterWidth,
  tableMetrics,
  toTableLocal,
} from '@panorama/renderer';
import { makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds(), { position: { x: 100, y: 50, z: 0 } });
const layout = computeColumnLayout(table.columns);
const HEADER = table.view.headerHeight;
const TITLE = DEFAULT_TABLE_THEME.titleHeight;
const ROWS = 1_000_000;
/**
 * Derived rather than assumed: the gutter is as wide as the longest row number
 * it has to show, so a million rows do not get the same gutter as a hundred.
 */
const GUTTER = rowNumberGutterWidth(ROWS, DEFAULT_TABLE_THEME);

const input = (overrides: Partial<TableHitInput> = {}): TableHitInput => ({
  entity: table,
  layout,
  theme: DEFAULT_TABLE_THEME,
  scrollTop: 0,
  scrollLeft: 0,
  rowCount: ROWS,
  ...overrides,
});

describe('toTableLocal', () => {
  it('subtracts the entity origin', () => {
    expect(toTableLocal(table, 150, 90)).toEqual({ x: 50, y: 40 });
  });
});

describe('hitTestTable', () => {
  it('returns null outside the table', () => {
    expect(hitTestTable(input(), -1, 10)).toBeNull();
    expect(hitTestTable(input(), 10, -1)).toBeNull();
    expect(hitTestTable(input(), 601, 10)).toBeNull();
    expect(hitTestTable(input(), 10, 401)).toBeNull();
  });

  it('finds the eight resize handles at the border', () => {
    const cases: ReadonlyArray<readonly [number, number, string]> = [
      [1, 1, 'top-left'],
      [599, 1, 'top-right'],
      [1, 399, 'bottom-left'],
      [599, 399, 'bottom-right'],
      [300, 1, 'top'],
      [300, 399, 'bottom'],
      [1, 200, 'left'],
      [599, 200, 'right'],
    ];
    for (const [x, y, handle] of cases) {
      const hit = hitTestTable(input(), x, y);
      expect(hit).toMatchObject({ kind: 'resize', handle });
      expect(hit?.cursor).toMatch(/resize$/);
    }
  });

  it('widens the grab zone when the camera is zoomed out', () => {
    expect(hitTestTable(input(), 300, 20)).toMatchObject({ kind: 'title' });
    expect(hitTestTable(input({ scale: 0.25 }), 300, 20)).toMatchObject({ kind: 'resize' });
  });

  it('treats the title bar as the move handle', () => {
    const hit = hitTestTable(input(), 300, TITLE - 1);
    expect(hit).toMatchObject({ kind: 'title', cursor: 'grab', tableId: table.id });
  });

  it('finds column headers and the gutter header', () => {
    const first = layout.placements[0];
    if (first === undefined) throw new Error('expected columns');
    // A column's header is a button, and says so under the pointer.
    expect(hitTestTable(input(), GUTTER + first.width / 2, TITLE + 4)).toMatchObject({
      kind: 'header',
      cursor: 'pointer',
    });
    // The row numbers beside it name no column, so nothing is promised there.
    expect(hitTestTable(input(), 20, TITLE + 4)).toMatchObject({
      kind: 'header',
      column: null,
      cursor: 'default',
    });
  });

  it('prefers the column separator over the header', () => {
    const first = layout.placements[0];
    if (first === undefined) throw new Error('expected columns');
    const hit = hitTestTable(input(), GUTTER + first.width, TITLE + 4);
    expect(hit).toMatchObject({ kind: 'column-resize', cursor: 'col-resize' });
    if (hit?.kind === 'column-resize') expect(hit.column.id).toBe(first.id);
  });

  it('maps body points to rows and columns', () => {
    const hit = hitTestTable(input(), 100, HEADER + 30);
    expect(hit).toMatchObject({ kind: 'body', row: 1 });
    if (hit?.kind === 'body') expect(hit.column?.index).toBe(0);
  });

  it('accounts for scrolling when resolving a row', () => {
    const hit = hitTestTable(input({ scrollTop: 4_300 * 24 }), 100, HEADER + 30);
    expect(hit).toMatchObject({ kind: 'body', row: 4_301 });
  });

  it('accounts for horizontal scrolling when resolving a column', () => {
    const hit = hitTestTable(input({ scrollLeft: 200 }), GUTTER + 6, HEADER + 4);
    expect(hit?.kind).toBe('body');
    if (hit?.kind === 'body') expect(hit.column?.x).toBeLessThanOrEqual(206);
  });

  it('recognises the pinned gutter', () => {
    expect(hitTestTable(input(), 20, HEADER + 30)).toMatchObject({ kind: 'gutter', row: 1 });
  });

  it('recognises the scrollbars only when they are shown', () => {
    expect(hitTestTable(input(), 590, HEADER + 40)).toMatchObject({
      kind: 'scrollbar',
      axis: 'vertical',
    });
    // With few rows there is no vertical bar, so the same point is a cell.
    expect(hitTestTable(input({ rowCount: 2 }), 590, HEADER + 40)?.kind).toBe('body');
  });

  it('recognises the horizontal scrollbar on a narrow table', () => {
    const narrow = makeTable(testIds(), { size: { width: 200, height: 400 } });
    const hit = hitTestTable(
      input({ entity: narrow, layout: computeColumnLayout(narrow.columns) }),
      120,
      388,
    );
    expect(hit).toMatchObject({ kind: 'scrollbar', axis: 'horizontal' });
  });

  it('falls back to the header when a point is past the last column', () => {
    const narrowColumns = { ...table, columns: [] };
    const hit = hitTestTable(
      input({ entity: narrowColumns, layout: computeColumnLayout([]) }),
      300,
      TITLE + 4,
    );
    expect(hit).toMatchObject({ kind: 'header', column: null });
  });
});

describe('the action halo', () => {
  const halo = computeHalo(
    tableMetrics(table, layout, 1_000_000, DEFAULT_TABLE_THEME),
    DEFAULT_TABLE_THEME,
  );
  const button = halo.buttons.at(-1);
  if (button === undefined) throw new Error('expected a halo button');
  const centre = { x: button.x + button.size / 2, y: button.y + button.size / 2 };

  it('is not hit-testable until the table is activated', () => {
    expect(hitTestTable(input(), centre.x, centre.y)).toBeNull();
  });

  it('is found above the table once activated', () => {
    const hit = hitTestTable(input({ showHalo: true }), centre.x, centre.y);
    expect(hit).toMatchObject({ kind: 'halo', action: 'close', cursor: 'pointer' });
  });

  it('does not reach into the table it hangs on', () => {
    // The corner button sits diagonally outside the table, so the resize handle
    // it used to hang over is still the resize handle.
    const hit = hitTestTable(input({ showHalo: true }), centre.x, centre.y);
    expect(hit?.kind).toBe('halo');
    expect(hitTestTable(input({ showHalo: true }), 599, 1)?.kind).toBe('resize');
  });

  it('is reachable down the right edge, where the new-box buttons are', () => {
    const sql = halo.buttons.find((button) => button.action === 'sql');
    if (sql === undefined) throw new Error('expected a query button');
    expect(
      hitTestTable(input({ showHalo: true }), sql.x + sql.width / 2, sql.y + sql.size / 2),
    ).toMatchObject({ kind: 'halo', action: 'sql' });
    // And the band beside the table carries the pointer to it.
    expect(hitTestTable(input({ showHalo: true }), 601, sql.y + sql.size / 2)).toMatchObject({
      kind: 'halo',
      action: null,
    });
  });

  it('reports the band between the table and its buttons, so hover survives', () => {
    // Reported as a halo hit with no button: nothing to press, but enough to
    // keep the table activated while the pointer travels to a button.
    const gap = hitTestTable(input({ showHalo: true }), 300, -1);
    expect(gap).toMatchObject({ kind: 'halo', action: null, button: null });

    // Anywhere along the table's width, not just above the buttons.
    expect(hitTestTable(input({ showHalo: true }), 20, -1)?.kind).toBe('halo');
    expect(hitTestTable(input({ showHalo: true }), 300, -1)?.kind).toBe('halo');
  });

  it('returns null above the band and inside the table', () => {
    expect(hitTestTable(input({ showHalo: true }), centre.x, halo.bounds.y - 20)).toBeNull();
    // Inside the table the ordinary hit testing takes over.
    expect(hitTestTable(input({ showHalo: true }), 300, 40)?.kind).not.toBe('halo');
  });

  it('scales its target area with the camera', () => {
    const zoomedOut = computeHalo(
      tableMetrics(table, layout, 1_000_000, DEFAULT_TABLE_THEME),
      DEFAULT_TABLE_THEME,
      0.25,
    );
    const far = zoomedOut.buttons[0];
    if (far === undefined) throw new Error('expected a halo button');
    const hit = hitTestTable(
      input({ showHalo: true, scale: 0.25 }),
      far.x + far.size / 2,
      far.y + far.size / 2,
    );
    expect(hit?.kind).toBe('halo');
  });
});
