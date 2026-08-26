import { describe, expect, it } from 'vitest';
import type { Rect } from '@panorama/core';
import {
  DEFAULT_PLACEMENT_GAP,
  findFreePlacement,
  rectsIntersect,
  rightEdgeAnchor,
} from '@panorama/core';

const GAP = DEFAULT_PLACEMENT_GAP;
/** A viewport with room for two tables across and one and a bit down. */
const VIEWPORT: Rect = { x: 0, y: 0, width: 1_400, height: 900 };
const SIZE = { width: 550, height: 600 };
/** Room enough that "inside the view" never decides these on its own. */
const WIDE_TALL: Rect = { x: 0, y: 0, width: 4_000, height: 4_000 };

const place = (occupied: readonly Rect[], viewport: Rect = VIEWPORT): Rect => {
  const at = findFreePlacement({ size: SIZE, occupied, viewport });
  return { ...at, ...SIZE };
};

const inside = (rect: Rect, viewport: Rect): boolean =>
  rect.x >= viewport.x + GAP &&
  rect.y >= viewport.y + GAP &&
  rect.x + rect.width <= viewport.x + viewport.width - GAP &&
  rect.y + rect.height <= viewport.y + viewport.height - GAP;

describe('findFreePlacement', () => {
  it('puts the first table by the explorer, a gap in from the corner', () => {
    expect(findFreePlacement({ size: SIZE, occupied: [], viewport: VIEWPORT })).toEqual({
      x: GAP,
      y: GAP,
    });
  });

  it('measures from the corner of the view rather than from the world origin', () => {
    // The camera has been panned a long way from the origin.
    const panned: Rect = { x: 10_000, y: -4_000, width: 1_400, height: 900 };
    expect(findFreePlacement({ size: SIZE, occupied: [], viewport: panned })).toEqual({
      x: 10_000 + GAP,
      y: -4_000 + GAP,
    });
  });

  it('puts the next table beside the first, flush against it', () => {
    const first = place([]);
    const second = place([first]);
    expect(rectsIntersect(first, second)).toBe(false);
    // Beside, not below: there is room across and the view is what matters.
    expect(second.y).toBe(first.y);
    expect(second.x).toBe(first.x + first.width + GAP);
    expect(inside(second, VIEWPORT)).toBe(true);
  });

  it('fills the visible area before it spills over', () => {
    // Two across is all this viewport holds; a third has to go somewhere else.
    const first = place([]);
    const second = place([first]);
    const third = place([first, second]);
    expect(rectsIntersect(third, first)).toBe(false);
    expect(rectsIntersect(third, second)).toBe(false);
    expect(inside(third, VIEWPORT)).toBe(false);
    // Just below the row it could not join, rather than far away.
    expect(third.y).toBe(first.y + first.height + GAP);
    expect(third.x).toBe(first.x);
  });

  it('uses a tall view for a second row before leaving it', () => {
    const tall: Rect = { x: 0, y: 0, width: 700, height: 1_400 };
    const first = place([], tall);
    const second = place([first], tall);
    // One across, two down: the second row is inside, so it is used.
    expect(second.x).toBe(first.x);
    expect(second.y).toBe(first.y + first.height + GAP);
    expect(inside(second, tall)).toBe(true);
  });

  it('takes the closest free spot rather than the next one along', () => {
    // A hole in the top-left, and everything else across the top row taken.
    const occupied: readonly Rect[] = [
      { x: GAP + 550 + GAP, y: GAP, width: 550, height: 600 },
      { x: GAP, y: GAP + 600 + GAP, width: 550, height: 600 },
    ];
    expect(findFreePlacement({ size: SIZE, occupied, viewport: VIEWPORT })).toEqual({
      x: GAP,
      y: GAP,
    });
  });

  it('slots into a gap between two tables when the new one fits', () => {
    const wide: Rect = { x: 0, y: 0, width: 2_400, height: 900 };
    const left = { x: GAP, y: GAP, width: 550, height: 600 };
    // A hole exactly one table wide sits between them.
    const right = { x: GAP + 550 + GAP + 550 + GAP, y: GAP, width: 550, height: 600 };
    const found = findFreePlacement({ size: SIZE, occupied: [left, right], viewport: wide });
    expect(found).toEqual({ x: left.x + left.width + GAP, y: GAP });
  });

  it('never overlaps, however crowded the view is', () => {
    const occupied: Rect[] = [];
    for (let index = 0; index < 12; index += 1) {
      const at = findFreePlacement({ size: SIZE, occupied, viewport: VIEWPORT });
      const rect = { ...at, ...SIZE };
      for (const taken of occupied) expect(rectsIntersect(rect, taken)).toBe(false);
      occupied.push(rect);
    }
    expect(occupied).toHaveLength(12);
  });

  it('never places above or to the left of the view, where the user is not looking', () => {
    const occupied = [{ x: -5_000, y: -5_000, width: 550, height: 600 }];
    const found = findFreePlacement({ size: SIZE, occupied, viewport: VIEWPORT });
    expect(found.x).toBeGreaterThanOrEqual(VIEWPORT.x + GAP);
    expect(found.y).toBeGreaterThanOrEqual(VIEWPORT.y + GAP);
  });

  it('finds room beside a table too big to fit the view at all', () => {
    const huge = { x: GAP, y: GAP, width: 4_000, height: 4_000 };
    const found = findFreePlacement({ size: SIZE, occupied: [huge], viewport: VIEWPORT });
    expect(rectsIntersect({ ...found, ...SIZE }, huge)).toBe(false);
  });

  it('ignores a position carried along with the size it was given', () => {
    // A caller may hand over a whole transform, which has an `x` and a `y` of
    // its own. Those describe where the entity is now, not where it may go.
    const transform = { x: -9_999, y: -9_999, z: 0, width: 550, height: 600 };
    expect(findFreePlacement({ size: transform, occupied: [], viewport: VIEWPORT })).toEqual({
      x: GAP,
      y: GAP,
    });
    const first = { x: GAP, y: GAP, width: 550, height: 600 };
    // And they must not put the ranking out either: below beats a third column.
    const narrow: Rect = { x: 0, y: 0, width: 1_246, height: 4_000 };
    const second = findFreePlacement({ size: transform, occupied: [first], viewport: narrow });
    expect(second).toEqual({ x: GAP + 550 + GAP, y: GAP });
    const third = findFreePlacement({
      size: transform,
      occupied: [first, { ...second, width: 550, height: 600 }],
      viewport: narrow,
    });
    expect(third).toEqual({ x: GAP, y: GAP + 600 + GAP });
  });

  it('gathers along an edge when given one, rather than around a corner', () => {
    // Where a table actually sits: inset from the view by a gap, as placement
    // put it there.
    const source: Rect = { x: GAP, y: GAP, width: 550, height: 600 };
    const anchor = rightEdgeAnchor(source, 220);
    expect(anchor).toEqual({ x: GAP + 550 + 220, top: GAP, bottom: GAP + 600 });
    // Nothing in the way: level with the table it belongs beside.
    expect(
      findFreePlacement({ size: SIZE, occupied: [source], viewport: WIDE_TALL, anchor }),
    ).toEqual({ x: anchor.x, y: GAP });
  });

  it('slides along the edge rather than past a table already sitting there', () => {
    const source: Rect = { x: GAP, y: GAP, width: 550, height: 600 };
    const anchor = rightEdgeAnchor(source, 220);
    // Something is already in the spot a followed table would have taken.
    const squatter: Rect = { x: anchor.x, y: GAP, width: 550, height: 600 };
    const found = findFreePlacement({
      size: SIZE,
      occupied: [source, squatter],
      viewport: WIDE_TALL,
      anchor,
    });
    // Below it, still hugging the source's edge — not shoved a table's width
    // further right, which is what measuring from a corner would have chosen.
    expect(found).toEqual({ x: anchor.x, y: GAP + 600 + GAP });
    expect(rectsIntersect({ ...found, ...SIZE }, squatter)).toBe(false);
  });

  it('stays on the edge even when the whole column beside it is taken', () => {
    const source: Rect = { x: GAP, y: 1_000, width: 550, height: 600 };
    const anchor = rightEdgeAnchor(source, 220);
    // Level with the source, and directly below it, both occupied.
    const column: readonly Rect[] = [
      { x: anchor.x, y: 1_000, width: 550, height: 600 },
      { x: anchor.x, y: 1_648, width: 550, height: 600 },
    ];
    const found = findFreePlacement({
      size: SIZE,
      occupied: [source, ...column],
      viewport: WIDE_TALL,
      anchor,
    });
    // Still on the edge — up it, or further down it — rather than a table's
    // width to the right, which would leave a long and meaningless connector.
    expect(found.x).toBe(anchor.x);
    for (const taken of column) expect(rectsIntersect({ ...found, ...SIZE }, taken)).toBe(false);
  });

  it('never places to the left of the edge it was given', () => {
    const source: Rect = { x: 2_000, y: 0, width: 550, height: 600 };
    const anchor = rightEdgeAnchor(source, 220);
    const found = findFreePlacement({
      size: SIZE,
      occupied: [source],
      // A view that is mostly to the *left* of the source.
      viewport: { x: 0, y: 0, width: 3_000, height: 900 },
      anchor,
    });
    expect(found.x).toBeGreaterThanOrEqual(anchor.x);
  });

  it('keeps the corner default filling the view in reading order', () => {
    // The edge metric must not change what opening from the explorer does: a
    // corner is a segment of no length, so down costs what it always did.
    const first = place([], WIDE_TALL);
    const second = place([first], WIDE_TALL);
    expect(second).toMatchObject({ y: first.y });
    expect(second.x).toBe(first.x + first.width + GAP);
  });

  it('honours a gap of its own', () => {
    const first = findFreePlacement({ size: SIZE, occupied: [], viewport: VIEWPORT, gap: 8 });
    expect(first).toEqual({ x: 8, y: 8 });
    const second = findFreePlacement({
      size: SIZE,
      occupied: [{ ...first, ...SIZE }],
      viewport: VIEWPORT,
      gap: 8,
    });
    expect(second.x).toBe(8 + SIZE.width + 8);
  });

  it('places a table larger than the view without looping forever', () => {
    const found = findFreePlacement({
      size: { width: 5_000, height: 5_000 },
      occupied: [{ x: GAP, y: GAP, width: 550, height: 600 }],
      viewport: VIEWPORT,
    });
    expect(
      rectsIntersect(
        { ...found, width: 5_000, height: 5_000 },
        {
          x: GAP,
          y: GAP,
          width: 550,
          height: 600,
        },
      ),
    ).toBe(false);
  });
});
