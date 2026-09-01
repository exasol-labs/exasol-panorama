import type { ColumnDataType, EntityId, SemanticColumnView } from '@panorama/core';
import { semanticHeader, semanticRenames } from '@panorama/core';
import type {
  CellValue,
  ColumnSummary,
  JsonColumnSummary,
  SummaryBin,
  SummaryValueCount,
} from '@panorama/table';
import {
  EMPTY_STRING_TEXT,
  EXPLICIT_NULL_TEXT,
  MISSING_TEXT,
  formatCell,
  isNumericType,
  summaryChart,
} from '@panorama/table';
import type { ClipRect, QuadInstance, TextRun } from './draw-list.js';
import type { TableTheme } from '../theme.js';

/**
 * The panel that opens under a column that has been picked out.
 *
 * It answers the questions worth asking before reading a single row — how much
 * is missing, how many different things are in there, how far it spreads, what
 * is in it most often — and it answers them as a picture first and a number
 * second, because the picture is what can be taken in at a glance across four
 * columns at once. Which picture follows the data rather than the declared type:
 * few enough values to name and each gets a bar; too many, and a numeric column
 * gets a bar per range instead.
 *
 * Drawn by the GPU, like everything else on the canvas. A DOM panel would have
 * been quicker to write and would have stopped existing the moment the scene was
 * taken into a headset; it would also have had to be kept in step with a table
 * that moves, scrolls and zooms, which is exactly the bookkeeping a drawn panel
 * does not have.
 *
 * It hangs *below* the table for the same reason the halo hangs above: the data
 * is the one thing on screen that must never be covered up.
 */

/** Gap between the table's bottom edge and the panels below it. */
export const SUMMARY_PANEL_GAP = 12;
/** A narrow column still needs a readable panel. */
export const SUMMARY_PANEL_MIN_WIDTH = 200;
/** A wide one does not need a panel as wide as itself. */
export const SUMMARY_PANEL_MAX_WIDTH = 320;

const PADDING = 10;
const TITLE_ROW = 18;
const TYPE_ROW = 14;
const META_ROW = 15;
const BAR_ROW = 15;
const BAR_HEIGHT = 5;
const NULL_BAR_GAP = 4;
const HISTOGRAM_HEIGHT = 46;

/**
 * A bound on how far below a table a panel can reach.
 *
 * Used only for culling — the tallest panel is a numeric one: a histogram, its
 * axis, five figures and a sampling note — so it is deliberately generous.
 * Getting it wrong makes a panel vanish at the edge of the view, not draw
 * wrongly.
 */
export const SUMMARY_PANEL_MAX_HEIGHT = 360;

/** What the panel knows about its column. */
export interface SummaryPanelColumn {
  readonly name: string;
  readonly type: ColumnDataType;
  /** Absent while the answer is still on its way, or when there is none. */
  readonly summary: ColumnSummary | undefined;
  /** Shown in place of the numbers when there are none: why there are none. */
  readonly note: string | undefined;
  /**
   * What is in a property, where this column presents one.
   *
   * Drawn *above* the distribution rather than instead of it. For a property
   * spread across several typed branches the distribution is a statement about
   * some of the rows, and how many rows that is — and how many were `null`, or
   * empty, or absent — is the question to answer first.
   */
  readonly document?: JsonColumnSummary;
  /**
   * What a semantic layer says this column means, where one does.
   *
   * Drawn above everything else the panel has to say, because it answers what
   * the numbers *are* — and the panel's other answers are about how they are
   * spread, which is a question that comes second.
   */
  readonly semantic?: SemanticColumnView;
}

/** How the shell hands a summary in; every part may be missing. */
export interface SummaryPanelView {
  readonly summary?: ColumnSummary;
  readonly note?: string;
  readonly document?: JsonColumnSummary;
}

/** A placed, selected column whose panel is wanted. */
export interface SummaryPanelRequest {
  readonly columnId: EntityId;
  /** Table-local left edge of the column, already scrolled. */
  readonly x: number;
  readonly width: number;
  readonly column: SummaryPanelColumn;
}

/**
 * One stripe of a panel: how tall it is and how it draws itself.
 *
 * Sections exist so the height of a panel and its contents cannot drift apart —
 * there is one list, measured by summing it and drawn by walking it, rather than
 * a layout branch and a matching drawing branch to keep in step.
 */
interface PanelSection {
  readonly height: number;
  paint(painter: PanelPainter, panel: SummaryPanel, top: number): void;
}

export interface SummaryPanel {
  readonly columnId: EntityId;
  readonly column: SummaryPanelColumn;
  /** Table-local coordinates; `y` is past the table's bottom edge. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly sections: readonly PanelSection[];
}

/** A count, shortened once it stops being worth reading digit by digit. */
export const compactCount = (value: number): string => {
  if (value < 10_000) return Math.round(value).toLocaleString('en-US');
  const [size, suffix]: readonly [number, string] =
    value >= 1e12
      ? [1e12, 'T']
      : value >= 1e9
        ? [1e9, 'B']
        : value >= 1e6
          ? [1e6, 'M']
          : [1e3, 'K'];
  const scaled = value / size;
  return `${scaled.toFixed(scaled >= 10 ? 0 : 1)}${suffix}`;
};

/** A share as words where words are clearer, and a percentage otherwise. */
export const formatNullShare = (nulls: number, rows: number): string => {
  if (rows === 0) return 'no rows';
  if (nulls === 0) return 'no nulls';
  if (nulls === rows) return 'all null';
  const share = (nulls / rows) * 100;
  return `${share < 1 ? '<1' : Math.round(share)}% null`;
};

/**
 * A number with enough digits to be worth showing and no more.
 *
 * Outside the range a person reads at a glance it goes exponential rather than
 * spelling out a run of zeros — the point of the figure is its magnitude, and
 * `0.00001200` takes longer to read than `1.20e-5` says the same thing.
 */
export const formatStatistic = (value: number): string =>
  Math.abs(value) >= 1e9 || (value !== 0 && Math.abs(value) < 0.001)
    ? value.toExponential(2)
    : value.toLocaleString('en-US', { maximumFractionDigits: 2 });

interface PanelPainter {
  readonly quads: QuadInstance[];
  readonly texts: TextRun[];
  readonly theme: TableTheme;
}

const clipOf = (panel: SummaryPanel): ClipRect => ({
  x: panel.x,
  y: panel.y,
  width: panel.width,
  height: panel.height,
});

const innerWidth = (panel: SummaryPanel): number => panel.width - PADDING * 2;

/** A line of text, clipped to its panel so a long value cannot escape it. */
const label = (
  painter: PanelPainter,
  panel: SummaryPanel,
  run: Omit<TextRun, 'clip' | 'color' | 'fontSize'> & {
    readonly color?: TextRun['color'];
    readonly fontSize?: number;
  },
): void => {
  painter.texts.push({
    ...run,
    color: run.color ?? painter.theme.cellText,
    fontSize: run.fontSize ?? painter.theme.typeFontSize,
    clip: clipOf(panel),
  });
};

/** A bar and the track it sits in, so a short bar still reads as a share. */
const bar = (
  painter: PanelPainter,
  x: number,
  y: number,
  width: number,
  fraction: number,
  color: TextRun['color'],
): void => {
  painter.quads.push({ x, y, width, height: BAR_HEIGHT, color: painter.theme.summaryBarTrack });
  if (fraction <= 0) return;
  painter.quads.push({
    x,
    y,
    // A present-but-tiny share gets a sliver rather than nothing: the difference
    // between rare and absent is exactly what someone is looking for here.
    width: Math.max(1, Math.min(1, fraction) * width),
    height: BAR_HEIGHT,
    color,
  });
};

const nameSections = (column: SummaryPanelColumn): readonly PanelSection[] => [
  {
    height: TITLE_ROW,
    paint: (painter, panel, top): void => {
      label(painter, panel, {
        x: panel.x + PADDING,
        y: top,
        maxWidth: innerWidth(panel),
        height: TITLE_ROW,
        text: semanticHeader(column.name, column.semantic),
        align: 'left',
        fontSize: painter.theme.headerFontSize,
        bold: true,
      });
    },
  },
  {
    height: TYPE_ROW,
    paint: (painter, panel, top): void => {
      label(painter, panel, {
        x: panel.x + PADDING,
        y: top,
        maxWidth: innerWidth(panel),
        height: TYPE_ROW,
        // The same rule as the column header: where a display name has taken the
        // title, the name the database answers to is said underneath it.
        text: semanticRenames(column.name, column.semantic)
          ? `${column.name} · ${column.type.name}`
          : column.type.name,
        align: 'left',
        color: painter.theme.typeText,
      });
    },
  },
];

/**
 * Roughly how many characters fit across a width at the small font.
 *
 * The same estimate the branch tag in a cell is laid out with. Exact widths live
 * in the glyph atlas and are not available while sections are being measured; a
 * line that wraps a word early is a better failure than one that runs off the
 * panel, so this deliberately under-counts.
 */
const CHARS_PER_UNIT = 0.62;
/** A description is prose. Three lines of it, then it is somebody's essay. */
const DESCRIPTION_LINES = 3;
const DESCRIPTION_ROW = 13;

/**
 * A sentence broken across lines that fit, on word boundaries where it can.
 *
 * The last line it is allowed keeps whatever is left, so nothing is silently
 * dropped: it is truncated by the clip like every other run in the panel, which
 * at least shows that there was more.
 */
export const wrapText = (
  text: string,
  charsPerLine: number,
  maxLines: number,
): readonly string[] => {
  if (charsPerLine < 1) return [];
  const words = text.split(/\s+/u).filter((word) => word !== '');
  const lines: string[] = [];
  for (const word of words) {
    const current = lines[lines.length - 1];
    if (current === undefined || current.length + 1 + word.length > charsPerLine) {
      if (lines.length === maxLines) {
        // Out of lines and still words left: the rest joins the last one and the
        // clip takes it from there.
        lines[maxLines - 1] = `${lines[maxLines - 1] as string} ${word}`;
        continue;
      }
      lines.push(word);
      continue;
    }
    lines[lines.length - 1] = `${current} ${word}`;
  }
  return lines;
};

/**
 * What a semantic layer says this column is.
 *
 * Above the distribution, because it answers a different and earlier question. A
 * histogram says how the numbers are spread; this says what the numbers *are*,
 * and somebody who does not know that has no use for the spread.
 *
 * The bottom line names the model, which is the panel's version of "says who" —
 * meaning has an author, and a reader being asked to trust a governed number
 * should be able to see whose governance it is.
 */
const meaningSection = (semantic: SemanticColumnView): PanelSection => {
  const provenance = [semantic.kind, ...(semantic.certified === true ? ['certified'] : [])].join(
    ' · ',
  );
  return {
    height: DESCRIPTION_ROW * (semantic.description === undefined ? 1 : DESCRIPTION_LINES + 1),
    paint: (painter, panel, top): void => {
      const description = semantic.description;
      const lines =
        description === undefined
          ? []
          : wrapText(
              description,
              Math.floor(innerWidth(panel) / (painter.theme.typeFontSize * CHARS_PER_UNIT)),
              DESCRIPTION_LINES,
            );
      lines.forEach((line, index) => {
        label(painter, panel, {
          x: panel.x + PADDING,
          y: top + index * DESCRIPTION_ROW,
          maxWidth: innerWidth(panel),
          height: DESCRIPTION_ROW,
          text: line,
          align: 'left',
        });
      });
      label(painter, panel, {
        x: panel.x + PADDING,
        // Pinned to the bottom of the reserved block rather than under the last
        // line, so a one-line description and a three-line one put the model in
        // the same place and a column of panels stays legible across.
        y: top + DESCRIPTION_ROW * (description === undefined ? 0 : DESCRIPTION_LINES),
        maxWidth: innerWidth(panel),
        height: DESCRIPTION_ROW,
        text: provenance,
        align: 'left',
        color: painter.theme.typeText,
      });
      label(painter, panel, {
        x: panel.x + PADDING,
        y: top + DESCRIPTION_ROW * (description === undefined ? 0 : DESCRIPTION_LINES),
        maxWidth: innerWidth(panel),
        height: DESCRIPTION_ROW,
        text: semantic.model,
        align: 'right',
        color: painter.theme.typeText,
      });
    },
  };
};

const noteSection = (note: string): PanelSection => ({
  height: META_ROW,
  paint: (painter, panel, top): void => {
    label(painter, panel, {
      x: panel.x + PADDING,
      y: top,
      maxWidth: innerWidth(panel),
      height: META_ROW,
      text: note,
      align: 'left',
      color: painter.theme.typeText,
    });
  },
});

/** What is missing and how varied it is: a bar, then the two numbers. */
const overviewSections = (summary: ColumnSummary): readonly PanelSection[] => [
  {
    height: BAR_HEIGHT + NULL_BAR_GAP,
    paint: (painter, panel, top): void => {
      bar(
        painter,
        panel.x + PADDING,
        top,
        innerWidth(panel),
        summary.rows === 0 ? 0 : summary.nulls / summary.rows,
        painter.theme.summaryNullBar,
      );
    },
  },
  {
    height: META_ROW,
    paint: (painter, panel, top): void => {
      label(painter, panel, {
        x: panel.x + PADDING,
        y: top,
        maxWidth: innerWidth(panel),
        height: META_ROW,
        text: formatNullShare(summary.nulls, summary.rows),
        align: 'left',
        color: summary.nulls === 0 ? painter.theme.typeText : painter.theme.summaryNullBar,
      });
      label(painter, panel, {
        x: panel.x + PADDING,
        y: top,
        maxWidth: innerWidth(panel),
        height: META_ROW,
        // No count at all is a different statement from a count of none, and the
        // panel says which one it is holding.
        text:
          summary.distinct === null ? 'many values' : `${compactCount(summary.distinct)} distinct`,
        align: 'right',
        color: painter.theme.typeText,
      });
    },
  },
];

/**
 * What is in a property: a bar per branch, then the three kinds of nothing.
 *
 * The counts are not a distribution and are not drawn as one. Each branch is
 * named by the type its values arrived as, and the three emptinesses are named in
 * the same words the cells use — `null`, `""`, `—` — so the panel and the grid
 * agree about what they are calling things. `missing` is a subtraction rather
 * than a count, because nothing in the storage can say "this property was
 * absent", and it is the number the whole document view exists to show.
 */
const documentSection = (document: JsonColumnSummary): PanelSection => {
  const rows: readonly (readonly [string, number, 'branch' | 'null' | 'empty' | 'missing'])[] = [
    ...document.branches.map(
      (branch) => [branch.name, branch.count, 'branch'] as readonly [string, number, 'branch'],
    ),
    ...(
      [
        [EXPLICIT_NULL_TEXT, document.explicitNulls, 'null'],
        [EMPTY_STRING_TEXT, document.emptyStrings, 'empty'],
        [MISSING_TEXT, document.missing, 'missing'],
      ] as readonly (readonly [string, number, 'null' | 'empty' | 'missing'])[]
    ).filter(
      // A property with no empty-string mask has no empty strings to report, and
      // a row of zero is a row that costs a line and says nothing.
      ([, count]) => count > 0,
    ),
  ];
  const most = rows.reduce((high, [, count]) => Math.max(high, count), 1);
  const colourOf = (
    painter: PanelPainter,
    kind: 'branch' | 'null' | 'empty' | 'missing',
  ): PanelPainter['theme']['cellText'] => {
    if (kind === 'null') return painter.theme.jsonNullText;
    if (kind === 'empty') return painter.theme.jsonEmptyText;
    if (kind === 'missing') return painter.theme.nullText;
    return painter.theme.cellText;
  };
  return {
    height: rows.length * BAR_ROW,
    paint: (painter, panel, top): void => {
      const inner = innerWidth(panel);
      const left = panel.x + PADDING;
      const nameWidth = Math.round(inner * 0.42);
      const countWidth = 36;
      const barWidth = Math.max(8, inner - nameWidth - countWidth - 8);
      rows.forEach(([name, count, kind], index) => {
        const y = top + index * BAR_ROW;
        label(painter, panel, {
          x: left,
          y,
          maxWidth: nameWidth,
          height: BAR_ROW,
          text: name,
          align: 'left',
          color: colourOf(painter, kind),
        });
        const barLeft = left + nameWidth + 4;
        bar(
          painter,
          barLeft,
          y + Math.round((BAR_ROW - BAR_HEIGHT) / 2),
          barWidth,
          count / most,
          // The emptinesses share the colour the null bar has always used, so a
          // reader who knows the panel knows what these are without being told.
          kind === 'branch' ? painter.theme.summaryBar : painter.theme.summaryNullBar,
        );
        label(painter, panel, {
          x: barLeft + barWidth + 4,
          y,
          maxWidth: countWidth,
          height: BAR_ROW,
          text: compactCount(count),
          align: 'right',
          color: painter.theme.typeText,
        });
      });
    },
  };
};

/** A bar per named value: the value, the bar, the count. */
const frequencySection = (
  frequencies: readonly SummaryValueCount[],
  type: ColumnDataType,
): PanelSection => {
  const most = frequencies.reduce((high, entry) => Math.max(high, entry.count), 1);
  return {
    height: frequencies.length * BAR_ROW,
    paint: (painter, panel, top): void => {
      const inner = innerWidth(panel);
      const left = panel.x + PADDING;
      const nameWidth = Math.round(inner * 0.42);
      const countWidth = 36;
      const barWidth = Math.max(8, inner - nameWidth - countWidth - 8);
      frequencies.forEach((entry, index) => {
        const y = top + index * BAR_ROW;
        const shown = formatCell(entry.value, type, { locale: 'en-US' });
        label(painter, panel, {
          x: left,
          y,
          maxWidth: nameWidth,
          height: BAR_ROW,
          // Null and the empty string are different values that both format to
          // nothing, and a bar with no label beside it is unreadable.
          text: entry.value === null ? '(null)' : shown === '' ? '(empty)' : shown,
          align: 'left',
          color: entry.value === null ? painter.theme.nullText : painter.theme.cellText,
        });
        const barLeft = left + nameWidth + 4;
        bar(
          painter,
          barLeft,
          y + Math.round((BAR_ROW - BAR_HEIGHT) / 2),
          barWidth,
          entry.count / most,
          painter.theme.summaryBar,
        );
        label(painter, panel, {
          x: barLeft + barWidth + 4,
          y,
          maxWidth: countWidth,
          height: BAR_ROW,
          text: compactCount(entry.count),
          align: 'right',
          color: painter.theme.typeText,
        });
      });
    },
  };
};

/** A bar per range, with the ends of the range spelled out beneath. */
const histogramSections = (bins: readonly SummaryBin[]): readonly PanelSection[] => {
  const most = bins.reduce((high, bin) => Math.max(high, bin.count), 1);
  // Non-empty by construction: a histogram with no ranges is not a histogram,
  // and `summaryChart` does not call one that.
  const first = bins[0] as SummaryBin;
  const last = bins[bins.length - 1] as SummaryBin;
  return [
    {
      height: HISTOGRAM_HEIGHT,
      paint: (painter, panel, top): void => {
        const inner = innerWidth(panel);
        const left = panel.x + PADDING;
        const step = inner / bins.length;
        const width = Math.max(1, step - 1);
        const baseline = top + HISTOGRAM_HEIGHT;
        bins.forEach((bin, index) => {
          const x = left + index * step;
          // An empty range still gets its sliver of track: a gap in a
          // distribution is part of its shape, and a chart with the gaps closed
          // up is a chart of different data.
          painter.quads.push({
            x,
            y: baseline - 1,
            width,
            height: 1,
            color: painter.theme.summaryBarTrack,
          });
          if (bin.count === 0) return;
          const height = Math.max(1, (bin.count / most) * HISTOGRAM_HEIGHT);
          painter.quads.push({
            x,
            y: baseline - height,
            width,
            height,
            color: painter.theme.summaryBar,
          });
        });
      },
    },
    {
      height: META_ROW,
      paint: (painter, panel, top): void => {
        const half = innerWidth(panel) / 2;
        label(painter, panel, {
          x: panel.x + PADDING,
          y: top,
          maxWidth: half,
          height: META_ROW,
          text: formatStatistic(first.from),
          align: 'left',
          color: painter.theme.typeText,
        });
        label(painter, panel, {
          x: panel.x + PADDING + half,
          y: top,
          maxWidth: half,
          height: META_ROW,
          text: formatStatistic(last.to),
          align: 'right',
          color: painter.theme.typeText,
        });
      },
    },
  ];
};

/** A labelled figure on the left, its value on the right. */
const factSection = (name: string, value: string, warn = false): PanelSection => ({
  height: META_ROW,
  paint: (painter, panel, top): void => {
    label(painter, panel, {
      x: panel.x + PADDING,
      y: top,
      maxWidth: innerWidth(panel),
      height: META_ROW,
      text: name,
      align: 'left',
      color: warn ? painter.theme.summaryNullBar : painter.theme.typeText,
    });
    label(painter, panel, {
      x: panel.x + PADDING,
      y: top,
      maxWidth: innerWidth(panel),
      height: META_ROW,
      text: value,
      align: 'right',
      color: warn ? painter.theme.summaryNullBar : painter.theme.cellText,
    });
  },
});

/** Both ends of a column, or the one value where they are the same. */
const extremes = (min: CellValue, max: CellValue, type: ColumnDataType): string => {
  const low = formatCell(min, type, { locale: 'en-US' });
  const high = formatCell(max, type, { locale: 'en-US' });
  return low === high ? low : `${low} … ${high}`;
};

/**
 * The numbers only a number column has: its ends, its total, its middle and its
 * spread.
 *
 * Named one to a line rather than folded into a range, which is what a text or
 * date column gets. Two reasons. Which end is which stops being obvious the
 * moment the values are negative — `-40 … -3` is read twice before it is read
 * right — and these five sit together as one block that can be compared down a
 * row of panels, which is the thing a person picks four columns out to do.
 *
 * All five are formatted as statistics rather than as cells, including the two
 * that *are* readings from the column. Formatting a min the way the column
 * formats its cells was the first instinct and it is wrong here: the min sits
 * directly under a histogram axis labelled with the same number, and one of them
 * printing `32,547.09` while the other prints `32547.09` reads as a bug rather
 * than as a distinction worth drawing.
 *
 * The exception is a number too wide for a double, which arrives as text and
 * keeps it: turning that into a `number` to format it would drop the digits the
 * source went out of its way to preserve.
 */
const numericSections = (summary: ColumnSummary, type: ColumnDataType): readonly PanelSection[] => {
  const sections: PanelSection[] = [];
  const figure = (value: CellValue): string =>
    typeof value === 'number'
      ? formatStatistic(value)
      : formatCell(value, type, { locale: 'en-US' });
  if (summary.min !== undefined) sections.push(factSection('min', figure(summary.min)));
  if (summary.max !== undefined) sections.push(factSection('max', figure(summary.max)));
  if (summary.sum !== undefined) sections.push(factSection('sum', formatStatistic(summary.sum)));
  if (summary.mean !== undefined) sections.push(factSection('mean', formatStatistic(summary.mean)));
  // Absent rather than zero below two values, and absent is not a thing to draw
  // a row about: a column of one number has no spread to report.
  if (summary.stdDev !== undefined) {
    sections.push(factSection('std dev', formatStatistic(summary.stdDev)));
  }
  return sections;
};

/** Everything one panel has to say, top to bottom. */
export const summaryPanelSections = (column: SummaryPanelColumn): readonly PanelSection[] => {
  const sections = [...nameSections(column)];
  if (column.semantic !== undefined) sections.push(meaningSection(column.semantic));
  const document = column.document;
  if (document !== undefined) sections.push(documentSection(document));
  const summary = column.summary;
  if (summary === undefined) {
    // A breakdown with no distribution under it is a complete answer, not a
    // half one: a property that is a list, or an object, or was `null` in every
    // row, has nothing to be distributed.
    if (document === undefined) sections.push(noteSection(column.note ?? 'Reading…'));
    return sections;
  }
  sections.push(...overviewSections(summary));

  const chart = summaryChart(summary);
  if (chart.kind === 'frequency') {
    sections.push(frequencySection(chart.frequencies, column.type));
  } else if (chart.kind === 'histogram') {
    sections.push(...histogramSections(chart.bins));
  }

  if (isNumericType(column.type)) {
    // Stated even where the histogram above is labelled with the same two
    // numbers: those labels are the ends of an axis, and these are the column's
    // figures, sitting with the three that go with them.
    sections.push(...numericSections(summary, column.type));
  } else {
    // A text or date column gets one line for both ends. There is no sum of
    // country names and no deviation from an average date, and `Denmark …
    // Poland` says what two rows would say in half the space — except where the
    // bars above have already named every value there is, which says it better.
    const min = summary.min;
    const max = summary.max;
    if (summary.frequenciesComplete !== true && min !== undefined && max !== undefined) {
      sections.push(factSection('range', extremes(min, max, column.type)));
    }
  }
  if (summary.basis === 'sampled') {
    // The one thing that must never be left implied: these numbers describe a
    // beginning, not a whole.
    sections.push(factSection('sampled', `first ${compactCount(summary.rows)} rows`, true));
  }
  return sections;
};

/** Which side of the table the row of panels hangs from. */
export type SummaryPanelSide = 'below' | 'above';

const overlaps = (a: ClipRect, b: ClipRect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/**
 * Lays out one row of panels, hanging from one edge of the table.
 *
 * Each starts at its own column's left edge so the eye can follow a column down
 * into its panel. A panel wider than its column overhangs to the right; where
 * that would cover the panel beside it the later one is pushed along, because
 * two overlapping panels are two panels nobody can read. A row above the table
 * hangs upwards from its edge, so the panels line up along the edge they belong
 * to rather than along their own ragged tops.
 */
const layoutRow = (
  requests: readonly SummaryPanelRequest[],
  tableHeight: number,
  side: SummaryPanelSide,
): readonly SummaryPanel[] => {
  const panels: SummaryPanel[] = [];
  let right = Number.NEGATIVE_INFINITY;
  for (const request of [...requests].sort((a, b) => a.x - b.x)) {
    const sections = summaryPanelSections(request.column);
    const width = Math.min(
      SUMMARY_PANEL_MAX_WIDTH,
      Math.max(SUMMARY_PANEL_MIN_WIDTH, request.width),
    );
    const x = Math.max(request.x, right);
    const height = sections.reduce((total, section) => total + section.height, PADDING * 2);
    panels.push({
      columnId: request.columnId,
      column: request.column,
      x,
      y: side === 'below' ? tableHeight + SUMMARY_PANEL_GAP : -SUMMARY_PANEL_GAP - height,
      width,
      height,
      sections,
    });
    right = x + width + SUMMARY_PANEL_GAP;
  }
  return panels;
};

/**
 * Lays the panels out beside their table, on whichever side is free.
 *
 * Below by default, because that is where the eye follows a column to. But a
 * panel is opaque and the canvas is a space users arrange themselves, so a row
 * of panels dropped onto the table someone parked underneath would bury its
 * rows — and covering data is the one thing none of this is allowed to do. So if
 * the row below would land on another table the row goes above instead, and if
 * both sides are occupied it goes below, which is where it belongs.
 *
 * `obstacles` are the other tables, in this table's own coordinates.
 */
export const layoutSummaryPanels = (
  requests: readonly SummaryPanelRequest[],
  tableHeight: number,
  obstacles: readonly ClipRect[] = [],
): readonly SummaryPanel[] => {
  const below = layoutRow(requests, tableHeight, 'below');
  const clear = (panels: readonly SummaryPanel[]): boolean =>
    !panels.some((panel) => obstacles.some((obstacle) => overlaps(panel, obstacle)));
  if (obstacles.length === 0 || clear(below)) return below;
  const above = layoutRow(requests, tableHeight, 'above');
  return clear(above) ? above : below;
};

/** Draws every panel into one pair of lists, for the table's own batches. */
export const buildSummaryPanels = (
  panels: readonly SummaryPanel[],
  theme: TableTheme,
): { readonly quads: readonly QuadInstance[]; readonly texts: readonly TextRun[] } => {
  const quads: QuadInstance[] = [];
  const texts: TextRun[] = [];
  const painter: PanelPainter = { quads, texts, theme };
  for (const panel of panels) {
    quads.push({
      x: panel.x,
      y: panel.y,
      width: panel.width,
      height: panel.height,
      color: theme.summaryPanelBorder,
    });
    quads.push({
      x: panel.x + theme.borderWidth,
      y: panel.y + theme.borderWidth,
      width: panel.width - theme.borderWidth * 2,
      height: panel.height - theme.borderWidth * 2,
      color: theme.summaryPanelBackground,
    });
    let top = panel.y + PADDING;
    for (const section of panel.sections) {
      section.paint(painter, panel, top);
      top += section.height;
    }
  }
  return { quads, texts };
};
