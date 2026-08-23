/**
 * Level of detail.
 *
 * Full semantic zoom is out of scope, but microscopic text must never be
 * rendered: it costs glyph work and reads as noise. The thresholds are in
 * device pixels per world unit, so they follow the camera rather than an
 * arbitrary zoom number.
 */

export type LodLevel = 'full' | 'reduced' | 'summary';

export interface LodThresholds {
  /** Below this scale the type row and grid detail are dropped. */
  readonly reducedBelow: number;
  /** Below this scale only the table title and a body impression remain. */
  readonly summaryBelow: number;
}

export const DEFAULT_LOD_THRESHOLDS: LodThresholds = Object.freeze({
  reducedBelow: 0.55,
  summaryBelow: 0.28,
});

export const lodForScale = (
  scale: number,
  thresholds: LodThresholds = DEFAULT_LOD_THRESHOLDS,
): LodLevel => {
  if (scale < thresholds.summaryBelow) return 'summary';
  if (scale < thresholds.reducedBelow) return 'reduced';
  return 'full';
};

export const showsCellText = (lod: LodLevel): boolean => lod !== 'summary';
export const showsTypeRow = (lod: LodLevel): boolean => lod === 'full';
export const showsGridLines = (lod: LodLevel): boolean => lod === 'full';
