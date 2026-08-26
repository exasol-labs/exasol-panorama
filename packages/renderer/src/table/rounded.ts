/**
 * A rounded rectangle, as axis-aligned strips.
 *
 * The DOM rounds a corner with one declaration. Here there is no such
 * declaration, and — because of the ordering law — not much choice about how to
 * get one either: **all polygons draw before all quads** (see
 * `docs/ARCHITECTURE.md` §8.2), and the halo draws on top of tables, whose bodies
 * are quads. So a halo button cannot be a polygon with arcs in it; whatever shape
 * it has must be built from quads.
 *
 * Which is what this is: the rectangle as a full-width middle band plus a few
 * horizontal strips at each end, inset to follow the corner arc. A staircase,
 * and the reason it does not look like one is the step count — the halo is drawn
 * at a constant *screen* size, so the number of steps is chosen from the radius
 * in screen pixels and each step is a fraction of a pixel high. At the radius the
 * explorer uses, three pixels, that is four steps of three quarters of a pixel.
 *
 * The cost is a handful of quads per button against the thousands a table draws,
 * which is why this is affordable and why no cleverer scheme is called for.
 */

export interface StripRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * How finely a corner is stepped, per screen pixel of radius.
 *
 * At the halo's three-pixel radius this gives five steps of about six tenths of a
 * screen pixel each — one or two device pixels on a doubled display, which is a
 * staircase on paper and a curve in practice, because the arc it is approximating
 * is three pixels long. Checked by screenshot at four times scale rather than
 * argued about: `scripts/shots/halo@4x.png`.
 *
 * Not device-pixel aware, deliberately: the renderer works in screen pixels and
 * threading the display's ratio down here would buy a smoothness nobody can see
 * on a shape this size.
 */
const STEPS_PER_PIXEL = 1.5;
const MIN_STEPS = 2;
const MAX_STEPS = 8;

/**
 * The strips that fill a rounded rectangle.
 *
 * `radius` and the rectangle are in the same units, and `scale` says how many
 * screen pixels one of those units is — the step count is a question about how
 * the result will look, which is a question about pixels.
 *
 * A radius of zero, or one the rectangle is too small to honour, degrades to the
 * plain rectangle rather than to something subtly wrong: a 6-unit-tall button
 * asked for a 4-unit radius is a lozenge nobody designed.
 */
export const roundedRectStrips = (
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
  scale = 1,
): readonly StripRect[] => {
  const limit = Math.min(width, height) / 2;
  const r = Math.min(Math.max(radius, 0), Math.max(limit, 0));
  if (r <= 0 || width <= 0 || height <= 0) {
    return width > 0 && height > 0 ? [{ x, y, width, height }] : [];
  }
  const steps = Math.min(
    MAX_STEPS,
    Math.max(MIN_STEPS, Math.ceil(r * Math.max(scale, 0.05) * STEPS_PER_PIXEL)),
  );
  const strips: StripRect[] = [];
  for (let step = 0; step < steps; step += 1) {
    const from = (step * r) / steps;
    const to = ((step + 1) * r) / steps;
    /**
     * The inset is measured at the middle of the strip rather than at its outer
     * edge. Taken at the edge, every strip would sit inside the true arc and the
     * corner would read as visibly clipped; at the middle the error alternates
     * either side of the curve and cancels to the eye.
     */
    const above = r - (from + to) / 2;
    const inset = r - Math.sqrt(Math.max(0, r * r - above * above));
    const stripWidth = width - inset * 2;
    if (stripWidth <= 0) continue;
    const stripHeight = to - from;
    strips.push({ x: x + inset, y: y + from, width: stripWidth, height: stripHeight });
    strips.push({
      x: x + inset,
      y: y + height - to,
      width: stripWidth,
      height: stripHeight,
    });
  }
  const middle = height - r * 2;
  if (middle > 0) strips.push({ x, y: y + r, width, height: middle });
  return strips;
};
