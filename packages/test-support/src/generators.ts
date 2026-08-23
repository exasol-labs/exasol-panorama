import type { ColumnDataType } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { TableColumnSchema, TableSchema } from '@panorama/table';

/**
 * Synthetic relations.
 *
 * Stage 1 must behave predictably for unusual schemas, so the generators cover
 * the pathological shapes deliberately: very tall, very wide, null-heavy, long
 * strings, and full type coverage.
 */

/** One column per Exasol type Panorama must render correctly. */
export const TYPE_COVERAGE: readonly ColumnDataType[] = Object.freeze([
  dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 }),
  dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }),
  dataType('double', 'DOUBLE'),
  dataType('varchar', 'VARCHAR(64)', { size: 64 }),
  dataType('char', 'CHAR(3)', { size: 3 }),
  dataType('boolean', 'BOOLEAN'),
  dataType('date', 'DATE'),
  dataType('timestamp', 'TIMESTAMP(3)', { fraction: 3 }),
  dataType('interval', 'INTERVAL DAY(2) TO SECOND(3)', { precision: 2, fraction: 3 }),
  dataType('geometry', 'GEOMETRY(4326)'),
]);

const COUNTRIES = ['Germany', 'Denmark', 'France', 'Sweden', 'Poland'] as const;

export const generateColumns = (count: number): readonly TableColumnSchema[] =>
  Array.from({ length: count }, (_, index) => {
    const type = TYPE_COVERAGE[index % TYPE_COVERAGE.length] as ColumnDataType;
    return { name: `COL_${index.toString().padStart(4, '0')}`, type };
  });

const DAY_MS = 86_400_000;
const EPOCH = Date.UTC(2026, 0, 1);

/** Deterministic, index-derived values: row 4 300 always holds the same data. */
export const generateValue = (type: ColumnDataType, column: number, row: number): unknown => {
  const salt = column * 7919 + row;
  switch (type.kind) {
    case 'decimal':
      return type.scale === undefined || type.scale === 0 ? salt : Math.round(salt * 137) / 100;
    case 'double':
      return salt / 3;
    case 'boolean':
      return salt % 2 === 0;
    case 'char':
      return String(COUNTRIES[salt % COUNTRIES.length])
        .slice(0, 3)
        .toUpperCase();
    case 'varchar':
      return COUNTRIES[salt % COUNTRIES.length];
    case 'date':
      return new Date(EPOCH + (salt % 3_650) * DAY_MS).toISOString().slice(0, 10);
    case 'timestamp':
      return new Date(EPOCH + salt * 1_000).toISOString().replace('T', ' ').replace('Z', '');
    case 'interval':
      return `${salt % 100} ${String(salt % 24).padStart(2, '0')}:00:00.000`;
    case 'geometry':
      return `POINT (${(salt % 180) - 90} ${(salt % 90) - 45})`;
    case 'hashtype':
      return salt.toString(16).padStart(32, '0');
    case 'unknown':
      return `value-${salt}`;
  }
};

export interface RelationShape {
  readonly schema: string;
  readonly table: string;
  readonly rowCount: number;
  readonly columns: readonly TableColumnSchema[];
  /** Overrides the default value generator; return `null` for SQL NULL. */
  readonly valueFor?: (type: ColumnDataType, column: number, row: number) => unknown;
}

export const relationSchema = (shape: RelationShape): TableSchema => ({
  schema: shape.schema,
  table: shape.table,
  columns: shape.columns,
});

/** Billions of rows, few columns. */
export const tallRelation = (rowCount = 10_000_000_000): RelationShape => ({
  schema: 'PANORAMA_TEST',
  table: 'VERY_TALL',
  rowCount,
  columns: generateColumns(4),
});

/** Thousands of columns, few rows. */
export const wideRelation = (columnCount = 5_000): RelationShape => ({
  schema: 'PANORAMA_TEST',
  table: 'VERY_WIDE',
  rowCount: 100,
  columns: generateColumns(columnCount),
});

/** A representative analytical fact table. */
export const factRelation = (rowCount = 2_830_000_000): RelationShape => ({
  schema: 'PANORAMA_TEST',
  table: 'SALES',
  rowCount,
  columns: [
    { name: 'ORDER_ID', type: dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 }) },
    { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
    { name: 'ORDER_DATE', type: dataType('date', 'DATE') },
    { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }) },
  ],
});

/** Long VARCHAR values, which stress text layout and clipping. */
export const largeStringRelation = (rowCount = 100_000): RelationShape => ({
  schema: 'PANORAMA_TEST',
  table: 'LARGE_STRINGS',
  rowCount,
  columns: [
    { name: 'ID', type: dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 }) },
    { name: 'BODY', type: dataType('varchar', 'VARCHAR(2000000)', { size: 2_000_000 }) },
  ],
  valueFor: (_type, column, row) =>
    column === 0 ? row : `${'lorem ipsum dolor sit amet '.repeat(40)}${row}`,
});

/** Predominantly NULL columns. */
export const nullHeavyRelation = (rowCount = 1_000_000): RelationShape => ({
  schema: 'PANORAMA_TEST',
  table: 'MOSTLY_NULL',
  rowCount,
  columns: generateColumns(6),
  valueFor: (type, column, row) =>
    (row + column) % 10 === 0 ? generateValue(type, column, row) : null,
});

/** One column per supported type. */
export const typeCoverageRelation = (rowCount = 10_000): RelationShape => ({
  schema: 'PANORAMA_TEST',
  table: 'TYPE_COVERAGE',
  rowCount,
  columns: generateColumns(TYPE_COVERAGE.length),
});
