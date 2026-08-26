import { describe, expect, it } from 'vitest';
import type { ChartText } from '@panorama/chart';
import { Rect, TSpan } from 'zrender';
import type { ChartPoint } from '@panorama/chart-echarts';
import {
  PolylineContext,
  applyAffine,
  fillOutline,
  parseColour,
  extractDrawList,
  strokeOutline,
  toCssColour,
  triangulate,
  withOpacity,
} from '@panorama/chart-echarts';

const BLACK = [0, 0, 0, 1] as const;

describe('a path context that yields polylines', () => {
  it('records a line', () => {
    const context = new PolylineContext();
    context.moveTo(0, 0);
    context.lineTo(10, 0);
    context.lineTo(10, 10);
    expect(context.subpaths).toEqual([
      {
        points: [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
        ],
        closed: false,
      },
    ]);
  });

  it('starts a new subpath on every move', () => {
    const context = new PolylineContext();
    context.moveTo(0, 0);
    context.lineTo(1, 1);
    context.moveTo(5, 5);
    context.lineTo(6, 6);
    expect(context.subpaths).toHaveLength(2);
  });

  it('normalises a rectangle drawn backwards, as a bar growing upwards is', () => {
    const context = new PolylineContext();
    context.rect(10, 100, 20, -40);
    const [subpath] = context.subpaths;
    expect(subpath?.closed).toBe(true);
    expect(subpath?.points).toEqual([
      { x: 10, y: 60 },
      { x: 30, y: 60 },
      { x: 30, y: 100 },
      { x: 10, y: 100 },
    ]);
  });

  it('flattens a cubic into a run of points that ends where it should', () => {
    const context = new PolylineContext();
    context.moveTo(0, 0);
    context.bezierCurveTo(0, 10, 10, 10, 10, 0);
    const points = context.subpaths[0]?.points ?? [];
    expect(points.length).toBeGreaterThan(8);
    expect(points.at(-1)).toEqual({ x: 10, y: 0 });
    // Bulges away from the chord rather than running along it.
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(3);
  });

  it('raises a quadratic to a cubic rather than having a second flattener', () => {
    const context = new PolylineContext();
    context.moveTo(0, 0);
    context.quadraticCurveTo(5, 10, 10, 0);
    const points = context.subpaths[0]?.points ?? [];
    expect(points.at(-1)).toEqual({ x: 10, y: 0 });
    expect(Math.max(...points.map((point) => point.y))).toBeGreaterThan(3);
  });

  it('starts a curve from nowhere without falling over', () => {
    const bezier = new PolylineContext();
    bezier.bezierCurveTo(0, 0, 1, 1, 2, 2);
    expect(bezier.subpaths[0]?.points.at(-1)).toEqual({ x: 2, y: 2 });
    const quad = new PolylineContext();
    quad.quadraticCurveTo(1, 1, 2, 2);
    expect(quad.subpaths[0]?.points.at(-1)).toEqual({ x: 2, y: 2 });
  });

  it('samples an arc, and spends its detail on the big ones', () => {
    const small = new PolylineContext();
    small.arc(0, 0, 3, 0, Math.PI * 2);
    const big = new PolylineContext();
    big.arc(0, 0, 90, 0, Math.PI * 2);
    const smallPoints = small.subpaths[0]?.points.length ?? 0;
    const bigPoints = big.subpaths[0]?.points.length ?? 0;
    // A four-pixel dot does not need sixty triangles; a pie does.
    expect(smallPoints).toBeLessThan(bigPoints);
    expect(smallPoints).toBeGreaterThanOrEqual(6);
  });

  it('goes the way round it was asked to', () => {
    const forwards = new PolylineContext();
    forwards.arc(0, 0, 10, 0, Math.PI / 2, false);
    const backwards = new PolylineContext();
    backwards.arc(0, 0, 10, 0, Math.PI / 2, true);
    // The same ends, opposite ways round, so the middles are on opposite sides.
    const mid = (context: PolylineContext): ChartPoint => {
      const points = context.subpaths[0]?.points ?? [];
      return points[Math.floor(points.length / 2)] as ChartPoint;
    };
    expect(mid(forwards).x).toBeGreaterThan(0);
    expect(mid(backwards).x).toBeLessThan(0);
  });

  it('drops a subpath with nothing in it', () => {
    const context = new PolylineContext();
    context.moveTo(1, 1);
    context.closePath();
    expect(context.subpaths).toEqual([]);
  });
});

describe('applying a transform', () => {
  it('leaves a point alone when there is none', () => {
    expect(applyAffine(undefined, { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });

  it('translates, scales and rotates as zrender means it to', () => {
    expect(applyAffine([1, 0, 0, 1, 10, 20], { x: 3, y: 4 })).toEqual({ x: 13, y: 24 });
    expect(applyAffine([2, 0, 0, 3, 0, 0], { x: 3, y: 4 })).toEqual({ x: 6, y: 12 });
  });

  it('fills in the identity for a short matrix rather than producing NaN', () => {
    expect(applyAffine([], { x: 3, y: 4 })).toEqual({ x: 3, y: 4 });
  });
});

describe('cutting an outline into triangles', () => {
  it('has nothing to say about fewer than three points', () => {
    expect(triangulate([])).toEqual([]);
    expect(
      triangulate([
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ]),
    ).toEqual([]);
  });

  it('cuts a rectangle into two', () => {
    const square: readonly ChartPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(triangulate(square)).toHaveLength(2);
  });

  it('cuts a concave outline correctly, which a fan would not', () => {
    // An L: a fan from one corner would put a triangle outside the shape.
    const ell: readonly ChartPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 4 },
      { x: 4, y: 4 },
      { x: 4, y: 10 },
      { x: 0, y: 10 },
    ];
    const triangles = triangulate(ell);
    expect(triangles).toHaveLength(4);
    const area = triangles.reduce(
      (total, [a, b, c]) =>
        total + Math.abs((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2,
      0,
    );
    // 10×4 plus 4×6: the triangles cover the shape and nothing else.
    expect(area).toBeCloseTo(64, 6);
  });

  it('ignores a repeated point', () => {
    const withDouble: readonly ChartPoint[] = [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
    ];
    expect(triangulate(withDouble)).toHaveLength(1);
  });

  it('cuts an outline wound either way', () => {
    const clockwise: readonly ChartPoint[] = [
      { x: 0, y: 0 },
      { x: 0, y: 10 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
    ];
    expect(triangulate(clockwise)).toHaveLength(2);
  });

  it('stops rather than looping on an outline that crosses itself', () => {
    const bowtie: readonly ChartPoint[] = [
      { x: 0, y: 0 },
      { x: 10, y: 10 },
      { x: 10, y: 0 },
      { x: 0, y: 10 },
    ];
    // A partial fill beats a hung frame.
    expect(triangulate(bowtie).length).toBeLessThanOrEqual(2);
  });
});

describe('filling and stroking', () => {
  it('gives each triangle a repeated corner, as the quad batch takes them', () => {
    const [polygon] = fillOutline(
      [
        { x: 0, y: 0 },
        { x: 4, y: 0 },
        { x: 4, y: 4 },
      ],
      BLACK,
    );
    expect(polygon?.corners.slice(4, 6)).toEqual(polygon?.corners.slice(6, 8));
    expect(polygon?.color).toBe(BLACK);
  });

  it('strokes a polyline as one quad per segment', () => {
    expect(
      strokeOutline(
        [
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 20, y: 0 },
        ],
        2,
        BLACK,
      ),
    ).toHaveLength(2);
  });

  it('closes the loop when the outline is closed', () => {
    const open = strokeOutline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      1,
      BLACK,
      false,
    );
    const closed = strokeOutline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      1,
      BLACK,
      true,
    );
    expect(closed).toHaveLength(open.length + 1);
  });

  it('has nothing to stroke from a single point', () => {
    expect(strokeOutline([{ x: 0, y: 0 }], 1, BLACK)).toEqual([]);
    expect(
      strokeOutline(
        [
          { x: 0, y: 0 },
          { x: 1, y: 1 },
        ],
        1,
        BLACK,
        true,
      ),
    ).toHaveLength(1);
  });

  it('gives a hairline a width you can see', () => {
    const [quad] = strokeOutline(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
      ],
      0,
      BLACK,
    );
    const top = quad?.corners[1] ?? 0;
    const bottom = quad?.corners[7] ?? 0;
    expect(Math.abs(bottom - top)).toBeGreaterThan(0);
  });
});

describe('colours across the boundary', () => {
  it('reads the hex forms', () => {
    expect(parseColour('#000')).toEqual([0, 0, 0, 1]);
    expect(parseColour('#ffffff')).toEqual([1, 1, 1, 1]);
    expect(parseColour('#FF0000')).toEqual([1, 0, 0, 1]);
    expect(parseColour('#00ff0080')?.[3]).toBeCloseTo(128 / 255, 6);
    expect(parseColour('#0f08')?.[3]).toBeCloseTo(136 / 255, 6);
  });

  it('reads the functional forms', () => {
    expect(parseColour('rgb(255, 0, 0)')).toEqual([1, 0, 0, 1]);
    expect(parseColour('rgba(0, 0, 255, 0.5)')).toEqual([0, 0, 1, 0.5]);
    expect(parseColour('rgb(255 0 0 / 0.25)')).toEqual([1, 0, 0, 0.25]);
  });

  it('reads a gradient as where it starts, which is the honest flat answer', () => {
    expect(parseColour({ colorStops: [{ color: '#ff0000' }, { color: '#0000ff' }] })).toEqual([
      1, 0, 0, 1,
    ]);
  });

  it('reports nothing for a functional colour with a channel missing', () => {
    expect(parseColour('rgb(1, 2)')).toBeNull();
  });

  it('reports nothing rather than guessing', () => {
    // A hole is easier to notice and diagnose than a plausible wrong colour.
    for (const value of [
      undefined,
      null,
      '',
      'none',
      'transparent',
      'rebeccapurple',
      '#12345',
      'rgb(a, b, c)',
      'hsl(1,2%,3%)',
      42,
      { colorStops: [] },
      { colorStops: [{}] },
    ]) {
      expect(parseColour(value)).toBeNull();
    }
  });

  it('multiplies in an element opacity, and leaves a solid one alone', () => {
    expect(withOpacity([1, 0, 0, 1], 0.5)).toEqual([1, 0, 0, 0.5]);
    expect(withOpacity([1, 0, 0, 0.5], 0.5)).toEqual([1, 0, 0, 0.25]);
    expect(withOpacity([1, 0, 0, 1], 1)).toEqual([1, 0, 0, 1]);
    expect(withOpacity([1, 0, 0, 1], undefined)).toEqual([1, 0, 0, 1]);
    expect(withOpacity([1, 0, 0, 1], Number.NaN)).toEqual([1, 0, 0, 1]);
    expect(withOpacity([1, 0, 0, 1], -1)).toEqual([1, 0, 0, 0]);
  });

  it('writes a colour back the way ECharts wants to receive it', () => {
    expect(toCssColour([1, 0, 0, 1])).toBe('#ff0000');
    expect(toCssColour([0, 0, 0, 1])).toBe('#000000');
    expect(toCssColour([1, 1, 1, 0.5])).toBe('rgba(255,255,255,0.5)');
    // Clamped, so a colour outside the range is still a colour.
    expect(toCssColour([2, -1, 0, 1])).toBe('#ff0000');
  });
});

describe('reading text out of the display list', () => {
  /** A label as zrender hands one over: a TSpan carrying a resolved style. */
  const label = (style: Record<string, unknown>, transform?: readonly number[]): TSpan => {
    const span = new TSpan({ style: style as never });
    if (transform !== undefined) (span as { transform?: readonly number[] }).transform = transform;
    return span;
  };
  const metrics = { measureText: (text: string) => text.length * 6, fontFamily: 'sans-serif' };
  const only = (element: TSpan): ChartText | undefined =>
    extractDrawList([element as never], metrics).texts[0];

  it('anchors by the baseline the style asks for', () => {
    const at = (textBaseline: string | undefined): number | undefined =>
      only(label({ text: 'x', fill: '#000', fontSize: 10, textBaseline }, [1, 0, 0, 1, 0, 100]))?.y;
    const height = 10 * 1.4;
    expect(at('top')).toBe(100);
    expect(at('hanging')).toBe(100);
    expect(at('middle')).toBe(100 - height / 2);
    expect(at('bottom')).toBe(100 - height);
    expect(at('ideographic')).toBe(100 - height);
    // The alphabetic baseline is a distance from the top, matched to the
    // renderer's own formula so labels do not drift against everything else.
    expect(at('alphabetic')).toBe(100 - Math.round((height + 10 * 0.72) / 2));
    expect(at(undefined)).toBe(at('alphabetic'));
  });

  it('anchors by the alignment the style asks for', () => {
    const at = (textAlign: string | undefined): number | undefined =>
      only(label({ text: 'abcd', fill: '#000', fontSize: 10, textAlign }, [1, 0, 0, 1, 50, 0]))?.x;
    expect(at('left')).toBe(50);
    expect(at(undefined)).toBe(50);
    expect(at('right')).toBe(50 - 24);
    expect(at('end')).toBe(50 - 24);
    expect(at('center')).toBe(50 - 12);
  });

  it('leaves out a label there is nothing to draw', () => {
    expect(only(label({ text: '', fill: '#000' }))).toBeUndefined();
    expect(only(label({ fill: '#000' }))).toBeUndefined();
    // No colour is no label: a hole is easier to diagnose than a black smear.
    expect(only(label({ text: 'x', fill: 'none' }))).toBeUndefined();
  });

  it('turns a number into text rather than dropping it', () => {
    expect(only(label({ text: 42 as never, fill: '#000' }))?.text).toBe('42');
  });

  it('reads the size out of the font when there is no explicit one', () => {
    expect(
      only(label({ text: 'x', fill: '#000', font: 'normal normal 17px sans-serif' }))?.fontSize,
    ).toBe(17);
    // And falls back to something readable when the font says nothing.
    expect(only(label({ text: 'x', fill: '#000', font: 'inherit' }))?.fontSize).toBe(12);
  });

  it('marks a bold label bold', () => {
    expect(only(label({ text: 'x', fill: '#000', font: 'bold 12px sans' }))?.bold).toBe(true);
    expect(only(label({ text: 'x', fill: '#000', font: '700 12px sans' }))?.bold).toBe(true);
    expect(only(label({ text: 'x', fill: '#000', font: '12px sans' }))?.bold).toBeUndefined();
  });

  it('declines to draw a rotated label rather than drawing it upright', () => {
    // Upright is the wrong place; the glyph batch cannot turn, so it is left out.
    expect(only(label({ text: 'x', fill: '#000' }, [0.7, 0.7, -0.7, 0.7, 0, 0]))).toBeUndefined();
  });

  it('skips what zrender has marked as not to be drawn', () => {
    const hidden = label({ text: 'x', fill: '#000' });
    (hidden as { invisible?: boolean }).invisible = true;
    expect(extractDrawList([hidden as never], metrics).texts).toEqual([]);
    const ignored = label({ text: 'x', fill: '#000' });
    (ignored as { ignore?: boolean }).ignore = true;
    expect(extractDrawList([ignored as never], metrics).texts).toEqual([]);
  });

  it('ignores anything that is neither a path nor a label', () => {
    expect(extractDrawList([{} as never], metrics)).toEqual({ polygons: [], texts: [] });
  });

  it('reads a size and a weight from nothing at all without falling over', () => {
    const bare = only(label({ text: 'x', fill: '#000' }));
    expect(bare?.fontSize).toBe(12);
    expect(bare?.bold).toBeUndefined();
  });

  it('adds the style position to the transform, when there is one', () => {
    const positioned = only(
      label(
        { text: 'x', fill: '#000', fontSize: 10, x: 7, y: 3, textBaseline: 'top' },
        [1, 0, 0, 1, 100, 200],
      ),
    );
    expect(positioned?.x).toBe(107);
    expect(positioned?.y).toBe(203);
  });
});

describe('reading shapes out of the display list', () => {
  const metrics = { measureText: (text: string) => text.length * 6, fontFamily: 'sans-serif' };

  it('fills and strokes a path, with its own opacities', () => {
    const rect = new Rect({
      shape: { x: 0, y: 0, width: 10, height: 10 },
      style: { fill: '#ff0000', fillOpacity: 0.5, stroke: '#0000ff', lineWidth: 3 },
    });
    const list = extractDrawList([rect as never], metrics);
    const fills = list.polygons.filter((polygon) => polygon.color[0] === 1);
    const strokes = list.polygons.filter((polygon) => polygon.color[2] === 1);
    expect(fills).toHaveLength(2);
    expect(fills[0]?.color[3]).toBe(0.5);
    expect(strokes).toHaveLength(4);
  });

  it('takes an element opacity where there is no per-part one', () => {
    const rect = new Rect({
      shape: { x: 0, y: 0, width: 10, height: 10 },
      style: { fill: '#ff0000', stroke: '#0000ff', opacity: 0.25 },
    });
    const list = extractDrawList([rect as never], metrics);
    expect(list.polygons.every((polygon) => polygon.color[3] === 0.25)).toBe(true);
  });

  it('strokes a hairline when no width was given', () => {
    const rect = new Rect({
      shape: { x: 0, y: 0, width: 10, height: 10 },
      style: { stroke: '#000000' },
    });
    expect(extractDrawList([rect as never], metrics).polygons.length).toBeGreaterThan(0);
  });

  it('draws nothing for a path with neither a fill nor a stroke', () => {
    const rect = new Rect({
      shape: { x: 0, y: 0, width: 10, height: 10 },
      style: { fill: 'none', stroke: 'none' },
    });
    expect(extractDrawList([rect as never], metrics).polygons).toEqual([]);
  });

  it('fills in the defaults for a style that says nothing', () => {
    const bare = new Rect({ shape: { x: 0, y: 0, width: 10, height: 10 } });
    // zrender's own default is a black fill and no stroke.
    const list = extractDrawList([bare as never], metrics);
    expect(list.polygons).toHaveLength(2);
    expect(list.polygons[0]?.color[3]).toBe(1);
  });

  it('multiplies a part opacity by the element’s own', () => {
    const rect = new Rect({
      shape: { x: 0, y: 0, width: 10, height: 10 },
      style: { fill: '#ff0000', fillOpacity: 0.5, opacity: 0.5 },
    });
    const list = extractDrawList([rect as never], metrics);
    expect(list.polygons[0]?.color[3]).toBe(0.25);
  });

  it('moves a path by its own transform', () => {
    const rect = new Rect({
      shape: { x: 0, y: 0, width: 10, height: 10 },
      style: { fill: '#ff0000' },
    });
    (rect as { transform?: readonly number[] }).transform = [1, 0, 0, 1, 50, 60];
    const list = extractDrawList([rect as never], metrics);
    const xs = list.polygons.flatMap((polygon) => [polygon.corners[0], polygon.corners[2]]);
    expect(Math.min(...xs)).toBe(50);
  });
});
