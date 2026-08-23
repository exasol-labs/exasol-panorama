import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import {
  TYPE_COVERAGE,
  factRelation,
  generateColumns,
  generateValue,
  largeStringRelation,
  nullHeavyRelation,
  relationSchema,
  tallRelation,
  typeCoverageRelation,
  wideRelation,
} from '@panorama/test-support';

describe('generateColumns', () => {
  it('cycles through the covered types with unique names', () => {
    const columns = generateColumns(25);
    expect(columns).toHaveLength(25);
    expect(new Set(columns.map((column) => column.name)).size).toBe(25);
    expect(columns[0]?.type).toBe(TYPE_COVERAGE[0]);
    expect(columns[TYPE_COVERAGE.length]?.type).toBe(TYPE_COVERAGE[0]);
    expect(columns[0]?.name).toBe('COL_0000');
  });
});

describe('generateValue', () => {
  it('is deterministic per cell', () => {
    for (const type of TYPE_COVERAGE) {
      expect(generateValue(type, 3, 4_300)).toEqual(generateValue(type, 3, 4_300));
    }
  });

  it('produces the right shape for each kind', () => {
    expect(generateValue(dataType('decimal', 'DECIMAL(9,0)', { scale: 0 }), 0, 5)).toBe(5);
    expect(generateValue(dataType('decimal', 'DECIMAL(9,2)', { scale: 2 }), 0, 5)).toBeCloseTo(
      6.85,
    );
    expect(generateValue(dataType('decimal', 'DECIMAL'), 0, 5)).toBe(5);
    expect(generateValue(dataType('double', 'DOUBLE'), 0, 3)).toBeCloseTo(1);
    expect(generateValue(dataType('boolean', 'BOOLEAN'), 0, 4)).toBe(true);
    expect(generateValue(dataType('char', 'CHAR(3)'), 0, 0)).toBe('GER');
    expect(generateValue(dataType('varchar', 'VARCHAR(64)'), 0, 1)).toBe('Denmark');
    expect(generateValue(dataType('date', 'DATE'), 0, 0)).toBe('2026-01-01');
    expect(String(generateValue(dataType('timestamp', 'TIMESTAMP'), 0, 0))).toContain(
      '2026-01-01 ',
    );
    expect(String(generateValue(dataType('interval', 'INTERVAL'), 0, 5))).toMatch(
      /^5 05:00:00\.000$/,
    );
    expect(String(generateValue(dataType('geometry', 'GEOMETRY'), 0, 0))).toMatch(/^POINT /);
    expect(String(generateValue(dataType('hashtype', 'HASHTYPE'), 0, 255))).toHaveLength(32);
    expect(generateValue(dataType('unknown', 'WHAT'), 0, 2)).toBe('value-2');
  });
});

describe('pathological relations', () => {
  it('describes a very tall relation without materialising it', () => {
    const shape = tallRelation();
    expect(shape.rowCount).toBe(10_000_000_000);
    expect(shape.columns).toHaveLength(4);
    expect(relationSchema(shape)).toEqual({
      schema: shape.schema,
      table: shape.table,
      columns: shape.columns,
    });
  });

  it('describes a very wide relation', () => {
    const shape = wideRelation();
    expect(shape.columns).toHaveLength(5_000);
    expect(shape.rowCount).toBe(100);
    expect(wideRelation(12).columns).toHaveLength(12);
  });

  it('describes a representative fact table', () => {
    const shape = factRelation();
    expect(shape.columns.map((column) => column.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'ORDER_DATE',
      'REVENUE',
    ]);
    expect(factRelation(10).rowCount).toBe(10);
  });

  it('describes long-string and null-heavy relations', () => {
    const large = largeStringRelation(10);
    const body = large.valueFor?.(large.columns[1]?.type as never, 1, 3);
    expect(String(body).length).toBeGreaterThan(1_000);
    expect(large.valueFor?.(large.columns[0]?.type as never, 0, 3)).toBe(3);

    const nulls = nullHeavyRelation(100);
    expect(nulls.valueFor?.(nulls.columns[0]?.type as never, 0, 1)).toBeNull();
    expect(nulls.valueFor?.(nulls.columns[0]?.type as never, 0, 0)).not.toBeNull();
  });

  it('describes a type-coverage relation', () => {
    const shape = typeCoverageRelation();
    expect(shape.columns).toHaveLength(TYPE_COVERAGE.length);
    expect(typeCoverageRelation(5).rowCount).toBe(5);
    expect(largeStringRelation().rowCount).toBe(100_000);
    expect(nullHeavyRelation().rowCount).toBe(1_000_000);
  });
});
