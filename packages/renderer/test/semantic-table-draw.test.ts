import { describe, expect, it } from 'vitest';
import { computeColumnLayout } from '@panorama/table';
import type { TableRenderInput } from '@panorama/renderer';
import { DEFAULT_TABLE_THEME, buildTableDrawList } from '@panorama/renderer';
import { dataType } from '@panorama/core';
import type { CellValue } from '@panorama/table';
import type { TableDataView } from '@panorama/renderer';
import { makeTable, testIds } from './fixtures.js';

/**
 * Drawing a table whose columns mean something.
 *
 * The whole of the visible change: the header says what the model calls the
 * column, the identifier the database answers to moves to the row underneath,
 * the values are written the way the model says to write them, and a column
 * somebody has vouched for carries a mark.
 */

const revenue = {
  kind: 'metric',
  model: 'sales',
  modelId: 1,
  fieldId: 1,
  displayName: 'Total Revenue',
  description: 'Net recognized revenue excluding tax',
  format: 'currency',
  certified: true,
} as const;

const describedTable = (
  semantic: Partial<typeof revenue> & { readonly kind: 'metric' | 'dimension' } = revenue,
) =>
  makeTable(testIds(), {
    columns: [
      {
        name: 'TOTAL_REVENUE',
        type: dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }),
        semantic: { model: 'sales', modelId: 1, fieldId: 1, ...semantic },
      },
      { name: 'ORDER_ID', type: dataType('varchar', 'VARCHAR(32)', { size: 32 }) },
    ],
    size: { width: 600, height: 400 },
  });

/** One big number, so grouping is the visible difference rather than a rounding. */
const millions: TableDataView = { cell: (): CellValue => 12345678.9 };

const drawn = (entity = describedTable()): ReturnType<typeof buildTableDrawList> => {
  const input: TableRenderInput = {
    entity,
    layout: computeColumnLayout(entity.columns),
    theme: DEFAULT_TABLE_THEME,
    lod: 'full',
    scrollTop: 0,
    scrollLeft: 0,
    rowCount: 20,
    data: millions,
  };
  return buildTableDrawList(input);
};

describe('a described column in the header', () => {
  it('shows the model’s name for it, and the database’s underneath', () => {
    const texts = drawn().texts.map((run) => run.text);
    expect(texts).toContain('Total Revenue');
    // The identifier is still on the box, because it is what has to be typed
    // into a statement written against it.
    expect(texts).toContain('TOTAL_REVENUE · DECIMAL(18,2)');
    // ...and the column nobody described is drawn exactly as it always was.
    expect(texts).toContain('ORDER_ID');
    expect(texts).toContain('VARCHAR(32)');
  });

  it('leaves the type row alone where the model added no name of its own', () => {
    const texts = drawn(describedTable({ kind: 'metric' })).texts.map((run) => run.text);
    expect(texts).toContain('TOTAL_REVENUE');
    expect(texts).toContain('DECIMAL(18,2)');
    expect(texts).not.toContain('TOTAL_REVENUE · DECIMAL(18,2)');
  });

  it('marks a certified column, and only a certified one', () => {
    const marks = drawn().quads.filter(
      (quad) => quad.color === DEFAULT_TABLE_THEME.semanticCertified,
    );
    expect(marks).toHaveLength(1);
    const uncertified = drawn(describedTable({ kind: 'metric', displayName: 'Total Revenue' }));
    expect(
      uncertified.quads.filter((quad) => quad.color === DEFAULT_TABLE_THEME.semanticCertified),
    ).toHaveLength(0);
  });

  /**
   * The same rule a variant cell's branch tag follows: the mark's room comes out
   * of the name's, so a long name is cut short rather than running underneath the
   * thing that qualifies it.
   */
  it('keeps the mark’s width clear of the name', () => {
    const marked = drawn().texts.find((run) => run.text === 'Total Revenue');
    const plain = drawn(
      describedTable({ kind: 'metric', displayName: 'Total Revenue' }),
    ).texts.find((run) => run.text === 'Total Revenue');
    expect(marked?.maxWidth).toBeLessThan(plain?.maxWidth ?? 0);
  });
});

describe('a described column’s cells', () => {
  it('writes the values the way the model says to', () => {
    const texts = drawn().texts.map((run) => run.text);
    expect(texts).toContain('12,345,678.90');
    expect(texts).not.toContain('12345678.90');
  });

  /**
   * A hint is the only thing that turns grouping on. A column the model says
   * nothing about is written exactly as it was before any of this existed.
   */
  it('writes them plainly where the model said nothing about the format', () => {
    const texts = drawn(describedTable({ kind: 'metric', displayName: 'Total Revenue' })).texts.map(
      (run) => run.text,
    );
    expect(texts).toContain('12345678.90');
    expect(texts).not.toContain('12,345,678.90');
  });
});
