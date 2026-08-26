import type { Binding, Rect, ResolvedBinding } from '@panorama/core';
import { RECT_SIDES, rectsIntersect, sideAnchor } from '@panorama/core';
import type { Rgba, TableTheme } from '../theme.js';
import type { PolygonInstance, TextRun } from './draw-list.js';
import { SQL_ICON, SQL_ICON_FONT_SIZE, barRects } from './halo.js';

/**
 * Directional connectors.
 *
 * A connector is drawn, never stored: its geometry is a pure function of the
 * two bound transforms, recomputed each frame. Moving a table therefore
 * re-routes every line attached to it with no bookkeeping, no lifecycle hooks
 * and no extra history commits.
 *
 * Widths are specified in screen pixels and divided by the camera scale, so a
 * line stays visible when the canvas is zoomed out.
 */

export interface ConnectorDrawList {
  /** The line itself, drawn behind the tables it joins. */
  readonly polygons: readonly PolygonInstance[];
  /** The marker, drawn in front so an expanded one is never hidden. */
  readonly markerPolygons: readonly PolygonInstance[];
  readonly texts: readonly TextRun[];
  /** Bounding box in world space, for culling and hit testing. */
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export const EMPTY_CONNECTOR: ConnectorDrawList = Object.freeze({
  polygons: [],
  markerPolygons: [],
  texts: [],
  bounds: Object.freeze({ x: 0, y: 0, width: 0, height: 0 }),
});

export interface ConnectorRenderInput {
  readonly resolved: ResolvedBinding;
  readonly theme: TableTheme;
  /** Camera pixels per world unit. */
  readonly scale?: number;
  readonly highlighted?: boolean;
  /** Expands the marker to spell out what the connection filters on. */
  readonly revealed?: boolean;
  /**
   * Tables the line should go round rather than through — every other table,
   * supplied by the host, which is the only thing that knows about them.
   */
  readonly obstacles?: readonly Rect[];
}

/** The marker sitting on a connector: compact by default, expanded on demand. */
export interface ConnectorMarker {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly icon: { readonly x: number; readonly y: number; readonly size: number };
  readonly label: { readonly text: string; readonly width: number } | null;
}

const rectangle = (
  x: number,
  y: number,
  width: number,
  height: number,
  color: Rgba,
): PolygonInstance => ({
  corners: [x, y, x + width, y, x + width, y + height, x, y + height],
  color,
});

/**
 * A key, drawn from rectangles rather than a glyph.
 *
 * The atlas rasterises whatever the system font provides, and key characters
 * are unevenly supported; geometry renders identically everywhere and stays
 * legible at the sizes a marker uses.
 */
export const keyIcon = (
  x: number,
  y: number,
  size: number,
  color: Rgba,
  holeColor: Rgba,
): readonly PolygonInstance[] => {
  const at = (u: number): number => x + u * size;
  const down = (v: number): number => y + v * size;
  const diamond = (
    centreU: number,
    centreV: number,
    half: number,
    fill: Rgba,
  ): PolygonInstance => ({
    corners: [
      at(centreU),
      down(centreV - half),
      at(centreU + half),
      down(centreV),
      at(centreU),
      down(centreV + half),
      at(centreU - half),
      down(centreV),
    ],
    color: fill,
  });

  return [
    // The bow, and the hole punched through it in the background colour. The
    // hole is what makes this read as a key rather than an arrow at 15 pixels.
    diamond(0.26, 0.5, 0.26, color),
    diamond(0.26, 0.5, 0.115, holeColor),
    // The shaft and two teeth.
    rectangle(at(0.44), down(0.425), size * 0.54, size * 0.15, color),
    rectangle(at(0.62), down(0.575), size * 0.13, size * 0.225, color),
    rectangle(at(0.85), down(0.575), size * 0.13, size * 0.225, color),
  ];
};

/**
 * What a marker stands for.
 *
 * A line drawn by following a foreign key shows a key; a line to a query box
 * shows the same `SQL` mark as the button that opened it. The marker names the
 * relationship, so it has to name the right one.
 */
export type ConnectorIconKind = 'key' | 'sql' | 'chart' | 'rows';

/** A drill-down line carries the same three lines as its button. */
export const ROWS_ICON = '\u2261';

export const connectorIconKind = (binding: Binding): ConnectorIconKind => {
  const kind = binding.meta?.['kind'];
  if (kind === 'query') return 'sql';
  if (kind === 'chart') return 'chart';
  if (kind === 'rows') return 'rows';
  return 'key';
};

const LABEL_CHARACTER_WIDTH = 7.4;

/**
 * Places the marker at the middle of a connector.
 *
 * Takes the path rather than working one out, so that hit testing lands on
 * exactly the marker that was drawn — including the expanded size, so the chip
 * stays under the pointer once it has opened. A marker that recomputed its own
 * curve would sit on the line the connector *would* have taken, which is not
 * where the line is whenever it had to go round something.
 */
export const connectorMarker = (
  path: ConnectorPath,
  binding: Binding,
  theme: TableTheme,
  scale = 1,
  revealed = false,
): ConnectorMarker | null => {
  const label = binding.label;
  if (label === undefined || label === '') return null;
  const safeScale = Math.max(0.05, scale);
  const size = theme.connectorMarkerSize / safeScale;
  const iconSize = theme.connectorMarkerIconSize / safeScale;
  const padding = theme.connectorLabelPaddingX / safeScale;
  const fontSize = theme.connectorLabelFontSize / safeScale;

  const labelWidth = revealed
    ? label.length * LABEL_CHARACTER_WIDTH * (fontSize / (theme.fontSize / safeScale))
    : 0;
  const width = revealed ? size + labelWidth + padding * 2 : size;
  const x = path.midpoint.x - width / 2;
  const y = path.midpoint.y - size / 2;

  return {
    x,
    y,
    width,
    height: size,
    icon: { x: x + (size - iconSize) / 2, y: y + (size - iconSize) / 2, size: iconSize },
    label: revealed ? { text: label, width: labelWidth } : null,
  };
};

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

export interface ConnectorPath {
  /** Points along the curve, start to tip. */
  readonly points: readonly Point2[];
  /** The point half way along it, where the marker sits. */
  readonly midpoint: Point2;
  /** Unit direction at the tip, for the arrowhead. */
  readonly direction: Point2;
  readonly length: number;
}

/** How far the control points reach, as a fraction of end-to-end distance. */
const CURVE_TENSION = 0.42;
const MIN_CONTROL_REACH = 36;
const MAX_CONTROL_REACH = 320;
/** Hard ceiling relative to the span, so short connectors stay tidy. */
const MAX_CONTROL_FRACTION = 0.6;
/** Target length of one sampled segment, in screen pixels. */
const SEGMENT_PIXELS = 9;
const MIN_SEGMENTS = 6;
const MAX_SEGMENTS = 64;

const cubicAt = (a: Point2, b: Point2, c: Point2, d: Point2, t: number): Point2 => {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: a.x * w0 + b.x * w1 + c.x * w2 + d.x * w3,
    y: a.y * w0 + b.y * w1 + c.y * w2 + d.y * w3,
  };
};

/**
 * The curve a connector follows.
 *
 * A cubic that leaves each table along the normal of the edge it meets, the way
 * every node editor draws a link: a straight chord between two borders reads as
 * stiff, and cuts awkwardly across corners when the tables are not aligned.
 * Sampled at roughly nine screen pixels per segment, so the curve stays smooth
 * at any zoom without spending vertices no one can see.
 *
 * Shared by drawing, the arrowhead and the marker, so all three agree on where
 * the line actually goes.
 */
/** One way of getting from one table to another: two anchors and a lean. */
export interface ConnectorShape {
  readonly from: Point2;
  readonly fromNormal: Point2;
  readonly to: Point2;
  readonly toNormal: Point2;
  /**
   * Sideways lean of the whole curve, as a fraction of the distance spanned.
   *
   * Both control points are pushed the same way across the chord, which bends
   * the line around something without moving its ends or changing the direction
   * it leaves either table by — so a route that goes round is still one smooth
   * curve rather than a dog-leg.
   */
  readonly bow?: number;
}

/** The shape a binding takes when nothing is in the way. */
const directShape = (resolved: ResolvedBinding): ConnectorShape => ({
  from: resolved.from,
  fromNormal: resolved.fromNormal,
  to: resolved.to,
  toNormal: resolved.toNormal,
});

export const connectorPath = (
  resolved: ResolvedBinding,
  theme: TableTheme,
  scale = 1,
): ConnectorPath | null =>
  resolved.degenerate ? null : shapedPath(directShape(resolved), theme, scale);

/** Builds the curve for one candidate shape. */
export const shapedPath = (
  shape: ConnectorShape,
  theme: TableTheme,
  scale = 1,
  fixedSegments?: number,
): ConnectorPath | null => {
  const safeScale = Math.max(0.05, scale);
  const gap = theme.connectorGap / safeScale;

  const start = {
    x: shape.from.x + shape.fromNormal.x * gap,
    y: shape.from.y + shape.fromNormal.y * gap,
  };
  const end = {
    x: shape.to.x + shape.toNormal.x * gap,
    y: shape.to.y + shape.toNormal.y * gap,
  };
  const span = Math.hypot(end.x - start.x, end.y - start.y);
  if (span === 0) return null;

  // Also capped by the span itself: a minimum reach larger than the distance
  // being spanned would balloon a short connector into a loop.
  const reach = Math.min(
    span * MAX_CONTROL_FRACTION,
    MAX_CONTROL_REACH / safeScale,
    Math.max(MIN_CONTROL_REACH / safeScale, span * CURVE_TENSION),
  );
  // Across the chord, so a lean bends the curve without tilting either end.
  const lean = (shape.bow ?? 0) * span;
  const sideX = (-(end.y - start.y) / span) * lean;
  const sideY = ((end.x - start.x) / span) * lean;
  const control1 = {
    x: start.x + shape.fromNormal.x * reach + sideX,
    y: start.y + shape.fromNormal.y * reach + sideY,
  };
  const control2 = {
    x: end.x + shape.toNormal.x * reach + sideX,
    y: end.y + shape.toNormal.y * reach + sideY,
  };

  const segments =
    fixedSegments ??
    Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.round((span * safeScale) / SEGMENT_PIXELS)));
  const points: Point2[] = [];
  let length = 0;
  for (let step = 0; step <= segments; step += 1) {
    const point = cubicAt(start, control1, control2, end, step / segments);
    const previous = points[points.length - 1];
    if (previous !== undefined) length += Math.hypot(point.x - previous.x, point.y - previous.y);
    points.push(point);
  }

  const last = points[points.length - 1] as Point2;
  const beforeLast = points[points.length - 2] as Point2;
  const dx = last.x - beforeLast.x;
  const dy = last.y - beforeLast.y;
  const tip = Math.hypot(dx, dy) || 1;

  return {
    points,
    midpoint: cubicAt(start, control1, control2, end, 0.5),
    direction: { x: dx / tip, y: dy / tip },
    length,
  };
};

/**
 * Routing: getting from one table to another without going through a third.
 *
 * A line that passes behind an unrelated table does not read as a line behind a
 * table; it reads as a line that stops and starts again somewhere else. So when
 * the obvious curve would cross something, other ways out of the two tables are
 * tried and the clearest short one wins. Best effort by design: a table boxed in
 * on all sides has no clear route, and the honest thing then is the direct line
 * rather than a loop around the whole canvas.
 *
 * The search is only run when the direct line is actually blocked, so the common
 * case costs one path and a handful of segment tests.
 */

/** How far obstacles are grown before testing, so a route clears them visibly. */
const CLEARANCE = 10;

/**
 * A wider berth, used only to settle ties.
 *
 * Two ways round an obstacle are often exactly the same length — a curve
 * overshoots symmetrically, so over the top and under the bottom cost the same.
 * When that happens the one that leaves more room wins, which is the one a person
 * would have drawn.
 */
const BERTH = CLEARANCE * 6;

/** Sideways leans tried when no straight way out is clear. Symmetric. */
const BOWS: readonly number[] = Object.freeze([0.3, -0.3, 0.6, -0.6]);

/** How many of the straight candidates are worth leaning as well. */
const LEAN_CANDIDATES = 4;

/** Samples used to score a candidate; the drawn curve is smoother than this. */
const SCORING_SEGMENTS = 22;

/** A candidate is only preferred if it is meaningfully clearer or shorter. */
const SCORE_EPSILON = 0.5;

export interface ConnectorRoute {
  readonly path: ConnectorPath;
  /** Arc length that runs through an obstacle. Zero is a clear route. */
  readonly blocked: number;
  /** True when the line goes a way it would not have gone unobstructed. */
  readonly detoured: boolean;
}

const grow = (rect: Rect, by: number): Rect => ({
  x: rect.x - by,
  y: rect.y - by,
  width: rect.width + by * 2,
  height: rect.height + by * 2,
});

/**
 * Whether any part of a segment lies inside a rectangle.
 *
 * Liang–Barsky, which is exact — a sampled point test would let a line tunnel
 * straight through a narrow table between two samples and call it clear.
 */
export const segmentHitsRect = (a: Point2, b: Point2, rect: Rect): boolean => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: readonly (readonly [number, number])[] = [
    [-dx, a.x - rect.x],
    [dx, rect.x + rect.width - a.x],
    [-dy, a.y - rect.y],
    [dy, rect.y + rect.height - a.y],
  ];
  let enter = 0;
  let exit = 1;
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) {
      if (t > exit) return false;
      if (t > enter) enter = t;
    } else {
      if (t < enter) return false;
      if (t < exit) exit = t;
    }
  }
  return true;
};

/**
 * How much of a path runs through something.
 *
 * Counted a segment at a time rather than clipped exactly: a segment that clips
 * two overlapping obstacles must not be charged twice, and at this resolution the
 * difference between "this segment is in the way" and "these nineteen pixels of
 * it are" decides nothing.
 */
export const blockedLength = (points: readonly Point2[], obstacles: readonly Rect[]): number => {
  if (obstacles.length === 0) return 0;
  let blocked = 0;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1] as Point2;
    const b = points[index] as Point2;
    if (obstacles.some((rect) => segmentHitsRect(a, b, rect))) {
      blocked += Math.hypot(b.x - a.x, b.y - a.y);
    }
  }
  return blocked;
};

const centreOf = (rect: Rect): Point2 => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

/**
 * The ways out of the two tables worth trying.
 *
 * Every side of each end, unless the anchor is a fixed one — a fixed anchor is
 * the user's own choice of spot, and moving it would be overruling them.
 */
const sideShapes = (resolved: ResolvedBinding): readonly ConnectorShape[] => {
  const fromAnchors =
    resolved.binding.from.mode === 'auto'
      ? RECT_SIDES.map((side) => sideAnchor(resolved.fromRect, side, centreOf(resolved.toRect)))
      : [{ point: resolved.from, normal: resolved.fromNormal }];
  const toAnchors =
    resolved.binding.to.mode === 'auto'
      ? RECT_SIDES.map((side) => sideAnchor(resolved.toRect, side, centreOf(resolved.fromRect)))
      : [{ point: resolved.to, normal: resolved.toNormal }];

  const shapes: ConnectorShape[] = [];
  for (const from of fromAnchors) {
    for (const to of toAnchors) {
      shapes.push({
        from: from.point,
        fromNormal: from.normal,
        to: to.point,
        toNormal: to.normal,
      });
    }
  }
  return shapes;
};

/**
 * Obstacles a curve between these two tables could possibly touch.
 *
 * Every candidate starts and ends on one of the two rectangles, so its chord
 * fits inside their union and no candidate strays more than about a chord's
 * length beyond it. Anything outside that cannot be hit by any of them — and on
 * a canvas holding thirty tables, that is nearly all of them. Worth a rectangle
 * test each to save a segment test each, several hundred times over.
 *
 * The bound is taken from the union rather than from the direct line, because a
 * route that leaves by the far sides is much longer than the line it replaces
 * and would otherwise be scored against obstacles that had been pruned away.
 */
const nearbyObstacles = (
  resolved: ResolvedBinding,
  obstacles: readonly Rect[],
  clearance: number,
): readonly [readonly Rect[], readonly Rect[]] => {
  const left = Math.min(resolved.fromRect.x, resolved.toRect.x);
  const top = Math.min(resolved.fromRect.y, resolved.toRect.y);
  const right = Math.max(
    resolved.fromRect.x + resolved.fromRect.width,
    resolved.toRect.x + resolved.toRect.width,
  );
  const bottom = Math.max(
    resolved.fromRect.y + resolved.fromRect.height,
    resolved.toRect.y + resolved.toRect.height,
  );
  // The longest chord any candidate can have, plus the room a curve needs to
  // lean away from it.
  const margin = Math.hypot(right - left, bottom - top) * (1 + MAX_CONTROL_FRACTION);
  const reach = {
    x: left - margin,
    y: top - margin,
    width: right - left + margin * 2,
    height: bottom - top + margin * 2,
  };
  const near: Rect[] = [];
  const wide: Rect[] = [];
  for (const rect of obstacles) {
    const grown = grow(rect, clearance);
    if (!rectsIntersect(grown, reach)) continue;
    near.push(grown);
    wide.push(grow(rect, clearance * (BERTH / CLEARANCE)));
  }
  return [near, wide];
};

interface ScoredShape {
  /** `null` for the straight-at-each-other line the binding resolved to. */
  readonly shape: ConnectorShape | null;
  readonly blocked: number;
  readonly length: number;
  /** Blockage at the wider berth: how tightly the route squeezes past. */
  readonly tight: number;
}

/**
 * Clear beats blocked, then shorter beats longer, then roomier beats tighter.
 *
 * Room is last on purpose: it settles the ties that come of a curve overshooting
 * symmetrically, and never buys clearance at the price of a longer way round.
 */
const beats = (candidate: ScoredShape, best: ScoredShape): boolean => {
  if (candidate.blocked < best.blocked - SCORE_EPSILON) return true;
  if (candidate.blocked > best.blocked + SCORE_EPSILON) return false;
  if (candidate.length < best.length - SCORE_EPSILON) return true;
  if (candidate.length > best.length + SCORE_EPSILON) return false;
  return candidate.tight < best.tight - SCORE_EPSILON;
};

/**
 * The route a connector should take, given what is in the way.
 *
 * The straight-at-each-other line first, because it is what the user expects and
 * because most lines are not obstructed at all. Then the other ways out of the
 * two tables. Only if none of those is clear does it start leaning curves
 * sideways, which is the expensive part and also the part that reads as trying
 * too hard — a scene where nothing is clear is a scene where the line should
 * stop wandering and just go.
 */
export const routeConnector = (
  resolved: ResolvedBinding,
  theme: TableTheme,
  scale = 1,
  obstacles: readonly Rect[] = [],
): ConnectorRoute | null => {
  const direct = connectorPath(resolved, theme, scale);
  if (direct === null) return null;
  if (obstacles.length === 0) return { path: direct, blocked: 0, detoured: false };
  const clearance = CLEARANCE / Math.max(0.05, scale);
  const [near, wide] = nearbyObstacles(resolved, obstacles, clearance);
  const directBlocked = blockedLength(direct.points, near);
  if (directBlocked === 0) return { path: direct, blocked: 0, detoured: false };

  const score = (shape: ConnectorShape): ScoredShape | null => {
    const path = shapedPath(shape, theme, scale, SCORING_SEGMENTS);
    return path === null
      ? null
      : {
          shape,
          blocked: blockedLength(path.points, near),
          length: path.length,
          tight: blockedLength(path.points, wide),
        };
  };

  const straight = sideShapes(resolved)
    .map(score)
    .filter((entry): entry is ScoredShape => entry !== null);
  let best: ScoredShape = {
    shape: null,
    blocked: directBlocked,
    length: direct.length,
    tight: blockedLength(direct.points, wide),
  };
  for (const candidate of straight) {
    if (beats(candidate, best)) best = candidate;
  }

  // Nothing got clear by changing sides, so try leaning the curves round.
  if (best.blocked > 0) {
    const leanable = [
      best.shape ?? directShape(resolved),
      ...straight.slice(0, LEAN_CANDIDATES).map((entry) => entry.shape as ConnectorShape),
    ];
    for (const shape of leanable) {
      for (const bow of BOWS) {
        const candidate = score({ ...shape, bow });
        if (candidate !== null && beats(candidate, best)) best = candidate;
      }
    }
  }

  const chosen = best.shape;
  if (chosen === null) return { path: direct, blocked: directBlocked, detoured: false };
  // Re-sampled at drawing resolution: the coarse sampling was for scoring, and a
  // curve drawn at twenty-two segments is visibly faceted.
  const drawn = shapedPath(chosen, theme, scale);
  return drawn === null
    ? { path: direct, blocked: directBlocked, detoured: false }
    : { path: drawn, blocked: best.blocked, detoured: true };
};

/** Drops `amount` of arc length from the end of a polyline. */
const trimEnd = (points: readonly Point2[], amount: number): readonly Point2[] => {
  if (amount <= 0) return points;
  let remaining = amount;
  const kept = [...points];
  while (kept.length > 2) {
    const last = kept[kept.length - 1] as Point2;
    const previous = kept[kept.length - 2] as Point2;
    const segment = Math.hypot(last.x - previous.x, last.y - previous.y);
    if (segment > remaining) {
      const ratio = (segment - remaining) / segment;
      kept[kept.length - 1] = {
        x: previous.x + (last.x - previous.x) * ratio,
        y: previous.y + (last.y - previous.y) * ratio,
      };
      return kept;
    }
    remaining -= segment;
    kept.pop();
  }
  return kept;
};

/**
 * Strokes a polyline into quads.
 *
 * Offsets are taken along the average of the two adjacent segment directions,
 * so consecutive quads share their corners exactly and the ribbon has no
 * notches on the outside of a bend.
 */
const strokePolyline = (
  points: readonly Point2[],
  width: number,
  color: Rgba,
): readonly PolygonInstance[] => {
  if (points.length < 2) return [];
  const half = width / 2;
  const offsets = points.map((point, index) => {
    const previous = points[index - 1] ?? point;
    const next = points[index + 1] ?? point;
    const dx = next.x - previous.x;
    const dy = next.y - previous.y;
    const length = Math.hypot(dx, dy) || 1;
    return { x: (-dy / length) * half, y: (dx / length) * half };
  });

  const quads: PolygonInstance[] = [];
  for (let index = 0; index + 1 < points.length; index += 1) {
    const a = points[index] as Point2;
    const b = points[index + 1] as Point2;
    const oa = offsets[index] as Point2;
    const ob = offsets[index + 1] as Point2;
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

export const buildConnectorDrawList = (input: ConnectorRenderInput): ConnectorDrawList => {
  const { resolved, theme } = input;
  const scale = Math.max(0.05, input.scale ?? 1);
  const route = routeConnector(resolved, theme, scale, input.obstacles);
  if (route === null) return EMPTY_CONNECTOR;
  const path = route.path;

  const width = theme.connectorWidth / scale;
  const arrowLength = theme.connectorArrowLength / scale;
  const arrowWidth = theme.connectorArrowWidth / scale;
  const color = input.highlighted === true ? theme.connectorHighlight : theme.connectorLine;

  const headRoom = resolved.binding.directed ? Math.min(arrowLength, path.length) : 0;
  const shaft = trimEnd(path.points, headRoom);
  const polygons: PolygonInstance[] = [...strokePolyline(shaft, width, color)];

  if (resolved.binding.directed) {
    const tip = path.points[path.points.length - 1] as Point2;
    const base = shaft[shaft.length - 1] as Point2;
    const px = -path.direction.y;
    const py = path.direction.x;
    // A triangle, expressed as a quad with a repeated tip corner.
    polygons.push({
      corners: [
        tip.x,
        tip.y,
        base.x + px * (arrowWidth / 2),
        base.y + py * (arrowWidth / 2),
        base.x - px * (arrowWidth / 2),
        base.y - py * (arrowWidth / 2),
        tip.x,
        tip.y,
      ],
      color,
    });
  }

  const texts: TextRun[] = [];
  const markerPolygons: PolygonInstance[] = [];
  const marker = connectorMarker(path, resolved.binding, theme, scale, input.revealed === true);
  if (marker !== null) {
    const revealed = input.revealed === true;
    const background = revealed
      ? theme.connectorMarkerHoverBackground
      : theme.connectorMarkerBackground;
    const border = Math.max(0.5, theme.borderWidth / scale);

    markerPolygons.push(
      rectangle(marker.x, marker.y, marker.width, marker.height, theme.connectorMarkerBorder),
    );
    markerPolygons.push(
      rectangle(
        marker.x + border,
        marker.y + border,
        marker.width - border * 2,
        marker.height - border * 2,
        background,
      ),
    );
    const iconColor = revealed ? theme.connectorMarkerHoverIcon : theme.connectorMarkerIcon;
    const kind = connectorIconKind(resolved.binding);
    if (kind === 'key') {
      markerPolygons.push(
        ...keyIcon(marker.icon.x, marker.icon.y, marker.icon.size, iconColor, background),
      );
    } else if (kind === 'chart') {
      // Bars, from the same geometry as the halo button that drew this line.
      markerPolygons.push(
        ...barRects(marker.icon.x, marker.icon.y, marker.icon.size).map((bar) =>
          rectangle(bar.x, bar.y, bar.width, bar.height, iconColor),
        ),
      );
    } else {
      // Centred in the whole marker square rather than the inner icon box: a
      // three-letter word needs the width a key does not.
      texts.push({
        x: marker.x,
        y: marker.y,
        maxWidth: theme.connectorMarkerSize / scale,
        height: marker.height,
        text: kind === 'sql' ? SQL_ICON : ROWS_ICON,
        color: iconColor,
        align: 'center',
        fontSize: SQL_ICON_FONT_SIZE / scale,
        bold: true,
      });
    }

    if (revealed && marker.label !== null) {
      texts.push({
        x: marker.icon.x + marker.icon.size + theme.connectorLabelPaddingX / scale,
        y: marker.y,
        maxWidth: marker.label.width,
        height: marker.height,
        text: marker.label.text,
        color: theme.connectorMarkerHoverIcon,
        align: 'left',
        fontSize: theme.connectorLabelFontSize / scale,
      });
    }
  }

  // The curve bows outside the straight box between the two ends, so bounds
  // come from the sampled points.
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of path.points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const margin = Math.max(arrowWidth, marker === null ? 0 : marker.width);
  return {
    polygons,
    markerPolygons,
    texts,
    bounds: {
      x: minX - margin,
      y: minY - margin,
      width: maxX - minX + margin * 2,
      height: maxY - minY + margin * 2,
    },
  };
};
