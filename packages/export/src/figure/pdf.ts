import type { ChartPolygon, ChartRgba, ChartText } from '@panorama/chart';
import type { ChartFigure } from './figure.js';
import { figureLayout } from './figure.js';

/**
 * A chart as a PDF.
 *
 * Hand-written, like the Parquet and the spreadsheet, and for the same reason: a
 * one-page vector document is a few hundred lines of a format that has not
 * changed in twenty years, and the alternative is a megabyte of dependency to
 * write the same bytes.
 *
 * Real text, not outlines. The fourteen standard fonts are in every reader, so a
 * chart's labels come out selectable, searchable and copyable — which is most of
 * why anybody wants a PDF rather than a picture.
 *
 * The geometry comes from the draw list, so the curves arrive as the polygons the
 * GPU drew rather than as arcs. Scalable and sharp, and the SVG is the format to
 * reach for when the arcs themselves matter.
 */

/** Points per inch, and the unit PDF measures everything in. */
const POINTS_PER_PIXEL = 0.75;

/**
 * Helvetica's advance widths, in thousandths of the font size.
 *
 * The printable ASCII range, which is what an axis label is. Needed because the
 * figure's boxes were measured with the application's own font: without these a
 * right-aligned number would be placed from a width that is not the width the
 * reader will lay out, and would drift away from its tick.
 */
const HELVETICA_WIDTHS: readonly number[] = Object.freeze([
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556,
  556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667,
  611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500,
  222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
]);

/** Bold is wider; near enough for placement, and exact for the standard font. */
const BOLD_SCALE = 1.06;

const advance = (text: string, size: number, bold: boolean): number => {
  let width = 0;
  for (const character of text) {
    const code = character.codePointAt(0) ?? 32;
    // Anything outside the range is approximated by a lower-case letter, which is
    // closer than assuming nothing and keeps a stray glyph from collapsing a box.
    const thousandths = code >= 32 && code <= 126 ? (HELVETICA_WIDTHS[code - 32] as number) : 556;
    width += (thousandths / 1000) * size;
  }
  return bold ? width * BOLD_SCALE : width;
};

/** Numbers in a content stream: short, and never in exponential form. */
const number = (value: number): string => {
  const rounded = Math.round(value * 100) / 100;
  return Number.isFinite(rounded) ? rounded.toFixed(2).replace(/\.?0+$/u, '') || '0' : '0';
};

/**
 * A colour as PDF sets one, flattened against what is behind it.
 *
 * PDF's `rg` operator has no alpha. Honouring one properly means a graphics-state
 * object per distinct opacity, which for a page whose background is a single
 * opaque colour buys nothing: blending against that colour gives the same pixels.
 * The one case it approximates is two translucent marks overlapping, where the
 * second is flattened against the page rather than against the first — visible
 * only where an area chart is stacked on itself, and a good deal better than
 * losing the fade or the dependency of writing a whole state machine for it.
 */
const colour = (value: ChartRgba, behind: ChartRgba): string => {
  const alpha = Math.min(1, Math.max(0, value[3]));
  const blend = (index: 0 | 1 | 2): number =>
    value[index] * alpha + (behind[index] as number) * (1 - alpha);
  return `${number(blend(0))} ${number(blend(1))} ${number(blend(2))}`;
};

/**
 * A string as PDF literal text.
 *
 * Parentheses and backslashes are the syntax, so they are escaped; anything
 * outside Latin-1 has no place in a standard font's encoding and is dropped
 * rather than written as a byte that means something else.
 */
const literal = (text: string): string => {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 255) continue;
    if (character === '(' || character === ')' || character === '\\') out += `\\${character}`;
    else if (code < 32) out += ' ';
    else out += character;
  }
  return out;
};

/** Where a run starts, given the width the reader will actually lay out. */
const leftEdge = (run: ChartText, size: number): number => {
  const natural = advance(run.text, size, run.bold === true);
  switch (run.align) {
    case 'right':
      return run.x + run.width - natural;
    case 'center':
      return run.x + run.width / 2 - natural / 2;
    default:
      return run.x;
  }
};

/**
 * Groups consecutive polygons of one colour into one path.
 *
 * A chart is thousands of triangles, most of them the same colour as the one
 * before. Setting the colour once per run rather than once per triangle is the
 * difference between a file of a few kilobytes and one of a few hundred.
 */
const fillPolygons = (
  polygons: readonly ChartPolygon[],
  offsetX: number,
  flip: (y: number) => number,
  behind: ChartRgba,
): string => {
  const parts: string[] = [];
  let current: ChartRgba | null = null;
  for (const polygon of polygons) {
    const sameColour =
      current !== null &&
      current[0] === polygon.color[0] &&
      current[1] === polygon.color[1] &&
      current[2] === polygon.color[2] &&
      current[3] === polygon.color[3];
    if (!sameColour) {
      if (current !== null) parts.push('f');
      parts.push(`${colour(polygon.color, behind)} rg`);
      current = polygon.color;
    }
    const [x0, y0, x1, y1, x2, y2, x3, y3] = polygon.corners;
    const point = (x: number, y: number): string => `${number(offsetX + x)} ${number(flip(y))}`;
    parts.push(`${point(x0, y0)} m ${point(x1, y1)} l ${point(x2, y2)} l ${point(x3, y3)} l h`);
  }
  if (current !== null) parts.push('f');
  return parts.join('\n');
};

const textRun = (
  run: ChartText,
  offsetX: number,
  offsetY: number,
  flip: (y: number) => number,
  behind: ChartRgba,
): string => {
  const size = run.fontSize;
  const x = offsetX + leftEdge(run, size);
  // The draw list's boxes bear their baseline the way the glyph renderer derives
  // it, so the same arithmetic is used here and the text sits on the same line.
  const baseline = offsetY + run.y + Math.round((run.height + size * 0.72) / 2);
  return [
    'BT',
    `/${run.bold === true ? 'F2' : 'F1'} ${number(size)} Tf`,
    `${colour(run.color, behind)} rg`,
    `${number(x)} ${number(flip(baseline - offsetY))} Td`,
    `(${literal(run.text)}) Tj`,
    'ET',
  ].join('\n');
};

const OBJECT_COUNT = 6;

/** Builds the document, with a cross-reference table the readers insist on. */
const document = (content: string, width: number, height: number): Uint8Array => {
  const objects: readonly string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${number(width)} ${number(height)}] ` +
      '/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
  ];

  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const startxref = body.length;
  body += `xref\n0 ${OBJECT_COUNT + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) {
    body += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  body +=
    `trailer\n<< /Size ${OBJECT_COUNT + 1} /Root 1 0 R >>\n` + `startxref\n${startxref}\n%%EOF\n`;
  // Latin-1: every byte this writer emits is one, and a text stream written as
  // UTF-8 would shift every offset in the table above.
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) bytes[index] = body.charCodeAt(index) & 0xff;
  return bytes;
};

export const chartFigureToPdf = (figure: ChartFigure): Uint8Array => {
  const layout = figureLayout(figure);
  const scale = POINTS_PER_PIXEL;
  const pageHeight = layout.height;
  // PDF counts upwards from the bottom of the page; the draw list counts down
  // from the top of the box. One flip, applied everywhere.
  const flip = (y: number): number => pageHeight - y;

  const stream: string[] = [
    'q',
    `${number(scale)} 0 0 ${number(scale)} 0 0 cm`,
    `${colour(figure.background, figure.background)} rg`,
    `0 0 ${number(layout.width)} ${number(pageHeight)} re f`,
    textRun(
      {
        x: layout.title.x,
        y: layout.title.y,
        width: layout.width - layout.title.x * 2,
        height: FIGURE_TITLE_LINE,
        text: figure.title,
        color: figure.text,
        align: 'left',
        fontSize: layout.title.size,
        bold: true,
      },
      0,
      0,
      flip,
      figure.background,
    ),
  ];

  if (figure.chart.polygons.length > 0) {
    stream.push(
      fillPolygons(
        figure.chart.polygons,
        layout.chart.x,
        (y) => flip(y + layout.chart.y),
        figure.background,
      ),
    );
  }
  for (const run of figure.chart.texts) {
    stream.push(
      textRun(
        run,
        layout.chart.x,
        layout.chart.y,
        (y) => flip(y + layout.chart.y),
        figure.background,
      ),
    );
  }
  if (layout.note !== null && figure.note !== undefined) {
    stream.push(
      textRun(
        {
          x: layout.note.x,
          y: layout.note.y,
          width: layout.width - layout.note.x * 2,
          height: FIGURE_NOTE_LINE,
          text: figure.note,
          color: figure.text,
          align: 'left',
          fontSize: layout.note.size,
        },
        0,
        0,
        flip,
        figure.background,
      ),
    );
  }
  stream.push('Q');

  return document(stream.join('\n'), layout.width * scale, pageHeight * scale);
};

/** Line boxes for the figure's own two labels, matching `figureLayout`. */
const FIGURE_TITLE_LINE = 22;
const FIGURE_NOTE_LINE = 16;
