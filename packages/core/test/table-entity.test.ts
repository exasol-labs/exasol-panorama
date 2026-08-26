import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TABLE_VIEW,
  MAX_ESTIMATED_COLUMN_WIDTH,
  MIN_ESTIMATED_COLUMN_WIDTH,
  ROW_NUMBER_GUTTER_WIDTH,
  buildTableEntity,
  dataType,
  estimateColumnWidth,
} from '@panorama/core';
import { TEST_CONNECTION, makeTable, sampleColumns, testIds } from './fixtures.js';

describe('estimateColumnWidth', () => {
  it('stays within the estimation bounds', () => {
    expect(estimateColumnWidth('A', dataType('char', 'CHAR', { size: 1 }))).toBe(
      MIN_ESTIMATED_COLUMN_WIDTH,
    );
    expect(
      estimateColumnWidth('X'.repeat(500), dataType('varchar', 'VARCHAR(2000000)', { size: 2e6 })),
    ).toBe(MAX_ESTIMATED_COLUMN_WIDTH);
  });

  it('caps string columns at their declared size', () => {
    const narrow = estimateColumnWidth('C', dataType('char', 'CHAR(2)', { size: 2 }));
    const wide = estimateColumnWidth('C', dataType('varchar', 'VARCHAR(200)', { size: 200 }));
    expect(narrow).toBeLessThanOrEqual(wide);
  });

  it('widens for long header names', () => {
    const short = estimateColumnWidth('ID', dataType('decimal', 'DECIMAL(9,0)'));
    const long = estimateColumnWidth(
      'A_VERY_LONG_COLUMN_NAME_INDEED',
      dataType('decimal', 'DECIMAL(9,0)'),
    );
    expect(long).toBeGreaterThan(short);
  });

  it('handles unsized string columns', () => {
    expect(estimateColumnWidth('TEXT', dataType('varchar', 'VARCHAR'))).toBeGreaterThan(
      MIN_ESTIMATED_COLUMN_WIDTH,
    );
  });
});

describe('buildTableEntity', () => {
  it('creates stable ids for the table and every column view', () => {
    const table = makeTable(testIds());
    expect(table.id).toMatch(/^table:/);
    expect(new Set(table.columns.map((column) => column.id)).size).toBe(sampleColumns.length);
    expect(table.columns.every((column) => column.id.startsWith('column:'))).toBe(true);
  });

  it('defaults position, view settings and visibility', () => {
    const table = makeTable(testIds());
    expect(table.transform).toMatchObject({ x: 0, y: 0, z: 0 });
    expect(table.view).toEqual(DEFAULT_TABLE_VIEW);
    expect(table.columns.every((column) => column.visible)).toBe(true);
  });

  it('sizes itself from the gutter plus visible columns', () => {
    const table = makeTable(testIds());
    const expected =
      ROW_NUMBER_GUTTER_WIDTH + table.columns.reduce((sum, column) => sum + column.width, 0);
    expect(table.transform.width).toBe(expected);
    expect(table.transform.height).toBe(
      DEFAULT_TABLE_VIEW.headerHeight + 22 * DEFAULT_TABLE_VIEW.rowHeight,
    );
  });

  it('caps the default width for very wide schemas', () => {
    const columns = Array.from({ length: 200 }, (_, index) => ({
      name: `COL_${index}`,
      type: dataType('varchar', 'VARCHAR(100)', { size: 100 }),
    }));
    const table = buildTableEntity(testIds(), {
      source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'S', table: 'WIDE' },
      columns,
    });
    expect(table.transform.width).toBe(1100);
  });

  it('excludes hidden columns from the default width', () => {
    const table = buildTableEntity(testIds(), {
      source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'S', table: 'T' },
      columns: [
        { name: 'A', type: dataType('decimal', 'DECIMAL(9,0)'), width: 100 },
        { name: 'B', type: dataType('decimal', 'DECIMAL(9,0)'), width: 100, visible: false },
      ],
    });
    expect(table.transform.width).toBe(ROW_NUMBER_GUTTER_WIDTH + 100);
  });

  it('honours explicit position, size, view and row-count overrides', () => {
    const table = buildTableEntity(testIds(), {
      source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'S', table: 'T' },
      columns: sampleColumns,
      position: { x: 10, y: 20, z: 30 },
      size: { width: 640, height: 480 },
      view: { rowHeight: 30 },
      preferredVisibleRows: 5,
    });
    expect(table.transform).toEqual({ x: 10, y: 20, z: 30, width: 640, height: 480 });
    expect(table.view.rowHeight).toBe(30);
    expect(table.view.headerHeight).toBe(DEFAULT_TABLE_VIEW.headerHeight);
  });

  it('derives height from the preferred visible row count', () => {
    const table = buildTableEntity(testIds(), {
      source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'S', table: 'T' },
      columns: sampleColumns,
      preferredVisibleRows: 5,
    });
    expect(table.transform.height).toBe(
      DEFAULT_TABLE_VIEW.headerHeight + 5 * DEFAULT_TABLE_VIEW.rowHeight,
    );
  });
});
