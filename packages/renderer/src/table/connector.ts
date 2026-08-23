import type { ResolvedBinding } from '@panorama/core';
import type { Rgba, TableTheme } from '../theme.js';
import type { TextRun } from './draw-list.js';

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

export interface PolygonInstance {
  /**
   * Four corners in world space, wound consistently:
   * `x0,y0, x1,y1, x2,y2, x3,y3`. Repeat a corner for a triangle.
   */
  readonly corners: readonly [number, number, number, number, number, number, number, number];
  readonly color: Rgba;
}

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

const LABEL_CHARACTER_WIDTH = 7.4;

/**
 * Places the marker at the middle of a connector.
 *
 * Exported because hit testing needs exactly the geometry that was drawn —
 * including the expanded size, so the chip stays under the pointer once it has
 * opened.
 */
export const connectorMarker = (
  resolved: ResolvedBinding,
  theme: TableTheme,
  scale = 1,
  revealed = false,
): ConnectorMarker | null => {
  const label = resolved.binding.label;
  if (label === undefined || label === '' || resolved.degenerate) return null;
  const safeScale = Math.max(0.05, scale);
  const size = theme.connectorMarkerSize / safeScale;
  const iconSize = theme.connectorMarkerIconSize / safeScale;
  const padding = theme.connectorLabelPaddingX / safeScale;
  const fontSize = theme.connectorLabelFontSize / safeScale;

  const labelWidth = revealed
    ? label.length * LABEL_CHARACTER_WIDTH * (fontSize / (theme.fontSize / safeScale))
    : 0;
  const width = revealed ? size + labelWidth + padding * 2 : size;
  const path = connectorPath(resolved, theme, safeScale);
  if (path === null) return null;
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
export const connectorPath = (
  resolved: ResolvedBinding,
  theme: TableTheme,
  scale = 1,
): ConnectorPath | null => {
  if (resolved.degenerate) return null;
  const safeScale = Math.max(0.05, scale);
  const gap = theme.connectorGap / safeScale;

  const start = {
    x: resolved.from.x + resolved.fromNormal.x * gap,
    y: resolved.from.y + resolved.fromNormal.y * gap,
  };
  const end = {
    x: resolved.to.x + resolved.toNormal.x * gap,
    y: resolved.to.y + resolved.toNormal.y * gap,
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
  const control1 = {
    x: start.x + resolved.fromNormal.x * reach,
    y: start.y + resolved.fromNormal.y * reach,
  };
  const control2 = {
    x: end.x + resolved.toNormal.x * reach,
    y: end.y + resolved.toNormal.y * reach,
  };

  const segments = Math.min(
    MAX_SEGMENTS,
    Math.max(MIN_SEGMENTS, Math.round((span * safeScale) / SEGMENT_PIXELS)),
  );
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
  const path = connectorPath(resolved, theme, scale);
  if (path === null) return EMPTY_CONNECTOR;

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
  const marker = connectorMarker(resolved, theme, scale, input.revealed === true);
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
    markerPolygons.push(
      ...keyIcon(
        marker.icon.x,
        marker.icon.y,
        marker.icon.size,
        revealed ? theme.connectorMarkerHoverIcon : theme.connectorMarkerIcon,
        background,
      ),
    );

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
