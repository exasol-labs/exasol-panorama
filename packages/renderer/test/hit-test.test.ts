import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { TableHitInput } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  computeHalo,
  hitTestTable,
  tableMetrics,
  toTableLocal,
} from '@panorama/renderer';
import { makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds(), { position: { x: 100, y: 50, z: 0 } });
const layout = computeColumnLayout(table.columns);
const HEADER = table.view.headerHeight;
const TITLE = DEFAULT_TABLE_THEME.titleHeight;

const input = (overrides: Partial<TableHitInput> = {}): TableHitInput => ({
  entity: table,
  layout,
  theme: DEFAULT_TABLE_THEME,
  scrollTop: 0,
  scrollLeft: 0,
  rowCount: 1_000_000,
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
    expect(hitTestTable(input(), 64 + first.width / 2, TITLE + 4)).toMatchObject({
      kind: 'header',
    });
    expect(hitTestTable(input(), 20, TITLE + 4)).toMatchObject({ kind: 'header', column: null });
  });

  it('prefers the column separator over the header', () => {
    const first = layout.placements[0];
    if (first === undefined) throw new Error('expected columns');
    const hit = hitTestTable(input(), 64 + first.width, TITLE + 4);
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
    const hit = hitTestTable(input({ scrollLeft: 200 }), 70, HEADER + 4);
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
  const button = halo.buttons[0];
  if (button === undefined) throw new Error('expected a halo button');
  const centre = { x: button.x + button.size / 2, y: button.y + button.size / 2 };

  it('is not hit-testable until the table is activated', () => {
    expect(hitTestTable(input(), centre.x, centre.y)).toBeNull();
  });

  it('is found above the table once activated', () => {
    const hit = hitTestTable(input({ showHalo: true }), centre.x, centre.y);
    expect(hit).toMatchObject({ kind: 'halo', action: 'close', cursor: 'pointer' });
  });

  it('takes precedence over the resize handles it overlaps', () => {
    // The halo hangs over the table's top-right corner region.
    const hit = hitTestTable(input({ showHalo: true }), centre.x, centre.y);
    expect(hit?.kind).toBe('halo');
    // Just below it, the corner handle still wins.
    expect(hitTestTable(input({ showHalo: true }), 599, 1)?.kind).toBe('resize');
  });

  it('returns null for the gap between the halo and the table', () => {
    expect(hitTestTable(input({ showHalo: true }), centre.x, -1)).toBeNull();
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
