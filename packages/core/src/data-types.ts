/**
 * Database-neutral description of a source column type.
 *
 * Core deliberately does not import anything from the Exasol package: the
 * Exasol driver maps its protocol metadata onto these structures, and any
 * future backend can do the same.
 */

export type DataTypeKind =
  | 'decimal'
  | 'double'
  | 'varchar'
  | 'char'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'interval'
  | 'geometry'
  | 'hashtype'
  | 'unknown';

export interface ColumnDataType {
  readonly kind: DataTypeKind;
  /** Fully-qualified type name as the database reports it, e.g. `DECIMAL(18,2)`. */
  readonly name: string;
  readonly precision?: number;
  readonly scale?: number;
  /** Character/byte size for string and hash types. */
  readonly size?: number;
  readonly withLocalTimeZone?: boolean;
  /** Fractional-second digits for TIMESTAMP types. */
  readonly fraction?: number;
}

/** Where a foreign key column points. Database-neutral, like the types. */
export interface ForeignKeyReference {
  readonly schema: string;
  readonly table: string;
  readonly column: string;
  readonly constraint: string;
}

export type CellAlignment = 'left' | 'right' | 'center';

const RIGHT_ALIGNED: ReadonlySet<DataTypeKind> = new Set<DataTypeKind>(['decimal', 'double']);

const CENTER_ALIGNED: ReadonlySet<DataTypeKind> = new Set<DataTypeKind>(['boolean']);

/** Numeric columns align right so digits line up; booleans centre; the rest left. */
export const alignmentForType = (type: ColumnDataType): CellAlignment => {
  if (RIGHT_ALIGNED.has(type.kind)) return 'right';
  if (CENTER_ALIGNED.has(type.kind)) return 'center';
  return 'left';
};

export const dataType = (
  kind: DataTypeKind,
  name: string,
  extra: Omit<ColumnDataType, 'kind' | 'name'> = {},
): ColumnDataType => ({ kind, name, ...extra });

/** A short label suitable for the second header row of a table. */
export const shortTypeLabel = (type: ColumnDataType): string => type.name;
