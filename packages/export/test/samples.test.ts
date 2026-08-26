import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { dataType } from '@panorama/core';
import type { RelationShape } from '@panorama/test-support';
import {
  MockTableDataSource,
  generateValue,
  nullHeavyRelation,
  typeCoverageRelation,
  wideRelation,
} from '@panorama/test-support';
import type { ExportFormat } from '@panorama/export';
import { EXPORT_FORMAT_ORDER, collectingSink, runExport } from '@panorama/export';

/**
 * Writes sample files for a reader that is not this one.
 *
 * The rest of the suite proves the bytes are what this package meant to write.
 * It cannot prove they are what Parquet, or Excel, or a spreadsheet's CSV
 * import actually expects — no test can assert that about a format it also
 * implements. So this writes the files out and leaves them to be opened by
 * someone else's library:
 *
 * ```
 * PANORAMA_EXPORT_SAMPLES=/tmp/panorama npm test
 * python3 -c "import pyarrow.parquet as pq; print(pq.read_table('/tmp/panorama/types.parquet'))"
 * python3 -c "import openpyxl; print(openpyxl.load_workbook('/tmp/panorama/types.xlsx').active.max_row)"
 * ```
 *
 * Skipped unless the directory is named, in the same way the Exasol integration
 * tests are skipped unless a database is.
 */

const directory = process.env['PANORAMA_EXPORT_SAMPLES'];

/**
 * The values the generated relations do not cover: digits no double can hold,
 * exponent notation, the edges of every calendar involved, and the text that
 * breaks a careless encoder.
 */
const AWKWARD: RelationShape = {
  schema: 'PANORAMA_TEST',
  table: 'AWKWARD',
  rowCount: 9,
  columns: [
    { name: 'BIG', type: dataType('decimal', 'DECIMAL(36,6)', { precision: 36, scale: 6 }) },
    { name: 'SMALL', type: dataType('decimal', 'DECIMAL(9,4)', { precision: 9, scale: 4 }) },
    { name: 'TEXT', type: dataType('varchar', 'VARCHAR(200)', { size: 200 }) },
    { name: 'FLAG', type: dataType('boolean', 'BOOLEAN') },
    { name: 'WHEN', type: dataType('date', 'DATE') },
  ],
  valueFor: (_type, column, row) => {
    const columns: ReadonlyArray<readonly unknown[]> = [
      [
        '123456789012345678901234567890.123456',
        '-123456789012345678901234567890.123456',
        '0.000001',
        '-0.0000005',
        '999999999999999999999999999999.999999',
        null,
        '0',
        '1e6',
        '-1E-6',
      ],
      ['12345.6789', '-12345.6789', '0', '0.00005', null, '99999.9999', '1', '2', '3'],
      [
        'plain',
        'with,comma',
        'with"quote"',
        'line\nbreak',
        'carriage\rreturn',
        '',
        null,
        'emoji \u{1F600} and é',
        'tab\tand\u0007bell',
      ],
      [true, false, null, true, false, true, false, null, true],
      [
        '1970-01-01',
        '2026-08-24',
        '1899-12-31',
        '1900-01-01',
        '1900-03-01',
        '9999-12-31',
        null,
        '2000-02-29',
        '1969-12-31',
      ],
    ];
    return columns[column]?.[row] ?? null;
  },
};

const EMPTY: RelationShape = {
  schema: 'PANORAMA_TEST',
  table: 'EMPTY',
  rowCount: 0,
  columns: [{ name: 'ONLY', type: dataType('varchar', 'VARCHAR(10)', { size: 10 }) }],
};

/** Each case names a shape, and how small a batch to force it through. */
const CASES: readonly (readonly [string, RelationShape, number])[] = [
  ['types', typeCoverageRelation(1_000), 137],
  ['nulls', nullHeavyRelation(500), 137],
  ['tiny', { ...typeCoverageRelation(3), table: 'TINY' }, 137],
  ['awkward', AWKWARD, 4],
  ['empty', EMPTY, 137],
  ['groups', { ...typeCoverageRelation(700), table: 'GROUPS' }, 64],
  ['wide', wideRelation(1_200), 8],
];

describe.skipIf(directory === undefined)('export samples', () => {
  it('writes one file per format per shape, plus the values to check them against', async () => {
    const out = directory as string;
    mkdirSync(out, { recursive: true });
    for (const [name, relation, batchRows] of CASES) {
      const valueFor = relation.valueFor ?? generateValue;
      writeFileSync(
        `${out}/${name}.expected.json`,
        JSON.stringify({
          columns: relation.columns.map((column) => ({
            name: column.name,
            kind: column.type.kind,
            scale: column.type.scale ?? null,
            precision: column.type.precision ?? null,
          })),
          rows: Array.from({ length: relation.rowCount }, (_row, row) =>
            relation.columns.map((column, index) => valueFor(column.type, index, row) ?? null),
          ),
        }),
      );
      for (const format of EXPORT_FORMAT_ORDER as readonly ExportFormat[]) {
        const source = new MockTableDataSource({ relation, latency: 0 });
        const session = await source.open();
        const sink = collectingSink();
        // A small row group as well as a small batch, so a Parquet file with
        // several row groups is among the samples.
        const result = await runExport({
          format,
          session,
          sink,
          batchRows,
          parquet: { rowGroupRows: 200 },
        });
        expect(result.rows).toBe(relation.rowCount);
        writeFileSync(`${out}/${name}.${format}`, sink.bytes());
      }
    }
  });
});
