import { describe, expect, it } from 'vitest';
import type { Binding, ResolvedBinding } from '@panorama/core';
import {
  DEFAULT_TABLE_THEME,
  EMPTY_CONNECTOR,
  buildConnectorDrawList,
  connectorMarker,
  connectorPath,
  keyIcon,
} from '@panorama/renderer';

const binding = (overrides: Partial<Binding> = {}): Binding => ({
  id: 'binding:1' as never,
  kind: 'connector',
  fromId: 'table:a' as never,
  toId: 'table:b' as never,
  from: { mode: 'auto' },
  to: { mode: 'auto' },
  directed: true,
  ...overrides,
});

const resolved = (overrides: Partial<ResolvedBinding> = {}): ResolvedBinding => ({
  binding: binding(),
  from: { x: 0, y: 0 },
  to: { x: 300, y: 0 },
  // Facing each other across the gap, as two side-by-side tables would be.
  fromNormal: { x: 1, y: 0 },
  toNormal: { x: -1, y: 0 },
  degenerate: false,
  ...overrides,
});

const build = (input: Partial<Parameters<typeof buildConnectorDrawList>[0]> = {}) =>
  buildConnectorDrawList({ resolved: resolved(), theme: DEFAULT_TABLE_THEME, ...input });

describe('buildConnectorDrawList', () => {
  it('strokes the curve as a ribbon, plus an arrowhead', () => {
    const list = build();
    // Many quads for the curve, one more for the head.
    expect(list.polygons.length).toBeGreaterThan(4);
    expect(
      list.polygons.every((polygon) => polygon.color === DEFAULT_TABLE_THEME.connectorLine),
    ).toBe(true);
  });

  it('omits the arrowhead when the binding is not directed', () => {
    const directed = build().polygons.length;
    const plain = build({ resolved: resolved({ binding: binding({ directed: false }) }) }).polygons
      .length;
    expect(plain).toBe(directed - 1);
  });

  it('points the arrowhead at the target end', () => {
    const list = build();
    const head = list.polygons[list.polygons.length - 1];
    if (head === undefined) throw new Error('expected an arrowhead');
    // The repeated first/last corner is the tip, at the far end of the curve.
    expect(head.corners[0]).toBeCloseTo(head.corners[6], 9);
    expect(head.corners[1]).toBeCloseTo(head.corners[7], 9);
    expect(head.corners[0]).toBeGreaterThan(280);
    expect(head.corners[0]).toBeLessThanOrEqual(300);
  });

  it('leaves the tables along their edge normals, then bends towards the other', () => {
    // Offset vertically: a straight chord would cut the corner, a curve leaves
    // sideways first and arrives sideways.
    const path = connectorPath(
      resolved({ to: { x: 300, y: 300 }, toNormal: { x: -1, y: 0 } }),
      DEFAULT_TABLE_THEME,
    );
    if (path === null) throw new Error('expected a path');
    const [first, second] = path.points;
    if (first === undefined || second === undefined) throw new Error('expected points');
    // It sets off horizontally, along the normal.
    expect(second.x - first.x).toBeGreaterThan(0);
    expect(Math.abs(second.y - first.y)).toBeLessThan(second.x - first.x);
    // And arrives horizontally too.
    expect(path.direction.x).toBeGreaterThan(0);
    expect(Math.abs(path.direction.y)).toBeLessThan(Math.abs(path.direction.x));
  });

  it('is longer than the straight line it replaces when the ends are offset', () => {
    const straight = connectorPath(resolved(), DEFAULT_TABLE_THEME);
    const bent = connectorPath(
      resolved({ to: { x: 300, y: 300 }, toNormal: { x: -1, y: 0 } }),
      DEFAULT_TABLE_THEME,
    );
    expect(bent?.length).toBeGreaterThan(straight?.length ?? 0);
  });

  it('turns with the line', () => {
    const vertical = build({
      resolved: resolved({
        to: { x: 0, y: 300 },
        fromNormal: { x: 0, y: 1 },
        toNormal: { x: 0, y: -1 },
      }),
    });
    const first = vertical.polygons[0];
    if (first === undefined) throw new Error('expected a shaft');
    // A vertical line is thick horizontally.
    expect(Math.abs(first.corners[0] - first.corners[6])).toBeGreaterThan(0);
    expect(Math.abs(first.corners[1] - first.corners[7])).toBeCloseTo(0, 6);
  });

  it('samples more finely for a longer line, within bounds', () => {
    const short = connectorPath(resolved({ to: { x: 60, y: 0 } }), DEFAULT_TABLE_THEME);
    const long = connectorPath(resolved({ to: { x: 4_000, y: 0 } }), DEFAULT_TABLE_THEME);
    expect(long?.points.length).toBeGreaterThan(short?.points.length ?? 0);
    expect(long?.points.length).toBeLessThanOrEqual(65);
    expect(short?.points.length).toBeGreaterThanOrEqual(7);
  });

  it('joins its segments without notches on the outside of a bend', () => {
    const list = build({
      resolved: resolved({ to: { x: 300, y: 300 }, toNormal: { x: -1, y: 0 } }),
    });
    // Consecutive quads share their corners exactly, so the ribbon is closed.
    for (let index = 0; index + 2 < list.polygons.length; index += 1) {
      const current = list.polygons[index];
      const next = list.polygons[index + 1];
      if (current === undefined || next === undefined) continue;
      expect(current.corners[2]).toBeCloseTo(next.corners[0] as number, 9);
      expect(current.corners[3]).toBeCloseTo(next.corners[1] as number, 9);
      expect(current.corners[4]).toBeCloseTo(next.corners[6] as number, 9);
      expect(current.corners[5]).toBeCloseTo(next.corners[7] as number, 9);
    }
  });

  it('leaves a gap at both ends so the line touches rather than pierces', () => {
    const shaft = build().polygons[0];
    if (shaft === undefined) throw new Error('expected a shaft');
    expect(shaft.corners[0]).toBeGreaterThan(0);
  });

  it('highlights when either end is activated', () => {
    expect(build({ highlighted: true }).polygons[0]?.color).toBe(
      DEFAULT_TABLE_THEME.connectorHighlight,
    );
  });

  it('marks a labelled connection with a key, and no text', () => {
    const list = build({
      resolved: resolved({ binding: binding({ label: 'COUNTRY = Germany' }) }),
    });
    // The marker states that there *is* a key relation; it does not shout the
    // predicate across the canvas.
    expect(list.texts).toEqual([]);
    expect(list.markerPolygons.length).toBeGreaterThan(4);
    expect(
      list.markerPolygons.some(
        (polygon) => polygon.color === DEFAULT_TABLE_THEME.connectorMarkerBackground,
      ),
    ).toBe(true);
    expect(
      list.markerPolygons.some(
        (polygon) => polygon.color === DEFAULT_TABLE_THEME.connectorMarkerIcon,
      ),
    ).toBe(true);
  });

  it('spells the filter out only once revealed', () => {
    const list = build({
      resolved: resolved({ binding: binding({ label: 'COUNTRY = Germany' }) }),
      revealed: true,
    });
    expect(list.texts.map((run) => run.text)).toEqual(['COUNTRY = Germany']);
    expect(
      list.markerPolygons.some(
        (polygon) => polygon.color === DEFAULT_TABLE_THEME.connectorMarkerHoverBackground,
      ),
    ).toBe(true);
  });

  it('keeps the marker out of the line geometry, so it can draw in front', () => {
    const list = build({
      resolved: resolved({ binding: binding({ label: 'COUNTRY = Germany' }) }),
    });
    expect(
      list.polygons.every((polygon) => polygon.color === DEFAULT_TABLE_THEME.connectorLine),
    ).toBe(true);
  });

  it('has no marker without a label', () => {
    expect(
      build({ resolved: resolved({ binding: binding({ label: '' }) }) }).markerPolygons,
    ).toEqual([]);
    expect(build().markerPolygons).toEqual([]);
  });

  it('reports bounds covering the whole line', () => {
    const list = build({ resolved: resolved({ from: { x: 10, y: 20 }, to: { x: 110, y: 220 } }) });
    expect(list.bounds.x).toBeLessThanOrEqual(10);
    expect(list.bounds.y).toBeLessThanOrEqual(20);
    expect(list.bounds.x + list.bounds.width).toBeGreaterThanOrEqual(110);
    expect(list.bounds.y + list.bounds.height).toBeGreaterThanOrEqual(220);
  });

  it('draws nothing for a degenerate line', () => {
    expect(build({ resolved: resolved({ degenerate: true }) })).toBe(EMPTY_CONNECTOR);
    expect(connectorPath(resolved({ degenerate: true }), DEFAULT_TABLE_THEME)).toBeNull();
  });

  it('draws nothing when the gap inset closes the line entirely', () => {
    // Two borders exactly twice the gap apart: insetting both ends leaves
    // nothing between them.
    const collapsed = resolved({
      from: { x: 0, y: 0 },
      to: { x: DEFAULT_TABLE_THEME.connectorGap * 2, y: 0 },
      fromNormal: { x: 1, y: 0 },
      toNormal: { x: -1, y: 0 },
    });
    expect(connectorPath(collapsed, DEFAULT_TABLE_THEME)).toBeNull();
    expect(build({ resolved: collapsed })).toBe(EMPTY_CONNECTOR);
  });

  it('keeps a very short connector coherent', () => {
    const list = build({ resolved: resolved({ to: { x: 14, y: 0 } }) });
    // Still a head, and every polygon is finite.
    expect(list.polygons.length).toBeGreaterThanOrEqual(1);
    for (const polygon of list.polygons) {
      for (const value of polygon.corners) expect(Number.isFinite(value)).toBe(true);
    }
  });

  it('does not balloon a short connector into a loop', () => {
    // The control points reach out along the normals; unchecked, a minimum
    // reach larger than the span would send the curve out and back.
    const short = connectorPath(resolved({ to: { x: 30, y: 0 } }), DEFAULT_TABLE_THEME);
    if (short === null) throw new Error('expected a path');
    const furthest = Math.max(...short.points.map((point) => point.x));
    expect(furthest).toBeLessThanOrEqual(30);
    // And it still runs forwards the whole way.
    for (let index = 1; index < short.points.length; index += 1) {
      expect((short.points[index] as { x: number }).x).toBeGreaterThanOrEqual(
        (short.points[index - 1] as { x: number }).x - 1e-9,
      );
    }
  });

  it('survives a degenerate camera scale', () => {
    expect(build({ scale: 0 }).polygons.length).toBeGreaterThan(0);
  });
});

describe('connectorMarker', () => {
  const labelled = resolved({ binding: binding({ label: 'COUNTRY = Germany' }) });

  it('sits at the middle of the line', () => {
    const marker = connectorMarker(labelled, DEFAULT_TABLE_THEME);
    if (marker === null) throw new Error('expected a marker');
    expect(marker.x + marker.width / 2).toBeCloseTo(150, 6);
    expect(marker.y + marker.height / 2).toBeCloseTo(0, 6);
  });

  it('is a small square until revealed, then a chip', () => {
    const compact = connectorMarker(labelled, DEFAULT_TABLE_THEME, 1, false);
    const expanded = connectorMarker(labelled, DEFAULT_TABLE_THEME, 1, true);
    expect(compact?.width).toBe(DEFAULT_TABLE_THEME.connectorMarkerSize);
    expect(compact?.height).toBe(DEFAULT_TABLE_THEME.connectorMarkerSize);
    expect(expanded?.width).toBeGreaterThan(compact?.width ?? 0);
    // It grows about its centre, so it does not jump when it opens.
    expect(expanded?.height).toBe(compact?.height);
    expect((expanded?.x ?? 0) + (expanded?.width ?? 0) / 2).toBeCloseTo(
      (compact?.x ?? 0) + (compact?.width ?? 0) / 2,
      6,
    );
  });

  it('keeps a constant screen size as the camera zooms out', () => {
    const near = connectorMarker(labelled, DEFAULT_TABLE_THEME, 1);
    const far = connectorMarker(labelled, DEFAULT_TABLE_THEME, 0.25);
    expect(far?.width).toBeCloseTo((near?.width ?? 0) * 4, 6);
  });

  it('carries the label only when revealed', () => {
    expect(connectorMarker(labelled, DEFAULT_TABLE_THEME, 1, false)?.label).toBeNull();
    expect(connectorMarker(labelled, DEFAULT_TABLE_THEME, 1, true)?.label?.text).toBe(
      'COUNTRY = Germany',
    );
  });

  it('is absent without a label or for a degenerate line', () => {
    expect(connectorMarker(resolved(), DEFAULT_TABLE_THEME)).toBeNull();
    expect(
      connectorMarker(resolved({ binding: binding({ label: '' }) }), DEFAULT_TABLE_THEME),
    ).toBeNull();
    expect(
      connectorMarker(
        resolved({ binding: binding({ label: 'x' }), degenerate: true }),
        DEFAULT_TABLE_THEME,
      ),
    ).toBeNull();
  });

  it('survives a degenerate camera scale', () => {
    expect(connectorMarker(labelled, DEFAULT_TABLE_THEME, 0)?.width).toBeGreaterThan(0);
  });
});

describe('keyIcon', () => {
  it('draws a bow with a hole, a shaft and two teeth', () => {
    const parts = keyIcon(0, 0, 10, [0, 0, 0, 1], [1, 1, 1, 1]);
    expect(parts).toHaveLength(5);
    // The hole is punched in the background colour, which is what stops the
    // icon reading as an arrow.
    expect(parts[1]?.color).toEqual([1, 1, 1, 1]);
    // The bow is a diamond: its corners are not axis-aligned.
    const bow = parts[0];
    if (bow === undefined) throw new Error('expected a bow');
    expect(bow.corners[0]).not.toBe(bow.corners[2]);
    expect(bow.corners[1]).not.toBe(bow.corners[3]);
    // Everything stays inside the icon box.
    for (const part of parts) {
      for (let index = 0; index < 8; index += 1) {
        expect(part.corners[index]).toBeGreaterThanOrEqual(0);
        expect(part.corners[index]).toBeLessThanOrEqual(10);
      }
    }
  });

  it('scales and positions with its box', () => {
    const parts = keyIcon(100, 50, 20, [0, 0, 0, 1], [1, 1, 1, 1]);
    for (const part of parts) {
      for (let index = 0; index < 8; index += 2) {
        expect(part.corners[index]).toBeGreaterThanOrEqual(100);
        expect(part.corners[index]).toBeLessThanOrEqual(120);
        expect(part.corners[index + 1]).toBeGreaterThanOrEqual(50);
        expect(part.corners[index + 1]).toBeLessThanOrEqual(70);
      }
    }
  });
});
