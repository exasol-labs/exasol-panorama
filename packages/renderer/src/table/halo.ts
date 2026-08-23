import type { EntityActionId } from '@panorama/core';
import type { ClipRect } from './draw-list.js';
import type { TableMetrics } from './table-draw.js';
import type { TableTheme } from '../theme.js';

/**
 * The action halo.
 *
 * A small row of buttons that appears when a table is activated — by pointer
 * hover on the desktop, and by whatever stands in for it elsewhere: touch, or
 * an XR gaze or controller ray. It is drawn by the GPU renderer like everything
 * else, so it works identically in a browser and in XR; a DOM overlay would
 * not.
 *
 * The buttons sit just *outside* the table's top edge so they never cover data,
 * and they are sized in screen pixels so they stay usable when the canvas is
 * zoomed out.
 */

export interface HaloButton {
  readonly action: EntityActionId;
  /** Table-local coordinates; `y` is negative — the halo is above the table. */
  readonly x: number;
  readonly y: number;
  readonly size: number;
  /** Glyph drawn on the button. */
  readonly icon: string;
  readonly label: string;
}

export interface Halo {
  readonly buttons: readonly HaloButton[];
  /** Bounds covering the buttons themselves. */
  readonly bounds: ClipRect;
  /**
   * The band that keeps a table activated while the pointer travels from it to
   * a button.
   *
   * It spans the table's whole width, not just the buttons: the pointer leaves
   * the table wherever it likes, and if the band were only as wide as the
   * buttons then any other path out would deactivate the table and the buttons
   * would vanish before they could be reached.
   */
  readonly hoverBounds: ClipRect;
}

interface ActionSpec {
  readonly action: EntityActionId;
  readonly icon: string;
  readonly label: string;
}

/**
 * `×` rather than a drawn cross: it is present in every system font, so it
 * needs no icon pipeline and no extra draw call.
 */
export const TABLE_ACTIONS: readonly ActionSpec[] = Object.freeze([
  { action: 'close', icon: '×', label: 'Close table' },
]);

const EMPTY_RECT: ClipRect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

export const EMPTY_HALO: Halo = Object.freeze({
  buttons: [],
  bounds: EMPTY_RECT,
  hoverBounds: EMPTY_RECT,
});

/**
 * Lays the halo out for a table. `scale` is the camera's pixels-per-world-unit,
 * so button sizes are constant on screen.
 */
export const computeHalo = (
  metrics: TableMetrics,
  theme: TableTheme,
  scale = 1,
  actions: readonly ActionSpec[] = TABLE_ACTIONS,
): Halo => {
  if (actions.length === 0) return EMPTY_HALO;
  const safeScale = Math.max(0.05, scale);
  const size = theme.haloButtonSize / safeScale;
  const gap = theme.haloGap / safeScale;
  const offset = theme.haloOffset / safeScale;

  const totalWidth = actions.length * size + (actions.length - 1) * gap;
  // Right-aligned with the table, which is where a close button is expected.
  const left = Math.max(0, metrics.width - totalWidth);
  const top = -(size + offset);

  const buttons = actions.map((spec, index) => ({
    action: spec.action,
    icon: spec.icon,
    label: spec.label,
    x: left + index * (size + gap),
    y: top,
    size,
  }));

  // A little forgiveness on the way up and to the sides, and none below: the
  // band must not overlap the table, whose own hit testing owns that space.
  const margin = gap;
  return {
    buttons,
    bounds: { x: left, y: top, width: totalWidth, height: size + offset },
    hoverBounds: {
      x: -margin,
      y: top - margin,
      width: metrics.width + margin * 2,
      height: size + offset + margin,
    },
  };
};

/** The button under a point in table-local coordinates, if any. */
export const haloButtonAt = (halo: Halo, localX: number, localY: number): HaloButton | null => {
  for (const button of halo.buttons) {
    if (
      localX >= button.x &&
      localX < button.x + button.size &&
      localY >= button.y &&
      localY < button.y + button.size
    ) {
      return button;
    }
  }
  return null;
};

/**
 * True when a point is in the halo's band — on a button or merely on the way to
 * one. This is what keeps the table activated while the pointer crosses the gap.
 */
export const withinHalo = (halo: Halo, localX: number, localY: number): boolean =>
  halo.buttons.length > 0 &&
  localX >= halo.hoverBounds.x &&
  localX < halo.hoverBounds.x + halo.hoverBounds.width &&
  localY >= halo.hoverBounds.y &&
  localY < halo.hoverBounds.y + halo.hoverBounds.height;
