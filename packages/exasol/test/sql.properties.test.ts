import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import type { ColumnDataType } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { CellValue, RowFilter } from '@panorama/table';
import {
  filterLiteral,
  filterPredicate,
  numberLiteral,
  qualifiedName,
  quoteIdentifier,
  quoteLiteral,
  selectWhere,
} from '@panorama/exasol';
import { scanQuoted, scanWhole, withoutQuoted } from './sql-scanner.js';

/**
 * Properties of SQL construction.
 *
 * Everything here is built from text Panorama did not choose. A filter's values
 * are cell contents — whatever somebody else inserted into the database — and
 * schema, table and column names are whatever the catalogue reports. The example
 * tests cover the values we thought of; these cover the ones we did not, and they
 * are read back with a scanner written from the dialect rather than from the
 * writer (`sql-scanner.ts`), so agreeing with ourselves is not enough to pass.
 *
 * Seeds are pinned, so a counterexample can be replayed and the coverage the run
 * reports is the same every time.
 */

const RUNS = { numRuns: 300 } as const;

/** Text chosen to break quoting: quotes, doubled quotes, newlines, astral pairs. */
const nasty = fc.oneof(
  fc.string({ unit: 'binary', maxLength: 24 }),
  fc.string({ unit: 'grapheme', maxLength: 24 }),
  fc.constantFrom(
    "'",
    "''",
    "'''",
    '"',
    '""',
    '\\',
    "\\'",
    'a\\',
    "'; DROP TABLE ORDERS --",
    "' OR 1 = 1 --",
    '" OR "" = "',
    ' ',
    '\r\n',
    '--',
    '/*',
    '*/',
    '\u{1d54a}',
    '\ud800',
    '1',
    '',
  ),
);

const TYPES: readonly (ColumnDataType | undefined)[] = [
  undefined,
  dataType('varchar', 'VARCHAR(64)', { size: 64 }),
  dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }),
  dataType('double', 'DOUBLE'),
  dataType('boolean', 'BOOLEAN'),
  dataType('date', 'DATE'),
];

const columnType = fc.constantFrom(...TYPES);

const cellValue: fc.Arbitrary<CellValue> = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.double(),
  fc.integer(),
  nasty,
);

/** A bare token a statement may carry unquoted, and nothing else. */
const SAFE_BARE = /^(NULL|TRUE|FALSE|-?\d+(\.\d+)?([eE][+-]?\d+)?)$/u;

describe('quoting', () => {
  it('round-trips any text through a literal', () => {
    fc.assert(
      fc.property(nasty, (text) => {
        const token = scanWhole(quoteLiteral(text));
        expect(token?.kind).toBe('literal');
        expect(token?.text).toBe(text);
      }),
      { seed: 20260826, ...RUNS },
    );
  });

  it('round-trips any text through an identifier', () => {
    fc.assert(
      fc.property(nasty, (text) => {
        const token = scanWhole(quoteIdentifier(text));
        expect(token?.kind).toBe('identifier');
        expect(token?.text).toBe(text);
      }),
      { seed: 201, ...RUNS },
    );
  });

  it('makes a qualified name of exactly two identifiers', () => {
    fc.assert(
      fc.property(nasty, nasty, (schema, table) => {
        const name = qualifiedName(schema, table);
        // Structure, with the quoted runs taken out: one dot and nothing else.
        expect(withoutQuoted(name)).toBe(' . ');
        const parts = scanQuoted(name);
        expect(parts.map((part) => part.text)).toEqual([schema, table]);
      }),
      { seed: 202, ...RUNS },
    );
  });
});

describe('a filter value as a literal', () => {
  it('is either a literal saying exactly the value or a bare token that can be nothing else', () => {
    fc.assert(
      fc.property(cellValue, columnType, (value, type) => {
        const sql = filterLiteral(value, type);
        const token = scanWhole(sql);
        if (token?.kind === 'literal') {
          // Quoted: it must say the value, and it must be closed.
          expect(token.text).toBe(typeof value === 'string' ? value : String(value));
          return;
        }
        // Bare: only the three words and a number may ever go in unquoted. This
        // is the property that keeps the numeric fast path from being a hole —
        // a *string* takes it when the column says decimal, so what it produces
        // has to be a number and nothing else.
        expect(sql).toMatch(SAFE_BARE);
      }),
      { seed: 203, ...RUNS },
    );
  });

  it('never lets a value contribute syntax', () => {
    fc.assert(
      fc.property(cellValue, columnType, (value, type) => {
        const structure = withoutQuoted(filterLiteral(value, type));
        // With the literals removed, what is left is either nothing (the value
        // was quoted) or the bare token itself. A value that closed its own quote
        // would leave its payload behind as syntax.
        expect(structure === ' ' || SAFE_BARE.test(structure.trim())).toBe(true);
      }),
      { seed: 204, ...RUNS },
    );
  });

  it('renders a number as a literal every parser accepts', () => {
    fc.assert(
      fc.property(fc.double(), (value) => {
        const sql = numberLiteral(value);
        expect(sql).toMatch(/^-?\d+(\.\d+)?$/u);
        // Never exponent notation, which is the whole reason this exists.
        expect(sql).not.toMatch(/[eE]/u);
      }),
      { seed: 205, ...RUNS },
    );
  });
});

describe('a membership predicate', () => {
  const filter = fc
    .tuple(nasty, fc.array(cellValue, { maxLength: 5 }), columnType)
    .map(([column, values, type]): RowFilter => ({
      column,
      values,
      ...(type === undefined ? {} : { type }),
    }));

  it('names the column as an identifier and nothing else as one', () => {
    fc.assert(
      fc.property(filter, (row) => {
        for (const token of scanQuoted(filterPredicate(row))) {
          if (token.kind === 'identifier') expect(token.text).toBe(row.column);
        }
      }),
      { seed: 206, ...RUNS },
    );
  });

  it('leaves a structure made only of the words and symbols it meant to write', () => {
    /** Every word `filterPredicate` is entitled to write. */
    const WORDS = new Set(['IN', 'IS', 'NULL', 'OR', 'TRUE', 'FALSE']);
    /** Every symbol it is entitled to write, plus what a bare number is made of. */
    const SYMBOLS = /^[\s=(),.\-+0-9eE]*$/u;
    fc.assert(
      fc.property(filter, (row) => {
        const structure = withoutQuoted(filterPredicate(row));
        // Quoted values are gone, so what is left is the predicate's own syntax
        // and its bare numeric literals. A value that closed its own quote would
        // appear here as a word or a symbol nothing in this function writes.
        for (const word of structure.match(/[A-Za-z_]{2,}/gu) ?? []) {
          expect(WORDS.has(word.toUpperCase())).toBe(true);
        }
        expect(structure.replace(/[A-Za-z_]{2,}|OR/gu, '')).toMatch(SYMBOLS);
      }),
      { seed: 207, ...RUNS },
    );
  });

  it('builds a whole statement in which every quoted run is closed', () => {
    fc.assert(
      fc.property(nasty, nasty, filter, (schema, table, row) => {
        const structure = withoutQuoted(selectWhere(schema, table, row));
        // An unterminated run swallows the rest of the statement, and a quote
        // left over in the structure is the sign of one.
        expect(structure.includes("'")).toBe(false);
        expect(structure.includes('"')).toBe(false);
      }),
      { seed: 208, ...RUNS },
    );
  });
});
