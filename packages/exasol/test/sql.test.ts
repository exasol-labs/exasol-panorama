import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import {
  describeQuery,
  filterLiteral,
  qualifiedName,
  quoteIdentifier,
  quoteLiteral,
  numberLiteral,
  selectAll,
  selectWhere,
  summaryAggregateQuery,
  summaryFrequencyQuery,
  summaryHistogramQuery,
  filterPredicate,
  selectWhereFrom,
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
    expect(selectWhere('SALES', 'ORDERS', { column: 'ID', values: [7] })).toBe(
      'SELECT * FROM "SALES"."ORDERS" WHERE "ID" = 7',
    );
  });

  it('uses IS NULL rather than = NULL', () => {
    expect(selectWhere('S', 'T', { column: 'C', values: [null] })).toBe(
      'SELECT * FROM "S"."T" WHERE "C" IS NULL',
    );
  });

  it('quotes identifiers, including the awkward ones real schemas contain', () => {
    expect(selectWhere('EJT', 'customers', { column: 'address|object', values: ['x'] })).toBe(
      'SELECT * FROM "EJT"."customers" WHERE "address|object" = \'x\'',
    );
  });

  it('neutralises injection through the value', () => {
    expect(selectWhere('S', 'T', { column: 'C', values: ["' OR 1=1 --"] })).toBe(
      'SELECT * FROM "S"."T" WHERE "C" = \'\'\' OR 1=1 --\'',
    );
  });
});

describe('summarising one column', () => {
  const SOURCE = 'SELECT * FROM "S"."T" WHERE "K" = 7';

  it('aggregates the statement rather than the table', () => {
    // A followed key is summarised as it is shown. Aggregating the table would
    // describe rows the panel is not showing, which is a different column.
    expect(summaryAggregateQuery(SOURCE, 'C', false)).toContain(
      `FROM (${SOURCE}) AS "panorama_source"`,
    );
  });

  it('reads one column and no others', () => {
    const query = summaryAggregateQuery('SELECT * FROM "S"."T"', 'C', true);
    expect(query).toBe(
      'SELECT COUNT(*), COUNT("C"), COUNT(DISTINCT "C"), MIN("C"), MAX("C"), AVG("C")' +
        ' FROM (SELECT * FROM "S"."T") AS "panorama_source"',
    );
  });

  it('keeps the shape of the result the same for a column with no mean', () => {
    // The columns come back by position, so a text column still has to answer
    // six of them.
    expect(summaryAggregateQuery('SELECT 1', 'C', false)).toContain(
      'MIN("C"), MAX("C"), CAST(NULL AS DOUBLE)',
    );
  });

  it('quotes the awkward column names real schemas contain', () => {
    expect(summaryAggregateQuery('SELECT 1', 'we"ird', false)).toContain('COUNT("we""ird")');
    expect(summaryFrequencyQuery('SELECT 1', 'we"ird', 8)).toContain('"we""ird" IS NOT NULL');
  });

  it('counts the most frequent values, biggest first and never null', () => {
    expect(summaryFrequencyQuery('SELECT 1', 'C', 8)).toBe(
      'SELECT "C", COUNT(*) FROM (SELECT 1) AS "panorama_source"' +
        ' WHERE "C" IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 ASC LIMIT 8',
    );
  });

  it('never lets a fractional limit reach the LIMIT clause', () => {
    expect(summaryFrequencyQuery('SELECT 1', 'C', 8.7)).toContain('LIMIT 8');
  });

  it('counts rows per equal slice of the range, by slice index', () => {
    expect(summaryHistogramQuery('SELECT 1', 'C', 0, 100, 4)).toBe(
      'SELECT LEAST(3, FLOOR(("C" - 0) / 25)), COUNT(*)' +
        ' FROM (SELECT 1) AS "panorama_source" WHERE "C" IS NOT NULL GROUP BY 1 ORDER BY 1',
    );
  });

  it('holds the largest value in the last slice rather than one past the end', () => {
    // FLOOR of the maximum lands on `bins`, which is one too far; LEAST pulls it
    // back rather than dropping the row.
    expect(summaryHistogramQuery('SELECT 1', 'C', 0, 24, 24)).toContain('LEAST(23,');
  });
});

describe('writing a number for SQL to read', () => {
  it.each([
    [0, '0'],
    [42, '42'],
    [-7, '-7'],
    [1.5, '1.5'],
    [1e-7, '0.0000001'],
    [1 / 3, '0.333333333333'],
  ])('writes %s', (value, expected) => {
    // Never in exponential form: `1e-7` is a literal some parsers take and
    // others refuse, and a fixed expansion is one they all take.
    expect(numberLiteral(value)).toBe(expected);
  });

  it('writes a very large integer plainly', () => {
    expect(numberLiteral(1e14)).toBe('100000000000000');
  });

  it('expands a number past the point where a fixed expansion gives up', () => {
    // `(1e21).toFixed(12)` is the string `1e+21`, which is exactly the form this
    // function promises never to produce. A DOUBLE column holding figures this
    // size is unusual and entirely legal.
    expect(numberLiteral(1e21)).toBe('1000000000000000000000');
    expect(numberLiteral(-1e21)).toBe('-1000000000000000000000');
    expect(numberLiteral(1.5e300)).toMatch(/^15\d+$/u);
  });

  it('writes something a parser will accept for a number that is not one', () => {
    expect(numberLiteral(Number.NaN)).toBe('0');
    expect(numberLiteral(Number.POSITIVE_INFINITY)).toBe('0');
  });
});

describe('filtering by membership', () => {
  const varchar = dataType('varchar', 'VARCHAR(64)', { size: 64 });

  it('compares one value with equality, not with a list of one', () => {
    // What a person reading the statement expects, and what an optimiser is
    // likeliest to recognise.
    expect(filterPredicate({ column: 'C', values: ['x'], type: varchar })).toBe('"C" = \'x\'');
  });

  it('lists several', () => {
    expect(filterPredicate({ column: 'C', values: ['a', 'b'], type: varchar })).toBe(
      "\"C\" IN ('a', 'b')",
    );
  });

  it('spells out the missing category separately, because IN does not match it', () => {
    expect(filterPredicate({ column: 'C', values: [null] })).toBe('"C" IS NULL');
    expect(filterPredicate({ column: 'C', values: ['a', null], type: varchar })).toBe(
      '("C" = \'a\' OR "C" IS NULL)',
    );
    expect(filterPredicate({ column: 'C', values: ['a', 'b', null], type: varchar })).toBe(
      '("C" IN (\'a\', \'b\') OR "C" IS NULL)',
    );
  });

  it('matches nothing at all when there is nothing to match', () => {
    // The honest reading of "the rows behind nothing", and clearer than an empty
    // IN () that half the parsers in the world reject.
    expect(filterPredicate({ column: 'C', values: [] })).toBe('1 = 0');
    expect(selectWhere('S', 'T', { column: 'C', values: [] })).toBe(
      'SELECT * FROM "S"."T" WHERE 1 = 0',
    );
  });

  it('quotes the column and neutralises the values', () => {
    expect(filterPredicate({ column: 'we"ird', values: ["' OR 1=1 --", 'b'], type: varchar })).toBe(
      "\"we\"\"ird\" IN (''' OR 1=1 --', 'b')",
    );
  });

  it('filters a statement result as readily as a stored relation', () => {
    expect(
      selectWhereFrom('SELECT * FROM "S"."T"', { column: 'C', values: ['a'], type: varchar }),
    ).toBe('SELECT * FROM (SELECT * FROM "S"."T") AS "panorama_source" WHERE "C" = \'a\'');
  });
});
