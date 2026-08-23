import type { ColumnDataType, DataTypeKind } from '@panorama/core';
import type { ExasolColumnType } from './messages.js';

/**
 * Maps Exasol protocol column metadata onto Panorama's database-neutral
 * `ColumnDataType`. Keeping the mapping here means nothing above the driver
 * has to recognise Exasol type spellings.
 */

const KIND_BY_TYPE: Readonly<Record<string, DataTypeKind>> = Object.freeze({
  DECIMAL: 'decimal',
  DOUBLE: 'double',
  'DOUBLE PRECISION': 'double',
  VARCHAR: 'varchar',
  CHAR: 'char',
  BOOLEAN: 'boolean',
  DATE: 'date',
  TIMESTAMP: 'timestamp',
  'TIMESTAMP WITH LOCAL TIME ZONE': 'timestamp',
  'INTERVAL DAY TO SECOND': 'interval',
  'INTERVAL YEAR TO MONTH': 'interval',
  GEOMETRY: 'geometry',
  HASHTYPE: 'hashtype',
});

export const exasolTypeKind = (type: string): DataTypeKind =>
  KIND_BY_TYPE[type.toUpperCase()] ?? 'unknown';

/** Renders the type the way Exasol's own tooling displays it. */
export const exasolTypeName = (raw: ExasolColumnType): string => {
  const type = raw.type.toUpperCase();
  switch (type) {
    case 'DECIMAL':
      return raw.precision === undefined
        ? 'DECIMAL'
        : `DECIMAL(${raw.precision},${raw.scale ?? 0})`;
    case 'VARCHAR':
    case 'CHAR':
      return raw.size === undefined ? type : `${type}(${raw.size})`;
    case 'TIMESTAMP':
      return raw.fraction === undefined ? 'TIMESTAMP' : `TIMESTAMP(${raw.fraction})`;
    case 'TIMESTAMP WITH LOCAL TIME ZONE':
      return raw.fraction === undefined
        ? 'TIMESTAMP WITH LOCAL TIME ZONE'
        : `TIMESTAMP(${raw.fraction}) WITH LOCAL TIME ZONE`;
    case 'INTERVAL DAY TO SECOND':
      return `INTERVAL DAY(${raw.precision ?? 2}) TO SECOND(${raw.fraction ?? 3})`;
    case 'INTERVAL YEAR TO MONTH':
      return `INTERVAL YEAR(${raw.precision ?? 2}) TO MONTH`;
    case 'GEOMETRY':
      return raw.srid === undefined ? 'GEOMETRY' : `GEOMETRY(${raw.srid})`;
    case 'HASHTYPE':
      return raw.size === undefined ? 'HASHTYPE' : `HASHTYPE(${raw.size} BYTE)`;
    default:
      return type;
  }
};

export const toColumnDataType = (raw: ExasolColumnType): ColumnDataType => {
  const base = { kind: exasolTypeKind(raw.type), name: exasolTypeName(raw) };
  return {
    ...base,
    ...(raw.precision === undefined ? {} : { precision: raw.precision }),
    ...(raw.scale === undefined ? {} : { scale: raw.scale }),
    ...(raw.size === undefined ? {} : { size: raw.size }),
    ...(raw.withLocalTimeZone === undefined ? {} : { withLocalTimeZone: raw.withLocalTimeZone }),
    ...(raw.fraction === undefined ? {} : { fraction: raw.fraction }),
  };
};
