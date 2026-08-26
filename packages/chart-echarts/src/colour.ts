import type { ChartRgba } from '@panorama/chart';

/**
 * Colours across the boundary.
 *
 * ECharts speaks CSS strings and Panorama speaks four floats, so this is the
 * translation both ways. Nothing is guessed: an unparseable colour comes back as
 * `null` and whatever it belonged to is not drawn, which shows up as a missing
 * bar rather than a black one — a hole being easier to notice and diagnose than a
 * plausible wrong answer.
 */

const HEX = /^#([0-9a-f]{3,8})$/iu;
const FUNCTIONAL = /^rgba?\(([^)]*)\)$/iu;

const byte = (value: string): number => Number.parseInt(value, 16) / 255;

/** A gradient or pattern, as zrender describes one. */
interface ColorStops {
  readonly colorStops?: readonly { readonly color?: unknown }[];
}

const firstStop = (value: ColorStops): string | null => {
  const stop = value.colorStops?.[0]?.color;
  return typeof stop === 'string' ? stop : null;
};

/** Fully transparent is not a colour; it is the absence of one. */
const opaqueEnough = (colour: ChartRgba): ChartRgba | null => (colour[3] <= 0 ? null : colour);

export const parseColour = (value: unknown): ChartRgba | null => {
  if (typeof value === 'object' && value !== null) {
    // A gradient reduced to where it starts. The batch paints flat colours, and
    // the first stop is the honest single answer for a ramp.
    const stop = firstStop(value as ColorStops);
    return stop === null ? null : parseColour(stop);
  }
  if (typeof value !== 'string') return null;
  const text = value.trim().toLowerCase();
  if (text === '' || text === 'none' || text === 'transparent') return null;

  const hex = HEX.exec(text)?.[1];
  if (hex !== undefined) {
    if (hex.length === 3 || hex.length === 4) {
      // A short hex doubles each digit. The pattern already established that
      // there are three or four of them, so each one is there.
      const digit = (index: number): number => {
        const part = hex[index] as string;
        return byte(`${part}${part}`);
      };
      return opaqueEnough([digit(0), digit(1), digit(2), hex.length === 4 ? digit(3) : 1]);
    }
    if (hex.length === 6 || hex.length === 8) {
      return opaqueEnough([
        byte(hex.slice(0, 2)),
        byte(hex.slice(2, 4)),
        byte(hex.slice(4, 6)),
        hex.length === 8 ? byte(hex.slice(6, 8)) : 1,
      ]);
    }
    return null;
  }

  const parts = FUNCTIONAL.exec(text)?.[1];
  if (parts === undefined) return null;
  const numbers = parts
    .split(/[,/\s]+/u)
    .filter((part) => part !== '')
    .map(Number);
  const [r, g, b, a] = numbers;
  if (r === undefined || g === undefined || b === undefined) return null;
  if (![r, g, b].every(Number.isFinite)) return null;
  return opaqueEnough([r / 255, g / 255, b / 255, a === undefined || !Number.isFinite(a) ? 1 : a]);
};

/** Multiplies in an element's own opacity, which zrender keeps separately. */
export const withOpacity = (colour: ChartRgba, opacity: unknown): ChartRgba =>
  typeof opacity === 'number' && Number.isFinite(opacity) && opacity < 1
    ? [colour[0], colour[1], colour[2], colour[3] * Math.max(0, opacity)]
    : colour;

const hexByte = (value: number): string =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');

/** The other direction: a theme colour as ECharts wants to receive it. */
export const toCssColour = (colour: ChartRgba): string =>
  colour[3] >= 1
    ? `#${hexByte(colour[0])}${hexByte(colour[1])}${hexByte(colour[2])}`
    : `rgba(${Math.round(colour[0] * 255)},${Math.round(colour[1] * 255)},${Math.round(colour[2] * 255)},${colour[3]})`;
