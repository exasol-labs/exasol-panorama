import type {
  ChartDrawList,
  ChartMark,
  ChartPolygon,
  ChartResolution,
  ChartRgba,
  ChartSurface,
  ChartSurfaceInput,
  ChartText,
  ChartTypography,
} from '@panorama/chart';
import { EMPTY_CHART_RESOLUTION } from '@panorama/chart';
import * as echarts from 'echarts';
import { Path, TSpan, setPlatformAPI } from 'zrender';
import { parseColour, withOpacity } from './colour.js';
import type { Affine, ChartPoint } from './geometry.js';
import { PolylineContext, applyAffine, fillOutline, strokeOutline } from './geometry.js';
import { chartOption } from './option.js';
import { resolveOption, seriesDatasets } from './resolution.js';

/**
 * ECharts, used as a layout engine rather than as a renderer.
 *
 * The whole integration rests on two hinges. Its text measurement is replaced
 * with Panorama's glyph atlas, so every axis label it positions is positioned for
 * the text that will actually appear — get this wrong and labels are spaced for a
 * font nobody is looking at. And its geometry is read out of zrender's display
 * list rather than off a canvas, so the chart is drawn by the same two batches as
 * every table, stays sharp at any zoom, and exists in a headset.
 *
 * What does not come through: tooltips. ECharts skips them in the server-side
 * rendering mode this uses, and no amount of coaxing produces one. Hover is
 * therefore Panorama's own business, which is where it belongs anyway — the
 * pointer is already hit-tested against everything else on the canvas.
 */

/** Line box for a label, as a multiple of its font size. */
const LINE_HEIGHT = 1.4;

/** Beyond this the label is rotated, and a rotated label is not drawn. */
const UPRIGHT = 0.02;

/**
 * Hands ECharts Panorama's own text metrics.
 *
 * zrender's hook is global, so this is set on the way into every layout rather
 * than once at startup: assigning a function costs nothing, and it means there is
 * no initialisation order to get wrong and no hidden state deciding how wide a
 * label is.
 */
const useTypography = (measured: ChartTypography): void => {
  setPlatformAPI({
    measureText: (text: string, font?: string): { width: number } => ({
      width: measured.measureText(text, fontSizeOf(font), boldOf(font)),
    }),
  });
};

const fontSizeOf = (font: string | undefined): number => {
  const px = /(\d+(?:\.\d+)?)px/u.exec(font ?? '')?.[1];
  return px === undefined ? 12 : Number(px);
};

const boldOf = (font: string | undefined): boolean =>
  /(^|\s)(bold|[6-9]00)(\s|$)/u.test(font ?? '');

interface ZrStyle {
  readonly fill?: unknown;
  readonly stroke?: unknown;
  readonly lineWidth?: number;
  readonly opacity?: number;
  readonly fillOpacity?: number;
  readonly strokeOpacity?: number;
  readonly text?: unknown;
  readonly font?: string;
  readonly fontSize?: number;
  /**
   * Canvas's names, not zrender's public ones: what reaches the display list is
   * the resolved text style, and it speaks `textAlign` and `textBaseline`. Read
   * the wrong pair and every axis label is anchored by its left edge — which
   * looks almost right, and puts the numbers on top of the bars.
   */
  readonly textAlign?: unknown;
  readonly textBaseline?: unknown;
  readonly x?: number;
  readonly y?: number;
}

interface ZrElement {
  /** Every displayable carries one; zrender fills in the defaults itself. */
  readonly style: ZrStyle;
  readonly parent?: ZrElement;
  /**
   * The element a piece of attached text belongs to.
   *
   * A value label is not a child of the bar it labels — it is attached to it — so
   * the tree does not lead back to the mark and this does.
   */
  readonly __hostTarget?: ZrElement;
  readonly shape?: unknown;
  readonly transform?: Affine;
  readonly invisible?: boolean;
  readonly ignore?: boolean;
  buildPath?: (context: unknown, shape: unknown) => void;
}

const alignOf = (style: ZrStyle): 'left' | 'right' | 'center' => {
  const align = style.textAlign;
  if (align === 'right' || align === 'end') return 'right';
  if (align === 'center') return 'center';
  return 'left';
};

/**
 * Where the anchor sits vertically within the line box.
 *
 * Canvas baselines, translated into the fraction of the box above the anchor. The
 * alphabetic baseline is the awkward one: it is not a fraction of the box at all
 * but a distance from the top, so it is matched to the renderer's own formula for
 * where a baseline goes — the same arithmetic on both sides, or labels drift.
 */
const topOf = (style: ZrStyle, anchorY: number, height: number, fontSize: number): number => {
  switch (style.textBaseline) {
    case 'top':
    case 'hanging':
      return anchorY;
    case 'middle':
      return anchorY - height / 2;
    case 'bottom':
    case 'ideographic':
      return anchorY - height;
    default:
      return anchorY - Math.round((height + fontSize * 0.72) / 2);
  }
};

/**
 * A label as a box the glyph renderer can place text in.
 *
 * ECharts gives an anchor point plus an alignment; the draw list wants a box with
 * the text laid out inside it. Measuring here — with the same metrics ECharts was
 * given — turns one into the other exactly, so a centred axis label ends up
 * centred on the tick rather than near it.
 */
const textFor = (element: ZrElement, metrics: ChartTypography): ChartText | null => {
  const style = element.style;
  const content = typeof style.text === 'string' ? style.text : String(style.text ?? '');
  if (content === '') return null;
  const matrix = element.transform;
  // A rotated label cannot be drawn upright without lying about where it is. A
  // transform is a full 2×3 when there is one, so its shear term is there too.
  if (matrix !== undefined && Math.abs(matrix[1] as number) > UPRIGHT) return null;
  const colour = parseColour(style.fill);
  if (colour === null) return null;

  const fontSize = style.fontSize ?? fontSizeOf(style.font);
  const bold = boldOf(style.font);
  const anchor = applyAffine(matrix, { x: style.x ?? 0, y: style.y ?? 0 });
  const width = metrics.measureText(content, fontSize, bold);
  const height = fontSize * LINE_HEIGHT;
  const align = alignOf(style);
  const left =
    align === 'center' ? anchor.x - width / 2 : align === 'right' ? anchor.x - width : anchor.x;
  const top = topOf(style, anchor.y, height, fontSize);

  return {
    x: left,
    y: top,
    width,
    height,
    text: content,
    color: withOpacity(colour, style.opacity),
    // The box is exactly the text, so aligning inside it gives the same answer
    // whichever edge you align to — and keeping the original alignment lets an
    // exporter with different font metrics anchor the run to the edge that was
    // meant rather than sliding it.
    align,
    fontSize,
    ...(bold ? { bold: true } : {}),
  };
};

/**
 * A path's colours and width, with zrender's defaults filled in once.
 *
 * The opacities multiply rather than shadow one another: canvas applies the
 * element's opacity *and* the part's, so a half-transparent fill inside a
 * quarter-opaque element is an eighth. Taking one or the other would quietly drop
 * a fade somebody asked for.
 */
const resolvePaint = (
  style: ZrStyle,
): { fill: ChartRgba | null; stroke: ChartRgba | null; width: number } => {
  const opacity = style.opacity ?? 1;
  const fill = parseColour(style.fill);
  const stroke = parseColour(style.stroke);
  return {
    fill: fill === null ? null : withOpacity(fill, (style.fillOpacity ?? 1) * opacity),
    stroke: stroke === null ? null : withOpacity(stroke, (style.strokeOpacity ?? 1) * opacity),
    width: style.lineWidth ?? 1,
  };
};

/**
 * Which mark an element belongs to, if any.
 *
 * The chart library keeps this on its elements under a private key whose name
 * carries a module-load counter, so it is found by shape rather than by name:
 * the one own property holding an object with a numeric `dataIndex`. Named
 * lookup would break on a version bump *silently*, leaving a chart that draws
 * perfectly and cannot be pointed at; this way the contract test has something
 * to fail on.
 */
const ownMark = (element: ZrElement): ChartMark | undefined => {
  for (const value of Object.values(element as unknown as Record<string, unknown>)) {
    if (typeof value !== 'object' || value === null) continue;
    const candidate = value as { dataIndex?: unknown; seriesIndex?: unknown };
    if (typeof candidate.dataIndex !== 'number' || candidate.dataIndex < 0) continue;
    if (typeof candidate.seriesIndex !== 'number') continue;
    return { series: candidate.seriesIndex, data: candidate.dataIndex };
  }
  return undefined;
};

/** How far up the tree a piece of geometry can be from the mark that owns it. */
const MARK_DEPTH = 4;

const markOf = (element: ZrElement): ChartMark | undefined => {
  // Up the tree as well as on the element, because a value label is a child of
  // the bar it labels and should light up with it rather than beside it.
  let current: ZrElement | undefined = element;
  for (let depth = 0; depth < MARK_DEPTH && current !== undefined; depth += 1) {
    const mark = ownMark(current);
    if (mark !== undefined) return mark;
    current = current.__hostTarget ?? current.parent;
  }
  return undefined;
};

const isVisible = (element: ZrElement): boolean =>
  element.invisible !== true && element.ignore !== true;

/** Walks the display list into geometry. The one place internals are touched. */
export const extractDrawList = (
  elements: readonly ZrElement[],
  metrics: ChartTypography,
  /** The data set each series reads, so a mark can say which row it is. */
  datasets: readonly (string | undefined)[] = [],
): ChartDrawList => {
  const polygons: ChartPolygon[] = [];
  const texts: ChartText[] = [];
  for (const element of elements) {
    if (!isVisible(element)) continue;
    const found = markOf(element);
    // Stamped here, where the series index is still in hand: a mark that knows
    // its data set and row can be traced back to the relation, and one that does
    // not can only be compared with other marks.
    const frame = found === undefined ? undefined : datasets[found.series];
    const mark =
      found === undefined || frame === undefined ? found : { ...found, frame, row: found.data };
    if (element instanceof TSpan) {
      const text = textFor(element, metrics);
      if (text !== null) texts.push(mark === undefined ? text : { ...text, mark });
      continue;
    }
    if (!(element instanceof Path) || element.buildPath === undefined) continue;
    const paint = resolvePaint(element.style);
    const context = new PolylineContext();
    element.buildPath(context, element.shape);
    const tag = (piece: ChartPolygon): ChartPolygon =>
      mark === undefined ? piece : { ...piece, mark };
    for (const subpath of context.subpaths) {
      const points: readonly ChartPoint[] = subpath.points.map((point) =>
        applyAffine(element.transform, point),
      );
      // Appended one at a time rather than spread in: `push(...pieces)` is a call
      // with one argument per piece, and a single polyline of a few tens of
      // thousands of points is a longer argument list than the stack allows.
      if (paint.fill !== null) {
        for (const piece of fillOutline(points, paint.fill)) polygons.push(tag(piece));
      }
      if (paint.stroke !== null) {
        for (const piece of strokeOutline(points, paint.width, paint.stroke, subpath.closed)) {
          polygons.push(tag(piece));
        }
      }
    }
  }
  return { polygons, texts };
};

interface EchartsInstance {
  setOption(option: unknown, notMerge?: boolean): void;
  renderToSVGString(): string;
  resize(size: { width: number; height: number }): void;
  dispatchAction(action: Record<string, unknown>): void;
  getZr(): { storage: { getDisplayList(update?: boolean): readonly ZrElement[] } };
  dispose(): void;
}

export class EChartsSurface implements ChartSurface {
  #chart: EchartsInstance | null = null;
  #typography: ChartTypography | null = null;
  #drawList: ChartDrawList = { polygons: [], texts: [] };
  /** The option this was laid out for, which is what the report reads. */
  #option: unknown = null;
  /** Which data set each series reads, for stamping the marks. */
  #datasets: readonly (string | undefined)[] = [];
  #width = 0;
  #height = 0;

  update(input: ChartSurfaceInput): void {
    const metrics = input.typography;
    useTypography(metrics);
    this.#typography = metrics;
    const width = Math.max(1, Math.round(input.width));
    const height = Math.max(1, Math.round(input.height));
    if (this.#chart === null) {
      // Headless, and with the SVG painter, so nothing here ever asks for a
      // canvas: the painter's output is discarded and only its geometry is read.
      this.#chart = echarts.init(null, null, {
        renderer: 'svg',
        ssr: true,
        width,
        height,
      }) as unknown as EchartsInstance;
    } else if (width !== this.#width || height !== this.#height) {
      this.#chart.resize({ width, height });
    }
    this.#width = width;
    this.#height = height;
    const option = chartOption(input.spec, input.data, input.frames, input.theme, metrics);
    this.#option = option;
    this.#datasets = seriesDatasets(option);
    this.#chart.setOption(option, true);
    this.#read(this.#chart, metrics);
  }

  point(x: number | null, y: number | null): void {
    const chart = this.#chart;
    const metrics = this.#typography;
    if (chart === null || metrics === null) return;
    chart.dispatchAction(
      x === null || y === null ? { type: 'downplay' } : { type: 'highlight', x, y },
    );
    this.#read(chart, metrics);
  }

  draw(): ChartDrawList {
    return this.#drawList;
  }

  resolution(): ChartResolution {
    // Counted against the last geometry, so "drew no marks" is a fact about the
    // picture rather than a guess from the option.
    return this.#option === null
      ? EMPTY_CHART_RESOLUTION
      : resolveOption(this.#option, this.#drawList);
  }

  toSvg(): string | null {
    return this.#chart?.renderToSVGString() ?? null;
  }

  dispose(): void {
    this.#chart?.dispose();
    this.#chart = null;
    this.#option = null;
  }

  /** Only ever called with a chart in hand, which is why it takes one. */
  #read(chart: EchartsInstance, metrics: ChartTypography): void {
    this.#drawList = extractDrawList(
      chart.getZr().storage.getDisplayList(true),
      metrics,
      this.#datasets,
    );
  }
}
