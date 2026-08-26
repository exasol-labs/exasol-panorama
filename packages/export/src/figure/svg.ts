import type { ChartFigure } from './figure.js';
import { escapeXml } from '../xlsx/xlsx.js';
import { cssColour, figureLayout } from './figure.js';

/**
 * A chart as an SVG document.
 *
 * The chart itself comes from the library that laid it out — real arcs, real
 * curves, real text — and is nested as a child `<svg>` rather than picked apart,
 * because an SVG inside an SVG is a placed drawing and taking one apart to move
 * it is how transforms get lost. Around it goes the title and the note, so the
 * file is the box rather than the plot.
 */

/** Strips the XML declaration a nested document must not carry. */
const nestable = (svg: string): string => svg.replace(/<\?xml[^>]*\?>\s*/u, '');

export const chartFigureToSvg = (figure: ChartFigure, chartSvg: string): string => {
  const layout = figureLayout(figure);
  const text = cssColour(figure.text);
  const font = escapeXml(figure.fontFamily);
  const parts: string[] = [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.width}" height="${layout.height}" viewBox="0 0 ${layout.width} ${layout.height}">`,
    `<rect width="${layout.width}" height="${layout.height}" fill="${cssColour(figure.background)}"/>`,
    `<text x="${layout.title.x}" y="${layout.title.y + layout.title.size}" fill="${text}" font-family="${font}" font-size="${layout.title.size}" font-weight="600">${escapeXml(figure.title)}</text>`,
    `<svg x="${layout.chart.x}" y="${layout.chart.y}" width="${figure.width}" height="${figure.height}" overflow="hidden">`,
    nestable(chartSvg),
    `</svg>`,
  ];
  if (layout.note !== null && figure.note !== undefined) {
    parts.push(
      `<text x="${layout.note.x}" y="${layout.note.y + layout.note.size}" fill="${text}" font-family="${font}" font-size="${layout.note.size}">${escapeXml(figure.note)}</text>`,
    );
  }
  parts.push('</svg>');
  return parts.join('\n');
};
