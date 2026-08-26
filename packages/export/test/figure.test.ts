import { describe, expect, it } from 'vitest';
import type { ChartDrawList } from '@panorama/chart';
import type { ChartFigure } from '@panorama/export';
import {
  CHART_EXPORT_FORMATS,
  FIGURE_PADDING,
  FIGURE_TITLE_HEIGHT,
  chartFigureToPdf,
  chartFigureToSvg,
  cssColour,
  figureLayout,
} from '@panorama/export';

const chart: ChartDrawList = {
  polygons: [
    { corners: [0, 0, 10, 0, 10, 10, 0, 10], color: [1, 0, 0, 1] },
    { corners: [20, 0, 30, 0, 30, 10, 20, 10], color: [1, 0, 0, 1] },
    { corners: [40, 0, 50, 0, 50, 10, 40, 10], color: [0, 0, 1, 1] },
  ],
  texts: [
    {
      x: 10,
      y: 20,
      width: 40,
      height: 14,
      text: '700,000',
      color: [0.2, 0.2, 0.2, 1],
      align: 'right',
      fontSize: 10,
    },
  ],
};

const figure = (overrides: Partial<ChartFigure> = {}): ChartFigure => ({
  title: 'SALES.ORDERS · Chart',
  note: '100 rows',
  chart,
  width: 400,
  height: 240,
  background: [1, 1, 1, 1],
  text: [0.3, 0.3, 0.3, 1],
  fontFamily: 'sans-serif',
  fontSize: 10,
  ...overrides,
});

describe('laying a figure out', () => {
  it('makes room for the title above and the note below', () => {
    const layout = figureLayout(figure());
    expect(layout.width).toBe(400 + FIGURE_PADDING * 2);
    expect(layout.height).toBeGreaterThan(240 + FIGURE_TITLE_HEIGHT);
    expect(layout.chart.y).toBe(FIGURE_PADDING + FIGURE_TITLE_HEIGHT);
    expect(layout.note?.y).toBe(FIGURE_PADDING + FIGURE_TITLE_HEIGHT + 240);
  });

  it('reclaims the note band when there is no note', () => {
    const withNote = figureLayout(figure());
    const { note: _note, ...bare } = figure();
    const without = figureLayout(bare);
    expect(without.note).toBeNull();
    expect(without.height).toBeLessThan(withNote.height);
  });

  it('names the three formats a picture comes in', () => {
    expect(Object.keys(CHART_EXPORT_FORMATS)).toEqual(['svg', 'png', 'pdf']);
    expect(CHART_EXPORT_FORMATS.pdf.extension).toBe('.pdf');
    expect(CHART_EXPORT_FORMATS.png.mimeType).toBe('image/png');
  });

  it('writes a colour the way CSS reads one', () => {
    expect(cssColour([1, 0, 0, 1])).toBe('rgb(255,0,0)');
    expect(cssColour([0, 0, 1, 0.5])).toBe('rgba(0,0,255,0.5)');
    // Clamped, so a colour outside the range is still a colour.
    expect(cssColour([2, -1, 0, 1])).toBe('rgb(255,0,0)');
  });
});

describe('a figure as SVG', () => {
  const svg = (overrides: Partial<ChartFigure> = {}): string =>
    chartFigureToSvg(figure(overrides), '<svg width="400" height="240"><circle r="5"/></svg>');

  it('is a document that parses, sized to the whole figure', () => {
    const document = svg();
    expect(document.startsWith('<?xml version="1.0"')).toBe(true);
    const layout = figureLayout(figure());
    expect(document).toContain(`width="${layout.width}" height="${layout.height}"`);
  });

  it('nests the library own drawing rather than taking it apart', () => {
    // An SVG inside an SVG is a placed drawing; picking one apart is how its
    // transforms get lost.
    expect(svg()).toContain('<circle r="5"/>');
    expect(svg()).toContain(`<svg x="${FIGURE_PADDING}"`);
  });

  it('strips an inner XML declaration, which a nested document must not carry', () => {
    const nested = chartFigureToSvg(
      figure(),
      '<?xml version="1.0" encoding="UTF-8"?>\n<svg><rect/></svg>',
    );
    expect(nested.match(/<\?xml/gu)).toHaveLength(1);
  });

  it('carries the title and the note, because a picture cannot say either', () => {
    expect(svg()).toContain('SALES.ORDERS · Chart');
    expect(svg()).toContain('100 rows');
  });

  it('leaves out the note when there is none', () => {
    const { note: _note, ...bare } = figure();
    expect(chartFigureToSvg(bare, '<svg/>')).not.toContain('100 rows');
  });

  it('escapes a title that would otherwise be markup', () => {
    const escaped = svg({ title: 'a & b < c' });
    expect(escaped).toContain('a &amp; b &lt; c');
    expect(escaped).not.toContain('a & b < c');
  });
});

describe('a figure as PDF', () => {
  const text = (bytes: Uint8Array): string => String.fromCharCode(...bytes);

  it('is a document a reader will accept', () => {
    const pdf = text(chartFigureToPdf(figure()));
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.endsWith('%%EOF\n')).toBe(true);
    expect(pdf).toContain('/Type /Catalog');
    expect(pdf).toContain('/Type /Page ');
  });

  it('points its cross-reference table at the objects it describes', () => {
    // The one thing in a PDF that fails silently: an offset a byte out and the
    // whole file is unreadable, with nothing in it to say why.
    const pdf = text(chartFigureToPdf(figure()));
    const xref = pdf.slice(pdf.indexOf('xref\n'));
    const offsets = [...xref.matchAll(/^(\d{10}) 00000 n $/gmu)].map((match) => Number(match[1]));
    expect(offsets).toHaveLength(6);
    offsets.forEach((offset, index) => {
      expect(pdf.slice(offset, offset + 12)).toContain(`${index + 1} 0 obj`);
    });
    const startxref = Number(/startxref\n(\d+)/u.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
  });

  it('uses the standard fonts, so the text is real text', () => {
    const pdf = text(chartFigureToPdf(figure()));
    expect(pdf).toContain('/BaseFont /Helvetica');
    expect(pdf).toContain('/BaseFont /Helvetica-Bold');
    // Selectable, searchable, copyable — most of why anyone wants a PDF.
    expect(pdf).toContain('(700,000) Tj');
    expect(pdf).toContain('(SALES.ORDERS · Chart) Tj');
  });

  it('sets a fill colour once per run of marks that share one', () => {
    // A chart is thousands of triangles, most the same colour as the one before.
    const pdf = text(chartFigureToPdf(figure()));
    const stream = pdf.slice(pdf.indexOf('stream'), pdf.indexOf('endstream'));
    // Three marks, two colours: red set once and blue once, plus the page.
    expect(stream.match(/1 0 0 rg/gu)).toHaveLength(1);
    expect(stream.match(/0 0 1 rg/gu)).toHaveLength(1);
  });

  it('flattens a translucent colour against the page rather than losing it', () => {
    // PDF's fill operator has no alpha, and a half-red mark on a white page is a
    // pink one.
    const faded = text(
      chartFigureToPdf(
        figure({
          chart: {
            polygons: [{ corners: [0, 0, 10, 0, 10, 10, 0, 10], color: [1, 0, 0, 0.5] }],
            texts: [],
          },
        }),
      ),
    );
    expect(faded).toContain('1 0.5 0.5 rg');
  });

  it('escapes the syntax characters, and drops what a standard font has no glyph for', () => {
    const awkward = text(chartFigureToPdf(figure({ title: 'a (b) \\ c \u{1F600} d' })));
    expect(awkward).toContain('(a \\(b\\) \\\\ c  d) Tj');
  });

  it('places a right-aligned run from the width the reader will lay out', () => {
    // The box was measured with the application's own font. Placed from that
    // width, a right-aligned axis number would drift away from its tick.
    const pdf = text(chartFigureToPdf(figure()));
    const placement = /([\d.]+) ([\d.]+) Td\n\(700,000\) Tj/u.exec(pdf);
    expect(placement).not.toBeNull();
    // Right-aligned in a box from x=10 to x=50, offset by the figure padding.
    const x = Number(placement?.[1]);
    expect(x).toBeGreaterThan(FIGURE_PADDING);
    expect(x).toBeLessThan(FIGURE_PADDING + 50);
  });

  it('centres a centred run, and leaves a left-aligned one where it is', () => {
    const place = (align: 'left' | 'center'): number => {
      const pdf = text(
        chartFigureToPdf(
          figure({
            chart: {
              polygons: [],
              texts: [
                {
                  x: 100,
                  y: 0,
                  width: 60,
                  height: 14,
                  text: 'ab',
                  color: [0, 0, 0, 1],
                  align,
                  fontSize: 10,
                },
              ],
            },
          }),
        ),
      );
      return Number(/([\d.]+) [\d.]+ Td\n\(ab\) Tj/u.exec(pdf)?.[1]);
    };
    expect(place('left')).toBeCloseTo(100 + FIGURE_PADDING, 1);
    expect(place('center')).toBeGreaterThan(100 + FIGURE_PADDING);
  });

  it('has a page to itself even with nothing to draw on it', () => {
    const { note: _note, ...bare } = figure({ chart: { polygons: [], texts: [] } });
    const empty = text(chartFigureToPdf(bare));
    expect(empty).toContain('/Count 1');
    expect(empty).toContain('%%EOF');
  });

  it('writes only bytes, so the offsets it promised are the offsets there are', () => {
    // A stream written as UTF-8 would shift every offset in the table.
    const bytes = chartFigureToPdf(figure({ title: 'é' }));
    expect(bytes.every((byte) => byte <= 0xff)).toBe(true);
    const pdf = text(bytes);
    const startxref = Number(/startxref\n(\d+)/u.exec(pdf)?.[1]);
    expect(pdf.slice(startxref, startxref + 4)).toBe('xref');
  });
});
