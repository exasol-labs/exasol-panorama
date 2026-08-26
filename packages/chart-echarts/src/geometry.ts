import type { ChartPolygon, ChartRgba } from '@panorama/chart';

/**
 * Turning zrender paths into triangles.
 *
 * Every zrender shape emits itself through `buildPath(context, shape)` into
 * something that looks like a canvas 2D path. That is the seam: give it a context
 * that records geometry instead of painting, and one adapter covers every shape
 * type there is — rectangles, sectors, polylines, scatter symbols — with no
 * per-chart-type code and nothing to update when a new chart type appears.
 */

export interface ChartPoint {
  readonly x: number;
  readonly y: number;
}

export interface SubPath {
  readonly points: readonly ChartPoint[];
  readonly closed: boolean;
}

/**
 * Segments a full turn is cut into, at most, and how radius earns them.
 *
 * A pie the size of a panel needs every one of them to read as round; a scatter
 * dot four pixels across needs eight and would cost sixty-two triangles each if
 * it got the same treatment as the pie. So the count follows the radius, which is
 * what keeps a five-hundred-point scatter from becoming thirty thousand quads.
 */
const MAX_ARC_SEGMENTS = 64;
const MIN_ARC_SEGMENTS = 6;
const SEGMENTS_PER_UNIT = 0.8;
/** Segments a curve is cut into. Charts use curves sparingly. */
const CURVE_SEGMENTS = 16;

/**
 * A path context that yields polylines rather than pixels.
 *
 * The method names are canvas's because that is the interface zrender writes to.
 * Only the handful of calls charts actually make are implemented as geometry;
 * the rest are here so that a shape reaching for one is a compile error rather
 * than a silently missing piece of a picture.
 */
export class PolylineContext {
  readonly #subpaths: SubPath[] = [];
  #current: ChartPoint[] = [];

  get subpaths(): readonly SubPath[] {
    this.#flush(false);
    return this.#subpaths;
  }

  moveTo(x: number, y: number): void {
    this.#flush(false);
    this.#current = [{ x, y }];
  }

  lineTo(x: number, y: number): void {
    this.#current.push({ x, y });
  }

  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void {
    const from = this.#current[this.#current.length - 1] ?? { x, y };
    for (let step = 1; step <= CURVE_SEGMENTS; step += 1) {
      const t = step / CURVE_SEGMENTS;
      const u = 1 - t;
      this.#current.push({
        x: u * u * u * from.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * x,
        y: u * u * u * from.y + 3 * u * u * t * c1y + 3 * u * t * t * c2y + t * t * t * y,
      });
    }
  }

  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    const from = this.#current[this.#current.length - 1] ?? { x, y };
    // Raised to a cubic rather than given its own loop: one flattener, and the
    // two control points of the equivalent cubic are a third of the way along.
    this.bezierCurveTo(
      from.x + (2 / 3) * (cx - from.x),
      from.y + (2 / 3) * (cy - from.y),
      x + (2 / 3) * (cx - x),
      y + (2 / 3) * (cy - y),
      x,
      y,
    );
  }

  arc(
    cx: number,
    cy: number,
    radius: number,
    from: number,
    to: number,
    counterClockwise = false,
  ): void {
    let sweep = to - from;
    // Canvas semantics: the direction decides which way round, and a sweep the
    // wrong side of zero has gone the long way.
    if (counterClockwise && sweep > 0) sweep -= Math.PI * 2;
    if (!counterClockwise && sweep < 0) sweep += Math.PI * 2;
    const perTurn = Math.min(
      MAX_ARC_SEGMENTS,
      MIN_ARC_SEGMENTS + Math.abs(radius) * SEGMENTS_PER_UNIT,
    );
    const segments = Math.max(
      2,
      Math.ceil((Math.abs(sweep) / (Math.PI * 2)) * Math.max(MIN_ARC_SEGMENTS, perTurn)),
    );
    for (let step = 0; step <= segments; step += 1) {
      const angle = from + (sweep * step) / segments;
      this.#current.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }
  }

  rect(x: number, y: number, width: number, height: number): void {
    // Normalised, because a bar growing upwards has a negative height.
    const left = Math.min(x, x + width);
    const top = Math.min(y, y + height);
    const right = Math.max(x, x + width);
    const bottom = Math.max(y, y + height);
    this.#flush(false);
    this.#current = [
      { x: left, y: top },
      { x: right, y: top },
      { x: right, y: bottom },
      { x: left, y: bottom },
    ];
    this.#flush(true);
  }

  closePath(): void {
    this.#flush(true);
  }

  #flush(closed: boolean): void {
    if (this.#current.length >= 2) this.#subpaths.push({ points: this.#current, closed });
    this.#current = [];
  }
}

/** A 2×3 affine transform, as zrender carries it: `[a, b, c, d, e, f]`. */
export type Affine = readonly number[];

export const applyAffine = (matrix: Affine | undefined, point: ChartPoint): ChartPoint => {
  if (matrix === undefined) return point;
  const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = matrix;
  return { x: a * point.x + c * point.y + e, y: b * point.x + d * point.y + f };
};

const cross = (o: ChartPoint, a: ChartPoint, b: ChartPoint): number =>
  (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

const inTriangle = (p: ChartPoint, a: ChartPoint, b: ChartPoint, c: ChartPoint): boolean => {
  const d1 = cross(a, b, p);
  const d2 = cross(b, c, p);
  const d3 = cross(c, a, p);
  return (d1 >= 0 && d2 >= 0 && d3 >= 0) || (d1 <= 0 && d2 <= 0 && d3 <= 0);
};

const signedArea = (points: readonly ChartPoint[]): number => {
  let total = 0;
  for (let index = 0; index < points.length; index += 1) {
    const a = points[index] as ChartPoint;
    const b = points[(index + 1) % points.length] as ChartPoint;
    total += a.x * b.y - b.x * a.y;
  }
  return total / 2;
};

/**
 * Cuts a filled outline into triangles by clipping ears.
 *
 * Hand-rolled rather than pulled in, in the same spirit as the rest of this
 * repository, and because the shapes a chart fills are kind: rectangles,
 * sectors, and areas that are monotone in one axis. Ear clipping is exact for
 * all of them, and for a self-crossing outline it stops rather than looping —
 * a partial fill being better than a hung frame.
 */
export const triangulate = (
  outline: readonly ChartPoint[],
): readonly (readonly [ChartPoint, ChartPoint, ChartPoint])[] => {
  const points = outline.filter((point, index) => {
    const previous = outline[index - 1];
    return previous === undefined || previous.x !== point.x || previous.y !== point.y;
  });
  if (points.length < 3) return [];
  const wound = signedArea(points) < 0 ? [...points].reverse() : points;
  const remaining = wound.map((_, index) => index);
  const triangles: (readonly [ChartPoint, ChartPoint, ChartPoint])[] = [];
  let guard = remaining.length * remaining.length;

  while (remaining.length > 3 && guard > 0) {
    guard -= 1;
    let clipped = false;
    for (let slot = 0; slot < remaining.length; slot += 1) {
      const previous = wound[remaining[(slot - 1 + remaining.length) % remaining.length] as number];
      const current = wound[remaining[slot] as number];
      const next = wound[remaining[(slot + 1) % remaining.length] as number];
      if (previous === undefined || current === undefined || next === undefined) continue;
      if (cross(previous, current, next) <= 0) continue;
      const blocked = remaining.some((index, other) => {
        if (
          other === slot ||
          other === (slot - 1 + remaining.length) % remaining.length ||
          other === (slot + 1) % remaining.length
        ) {
          return false;
        }
        const point = wound[index] as ChartPoint;
        return inTriangle(point, previous, current, next);
      });
      if (blocked) continue;
      triangles.push([previous, current, next]);
      remaining.splice(slot, 1);
      clipped = true;
      break;
    }
    // No ear anywhere means the outline crosses itself. Keep what was found.
    if (!clipped) return triangles;
  }
  const [a, b, c] = remaining.map((index) => wound[index] as ChartPoint);
  if (a !== undefined && b !== undefined && c !== undefined) triangles.push([a, b, c]);
  return triangles;
};

const triangle = (a: ChartPoint, b: ChartPoint, c: ChartPoint, color: ChartRgba): ChartPolygon => ({
  // A repeated last corner is how the quad batch takes a triangle.
  corners: [a.x, a.y, b.x, b.y, c.x, c.y, c.x, c.y],
  color,
});

export const fillOutline = (
  outline: readonly ChartPoint[],
  color: ChartRgba,
): readonly ChartPolygon[] => triangulate(outline).map(([a, b, c]) => triangle(a, b, c, color));

/** Strokes a polyline as a ribbon of quads, mitred at the joins. */
export const strokeOutline = (
  points: readonly ChartPoint[],
  width: number,
  color: ChartRgba,
  closed = false,
): readonly ChartPolygon[] => {
  const path = closed && points.length > 2 ? [...points, points[0] as ChartPoint] : points;
  if (path.length < 2) return [];
  const half = Math.max(width, 0.5) / 2;
  const offsets = path.map((point, index) => {
    const previous = path[index - 1] ?? point;
    const next = path[index + 1] ?? point;
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: (-dy / length) * half, y: (dx / length) * half };
  });
  const quads: ChartPolygon[] = [];
  for (let index = 0; index + 1 < path.length; index += 1) {
    const a = path[index] as ChartPoint;
    const b = path[index + 1] as ChartPoint;
    const oa = offsets[index] as ChartPoint;
    const ob = offsets[index + 1] as ChartPoint;
    quads.push({
      corners: [
        a.x + oa.x,
        a.y + oa.y,
        b.x + ob.x,
        b.y + ob.y,
        b.x - ob.x,
        b.y - ob.y,
        a.x - oa.x,
        a.y - oa.y,
      ],
      color,
    });
  }
  return quads;
};
