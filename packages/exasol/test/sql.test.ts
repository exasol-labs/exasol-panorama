import { describe, expect, it } from 'vitest';
import {
  describeQuery,
  qualifiedName,
  quoteIdentifier,
  quoteLiteral,
  selectAll,
} from '@panorama/exasol';

describe('SQL helpers', () => {
  it('quotes identifiers and doubles embedded quotes', () => {
    expect(quoteIdentifier('SALES')).toBe('"SALES"');
    expect(quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it('quotes literals and doubles embedded apostrophes', () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it('builds the Stage 1 queries', () => {
    expect(qualifiedName('S', 'T')).toBe('"S"."T"');
    expect(selectAll('SALES', 'ORDERS')).toBe('SELECT * FROM "SALES"."ORDERS"');
    expect(describeQuery('SALES', 'ORDERS')).toBe('SELECT * FROM "SALES"."ORDERS" WHERE 1 = 0');
  });

  it('neutralises injection attempts in object names', () => {
    const sql = selectAll('S', 'T" ; DROP SCHEMA "X');
    expect(sql).toBe('SELECT * FROM "S"."T"" ; DROP SCHEMA ""X"');
  });
});
