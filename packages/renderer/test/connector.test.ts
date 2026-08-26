import { describe, expect, it } from 'vitest';
import type { Binding, Rect, ResolvedBinding } from '@panorama/core';
import type { Point2 } from '@panorama/renderer';
import {
  DEFAULT_TABLE_THEME,
  EMPTY_CONNECTOR,
  buildConnectorDrawList,
  connectorMarker,
  connectorPath,
  shapedPath,
  blockedLength,
  routeConnector,
  segmentHitsRect,
  ROWS_ICON,
  SQL_ICON,
  SQL_ICON_FONT_SIZE,
  barRects,
  connectorIconKind,
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
  fromRect: { x: -200, y: -100, width: 200, height: 200 },
  toRect: { x: 300, y: -100, width: 200, height: 200 },
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

  it('marks a line to a query box with the same SQL mark as the button', () => {
    const list = build({
      resolved: resolved({
        binding: binding({ label: 'SQL', meta: { kind: 'query' } }),
      }),
    });
    // The mark is the word, not a key: a query is not a foreign key.
    expect(list.texts.map((run) => run.text)).toEqual([SQL_ICON]);
    expect(list.texts[0]?.align).toBe('center');
    expect(list.texts[0]?.bold).toBe(true);
    // The chrome is still there — border and face — but no key geometry.
    expect(list.markerPolygons).toHaveLength(2);
    expect(
      list.markerPolygons.some(
        (polygon) => polygon.color === DEFAULT_TABLE_THEME.connectorMarkerIcon,
      ),
    ).toBe(false);
  });

  it('keeps the SQL mark inside the marker square', () => {
    const marked = resolved({ binding: binding({ label: 'SQL', meta: { kind: 'query' } }) });
    const list = build({ resolved: marked });
    const path = connectorPath(marked, DEFAULT_TABLE_THEME);
    if (path === null) throw new Error('expected a path');
    const marker = connectorMarker(path, marked.binding, DEFAULT_TABLE_THEME);
    const run = list.texts[0];
    if (marker === null || run === undefined) throw new Error('expected a marked connector');
    expect(run.x).toBeGreaterThanOrEqual(marker.x);
    expect(run.x + run.maxWidth).toBeLessThanOrEqual(marker.x + marker.width + 1e-9);
  });

  it('reads the mark from the binding it was given', () => {
    expect(connectorIconKind(binding({ meta: { kind: 'query' } }))).toBe('sql');
    expect(connectorIconKind(binding({ meta: { kind: 'foreign-key' } }))).toBe('key');
    // No metadata at all still means a key: that is what a bare connector was.
    expect(connectorIconKind(binding())).toBe('key');
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
  /** The path the marker is asked to sit on, as the caller would supply it. */
  const pathOf = (target = labelled, scale = 1): ReturnType<typeof connectorPath> =>
    connectorPath(target, DEFAULT_TABLE_THEME, scale);
  const markerOn = (
    target = labelled,
    scale = 1,
    revealed = false,
  ): ReturnType<typeof connectorMarker> => {
    const path = pathOf(target, scale);
    return path === null
      ? null
      : connectorMarker(path, target.binding, DEFAULT_TABLE_THEME, scale, revealed);
  };

  it('sits at the middle of the line', () => {
    const marker = markerOn();
    if (marker === null) throw new Error('expected a marker');
    expect(marker.x + marker.width / 2).toBeCloseTo(150, 6);
    expect(marker.y + marker.height / 2).toBeCloseTo(0, 6);
  });

  it('is a small square until revealed, then a chip', () => {
    const compact = markerOn(labelled, 1, false);
    const expanded = markerOn(labelled, 1, true);
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
    const near = markerOn(labelled, 1);
    const far = markerOn(labelled, 0.25);
    expect(far?.width).toBeCloseTo((near?.width ?? 0) * 4, 6);
  });

  it('carries the label only when revealed', () => {
    expect(markerOn(labelled, 1, false)?.label).toBeNull();
    expect(markerOn(labelled, 1, true)?.label?.text).toBe('COUNTRY = Germany');
  });

  it('is absent without a label, and there is no line for a degenerate binding', () => {
    expect(markerOn(resolved())).toBeNull();
    expect(markerOn(resolved({ binding: binding({ label: '' }) }))).toBeNull();
    expect(pathOf(resolved({ binding: binding({ label: 'x' }), degenerate: true }))).toBeNull();
  });

  it('survives a degenerate camera scale', () => {
    expect(markerOn(labelled, 0)?.width).toBeGreaterThan(0);
  });

  it('sits on the line that was drawn, not the line that would have been', () => {
    // A table squarely in between, so the connector has to go round it. The
    // marker has to follow: hit testing looks for it where the line went.
    const between: Rect = { x: 60, y: -60, width: 180, height: 120 };
    const route = routeConnector(labelled, DEFAULT_TABLE_THEME, 1, [between]);
    if (route === null) throw new Error('expected a route');
    expect(route.detoured).toBe(true);
    const detoured = connectorMarker(route.path, labelled.binding, DEFAULT_TABLE_THEME);
    expect(detoured?.y).not.toBeCloseTo(markerOn()?.y ?? 0, 3);
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

describe('routing a connector past other tables', () => {
  const theme = DEFAULT_TABLE_THEME;
  /** Two tables 300 apart, facing each other, with a 200-tall gap between. */
  const pair = resolved({ binding: binding({ label: 'COUNTRY → CODE' }) });
  const route = (obstacles: readonly Rect[] = [], scale = 1): ReturnType<typeof routeConnector> =>
    routeConnector(pair, theme, scale, obstacles);

  const hits = (points: readonly Point2[], rect: Rect): boolean => {
    for (let index = 1; index < points.length; index += 1) {
      if (segmentHitsRect(points[index - 1] as Point2, points[index] as Point2, rect)) return true;
    }
    return false;
  };

  it('goes straight when nothing is in the way', () => {
    const clear = route();
    expect(clear?.detoured).toBe(false);
    expect(clear?.blocked).toBe(0);
    expect(clear?.path.points).toEqual(connectorPath(pair, theme)?.points);
  });

  it('ignores a table nowhere near the line', () => {
    const far = route([{ x: 4_000, y: 4_000, width: 200, height: 200 }]);
    expect(far?.detoured).toBe(false);
  });

  it('still sees a table only a long way round would have reached', () => {
    // Beyond the direct line by a wide margin, but squarely across the route a
    // pair of far sides would take. Pruning to the direct span would have thrown
    // it away and then scored that route as clear.
    const between: Rect = { x: 100, y: -70, width: 100, height: 140 };
    const outside: Rect = { x: -400, y: -400, width: 1_200, height: 260 };
    const detour = route([between, outside]);
    expect(hits(detour?.path.points ?? [], outside)).toBe(false);
  });

  it('goes round a table squarely in the way, and clears it', () => {
    const between: Rect = { x: 100, y: -70, width: 100, height: 140 };
    const detour = route([between]);
    expect(detour?.detoured).toBe(true);
    expect(detour?.blocked).toBe(0);
    expect(hits(detour?.path.points ?? [], between)).toBe(false);
  });

  it('leaves visible room rather than shaving the corner', () => {
    const between: Rect = { x: 100, y: -70, width: 100, height: 140 };
    const detour = route([between]);
    // Scored against a grown rectangle, so a route that merely touched the edge
    // would still have counted as blocked.
    expect(hits(detour?.path.points ?? [], { x: 96, y: -74, width: 108, height: 148 })).toBe(false);
  });

  it('passes on the side with room, when the two ways round cost the same', () => {
    // A curve overshoots symmetrically, so over the top and under the bottom are
    // exactly the same length. What separates them is how much room is left.
    const above: Rect = { x: 100, y: -160, width: 100, height: 200 };
    const below: Rect = { x: 100, y: -40, width: 100, height: 200 };
    expect(route([above])?.path.midpoint.y).toBeGreaterThan(0);
    expect(route([below])?.path.midpoint.y).toBeLessThan(0);
    expect(route([above])?.blocked).toBe(0);
    expect(route([below])?.blocked).toBe(0);
  });

  it('never buys room at the price of a longer way round', () => {
    // Only one side is open at all, so there is nothing to weigh: it goes the
    // way that works even though it ends up close to the obstacle.
    const shelf: readonly Rect[] = [
      { x: 60, y: -800, width: 180, height: 700 },
      { x: 60, y: 120, width: 180, height: 800 },
    ];
    const detour = route(shelf);
    expect(detour?.blocked).toBe(0);
    expect(Math.abs(detour?.path.midpoint.y ?? 999)).toBeLessThan(120);
  });

  it('leans a curve sideways when that is what gets past', () => {
    // Leaning bends the line without moving its ends or the direction it leaves
    // by, so a route that has to go round is still one smooth curve.
    const straight = shapedPath(
      {
        from: { x: 0, y: 0 },
        fromNormal: { x: 1, y: 0 },
        to: { x: 300, y: 0 },
        toNormal: { x: -1, y: 0 },
      },
      theme,
    );
    const leaned = shapedPath(
      {
        from: { x: 0, y: 0 },
        fromNormal: { x: 1, y: 0 },
        to: { x: 300, y: 0 },
        toNormal: { x: -1, y: 0 },
        bow: 0.5,
      },
      theme,
    );
    expect(straight?.midpoint.y).toBeCloseTo(0, 6);
    expect(Math.abs(leaned?.midpoint.y ?? 0)).toBeGreaterThan(50);
    // Same ends, same tangents: only the middle moved.
    expect(leaned?.points[0]).toEqual(straight?.points[0]);
    expect(leaned?.points.at(-1)).toEqual(straight?.points.at(-1));
  });

  it('gives up gracefully on a table with nowhere clear to go', () => {
    // Boxed in on every side: there is no route, so the honest answer is the
    // line the binding asked for rather than a loop around the canvas.
    const boxedIn: readonly Rect[] = [{ x: -2_000, y: -2_000, width: 4_000, height: 4_000 }];
    const stuck = route(boxedIn);
    expect(stuck?.blocked).toBeGreaterThan(0);
    expect(stuck?.path.points.length).toBeGreaterThan(2);
  });

  it('keeps a fixed anchor where the user put it', () => {
    const pinned = resolved({
      binding: binding({ from: { mode: 'fixed', x: 1, y: 0.5 }, label: 'x' }),
    });
    const between: Rect = { x: 100, y: -70, width: 100, height: 140 };
    const detour = routeConnector(pinned, theme, 1, [between]);
    // The pinned end has not moved; only the other end and the lean may change.
    expect(detour?.path.points[0]?.y).toBeCloseTo(pinned.from.y, 6);
  });

  it('routes the same way at any zoom, allowing for the clearance', () => {
    const between: Rect = { x: 100, y: -70, width: 100, height: 140 };
    expect(route([between], 0.4)?.blocked).toBe(0);
    expect(route([between], 2)?.blocked).toBe(0);
  });

  it('has no route at all for a degenerate binding', () => {
    expect(routeConnector(resolved({ degenerate: true }), theme, 1, [])).toBeNull();
  });

  it('draws the route it chose, not the one it scored', () => {
    const between: Rect = { x: 100, y: -70, width: 100, height: 140 };
    const list = build({ resolved: pair, obstacles: [between] });
    // The drawn line is sampled far more finely than the scoring pass, so the
    // curve is smooth rather than a chain of long facets.
    expect(list.polygons.length).toBeGreaterThan(20);
    expect(list.bounds.height).toBeGreaterThan(80);
  });
});

describe('segmentHitsRect', () => {
  const box: Rect = { x: 0, y: 0, width: 10, height: 10 };

  it('finds a segment that passes clean through', () => {
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 15, y: 5 }, box)).toBe(true);
  });

  it('finds a segment that only pokes in', () => {
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 1, y: 5 }, box)).toBe(true);
  });

  it('rejects one that stops short, and one that goes past on either side', () => {
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: -1, y: 5 }, box)).toBe(false);
    expect(segmentHitsRect({ x: -5, y: -5 }, { x: 15, y: -5 }, box)).toBe(false);
    expect(segmentHitsRect({ x: -5, y: 15 }, { x: 15, y: 15 }, box)).toBe(false);
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: -5, y: 15 }, box)).toBe(false);
  });

  it('rejects a diagonal that passes outside the corner', () => {
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 3, y: -5 }, box)).toBe(false);
    // Exactly through the corner does touch it, which is the honest answer.
    expect(segmentHitsRect({ x: -5, y: 5 }, { x: 5, y: -5 }, box)).toBe(true);
  });

  it('counts a segment entirely inside', () => {
    expect(segmentHitsRect({ x: 2, y: 2 }, { x: 8, y: 8 }, box)).toBe(true);
  });

  it('counts a zero-length segment by where it sits', () => {
    expect(segmentHitsRect({ x: 5, y: 5 }, { x: 5, y: 5 }, box)).toBe(true);
    expect(segmentHitsRect({ x: 50, y: 5 }, { x: 50, y: 5 }, box)).toBe(false);
  });
});

describe('blockedLength', () => {
  it('is nothing at all when there is nothing to hit', () => {
    expect(
      blockedLength(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
        ],
        [],
      ),
    ).toBe(0);
  });

  it('charges the segments that are in the way and no others', () => {
    const points: readonly Point2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 20, y: 0 },
    ];
    expect(blockedLength(points, [{ x: 12, y: -5, width: 4, height: 10 }])).toBe(10);
  });

  it('charges a segment once even when two obstacles overlap on it', () => {
    const points: readonly Point2[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ];
    const overlapping: readonly Rect[] = [
      { x: 2, y: -5, width: 6, height: 10 },
      { x: 4, y: -5, width: 6, height: 10 },
    ];
    expect(blockedLength(points, overlapping)).toBe(10);
  });
});

describe('the mark a line carries', () => {
  const marked = (kind: string): ReturnType<typeof buildConnectorDrawList> =>
    build({
      resolved: resolved({ binding: binding({ label: 'x', meta: { kind } }) }),
      revealed: false,
    });

  it('spells out a drill-down line the same way its button does', () => {
    // Three lines, which is what a table looks like from a distance.
    expect(marked('rows').texts.map((run) => run.text)).toContain(ROWS_ICON);
    expect(marked('query').texts.map((run) => run.text)).toContain(SQL_ICON);
    expect(marked('query').texts.find((run) => run.text === SQL_ICON)?.fontSize).toBe(
      SQL_ICON_FONT_SIZE,
    );
  });

  it("draws a charting line's bars from the same geometry as the button", () => {
    // Bars rather than a word, and geometry rather than glyphs: three block
    // characters touch, and at this size they were drawn as two and an ellipsis.
    const chart = marked('chart');
    expect(chart.texts).toHaveLength(0);
    const bars = barRects(0, 0, DEFAULT_TABLE_THEME.connectorMarkerSize);
    expect(bars).toHaveLength(3);
    // Three ascending bars, each clear of the next.
    expect(bars.map((bar) => bar.height)).toEqual(
      [...bars.map((bar) => bar.height)].sort((a, b) => a - b),
    );
    for (let index = 1; index < bars.length; index += 1) {
      const previous = bars[index - 1];
      const current = bars[index];
      if (previous === undefined || current === undefined) throw new Error('expected bars');
      expect(current.x).toBeGreaterThan(previous.x + previous.width);
    }
    // Bottom-aligned, which is what makes them bars and not blocks.
    expect(new Set(bars.map((bar) => bar.y + bar.height)).size).toBe(1);
    // Two rectangles for the chip itself, and one per bar on top.
    expect(chart.markerPolygons).toHaveLength(2 + bars.length);
  });

  it('draws a key for a foreign key, which is a shape rather than a word', () => {
    const key = marked('foreign-key');
    expect(key.texts.map((run) => run.text)).not.toContain(ROWS_ICON);
    expect(key.markerPolygons.length).toBeGreaterThan(2);
  });
});
