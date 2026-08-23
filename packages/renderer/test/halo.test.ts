import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import {
  DEFAULT_TABLE_THEME,
  EMPTY_HALO,
  TABLE_ACTIONS,
  computeHalo,
  haloButtonAt,
  tableMetrics,
  withinHalo,
} from '@panorama/renderer';
import { makeTable, testIds } from './fixtures.js';

const table = makeTable(testIds());
const metrics = tableMetrics(table, computeColumnLayout(table.columns), 1_000, DEFAULT_TABLE_THEME);

describe('computeHalo', () => {
  it('offers a close button', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);
    expect(halo.buttons.map((button) => button.action)).toEqual(['close']);
    expect(halo.buttons[0]?.label).toBe('Close table');
    expect(halo.buttons[0]?.icon).toBe('×');
    expect(TABLE_ACTIONS).toHaveLength(1);
  });

  it('sits above the table so it never covers data', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);
    const button = halo.buttons[0];
    if (button === undefined) throw new Error('expected a button');
    expect(button.y + button.size).toBeLessThanOrEqual(0);
    expect(halo.bounds.y).toBeLessThan(0);
  });

  it('right-aligns with the table', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);
    const button = halo.buttons[0];
    if (button === undefined) throw new Error('expected a button');
    expect(button.x + button.size).toBeCloseTo(metrics.width, 6);
  });

  it('keeps a constant screen size as the camera zooms', () => {
    const near = computeHalo(metrics, DEFAULT_TABLE_THEME, 1);
    const far = computeHalo(metrics, DEFAULT_TABLE_THEME, 0.25);
    expect(far.buttons[0]?.size).toBeCloseTo((near.buttons[0]?.size ?? 0) * 4, 6);
    // Still anchored to the table's right edge at any zoom.
    expect((far.buttons[0]?.x ?? 0) + (far.buttons[0]?.size ?? 0)).toBeCloseTo(metrics.width, 6);
  });

  it('survives a degenerate scale', () => {
    expect(Number.isFinite(computeHalo(metrics, DEFAULT_TABLE_THEME, 0).buttons[0]?.size)).toBe(
      true,
    );
  });

  it('lays several actions out in a row', () => {
    const halo = computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [
      { action: 'close', icon: '×', label: 'Close table' },
      { action: 'close', icon: '×', label: 'Also close' },
    ]);
    expect(halo.buttons).toHaveLength(2);
    const [first, second] = halo.buttons;
    expect((second?.x ?? 0) - (first?.x ?? 0)).toBeCloseTo(
      DEFAULT_TABLE_THEME.haloButtonSize + DEFAULT_TABLE_THEME.haloGap,
      6,
    );
    expect(halo.bounds.width).toBeCloseTo(
      DEFAULT_TABLE_THEME.haloButtonSize * 2 + DEFAULT_TABLE_THEME.haloGap,
      6,
    );
  });

  it('never starts left of the table, even when the halo is wider', () => {
    const narrow = { ...metrics, width: 10 };
    expect(computeHalo(narrow, DEFAULT_TABLE_THEME).buttons[0]?.x).toBe(0);
  });

  it('is empty when there are no actions', () => {
    expect(computeHalo(metrics, DEFAULT_TABLE_THEME, 1, [])).toBe(EMPTY_HALO);
  });
});

describe('haloButtonAt', () => {
  const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);
  const button = halo.buttons[0];
  if (button === undefined) throw new Error('expected a button');

  it('finds the button under a point', () => {
    expect(haloButtonAt(halo, button.x + 1, button.y + 1)?.action).toBe('close');
    expect(
      haloButtonAt(halo, button.x + button.size - 0.1, button.y + button.size - 0.1)?.action,
    ).toBe('close');
  });

  it('misses outside the button', () => {
    expect(haloButtonAt(halo, button.x - 1, button.y + 1)).toBeNull();
    expect(haloButtonAt(halo, button.x + button.size, button.y + 1)).toBeNull();
    expect(haloButtonAt(halo, button.x + 1, button.y - 1)).toBeNull();
    expect(haloButtonAt(halo, button.x + 1, button.y + button.size)).toBeNull();
    expect(haloButtonAt(EMPTY_HALO, 0, 0)).toBeNull();
  });
});

describe('withinHalo', () => {
  const halo = computeHalo(metrics, DEFAULT_TABLE_THEME);

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

  it('excludes the table itself and anything beyond the band', () => {
    // y >= 0 is the table's own space; its hit testing owns that.
    expect(withinHalo(halo, metrics.width / 2, 0)).toBe(false);
    expect(withinHalo(halo, metrics.width / 2, 1)).toBe(false);
    expect(withinHalo(halo, metrics.width / 2, halo.hoverBounds.y - 1)).toBe(false);
    expect(withinHalo(halo, -50, -1)).toBe(false);
    expect(withinHalo(halo, metrics.width + 50, -1)).toBe(false);
    expect(withinHalo(EMPTY_HALO, 0, 0)).toBe(false);
  });
});
