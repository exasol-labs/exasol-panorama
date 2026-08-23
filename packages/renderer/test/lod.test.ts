import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LOD_THRESHOLDS,
  lodForScale,
  showsCellText,
  showsGridLines,
  showsTypeRow,
} from '@panorama/renderer';

describe('level of detail', () => {
  it('drops detail as the camera zooms out', () => {
    expect(lodForScale(1)).toBe('full');
    expect(lodForScale(DEFAULT_LOD_THRESHOLDS.reducedBelow)).toBe('full');
    expect(lodForScale(0.4)).toBe('reduced');
    expect(lodForScale(DEFAULT_LOD_THRESHOLDS.summaryBelow)).toBe('reduced');
    expect(lodForScale(0.1)).toBe('summary');
  });

  it('honours custom thresholds', () => {
    expect(lodForScale(0.9, { reducedBelow: 1, summaryBelow: 0.5 })).toBe('reduced');
  });

  it('describes what each level draws', () => {
    expect([showsCellText('full'), showsTypeRow('full'), showsGridLines('full')]).toEqual([
      true,
      true,
      true,
    ]);
    expect([showsCellText('reduced'), showsTypeRow('reduced'), showsGridLines('reduced')]).toEqual([
      true,
      false,
      false,
    ]);
    expect(showsCellText('summary')).toBe(false);
  });
});
