import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import {
  describeQuery,
  filterLiteral,
  qualifiedName,
  quoteIdentifier,
  quoteLiteral,
  selectAll,
  selectWhere,
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

describe('filterLiteral', () => {
  it('renders numbers bare and text quoted', () => {
    expect(filterLiteral(42)).toBe('42');
    expect(filterLiteral(-1.5)).toBe('-1.5');
    expect(filterLiteral('Germany')).toBe("'Germany'");
    expect(filterLiteral(true)).toBe('TRUE');
    expect(filterLiteral(false)).toBe('FALSE');
    expect(filterLiteral(null)).toBe('NULL');
  });

  it('escapes apostrophes, which is the whole of the rule in Exasol', () => {
    expect(filterLiteral("O'Brien")).toBe("'O''Brien'");
    // A backslash is an ordinary character in an Exasol literal.
    expect(filterLiteral('c\\d')).toBe("'c\\d'");
  });

  it('compares high-precision decimals numerically when the column says so', () => {
    const decimal = dataType('decimal', 'DECIMAL(36,0)');
    expect(filterLiteral('123456789012345678901234567890', decimal)).toBe(
      '123456789012345678901234567890',
    );
    // Anything that is not a plain number stays quoted, whatever the column says.
    expect(filterLiteral('1;DROP', decimal)).toBe("'1;DROP'");
    expect(filterLiteral('123', dataType('varchar', 'VARCHAR(10)'))).toBe("'123'");
  });

  it('quotes non-finite numbers rather than emitting them bare', () => {
    expect(filterLiteral(Number.NaN)).toBe("'NaN'");
    expect(filterLiteral(Number.POSITIVE_INFINITY)).toBe("'Infinity'");
  });
});

describe('selectWhere', () => {
  it('builds the follow-a-foreign-key query', () => {
    expect(selectWhere('SALES', 'ORDERS', { column: 'ID', value: 7 })).toBe(
      'SELECT * FROM "SALES"."ORDERS" WHERE "ID" = 7',
    );
  });

  it('uses IS NULL rather than = NULL', () => {
    expect(selectWhere('S', 'T', { column: 'C', value: null })).toBe(
      'SELECT * FROM "S"."T" WHERE "C" IS NULL',
    );
  });

  it('quotes identifiers, including the awkward ones real schemas contain', () => {
    expect(selectWhere('EJT', 'customers', { column: 'address|object', value: 'x' })).toBe(
      'SELECT * FROM "EJT"."customers" WHERE "address|object" = \'x\'',
    );
  });

  it('neutralises injection through the value', () => {
    expect(selectWhere('S', 'T', { column: 'C', value: "' OR 1=1 --" })).toBe(
      'SELECT * FROM "S"."T" WHERE "C" = \'\'\' OR 1=1 --\'',
    );
  });
});
