import type { Rect, Size2 } from './geometry.js';
import { rectsIntersect } from './geometry.js';

/**
 * Where to put something new.
 *
 * Two things want an answer, and they want the same shape of answer measured
 * from different places. A table opened from the explorer wants to be near the
 * explorer, which on screen is the left edge of the viewport. A table opened by
 * following a foreign key wants to be beside the table the key came from, which
 * is that table's right edge — the line between them is the point, and a long
 * line is a worse line.
 *
 * So "near" is measured from a vertical *segment* the new entity should end up
 * alongside. Distance to a segment is zero anywhere along it, so a spot pushed
 * up or down but still hugging the edge beats one shoved sideways past a
 * neighbour — which is exactly the difference between a followed table sitting
 * next to its source and sitting two tables away from it.
 *
 * The explorer's anchor is a segment of no length — a corner. That puts the
 * distance back into the vertical, so tables opened from the explorer fill the
 * view across before they fill it down, in reading order, instead of stacking in
 * one column down the left. One rule, two shapes of anchor.
 *
 * Two rules, in order. *Inside the viewport beats close to the edge*: a table
 * the user cannot see is worse than one a little further along, so the whole
 * visible area is used before any of it spills over. Then, among the spots that
 * qualify, the closest to the edge wins; ties go to whichever is most nearly
 * level with the edge's own top, and then to the leftmost.
 *
 * Candidates are the corners existing entities make rather than a lattice over
 * the world. A new table can only ever be flush against the right or the bottom
 * of something already there — anywhere else either overlaps or leaves a gap
 * nothing will fit into — so the search is a handful of positions rather than
 * thousands, it costs nothing at any zoom, and what comes out is aligned with
 * its neighbours instead of merely not touching them.
 */

/** Room left between entities, and between an entity and the viewport's edge. */
export const DEFAULT_PLACEMENT_GAP = 48;

export interface Placement {
  readonly x: number;
  readonly y: number;
}

/**
 * The edge a new entity gathers along, and the line it may not cross.
 *
 * A vertical segment: `x` is the line, and `top`..`bottom` the stretch of it
 * that counts as being *beside* rather than merely to the right.
 */
export interface PlacementAnchor {
  readonly x: number;
  readonly top: number;
  readonly bottom: number;
}

export interface PlacementRequest {
  /** Size of the entity being placed; a free spot depends on how big it is. */
  readonly size: Size2;
  /** What is already taken. Anything not a rectangle is not in the way. */
  readonly occupied: readonly Rect[];
  /**
   * The world rectangle currently on screen. Placement prefers a spot wholly
   * inside it; the caller reveals whatever comes back, which is a no-op when it
   * already fits.
   */
  readonly viewport: Rect;
  /**
   * Defaults to the viewport's top-left corner, a gap in — beside the explorer.
   * A corner is a segment of no length, which is what makes the default fill the
   * view in reading order while a real edge hugs the table it belongs to.
   */
  readonly anchor?: PlacementAnchor;
  readonly gap?: number;
}

/** Candidate x and y values: the anchor, and the edges of everything taken. */
const candidateEdges = (
  occupied: readonly Rect[],
  anchor: PlacementAnchor,
  viewport: Rect,
  gap: number,
): { readonly xs: readonly number[]; readonly ys: readonly number[] } => {
  const xs = new Set<number>([anchor.x]);
  // Level with the edge, and level with the top of the view: the two positions
  // that look deliberate rather than merely free.
  const ys = new Set<number>([anchor.top, viewport.y + gap]);
  for (const rect of occupied) {
    xs.add(rect.x + rect.width + gap);
    ys.add(rect.y + rect.height + gap);
    // Aligning with a neighbour's own edge is what makes rows and columns of
    // tables line up rather than merely miss each other.
    xs.add(rect.x);
    ys.add(rect.y);
  }
  return { xs: [...xs], ys: [...ys] };
};

const fits = (rect: Rect, viewport: Rect, gap: number): boolean =>
  rect.x >= viewport.x + gap &&
  rect.y >= viewport.y + gap &&
  rect.x + rect.width <= viewport.x + viewport.width - gap &&
  rect.y + rect.height <= viewport.y + viewport.height - gap;

const isFree = (rect: Rect, occupied: readonly Rect[]): boolean =>
  !occupied.some((taken) => rectsIntersect(rect, taken));

/**
 * The rectangle a placement would occupy.
 *
 * Built field by field rather than by spreading: a caller may reasonably pass a
 * whole `EntityTransform` as the size, and that carries an `x` and a `y` of its
 * own which a spread would let win over the placement's.
 */
const rectAt = (at: Placement, size: Size2): Rect => ({
  x: at.x,
  y: at.y,
  width: size.width,
  height: size.height,
});

/** How far a rectangle falls short of being level with the anchor's segment. */
const verticalMiss = (rect: Rect, anchor: PlacementAnchor): number => {
  if (rect.y + rect.height <= anchor.top) return anchor.top - (rect.y + rect.height);
  if (rect.y >= anchor.bottom) return rect.y - anchor.bottom;
  return 0;
};

/**
 * Ranking, most significant first: in view, near the edge, level with it, left.
 *
 * Being *level* is the tie-break rather than being high up, because every spot
 * along the edge is equally close to it — and of those, the one lined up with
 * the table it belongs beside is the one that looks placed rather than dropped.
 */
type PlacementKey = readonly [number, number, number, number];

const placementKey = (
  rect: Rect,
  anchor: PlacementAnchor,
  viewport: Rect,
  gap: number,
): PlacementKey => {
  const dx = rect.x - anchor.x;
  const dy = verticalMiss(rect, anchor);
  return [
    fits(rect, viewport, gap) ? 0 : 1,
    dx * dx + dy * dy,
    Math.abs(rect.y - anchor.top),
    rect.x,
  ];
};

const better = (a: PlacementKey, b: PlacementKey): boolean => {
  for (let index = 0; index < a.length; index += 1) {
    const left = a[index] as number;
    const right = b[index] as number;
    if (left !== right) return left < right;
  }
  return false;
};

export const findFreePlacement = (request: PlacementRequest): Placement => {
  const gap = request.gap ?? DEFAULT_PLACEMENT_GAP;
  const { size, occupied, viewport } = request;
  const anchor: PlacementAnchor = request.anchor ?? {
    x: viewport.x + gap,
    top: viewport.y + gap,
    // A corner, not the whole left edge: a segment of no length puts distance
    // back into the vertical, so the view fills across before it fills down.
    bottom: viewport.y + gap,
  };
  // Never left of the edge, and never above the view — nobody is looking there.
  const minY = Math.min(anchor.top, viewport.y + gap);

  /**
   * The column to the right of everything, which cannot overlap anything and so
   * is always available. Starting from it means the search only ever improves on
   * a known answer, and needs no fallback for having found nothing.
   */
  let best: Placement = {
    x: occupied.reduce((right, rect) => Math.max(right, rect.x + rect.width + gap), anchor.x),
    y: anchor.top,
  };
  let bestKey = placementKey(rectAt(best, size), anchor, viewport, gap);

  const { xs, ys } = candidateEdges(occupied, anchor, viewport, gap);
  for (const x of xs) {
    for (const y of ys) {
      if (x < anchor.x || y < minY) continue;
      const rect = rectAt({ x, y }, size);
      if (!isFree(rect, occupied)) continue;
      const key = placementKey(rect, anchor, viewport, gap);
      if (better(key, bestKey)) {
        best = { x, y };
        bestKey = key;
      }
    }
  }

  return best;
};

/** The right-hand edge of an entity, as an anchor to place beside it. */
export const rightEdgeAnchor = (rect: Rect, gap: number): PlacementAnchor => ({
  x: rect.x + rect.width + gap,
  top: rect.y,
  bottom: rect.y + rect.height,
});
