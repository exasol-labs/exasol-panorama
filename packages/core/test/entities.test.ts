import { describe, expect, it } from 'vitest';
import type { EntityId } from '@panorama/core';
import { findColumn, isTableEntity, tableDisplayName, visibleColumnsWidth } from '@panorama/core';
import { makeTable, testIds } from './fixtures.js';

describe('table entity helpers', () => {
  const table = makeTable(testIds());

  it('identifies tables', () => {
    expect(isTableEntity(table)).toBe(true);
  });

  it('renders a qualified display name', () => {
    expect(tableDisplayName(table)).toBe('SALES.ORDERS');
  });

  it('sums only visible column widths', () => {
    const total = table.columns.reduce((sum, column) => sum + column.width, 0);
    expect(visibleColumnsWidth(table)).toBe(total);

    const firstColumn = table.columns[0];
    if (firstColumn === undefined) throw new Error('expected columns');
    const hidden = {
      ...table,
      columns: table.columns.map((column) =>
        column.id === firstColumn.id ? { ...column, visible: false } : column,
      ),
    };
    expect(visibleColumnsWidth(hidden)).toBe(total - firstColumn.width);
  });

  it('finds columns by id', () => {
    const first = table.columns[0];
    if (first === undefined) throw new Error('expected columns');
    expect(findColumn(table, first.id)).toBe(first);
    expect(findColumn(table, 'column:none' as EntityId)).toBeUndefined();
  });
});
