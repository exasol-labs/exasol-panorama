import type { Rect, Vec3 } from './geometry.js';
import { clamp } from './geometry.js';
import type { BindingId, EntityId } from './ids.js';
import type { WorldState } from './world.js';

/**
 * Bindings.
 *
 * A binding is a persistent relationship between two entities that survives
 * either of them moving. The model follows tldraw's: a binding is its own
 * record with `fromId` and `toId`, and the relationship is asymmetric — the
 * `from` end depends on, or points at, the `to` end.
 *
 * One deliberate difference. tldraw recomputes bound geometry in lifecycle
 * hooks that write back to the shape records. Panorama derives it every frame
 * instead: a connector's endpoints are a pure function of the two transforms,
 * so nothing has to be kept in sync, moving a table appends no extra commits,
 * and no derived geometry leaks into document history.
 */

/** Where a binding attaches to an entity. */
export type BindingAnchor =
  /**
   * Tracks the point on the entity's border facing the other end. This is what
   * makes a connector "mobile": the attachment slides around the border as
   * either entity moves.
   */
  | { readonly mode: 'auto' }
  /**
   * A fixed point in the entity's own normalised space, `0..1` on each axis.
   * This is the "sticky" attachment: the same spot on the entity, wherever the
   * entity goes.
   */
  | { readonly mode: 'fixed'; readonly x: number; readonly y: number };

export const AUTO_ANCHOR: BindingAnchor = Object.freeze({ mode: 'auto' });

/**
 * Kinds of binding.
 *
 * `connector` draws a line between two entities and moves neither of them: a
 * followed foreign key, a query built on a table, a chart of one.
 *
 * `data` is a connector that also *means* something to the box it points at: it
 * supplies one of a chart's named data sets, and its label is the name. That is
 * the whole of the mechanism — a chart's specification says what shape each data
 * set has, and the arrow says which box it reads. Drawn the same way as any other
 * line, deliberately: the canvas then shows what feeds what, and removing the
 * arrow is how you stop it feeding.
 *
 * `filter` is the other way round: it does not supply rows, it supplies a
 * *predicate*. What is picked out in the box it comes from becomes the `{{name}}`
 * its label names, wherever the box it points at writes that name in a statement.
 * Cross-filtering, declared spatially — click a cell, and everything downstream
 * of the arrow re-scopes.
 *
 * The next kind will be an attachment, where `fromId`'s transform is derived from
 * `toId`'s — a note stuck to a table. It plugs in at `resolveBinding` and in the
 * renderer, and needs an entity type that can be attached, which Stage 1 does not
 * yet have.
 */
export type BindingKind = 'connector' | 'data' | 'filter';

export const BINDING_KINDS: readonly BindingKind[] = Object.freeze(['connector', 'data', 'filter']);

export interface Binding {
  readonly id: BindingId;
  readonly kind: BindingKind;
  /** The end the relationship points *from*. */
  readonly fromId: EntityId;
  /** The end it points *to*; a directed connector draws its arrowhead here. */
  readonly toId: EntityId;
  readonly from: BindingAnchor;
  readonly to: BindingAnchor;
  readonly directed: boolean;
  /** Shown along the line, e.g. `COUNTRY → COUNTRIES.CODE`. */
  readonly label?: string;
  /** Machine-readable detail for agents and for reopening the target. */
  readonly meta?: Readonly<Record<string, string>>;
}

/**
 * Which box supplies each of a chart's named data sets.
 *
 * Read from the bindings rather than from the specification, so the fact lives in
 * one place: the specification says what shape a data set has and the arrow says
 * where its rows come from. A name with no arrow reads the chart's own relation,
 * which is what every chart did before there were arrows.
 */
export const dataSourcesOf = (
  world: WorldState,
  chartId: EntityId,
): ReadonlyMap<string, EntityId> => {
  const sources = new Map<string, EntityId>();
  for (const binding of world.bindings.values()) {
    if (binding.kind !== 'data' || binding.toId !== chartId) continue;
    const name = binding.label ?? '';
    // A data binding with no name feeds nothing: there is no data set to be.
    // Refused when it is made, so this is only ever belt and braces.
    if (name !== '' && !sources.has(name)) sources.set(name, binding.fromId);
  }
  return sources;
};

/**
 * Which box decides each `{{name}}` a statement leaves open.
 *
 * The same shape as `dataSourcesOf` and for the same reason: the arrow is the
 * fact, so the canvas shows what scopes what and cutting the line is how you stop
 * it scoping.
 */
export const filterSourcesOf = (
  world: WorldState,
  tableId: EntityId,
): ReadonlyMap<string, EntityId> => {
  const sources = new Map<string, EntityId>();
  for (const binding of world.bindings.values()) {
    if (binding.kind !== 'filter' || binding.toId !== tableId) continue;
    const name = binding.label ?? '';
    if (name !== '' && !sources.has(name)) sources.set(name, binding.fromId);
  }
  return sources;
};

export const bindingsOf = (world: WorldState, entityId: EntityId): readonly Binding[] =>
  [...world.bindings.values()].filter(
    (binding) => binding.fromId === entityId || binding.toId === entityId,
  );

export const bindingsFrom = (world: WorldState, entityId: EntityId): readonly Binding[] =>
  [...world.bindings.values()].filter((binding) => binding.fromId === entityId);

export const entityRect = (transform: {
  x: number;
  y: number;
  width: number;
  height: number;
}): Rect => ({
  x: transform.x,
  y: transform.y,
  width: transform.width,
  height: transform.height,
});

const centreOf = (rect: Rect): { x: number; y: number } => ({
  x: rect.x + rect.width / 2,
  y: rect.y + rect.height / 2,
});

/**
 * The entities a binding's line has to get past: everything except its own ends.
 *
 * One function so that drawing and hit testing are looking at the same
 * obstacles. If they disagreed, the marker would be picked where the line is not.
 */
export const connectorObstacles = (
  world: WorldState,
  binding: Binding,
  transformOf?: (id: EntityId) => (Vec3 & { width: number; height: number }) | undefined,
): readonly Rect[] => {
  const rects: Rect[] = [];
  for (const entity of world.entities.values()) {
    if (entity.id === binding.fromId || entity.id === binding.toId) continue;
    rects.push(entityRect(transformOf?.(entity.id) ?? entity.transform));
  }
  return rects;
};

export interface Point2 {
  readonly x: number;
  readonly y: number;
}

/** Where a binding meets an entity, and which way it leaves. */
export interface AnchorResolution {
  readonly point: Point2;
  /**
   * Outward unit normal of the edge the anchor sits on. A connector leaves
   * along it, which is what lets the line curve away from the table instead of
   * cutting across its corner.
   */
  readonly normal: Point2;
}

const OUTWARD: readonly Point2[] = Object.freeze([
  Object.freeze({ x: 1, y: 0 }),
  Object.freeze({ x: -1, y: 0 }),
  Object.freeze({ x: 0, y: 1 }),
  Object.freeze({ x: 0, y: -1 }),
]);

/**
 * The point on a rectangle's border along the ray from its centre towards
 * `toward`, and the normal of the edge it lands on. Returns the centre, facing
 * right, when the two coincide.
 */
export const borderPointToward = (rect: Rect, toward: Point2): AnchorResolution => {
  const centre = centreOf(rect);
  const dx = toward.x - centre.x;
  const dy = toward.y - centre.y;
  if (dx === 0 && dy === 0) return { point: centre, normal: OUTWARD[0] as Point2 };
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  const horizontal = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const vertical = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const scale = Math.min(horizontal, vertical);
  const throughSide = horizontal <= vertical;
  return {
    point: { x: centre.x + dx * scale, y: centre.y + dy * scale },
    normal: throughSide
      ? ((dx > 0 ? OUTWARD[0] : OUTWARD[1]) as Point2)
      : ((dy > 0 ? OUTWARD[2] : OUTWARD[3]) as Point2),
  };
};

/** The outward normal of the rectangle edge nearest a point. */
const nearestEdgeNormal = (rect: Rect, point: Point2): Point2 => {
  const distances = [
    { normal: OUTWARD[0] as Point2, distance: Math.abs(rect.x + rect.width - point.x) },
    { normal: OUTWARD[1] as Point2, distance: Math.abs(point.x - rect.x) },
    { normal: OUTWARD[2] as Point2, distance: Math.abs(rect.y + rect.height - point.y) },
    { normal: OUTWARD[3] as Point2, distance: Math.abs(point.y - rect.y) },
  ];
  return distances.reduce((best, entry) => (entry.distance < best.distance ? entry : best)).normal;
};

/** The four sides a connector can leave a table by. */
export type RectSide = 'right' | 'left' | 'bottom' | 'top';

export const RECT_SIDES: readonly RectSide[] = Object.freeze(['right', 'left', 'bottom', 'top']);

/** Kept clear of the corners, so a line never leaves one. */
const SIDE_INSET = 14;

/**
 * The anchor on one named side, as near as it can get to where it is going.
 *
 * Used to consider routes other than the straight-at-each-other one: when the
 * obvious line would cross a third table, leaving by a different side is usually
 * what a person would draw instead. Held away from the corners, because a line
 * leaving exactly at one reads as leaving the wrong side.
 */
export const sideAnchor = (rect: Rect, side: RectSide, toward: Point2): AnchorResolution => {
  const insetX = Math.min(SIDE_INSET, rect.width / 3);
  const insetY = Math.min(SIDE_INSET, rect.height / 3);
  const alongX = clamp(toward.x, rect.x + insetX, rect.x + rect.width - insetX);
  const alongY = clamp(toward.y, rect.y + insetY, rect.y + rect.height - insetY);
  switch (side) {
    case 'right':
      return { point: { x: rect.x + rect.width, y: alongY }, normal: OUTWARD[0] as Point2 };
    case 'left':
      return { point: { x: rect.x, y: alongY }, normal: OUTWARD[1] as Point2 };
    case 'bottom':
      return { point: { x: alongX, y: rect.y + rect.height }, normal: OUTWARD[2] as Point2 };
    default:
      return { point: { x: alongX, y: rect.y }, normal: OUTWARD[3] as Point2 };
  }
};

export const resolveAnchor = (
  rect: Rect,
  anchor: BindingAnchor,
  toward: Point2,
): AnchorResolution => {
  if (anchor.mode === 'auto') return borderPointToward(rect, toward);
  const point = { x: rect.x + anchor.x * rect.width, y: rect.y + anchor.y * rect.height };
  return { point, normal: nearestEdgeNormal(rect, point) };
};

export interface ResolvedBinding {
  readonly binding: Binding;
  readonly from: Point2;
  readonly to: Point2;
  /** Outward normals at each end; a connector leaves along them. */
  readonly fromNormal: Point2;
  readonly toNormal: Point2;
  /** True when the two entities overlap so much the line has nowhere to go. */
  readonly degenerate: boolean;
  /**
   * The rectangles the ends sit on. Carried because whoever draws the line may
   * want to consider a different way out of them, and re-deriving the rectangles
   * from the world would risk disagreeing with the transforms these came from —
   * a drag preview included.
   */
  readonly fromRect: Rect;
  readonly toRect: Rect;
}

/**
 * Resolves a binding to world-space endpoints. Pure: it reads transforms and
 * returns geometry, which is why nothing needs to be recomputed on move.
 *
 * `transformOf` lets the renderer resolve against *drawn* transforms — mid-drag
 * previews included — rather than only committed ones.
 */
export const resolveBinding = (
  world: WorldState,
  binding: Binding,
  transformOf?: (id: EntityId) => (Vec3 & { width: number; height: number }) | undefined,
): ResolvedBinding | null => {
  const lookup = (id: EntityId): (Vec3 & { width: number; height: number }) | undefined =>
    transformOf?.(id) ?? world.entities.get(id)?.transform;
  const fromTransform = lookup(binding.fromId);
  const toTransform = lookup(binding.toId);
  if (fromTransform === undefined || toTransform === undefined) return null;

  const fromRect = entityRect(fromTransform);
  const toRect = entityRect(toTransform);
  // Each end aims at the other's centre, so the pair is stable and symmetric.
  const from = resolveAnchor(fromRect, binding.from, centreOf(toRect));
  const to = resolveAnchor(toRect, binding.to, centreOf(fromRect));
  const degenerate = from.point.x === to.point.x && from.point.y === to.point.y;
  return {
    binding,
    from: from.point,
    to: to.point,
    fromNormal: from.normal,
    toNormal: to.normal,
    degenerate,
    fromRect,
    toRect,
  };
};
