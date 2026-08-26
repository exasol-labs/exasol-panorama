import type { ChartDrawList, ChartMark, ChartPolygon, ChartRgba } from './draw-list.js';
import { sameChartMark } from './draw-list.js';

/**
 * Pointing at a chart, and picking parts of it out.
 *
 * Both are done against the geometry rather than through the library that laid it
 * out. Not for want of trying: a chart library's own hover and selection are
 * driven by DOM events on a canvas it owns, and there is no such canvas here —
 * the pointer is Panorama's, arriving from a mouse, a finger or a ray in a
 * headset, and there is no DOM at all in the last of those.
 *
 * So the geometry carries which mark each piece belongs to, hit testing is a
 * point in a polygon, and the effects are colour: the same shape of solution as
 * the hovered row and the picked-out column, and it reads as part of the same
 * application rather than as a chart library's idea of highlighting.
 */

interface Point {
  readonly x: number;
  readonly y: number;
}

const cross = (o: Point, a: Point, b: Point): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

const inTriangle = (p: Point, a: Point, b: Point, c: Point): boolean => {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
};

/**
 * Whether a point is inside a quad, taken as its two triangles.
 *
 * Two rather than one polygon test because a quad from a chart is not reliably
 * convex — a triangle written as a quad repeats its last corner, and a stroked
 * segment's corners are mitred.
 */
const inside = (polygon: ChartPolygon, point: Point): boolean => {
  const c = polygon.corners;
  const corner = (index: 0 | 2 | 4 | 6): Point => ({
    x: c[index] as number,
    y: c[index + 1] as number,
  });
  const a = corner(0);
  const b = corner(2);
  const d = corner(4);
  const e = corner(6);
  return inTriangle(point, a, b, d) || inTriangle(point, a, d, e);
};

/**
 * The mark under a point, in chart-local coordinates.
 *
 * Searched from the front, because the geometry is in painter's order and what
 * was drawn last is what a person sees and therefore what they are pointing at.
 */
export const chartMarkAt = (drawList: ChartDrawList, x: number, y: number): ChartMark | null => {
  const point = { x, y };
  for (let index = drawList.polygons.length - 1; index >= 0; index -= 1) {
    const polygon = drawList.polygons[index] as ChartPolygon;
    if (polygon.mark === undefined) continue;
    if (inside(polygon, point)) return polygon.mark;
  }
  return null;
};

/** How far a hovered mark is lifted towards white. */
const HOVER_LIFT = 0.22;
/** What the marks nobody picked out fade to, once something has been picked. */
const BLUR_ALPHA = 0.28;

const lift = (colour: ChartRgba, amount: number): ChartRgba => [
  colour[0] + (1 - colour[0]) * amount,
  colour[1] + (1 - colour[1]) * amount,
  colour[2] + (1 - colour[2]) * amount,
  colour[3],
];

const fade = (colour: ChartRgba, alpha: number): ChartRgba => [
  colour[0],
  colour[1],
  colour[2],
  colour[3] * alpha,
];

export interface ChartEmphasis {
  /** The mark under the pointer, brightened. */
  readonly hovered?: ChartMark | null;
  /** The marks picked out. Everything else fades, which is what says "these". */
  readonly selected?: readonly ChartMark[];
}

const isSelected = (selected: readonly ChartMark[], mark: ChartMark | undefined): boolean =>
  mark !== undefined && selected.some((entry) => sameChartMark(entry, mark));

/**
 * Applies hover and selection to a laid-out chart.
 *
 * A colour transform over the geometry, not a re-layout: nothing moves, so
 * pointing at a chart cannot make it jump, and the answer is cheap enough to
 * recompute whenever the pointer crosses a boundary.
 *
 * Fading the rest rather than outlining the chosen, because an outline needs
 * geometry that is not there and a fade needs none — and because "these ones,
 * not those" is what a person actually wants to see.
 */
export const emphasiseChart = (drawList: ChartDrawList, emphasis: ChartEmphasis): ChartDrawList => {
  const hovered = emphasis.hovered ?? null;
  const selected = emphasis.selected ?? [];
  if (hovered === null && selected.length === 0) return drawList;

  const restyle = <TPiece extends { readonly color: ChartRgba; readonly mark?: ChartMark }>(
    piece: TPiece,
  ): TPiece => {
    const mark = piece.mark;
    if (mark === undefined) return piece;
    if (selected.length > 0 && !isSelected(selected, mark)) {
      return { ...piece, color: fade(piece.color, BLUR_ALPHA) };
    }
    return sameChartMark(hovered, mark)
      ? { ...piece, color: lift(piece.color, HOVER_LIFT) }
      : piece;
  };

  return {
    polygons: drawList.polygons.map(restyle),
    texts: drawList.texts.map(restyle),
  };
};
