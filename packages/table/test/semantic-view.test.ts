import { describe, expect, it } from 'vitest';
import type { SemanticColumnView, TableColumnSpec } from '@panorama/core';
import { dataType } from '@panorama/core';
import { withSemantics } from '@panorama/table';

/**
 * Putting meaning on the columns that have some, and on no others.
 *
 * The whole of the contract is that it composes: whatever built the specs —
 * the physical columns, or the document view of a family — hands them here and
 * gets them back with one more field on the ones a model describes.
 */

const revenue: SemanticColumnView = {
  kind: 'metric',
  model: 'sales',
  displayName: 'Total Revenue',
  format: 'currency',
};

const specs: readonly TableColumnSpec[] = [
  { name: 'TOTAL_REVENUE', type: dataType('decimal', 'DECIMAL(18,2)') },
  { name: 'ORDER_ID', type: dataType('varchar', 'VARCHAR(32)') },
];

describe('withSemantics', () => {
  it('describes the columns a model names and leaves the rest alone', () => {
    const described = withSemantics(specs, new Map([['TOTAL_REVENUE', revenue]]));
    expect(described[0]?.semantic).toBe(revenue);
    expect(described[1]).toBe(specs[1]);
    // Order and count are untouched: this adds to columns, it does not choose
    // them.
    expect(described.map((column) => column.name)).toEqual(['TOTAL_REVENUE', 'ORDER_ID']);
  });

  /** Every table on almost every connection. It must cost nothing and change nothing. */
  it('hands back the very same array when there is nothing to say', () => {
    expect(withSemantics(specs, undefined)).toBe(specs);
    expect(withSemantics(specs, new Map())).toBe(specs);
    // A model describing an object whose columns are all named something else:
    // the lookup found the object, and none of its fields is here.
    expect(withSemantics(specs, new Map([['SOMETHING_ELSE', revenue]]))).toBe(specs);
  });

  it('keeps whatever the column already carried', () => {
    const document: readonly TableColumnSpec[] = [
      {
        name: 'TOTAL_REVENUE',
        type: dataType('decimal', 'DECIMAL(18,2)'),
        visible: false,
        json: { kind: 'scalar', branches: [{ index: 3, type: dataType('decimal', 'DECIMAL') }] },
      },
    ];
    const described = withSemantics(document, new Map([['TOTAL_REVENUE', revenue]]));
    expect(described[0]).toMatchObject({ visible: false, semantic: revenue });
    expect(described[0]?.json?.branches[0]?.index).toBe(3);
  });
});
