import { describe, expect, it } from 'vitest';
import { exasolTypeKind, exasolTypeName, toColumnDataType } from '@panorama/exasol';

describe('exasolTypeKind', () => {
  it('maps every Stage 1 type', () => {
    expect(exasolTypeKind('DECIMAL')).toBe('decimal');
    expect(exasolTypeKind('double')).toBe('double');
    expect(exasolTypeKind('DOUBLE PRECISION')).toBe('double');
    expect(exasolTypeKind('VARCHAR')).toBe('varchar');
    expect(exasolTypeKind('CHAR')).toBe('char');
    expect(exasolTypeKind('BOOLEAN')).toBe('boolean');
    expect(exasolTypeKind('DATE')).toBe('date');
    expect(exasolTypeKind('TIMESTAMP')).toBe('timestamp');
    expect(exasolTypeKind('TIMESTAMP WITH LOCAL TIME ZONE')).toBe('timestamp');
    expect(exasolTypeKind('INTERVAL DAY TO SECOND')).toBe('interval');
    expect(exasolTypeKind('INTERVAL YEAR TO MONTH')).toBe('interval');
    expect(exasolTypeKind('GEOMETRY')).toBe('geometry');
    expect(exasolTypeKind('HASHTYPE')).toBe('hashtype');
    expect(exasolTypeKind('SOMETHING_NEW')).toBe('unknown');
  });
});

describe('exasolTypeName', () => {
  it.each([
    [{ type: 'DECIMAL', precision: 18, scale: 2 }, 'DECIMAL(18,2)'],
    [{ type: 'DECIMAL', precision: 9 }, 'DECIMAL(9,0)'],
    [{ type: 'DECIMAL' }, 'DECIMAL'],
    [{ type: 'VARCHAR', size: 64 }, 'VARCHAR(64)'],
    [{ type: 'VARCHAR' }, 'VARCHAR'],
    [{ type: 'CHAR', size: 2 }, 'CHAR(2)'],
    [{ type: 'TIMESTAMP' }, 'TIMESTAMP'],
    [{ type: 'TIMESTAMP', fraction: 6 }, 'TIMESTAMP(6)'],
    [{ type: 'TIMESTAMP WITH LOCAL TIME ZONE' }, 'TIMESTAMP WITH LOCAL TIME ZONE'],
    [{ type: 'TIMESTAMP WITH LOCAL TIME ZONE', fraction: 3 }, 'TIMESTAMP(3) WITH LOCAL TIME ZONE'],
    [{ type: 'INTERVAL DAY TO SECOND' }, 'INTERVAL DAY(2) TO SECOND(3)'],
    [{ type: 'INTERVAL DAY TO SECOND', precision: 4, fraction: 6 }, 'INTERVAL DAY(4) TO SECOND(6)'],
    [{ type: 'INTERVAL YEAR TO MONTH' }, 'INTERVAL YEAR(2) TO MONTH'],
    [{ type: 'INTERVAL YEAR TO MONTH', precision: 5 }, 'INTERVAL YEAR(5) TO MONTH'],
    [{ type: 'GEOMETRY' }, 'GEOMETRY'],
    [{ type: 'GEOMETRY', srid: 4326 }, 'GEOMETRY(4326)'],
    [{ type: 'HASHTYPE' }, 'HASHTYPE'],
    [{ type: 'HASHTYPE', size: 16 }, 'HASHTYPE(16 BYTE)'],
    [{ type: 'BOOLEAN' }, 'BOOLEAN'],
  ])('renders %j', (raw, expected) => {
    expect(exasolTypeName(raw)).toBe(expected);
  });
});

describe('toColumnDataType', () => {
  it('carries only the metadata the server provided', () => {
    expect(toColumnDataType({ type: 'DECIMAL', precision: 18, scale: 2 })).toEqual({
      kind: 'decimal',
      name: 'DECIMAL(18,2)',
      precision: 18,
      scale: 2,
    });
    expect(toColumnDataType({ type: 'BOOLEAN' })).toEqual({ kind: 'boolean', name: 'BOOLEAN' });
    expect(
      toColumnDataType({
        type: 'TIMESTAMP WITH LOCAL TIME ZONE',
        withLocalTimeZone: true,
        fraction: 3,
      }),
    ).toEqual({
      kind: 'timestamp',
      name: 'TIMESTAMP(3) WITH LOCAL TIME ZONE',
      withLocalTimeZone: true,
      fraction: 3,
    });
    expect(toColumnDataType({ type: 'VARCHAR', size: 20 }).size).toBe(20);
  });
});
