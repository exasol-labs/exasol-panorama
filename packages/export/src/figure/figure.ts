import type { ChartDrawList, ChartRgba } from '@panorama/chart';
import type { FileFormatDescriptor } from '../format.js';

/**
 * A chart on its way out of the application, as a file.
 *
 * The *box*, not just the plot: a chart exported without the title above it and
 * the row count beneath it is a picture nobody can place afterwards. So the
 * figure carries all three, and every format lays them out the same way — which
 * is why the arithmetic lives here rather than three times over.
 */

export type ChartExportFormat = 'svg' | 'png' | 'pdf';

export interface ChartExportFormatDescriptor extends FileFormatDescriptor {
  readonly format: ChartExportFormat;
}

export const CHART_EXPORT_FORMATS: Readonly<
  Record<ChartExportFormat, ChartExportFormatDescriptor>
> = Object.freeze({
  svg: Object.freeze({
    format: 'svg',
    label: 'SVG',
    extension: '.svg',
    mimeType: 'image/svg+xml',
  }),
  png: Object.freeze({
    format: 'png',
    label: 'PNG',
    extension: '.png',
    mimeType: 'image/png',
  }),
  pdf: Object.freeze({
    format: 'pdf',
    label: 'PDF',
    extension: '.pdf',
    mimeType: 'application/pdf',
  }),
});

export interface ChartFigure {
  /** Shown above the chart, as the box's title bar shows it. */
  readonly title: string;
  /** Shown beneath it: what it was drawn from. */
  readonly note?: string;
  /**
   * The chart's own geometry, in its own coordinates. Used by the formats that
   * have to draw it themselves; the SVG asks the library instead.
   */
  readonly chart: ChartDrawList;
  /** The size the geometry was laid out for. */
  readonly width: number;
  readonly height: number;
  readonly background: ChartRgba;
  readonly text: ChartRgba;
  readonly fontFamily: string;
  readonly fontSize: number;
}

/** Margin around the whole figure. */
export const FIGURE_PADDING = 16;
/** Height of the band the title sits in. */
export const FIGURE_TITLE_HEIGHT = 22;
/** ...and the one the note sits in, when there is one. */
export const FIGURE_NOTE_HEIGHT = 16;

export interface FigureLayout {
  readonly width: number;
  readonly height: number;
  /** Baseline-bearing boxes, in figure coordinates: origin top-left, y down. */
  readonly title: { readonly x: number; readonly y: number; readonly size: number };
  readonly chart: { readonly x: number; readonly y: number };
  readonly note: { readonly x: number; readonly y: number; readonly size: number } | null;
}

/**
 * Where the three parts go.
 *
 * One function, so an SVG, a PNG and a PDF of the same chart are the same
 * picture. A format that laid its own title out would be a format that disagreed
 * with the other two about how tall the file is.
 */
export const figureLayout = (figure: ChartFigure): FigureLayout => {
  const titleSize = Math.round(figure.fontSize * 1.35);
  const noteHeight = figure.note === undefined ? 0 : FIGURE_NOTE_HEIGHT;
  return {
    width: figure.width + FIGURE_PADDING * 2,
    height: figure.height + FIGURE_TITLE_HEIGHT + noteHeight + FIGURE_PADDING * 2,
    title: { x: FIGURE_PADDING, y: FIGURE_PADDING, size: titleSize },
    chart: { x: FIGURE_PADDING, y: FIGURE_PADDING + FIGURE_TITLE_HEIGHT },
    note:
      figure.note === undefined
        ? null
        : {
            x: FIGURE_PADDING,
            y: FIGURE_PADDING + FIGURE_TITLE_HEIGHT + figure.height,
            size: figure.fontSize,
          },
  };
};

/** A colour as CSS writes it, for the formats that speak CSS. */
export const cssColour = (colour: ChartRgba): string => {
  const byte = (value: number): number => Math.round(Math.min(1, Math.max(0, value)) * 255);
  return colour[3] >= 1
    ? `rgb(${byte(colour[0])},${byte(colour[1])},${byte(colour[2])})`
    : `rgba(${byte(colour[0])},${byte(colour[1])},${byte(colour[2])},${colour[3]})`;
};
