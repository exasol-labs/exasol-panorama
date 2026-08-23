import type { Rect, Vec3 } from './geometry.js';
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
 * `connector` draws a line between two entities and moves neither of them. The
 * next kind will be an attachment, where `fromId`'s transform is derived from
 * `toId`'s — a note stuck to a table. It plugs in at `resolveBinding` and in
 * the renderer, and needs an entity type that can be attached, which Stage 1
 * does not yet have.
 */
export type BindingKind = 'connector';

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
  };
};
