/**
 * Wheel and trackpad normalisation.
 *
 * A mouse wheel sends a few large line-mode steps; a precision trackpad sends
 * a dense stream of small pixel deltas. Both must feel right, and telling them
 * apart is the only reliable way to do that: smoothing helps a wheel and hurts
 * a trackpad.
 */

export interface WheelSample {
  readonly deltaX: number;
  readonly deltaY: number;
  /** 0 = pixels, 1 = lines, 2 = pages. */
  readonly deltaMode: number;
  readonly ctrlKey?: boolean;
  readonly shiftKey?: boolean;
  readonly metaKey?: boolean;
}

export type WheelDevice = 'wheel' | 'trackpad';

export interface NormalizedWheel {
  readonly pixelsX: number;
  readonly pixelsY: number;
  readonly device: WheelDevice;
  /** True for pinch-zoom, which browsers report as ctrl+wheel. */
  readonly zoom: boolean;
  /** True when the gesture should scroll horizontally. */
  readonly horizontal: boolean;
}

export interface WheelOptions {
  readonly lineHeight?: number;
  readonly pageHeight?: number;
  /** Pixel deltas at or below this magnitude look like a trackpad. */
  readonly trackpadThreshold?: number;
}

export const DEFAULT_LINE_HEIGHT = 16;
export const DEFAULT_PAGE_HEIGHT = 400;
export const DEFAULT_TRACKPAD_THRESHOLD = 40;

const scaleFor = (deltaMode: number, options: WheelOptions): number => {
  if (deltaMode === 1) return options.lineHeight ?? DEFAULT_LINE_HEIGHT;
  if (deltaMode === 2) return options.pageHeight ?? DEFAULT_PAGE_HEIGHT;
  return 1;
};

export const normalizeWheel = (
  sample: WheelSample,
  options: WheelOptions = {},
): NormalizedWheel => {
  const scale = scaleFor(sample.deltaMode, options);
  let pixelsX = sample.deltaX * scale;
  let pixelsY = sample.deltaY * scale;

  // Shift+wheel scrolls horizontally. Browsers that already swapped the axes
  // report deltaX themselves, so only redirect when they did not.
  const shiftSwap = sample.shiftKey === true && pixelsX === 0;
  if (shiftSwap) {
    pixelsX = pixelsY;
    pixelsY = 0;
  }

  const threshold = options.trackpadThreshold ?? DEFAULT_TRACKPAD_THRESHOLD;
  const fractional = !Number.isInteger(sample.deltaY) || !Number.isInteger(sample.deltaX);
  const device: WheelDevice =
    sample.deltaMode === 0 &&
    (fractional || (Math.abs(pixelsY) <= threshold && Math.abs(pixelsX) <= threshold))
      ? 'trackpad'
      : 'wheel';

  return {
    pixelsX,
    pixelsY,
    device,
    zoom: sample.ctrlKey === true || sample.metaKey === true,
    horizontal: shiftSwap || Math.abs(pixelsX) > Math.abs(pixelsY),
  };
};

/** Converts a zoom gesture into a multiplicative scale factor. */
export const wheelZoomFactor = (pixelsY: number, sensitivity = 0.0025): number =>
  Math.exp(-pixelsY * sensitivity);
