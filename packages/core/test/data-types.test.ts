import { describe, expect, it } from 'vitest';
import { alignmentForType, dataType, shortTypeLabel } from '@panorama/core';

describe('data types', () => {
  it('right-aligns numbers, centres booleans and left-aligns everything else', () => {
    expect(alignmentForType(dataType('decimal', 'DECIMAL(9,2)'))).toBe('right');
    expect(alignmentForType(dataType('double', 'DOUBLE'))).toBe('right');
    expect(alignmentForType(dataType('boolean', 'BOOLEAN'))).toBe('center');
    expect(alignmentForType(dataType('varchar', 'VARCHAR(20)'))).toBe('left');
    expect(alignmentForType(dataType('timestamp', 'TIMESTAMP'))).toBe('left');
  });

  it('carries optional metadata', () => {
    const type = dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 });
    expect(type).toEqual({ kind: 'decimal', name: 'DECIMAL(18,2)', precision: 18, scale: 2 });
    expect(shortTypeLabel(type)).toBe('DECIMAL(18,2)');
  });
});
