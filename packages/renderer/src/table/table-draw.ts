import type { SqlRange, TableEntity } from '@panorama/core';
import {
  ROW_NUMBER_GUTTER_WIDTH,
  derivedTableRanges,
  alignmentForType,
  clamp,
  isQueryTable,
  tableDisplayName,
} from '@panorama/core';
import type { CellValue, ColumnLayout } from '@panorama/table';
import { computeColumnWindow, computeRowWindow, formatCell } from '@panorama/table';
import type { Rgba, TableTheme } from '../theme.js';
import type { LodLevel } from './lod.js';
import { showsCellText, showsGridLines, showsTypeRow } from './lod.js';
import type { EntityActionId, EntityId } from '@panorama/core';
import { actionsForTable, barRects, computeHalo } from './halo.js';
import { roundedRectStrips } from './rounded.js';
import type { SummaryPanelRequest, SummaryPanelView } from './summary-panel.js';
import { buildSummaryPanels, layoutSummaryPanels } from './summary-panel.js';
import { baselineOffset } from '../text/metrics.js';
import type {
  ChartDrawList,
  ClipRect,
  PolygonInstance,
  QuadInstance,
  TableDrawList,
  TextRun,
  TextSpan,
} from './draw-list.js';

/**
 * Builds one frame of a table.
 *
 * The work here is proportional to the *visible* cells, never to the row count
 * of the relation: a 10-billion-row table produces exactly as many quads as a
 * 100-row one at the same size.
 */

export interface TableDataView {
  /** Synchronous cell read. `undefined` means "not loaded"; draw a placeholder. */
  cell(row: number, columnIndex: number): CellValue | undefined;
}

export interface TableRenderInput {
  readonly entity: TableEntity;
  readonly layout: ColumnLayout;
  readonly theme: TableTheme;
  readonly lod: LodLevel;
  readonly scrollTop: number;
  readonly scrollLeft: number;
  readonly rowCount: number | null;
  readonly data: TableDataView;
  readonly selected?: boolean;
  readonly hoveredRow?: number | null;
  readonly rowOverscan?: number;
  readonly columnOverscan?: number;
  readonly gutterWidth?: number;
  /** Shown next to the title, e.g. `2.83B rows`. */
  readonly rowCountLabel?: string;
  /** Actions the halo draws greyed out, because this table cannot perform them. */
  readonly disabledActions?: readonly EntityActionId[];
  /** Draws the action halo; set when the table is activated. */
  readonly showHalo?: boolean;
  /** Camera pixels per world unit, so the halo keeps a constant screen size. */
  readonly scale?: number;
  readonly hoveredAction?: EntityActionId | null;
  readonly pressedAction?: EntityActionId | null;
  /** The action whose choices the halo is showing, if any. */
  readonly expandedAction?: EntityActionId | null;
  /** Column-view ids picked out by clicking their headers. */
  readonly selectedColumns?: readonly EntityId[];
  /**
   * The other tables, in this table's coordinates, so a statistics panel is not
   * dropped onto one of them. Supplied by the host because a table knows nothing
   * about its neighbours, and the renderer knows all of them.
   */
  readonly panelObstacles?: readonly ClipRect[];
  /**
   * The chart this box is drawing, in chart-local coordinates.
   *
   * Geometry from whatever laid it out, placed into the body by this function.
   * A chart with no numbers yet gets `note` instead, for the same reason a
   * summary panel does: "still reading" is a thing worth saying.
   */
  readonly chart?: ChartDrawList;
  /** Shown beneath the chart: what it drew, and from how much. */
  readonly chartNote?: string;
  /** Marks the note as something the reader must not skim past. */
  readonly chartNoteCaution?: boolean;
  /**
   * Statistics for the picked-out columns, keyed by column-view id.
   *
   * Supplied by the shell rather than computed here: a summary comes from the
   * data source over a worker boundary, and the renderer is a pure function of
   * one frame's inputs.
   */
  readonly columnSummaries?: ReadonlyMap<EntityId, SummaryPanelView>;
}

const NULL_PLACEHOLDER = '—';

/**
 * Room kept under a chart for the line that says what it drew.
 *
 * Exported because whoever lays the chart out has to subtract exactly this: the
 * body it is given and the body it is drawn into must be the same rectangle.
 */
export const chartNoteHeight = (theme: TableTheme): number => theme.typeFontSize * 1.6;

/** The controls take this much of the box's width, at most. */
export /**
 * How much of a halo button a drawn mark fills. A typed glyph brings its own
 * side bearings; a rectangle has none, so the padding has to be given to it.
 */
const HALO_SHAPE_FRACTION = 0.55;

const CHART_FORM_MAX_WIDTH = 250;
/** ...and at least this much, or a fraction of the box, whichever is larger. */
export const CHART_FORM_MIN_WIDTH = 170;
export const CHART_FORM_FRACTION = 0.46;

export interface ChartBoxLayout {
  /** Where the controls go while the chart is being set up; empty otherwise. */
  readonly form: ClipRect;
  /** Where the picture goes. */
  readonly chart: ClipRect;
}

/**
 * Splits a chart box between its controls and its picture.
 *
 * The controls take a column down the left and the picture keeps the rest, so
 * that setting a chart up is done *while looking at it*. A form covering the
 * whole box would make every control a guess followed by a reveal, which is the
 * difference between configuring a chart and filling in a questionnaire about
 * one.
 *
 * Shared, because the controls are DOM and the picture is drawn by the GPU: two
 * different systems have to agree on the same two rectangles, and a disagreement
 * would show up as a form overlapping its own preview.
 */
export const chartBoxLayout = (
  width: number,
  height: number,
  theme: TableTheme,
  editing: boolean,
): ChartBoxLayout => {
  const pad = theme.editorPadding;
  const top = theme.titleHeight;
  const body = {
    x: pad,
    y: top + pad,
    width: Math.max(0, width - pad * 2),
    height: Math.max(0, height - top - pad * 2 - chartNoteHeight(theme)),
  };
  if (!editing) return { form: { x: 0, y: top, width: 0, height: 0 }, chart: body };
  const formWidth = Math.min(
    CHART_FORM_MAX_WIDTH,
    Math.max(CHART_FORM_MIN_WIDTH, width * CHART_FORM_FRACTION),
  );
  // A box too narrow to split gives the whole of itself to the controls: half a
  // form beside a sliver of chart is neither.
  if (formWidth + CHART_FORM_MIN_WIDTH > width) {
    return { form: { x: 0, y: top, width, height: height - top }, chart: body };
  }
  return {
    form: { x: 0, y: top, width: formWidth, height: height - top },
    chart: {
      x: formWidth + pad,
      y: body.y,
      width: Math.max(0, width - formWidth - pad * 2),
      height: body.height,
    },
  };
};

/**
 * The parts of one line covered by a reference, in that line's own offsets.
 *
 * A statement is lexed as a whole and drawn a line at a time, so the ranges have
 * to be moved into each line's frame and trimmed to it.
 */
export const referenceSpans = (
  ranges: readonly SqlRange[],
  lineStart: number,
  lineLength: number,
  color: Rgba,
): readonly TextSpan[] => {
  const spans: TextSpan[] = [];
  const lineEnd = lineStart + lineLength;
  for (const range of ranges) {
    if (range.to <= lineStart || range.from >= lineEnd) continue;
    spans.push({
      from: Math.max(0, range.from - lineStart),
      to: Math.min(lineLength, range.to - lineStart),
      color,
    });
  }
  return spans;
};

/** Compact row counts the way the mock-up shows them: `2.83B rows`. */
export const formatRowCount = (rowCount: number | null): string => {
  if (rowCount === null) return '… rows';
  if (rowCount === 1) return '1 row';
  const units: ReadonlyArray<readonly [number, string]> = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (rowCount >= size) {
      const scaled = rowCount / size;
      const digits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
      return `${scaled.toFixed(digits)}${suffix} rows`;
    }
  }
  return `${rowCount} rows`;
};

/**
 * The one place table geometry is computed.
 *
 * Drawing, hit testing and scroll clamping all read these numbers, so they
 * cannot drift apart. Scrollbars reserve space rather than floating over the
 * cells: a bar that hides the last row hides data.
 */
export interface TableMetrics {
  readonly width: number;
  readonly height: number;
  readonly gutterWidth: number;
  readonly titleHeight: number;
  readonly headerHeight: number;
  readonly rowHeight: number;
  /** Width available for scrolling cells, excluding any vertical scrollbar. */
  readonly bodyWidth: number;
  /** Height available for rows, excluding any horizontal scrollbar. */
  readonly bodyHeight: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly verticalScrollbar: boolean;
  readonly horizontalScrollbar: boolean;
  readonly scrollbarThickness: number;
  /** Gap between a scrollbar and the table border, left free for resizing. */
  readonly scrollbarInset: number;
}

/**
 * Width of one digit as a fraction of the font size.
 *
 * The *widest* digit of the fonts the glyph atlas falls through, rounded up —
 * the whole point of measuring is that a row number is never cut short, so the
 * estimate has to be generous rather than average. An estimate rather than a
 * measurement because hit testing must arrive at the same gutter as drawing,
 * and hit testing has no text system to ask.
 */
const DIGIT_WIDTH_RATIO = 0.65;

/**
 * How far a line of text inks above and below its baseline, as a fraction of
 * the font size — generous enough to cover the ascenders and descenders of the
 * fonts the atlas falls through.
 */
const ASCENT_RATIO = 0.78;
const DESCENT_RATIO = 0.24;

/**
 * The band a row's text actually inks, as offsets from the top of the row.
 *
 * Text is centred on a baseline rather than filling its row, so a row can be
 * clipped by a few pixels and still show every glyph whole. Measuring the band
 * rather than the row is what keeps the textless gap at a scrolling edge down to
 * a few pixels instead of a whole row.
 */
export const rowTextBand = (
  rowHeight: number,
  fontSize: number,
): { readonly top: number; readonly bottom: number } => {
  const baseline = baselineOffset(rowHeight, fontSize);
  return { top: baseline - fontSize * ASCENT_RATIO, bottom: baseline + fontSize * DESCENT_RATIO };
};

/**
 * How wide the row-number gutter has to be.
 *
 * A fixed gutter cannot work: the number in it is a *result position*, so a
 * hundred-row table needs three digits and a ten-billion-row one needs eleven,
 * and a width that suits the first truncates the second — which is the one case
 * where the number shown would be actively misleading rather than merely
 * abbreviated.
 *
 * Derived from the row count rather than from the numbers currently on screen,
 * so it is settled once when the result set reports its size and never moves
 * again while scrolling. A gutter that grew as you scrolled past a million would
 * shift every column to its right, which is the same reason Stage 1 does not
 * re-measure columns from the values that happen to be visible.
 *
 * Never *narrower* than the configured width: a short table keeps the gutter
 * proportions the rest of the chrome was designed around.
 */
export const rowNumberGutterWidth = (
  rowCount: number | null,
  theme: TableTheme,
  minimum = ROW_NUMBER_GUTTER_WIDTH,
): number => {
  // Nothing to derive from: a source that cannot report a row count cannot say
  // how wide its positions will get either.
  if (rowCount === null) return minimum;
  const digits = String(Math.max(1, Math.trunc(rowCount))).length;
  const digitWidth = Math.ceil(theme.fontSize * DIGIT_WIDTH_RATIO);
  return Math.max(minimum, digits * digitWidth + theme.cellPaddingX * 2);
};

export const tableMetrics = (
  entity: TableEntity,
  layout: ColumnLayout,
  rowCount: number | null,
  theme: TableTheme,
  minimumGutterWidth = ROW_NUMBER_GUTTER_WIDTH,
): TableMetrics => {
  const width = entity.transform.width;
  const height = entity.transform.height;
  const headerHeight = entity.view.headerHeight;
  const rowHeight = entity.view.rowHeight;
  const reserve = theme.scrollbarWidth + theme.resizeMargin;
  const contentHeight = (rowCount ?? 0) * rowHeight;
  const contentWidth = layout.totalWidth;
  const gutterWidth = rowNumberGutterWidth(rowCount, theme, minimumGutterWidth);

  let bodyWidth = Math.max(0, width - gutterWidth);
  let bodyHeight = Math.max(0, height - headerHeight);
  let verticalScrollbar = contentHeight > bodyHeight;
  let horizontalScrollbar = contentWidth > bodyWidth;
  if (verticalScrollbar) bodyWidth = Math.max(0, bodyWidth - reserve);
  if (horizontalScrollbar) bodyHeight = Math.max(0, bodyHeight - reserve);
  // Reserving space for one bar can push the other axis into overflow.
  if (!verticalScrollbar && contentHeight > bodyHeight) {
    verticalScrollbar = true;
    bodyWidth = Math.max(0, bodyWidth - reserve);
  }
  if (!horizontalScrollbar && contentWidth > bodyWidth) {
    horizontalScrollbar = true;
    bodyHeight = Math.max(0, bodyHeight - reserve);
  }

  return {
    width,
    height,
    gutterWidth,
    titleHeight: Math.min(theme.titleHeight, headerHeight),
    headerHeight,
    rowHeight,
    bodyWidth,
    bodyHeight,
    contentWidth,
    contentHeight,
    verticalScrollbar,
    horizontalScrollbar,
    scrollbarThickness: theme.scrollbarWidth,
    scrollbarInset: theme.resizeMargin,
  };
};

export const maxScrollTopOf = (metrics: TableMetrics): number =>
  Math.max(0, metrics.contentHeight - metrics.bodyHeight);

export const maxScrollLeftOf = (metrics: TableMetrics): number =>
  Math.max(0, metrics.contentWidth - metrics.bodyWidth);

/** Geometry of the scrollbars, shared by rendering and hit testing. */
export interface ScrollbarGeometry {
  readonly vertical: QuadInstance | null;
  readonly verticalTrack: QuadInstance | null;
  readonly horizontal: QuadInstance | null;
  readonly horizontalTrack: QuadInstance | null;
}

const thumb = (
  trackStart: number,
  trackLength: number,
  contentLength: number,
  scroll: number,
  minLength: number,
): { offset: number; length: number } => {
  const length = Math.max(minLength, trackLength * (trackLength / contentLength));
  const travel = Math.max(0, trackLength - length);
  const maxScroll = Math.max(0, contentLength - trackLength);
  const offset = maxScroll === 0 ? 0 : (clamp(scroll, 0, maxScroll) / maxScroll) * travel;
  return { offset: trackStart + offset, length };
};

export const computeScrollbars = (
  metrics: TableMetrics,
  scrollTop: number,
  scrollLeft: number,
  theme: TableTheme,
): ScrollbarGeometry => {
  const verticalX = metrics.gutterWidth + metrics.bodyWidth;
  const horizontalY = metrics.headerHeight + metrics.bodyHeight;

  const vertical =
    metrics.verticalScrollbar && metrics.bodyHeight > 0
      ? thumb(
          metrics.headerHeight,
          metrics.bodyHeight,
          metrics.contentHeight,
          scrollTop,
          theme.scrollbarMinLength,
        )
      : null;
  const horizontal =
    metrics.horizontalScrollbar && metrics.bodyWidth > 0
      ? thumb(
          metrics.gutterWidth,
          metrics.bodyWidth,
          metrics.contentWidth,
          scrollLeft,
          theme.scrollbarMinLength,
        )
      : null;

  return {
    vertical:
      vertical === null
        ? null
        : {
            x: verticalX,
            y: vertical.offset,
            width: metrics.scrollbarThickness,
            height: vertical.length,
            color: theme.scrollbar,
          },
    verticalTrack:
      vertical === null
        ? null
        : {
            x: verticalX,
            y: metrics.headerHeight,
            width: metrics.scrollbarThickness,
            height: metrics.bodyHeight,
            color: theme.scrollbarTrack,
          },
    horizontal:
      horizontal === null
        ? null
        : {
            x: horizontal.offset,
            y: horizontalY,
            width: horizontal.length,
            height: metrics.scrollbarThickness,
            color: theme.scrollbar,
          },
    horizontalTrack:
      horizontal === null
        ? null
        : {
            x: metrics.gutterWidth,
            y: horizontalY,
            width: metrics.bodyWidth,
            height: metrics.scrollbarThickness,
            color: theme.scrollbarTrack,
          },
  };
};

export const buildTableDrawList = (input: TableRenderInput): TableDrawList => {
  const { entity, theme, layout, lod } = input;
  const metrics = tableMetrics(entity, layout, input.rowCount, theme, input.gutterWidth);
  const { gutterWidth, width, height, headerHeight, rowHeight, bodyHeight, bodyWidth } = metrics;
  /** Bottom of the row area: above the horizontal scrollbar, not the border. */
  const bodyBottom = headerHeight + bodyHeight;

  const quads: QuadInstance[] = [];
  const polygons: PolygonInstance[] = [];
  const texts: TextRun[] = [];
  let characters = 0;
  let placeholderCells = 0;

  const quad = (x: number, y: number, w: number, h: number, color: Rgba): void => {
    if (w <= 0 || h <= 0) return;
    quads.push({ x, y, width: w, height: h, color });
  };
  const text = (run: TextRun): void => {
    if (run.maxWidth <= 0 || run.text === '') return;
    texts.push(run);
    characters += run.text.length;
  };

  // Table body background and outer border.
  quad(0, 0, width, height, theme.background);
  const borderColor = input.selected === true ? theme.selectedBorder : theme.border;
  const borderWidth = input.selected === true ? theme.borderWidth * 2 : theme.borderWidth;
  quad(0, 0, width, borderWidth, borderColor);
  quad(0, height - borderWidth, width, borderWidth, borderColor);
  quad(0, 0, borderWidth, height, borderColor);
  quad(width - borderWidth, 0, borderWidth, height, borderColor);

  // Title bar.
  const titleHeight = metrics.titleHeight;
  // A derived table is tinted rather than differently shaped: the eye picks up
  // "this one was computed" from the title bar without anything else moving, and
  // the bar stays one flat colour like every other table's.
  const derived = isQueryTable(entity);
  quad(0, 0, width, titleHeight, derived ? theme.derivedTitleBackground : theme.titleBackground);
  // A box being written has no rows, and saying "0 rows" would read as a result
  // that came back empty rather than a statement that has not run.
  // A chart has no rows of its own to count, and "0 rows" beside a picture of a
  // hundred thousand of them is worse than nothing. What it read is said under
  // the chart instead, where it belongs.
  const rowCountLabel =
    entity.mode === 'editing' || entity.source.kind === 'chart'
      ? ''
      : (input.rowCountLabel ?? formatRowCount(input.rowCount));
  text({
    x: theme.cellPaddingX,
    y: 0,
    maxWidth: Math.max(0, width - theme.cellPaddingX * 2 - 110),
    height: titleHeight,
    text: tableDisplayName(entity),
    color: derived ? theme.derivedTitleText : theme.titleText,
    align: 'left',
    fontSize: theme.titleFontSize,
    bold: true,
  });
  if (rowCountLabel !== '') {
    text({
      x: Math.max(0, width - 110 - theme.cellPaddingX),
      y: 0,
      maxWidth: 110,
      height: titleHeight,
      text: rowCountLabel,
      color: theme.typeText,
      align: 'right',
      fontSize: theme.typeFontSize,
    });
  }

  /**
   * The halo is drawn after everything else so it layers above the chrome, and
   * is skipped at far zoom where its buttons would be meaningless.
   */
  const drawHalo = (): void => {
    if (input.showHalo !== true || lod === 'summary') return;
    const halo = computeHalo(
      metrics,
      theme,
      input.scale ?? 1,
      actionsForTable(entity, input.expandedAction ?? null),
    );
    for (const button of halo.buttons) {
      // A disabled button is drawn, not hidden: the halo keeps a stable shape,
      // and a greyed-out control says "not for this table" where a missing one
      // would say nothing at all.
      const disabled = input.disabledActions?.includes(button.action) === true;
      const hovered = !disabled && input.hoveredAction === button.action;
      const pressed = !disabled && input.pressedAction === button.action;
      const highlight =
        button.tone === 'destructive'
          ? { hover: theme.haloDangerBackground, press: theme.haloDangerPressedBackground }
          : { hover: theme.haloAccentBackground, press: theme.haloAccentPressedBackground };
      const background = disabled
        ? theme.haloDisabledBackground
        : pressed
          ? highlight.press
          : hovered
            ? highlight.hover
            : theme.haloBackground;
      /**
       * Rounded, and therefore several quads rather than one — see `rounded.ts`
       * for why it cannot be a polygon.
       *
       * The border is a rounded rectangle and the background a smaller one inside
       * it, so what is left of the first is a ring of even width: the corner of
       * the inner shape is rounded by one border width less, which is what keeps
       * the two arcs concentric instead of the ring thickening at the corners.
       *
       * Hit testing still treats a button as its rectangle. The sliver outside a
       * three-pixel arc is under two square pixels of a 22-pixel button, and a
       * pointer that has to respect the curve is a button with a dead corner —
       * the wrong trade for something this size.
       */
      const scale = Math.max(0.05, input.scale ?? 1);
      const radius = theme.haloCornerRadius / scale;
      const inset = Math.max(0.5, theme.borderWidth / scale);
      for (const strip of roundedRectStrips(
        button.x,
        button.y,
        button.width,
        button.size,
        radius,
        scale,
      )) {
        quad(
          strip.x,
          strip.y,
          strip.width,
          strip.height,
          disabled ? theme.haloDisabledBorder : theme.haloBorder,
        );
      }
      for (const strip of roundedRectStrips(
        button.x + inset,
        button.y + inset,
        button.width - inset * 2,
        button.size - inset * 2,
        radius - inset,
        scale,
      )) {
        quad(strip.x, strip.y, strip.width, strip.height, background);
      }
      const mark = disabled
        ? theme.haloDisabledIcon
        : hovered || pressed
          ? theme.haloHoverIcon
          : theme.haloIcon;
      if (button.shape === 'bars') {
        // Into the quads, with the background it has to sit on top of: the
        // polygon batch is drawn under them and the button would swallow it.
        const box = button.size * HALO_SHAPE_FRACTION;
        for (const bar of barRects(
          button.x + (button.width - box) / 2,
          button.y + (button.size - box) / 2,
          box,
        )) {
          quad(bar.x, bar.y, bar.width, bar.height, mark);
        }
      }
      if (button.icon !== undefined) {
        text({
          x: button.x,
          y: button.y,
          maxWidth: button.width,
          height: button.size,
          text: button.icon,
          color: mark,
          align: 'center',
          fontSize:
            (button.iconFontSize ?? theme.haloIconFontSize) / Math.max(0.05, input.scale ?? 1),
          bold: true,
        });
      }
    }
  };

  if (lod === 'summary') {
    // Far zoom: title plus a plain impression of the body.
    quad(0, titleHeight, width, height - titleHeight, theme.rowAlternateBackground);
    const bands = Math.min(12, Math.max(1, Math.floor((height - titleHeight) / 12)));
    for (let band = 0; band < bands; band += 1) {
      quad(6, titleHeight + 6 + band * 12, Math.max(0, width - 12), 6, theme.placeholderFill);
    }
    drawHalo();
    return {
      quads,
      polygons,
      texts,
      stats: {
        visibleRows: 0,
        renderedRows: 0,
        visibleColumns: 0,
        quads: quads.length,
        textRuns: texts.length,
        characters,
        placeholderCells: 0,
      },
    };
  }

  /**
   * A query box being written has no rows to draw, so it draws its statement
   * instead.
   *
   * The text is rendered by the GPU even though an editable DOM surface sits on
   * top of it in the browser: that surface is opaque, and in XR — or in a
   * screenshot — there is no DOM at all, so this is what the box actually looks
   * like.
   */
  /**
   * A chart takes the body whole: no gutter, no header, no rows. It is drawn
   * from geometry someone else laid out, translated here into the same quads and
   * text runs as everything else on the canvas — so it is sharp at any zoom, it
   * joins the same two batches, and it exists in a headset.
   */
  const chart = input.chart;
  if (chart !== undefined) {
    const pad = theme.editorPadding;
    const note = input.chartNote;
    // Reserved whether or not there is a note to put in it, so the picture is
    // laid out for exactly the room it is drawn into. Reserve it on one side only
    // and the axis labels along the bottom are laid out into space that is then
    // clipped away.
    const noteHeight = chartNoteHeight(theme);
    const box = chartBoxLayout(width, height, theme, entity.mode === 'editing');
    quad(0, titleHeight, width, height - titleHeight, theme.background);
    // The controls' own ground, drawn by the GPU as well as covered by the DOM —
    // so the split reads the same in a headset, where there is no DOM at all.
    if (box.form.width > 0) {
      quad(box.form.x, box.form.y, box.form.width, box.form.height, theme.editorBackground);
    }
    const clip = box.chart;
    for (const polygon of chart.polygons) {
      polygons.push({
        corners: [
          clip.x + polygon.corners[0],
          clip.y + polygon.corners[1],
          clip.x + polygon.corners[2],
          clip.y + polygon.corners[3],
          clip.x + polygon.corners[4],
          clip.y + polygon.corners[5],
          clip.x + polygon.corners[6],
          clip.y + polygon.corners[7],
        ],
        color: polygon.color,
      });
    }
    for (const run of chart.texts) {
      text({
        x: clip.x + run.x,
        y: clip.y + run.y,
        maxWidth: run.width,
        height: run.height,
        text: run.text,
        color: run.color,
        align: run.align,
        fontSize: run.fontSize,
        ...(run.bold === true ? { bold: true } : {}),
        clip,
      });
    }
    if (note !== undefined) {
      text({
        x: clip.x,
        y: height - pad - noteHeight,
        maxWidth: Math.max(0, width - clip.x - pad),
        height: noteHeight,
        text: note,
        color: input.chartNoteCaution === true ? theme.summaryNullBar : theme.typeText,
        align: 'left',
        fontSize: theme.typeFontSize,
      });
    }
    drawHalo();
    return {
      quads,
      texts,
      polygons,
      stats: {
        visibleRows: 0,
        renderedRows: 0,
        visibleColumns: 0,
        quads: quads.length + polygons.length,
        textRuns: texts.length,
        characters,
        placeholderCells: 0,
      },
    };
  }

  if (entity.mode === 'editing') {
    const pad = theme.editorPadding;
    quad(0, titleHeight, width, height - titleHeight, theme.editorBackground);
    quad(
      pad,
      titleHeight + pad,
      Math.max(0, width - pad * 2),
      Math.max(0, height - titleHeight - pad * 2),
      theme.editorFieldBackground,
    );
    const lineHeight = theme.editorFontSize * 1.45;
    const statement = entity.source.kind === 'query' ? entity.source.sql : '';
    // Where the statement names its input. Found once over the whole text, so
    // that a name inside a string or a comment is left alone even when the
    // string or comment runs across lines, and then cut up per line.
    const references = derivedTableRanges(statement);
    const lines = statement === '' ? [] : statement.split('\n');
    const room = Math.max(0, height - titleHeight - pad * 2 - lineHeight);
    let lineStart = 0;
    lines.slice(0, Math.max(0, Math.floor(room / lineHeight))).forEach((line, index) => {
      const spans = referenceSpans(references, lineStart, line.length, theme.editorReferenceText);
      lineStart += line.length + 1;
      text({
        x: pad * 2,
        y: titleHeight + pad * 2 + index * lineHeight,
        maxWidth: Math.max(0, width - pad * 4),
        height: lineHeight,
        text: line,
        color: theme.editorText,
        align: 'left',
        fontSize: theme.editorFontSize,
        ...(spans.length === 0 ? {} : { spans }),
      });
    });
    text({
      x: pad * 2,
      y: height - pad - lineHeight,
      maxWidth: Math.max(0, width - pad * 4),
      height: lineHeight,
      text: theme.editorHint,
      color: theme.typeText,
      align: 'left',
      fontSize: theme.typeFontSize,
    });
    drawHalo();
    return {
      quads,
      polygons,
      texts,
      stats: {
        visibleRows: 0,
        renderedRows: 0,
        visibleColumns: 0,
        quads: quads.length,
        textRuns: texts.length,
        characters,
        placeholderCells: 0,
      },
    };
  }

  const rows = computeRowWindow({
    scrollTop: input.scrollTop,
    rowHeight,
    bodyHeight,
    rowCount: input.rowCount,
    ...(input.rowOverscan === undefined ? {} : { overscan: input.rowOverscan }),
  });
  const columns = computeColumnWindow(
    layout,
    input.scrollLeft,
    bodyWidth,
    input.columnOverscan ?? 1,
  );

  // Column header band.
  quad(0, titleHeight, width, headerHeight - titleHeight, theme.headerBackground);
  quad(0, headerHeight - theme.gridLineWidth, width, theme.gridLineWidth, theme.border);

  // Both the name row and the type row need room; below that, names win.
  const typeRowVisible = showsTypeRow(lod) && headerHeight - titleHeight >= theme.typeRowHeight * 2;
  const nameRowHeight = typeRowVisible
    ? headerHeight - titleHeight - theme.typeRowHeight
    : headerHeight - titleHeight;

  // Gutter column, pinned while the body scrolls horizontally.
  quad(0, headerHeight, gutterWidth, bodyHeight, theme.gutterBackground);

  const columnX = (placementX: number): number => gutterWidth + placementX - input.scrollLeft;
  /** Right edge of the cell area: inside the vertical scrollbar. */
  const cellRight = gutterWidth + bodyWidth;

  for (const placement of columns.placements) {
    const x = columnX(placement.x);
    if (x + placement.width <= gutterWidth || x >= cellRight) continue;
    const visibleX = Math.max(x, gutterWidth);
    const visibleWidth = Math.min(x + placement.width, cellRight) - visibleX;
    const headerClip = {
      x: gutterWidth,
      y: titleHeight,
      width: cellRight - gutterWidth,
      height: headerHeight - titleHeight,
    };
    text({
      x: visibleX + theme.cellPaddingX,
      y: titleHeight,
      maxWidth: Math.max(0, visibleWidth - theme.cellPaddingX * 2),
      height: nameRowHeight,
      clip: headerClip,
      text: placement.column.sourceColumn.name,
      color: theme.headerText,
      align: 'left',
      fontSize: theme.headerFontSize,
      bold: true,
    });
    if (typeRowVisible) {
      text({
        x: visibleX + theme.cellPaddingX,
        y: titleHeight + nameRowHeight,
        maxWidth: Math.max(0, visibleWidth - theme.cellPaddingX * 2),
        height: theme.typeRowHeight,
        clip: headerClip,
        text: placement.column.sourceColumn.type.name,
        color: theme.typeText,
        align: 'left',
        fontSize: theme.typeFontSize,
      });
    }
  }

  // Rows.
  const drawCellText = showsCellText(lod);
  const textBand = rowTextBand(rowHeight, theme.fontSize);
  for (let offset = 0; offset < rows.renderedRowCount; offset += 1) {
    const row = rows.firstRenderedRow + offset;
    const y = headerHeight + rows.offsetY + offset * rowHeight;
    if (y + rowHeight <= headerHeight || y >= bodyBottom) continue;

    const hovered = input.hoveredRow === row;
    const background = hovered
      ? theme.rowHoverBackground
      : row % 2 === 0
        ? theme.rowBackground
        : theme.rowAlternateBackground;
    const clippedY = Math.max(y, headerHeight);
    const clippedHeight = Math.min(y + rowHeight, bodyBottom) - clippedY;
    /**
     * A partly visible row keeps its background and loses its text.
     *
     * Clipping a glyph mid-height does not abbreviate a value, it changes it: a
     * halved `8` reads as a `0`, and a halved row *position* reads as a
     * different row. That is worst at the bottom edge, where the clip line is
     * the horizontal scrollbar and a sliced number looks like the bar is lying
     * on top of it. So the letters wait until they can be read — which, because
     * the test is against the inked band rather than the whole row, is only a
     * few pixels of patience either side.
     */
    const rowClip = { x: 0, y: clippedY, width, height: clippedHeight };
    const lettered =
      drawCellText &&
      y + textBand.top >= clippedY &&
      y + textBand.bottom <= clippedY + clippedHeight;
    quad(theme.borderWidth, clippedY, cellRight - theme.borderWidth, clippedHeight, background);
    quad(
      theme.borderWidth,
      clippedY,
      gutterWidth - theme.borderWidth,
      clippedHeight,
      hovered ? theme.rowHoverBackground : theme.gutterBackground,
    );

    if (lettered) {
      text({
        x: theme.cellPaddingX,
        y,
        maxWidth: gutterWidth - theme.cellPaddingX * 2,
        height: rowHeight,
        clip: rowClip,
        // Result *positions* are one-based for display; they are not row identity.
        text: String(row + 1),
        color: theme.gutterText,
        align: 'right',
        fontSize: theme.fontSize,
      });
    }

    for (const placement of columns.placements) {
      const x = columnX(placement.x);
      if (x + placement.width <= gutterWidth || x >= cellRight) continue;
      const visibleX = Math.max(x, gutterWidth);
      const visibleWidth = Math.min(x + placement.width, cellRight) - visibleX;
      const value = input.data.cell(row, placement.sourceIndex);

      if (value === undefined) {
        placeholderCells += 1;
        // Placeholders keep the layout stable so the eye has nothing to track.
        quad(
          visibleX + theme.cellPaddingX,
          clippedY + clippedHeight / 2 - 4,
          Math.max(0, Math.min(visibleWidth - theme.cellPaddingX * 2, placement.width * 0.6)),
          Math.min(8, clippedHeight),
          theme.placeholderFill,
        );
        continue;
      }
      // Same rule as the row number: a value cut in half is not the value.
      if (!lettered) continue;

      const type = placement.column.sourceColumn.type;
      const formatted = value === null ? NULL_PLACEHOLDER : formatCell(value, type);
      // A followable cell reads as a link, which is the whole affordance: the
      // click that opens the referenced rows has to look like it will.
      const followable = value !== null && placement.column.sourceColumn.foreignKey !== undefined;
      text({
        x: visibleX + theme.cellPaddingX,
        y,
        maxWidth: Math.max(0, visibleWidth - theme.cellPaddingX * 2),
        height: rowHeight,
        clip: rowClip,
        text: formatted,
        color: value === null ? theme.nullText : followable ? theme.linkText : theme.cellText,
        align: value === null ? 'left' : alignmentForType(type),
        fontSize: theme.fontSize,
      });
    }
  }

  /**
   * Columns picked out by their headers.
   *
   * Drawn after the rows and before the grid lines: a wash over the cells rather
   * than a replacement for their backgrounds, so the striping and the hovered
   * row still read through it, and the values are untouched — they are glyphs,
   * which land on top of every quad whatever order these go in.
   */
  const selected = input.selectedColumns;
  const panelRequests: SummaryPanelRequest[] = [];
  if (selected !== undefined && selected.length > 0) {
    for (const placement of columns.placements) {
      if (!selected.includes(placement.id)) continue;
      const x = columnX(placement.x);
      if (x + placement.width <= gutterWidth || x >= cellRight) continue;
      const visibleX = Math.max(x, gutterWidth);
      const visibleWidth = Math.min(x + placement.width, cellRight) - visibleX;
      const view = input.columnSummaries?.get(placement.id);
      panelRequests.push({
        columnId: placement.id,
        // Aligned to the part of the column that can be seen, so a column half
        // scrolled under the gutter still gets a panel inside the table's span
        // rather than one reaching out to the left of it.
        x: visibleX,
        width: visibleWidth,
        column: {
          name: placement.column.sourceColumn.name,
          type: placement.column.sourceColumn.type,
          summary: view?.summary,
          note: view?.note,
        },
      });
      quad(
        visibleX,
        titleHeight,
        visibleWidth,
        headerHeight - titleHeight,
        theme.columnSelectedHeaderBackground,
      );
      quad(visibleX, headerHeight, visibleWidth, bodyHeight, theme.columnSelectedBackground);
      // An edge either side, so two selected columns side by side still read as
      // two rather than as one wide one.
      quad(
        visibleX,
        titleHeight,
        theme.gridLineWidth,
        height - titleHeight,
        theme.columnSelectedBorder,
      );
      const right = visibleX + visibleWidth - theme.gridLineWidth;
      if (right > visibleX) {
        quad(
          right,
          titleHeight,
          theme.gridLineWidth,
          height - titleHeight,
          theme.columnSelectedBorder,
        );
      }
    }
  }

  // Grid lines, drawn after the rows so they sit on top.
  if (showsGridLines(lod)) {
    for (let offset = 0; offset <= rows.renderedRowCount; offset += 1) {
      const y = headerHeight + rows.offsetY + offset * rowHeight;
      if (y < headerHeight || y > height) continue;
      quad(
        theme.borderWidth,
        y,
        width - theme.borderWidth * 2,
        theme.gridLineWidth,
        theme.gridLine,
      );
    }
    quad(gutterWidth, headerHeight, theme.gridLineWidth, bodyHeight, theme.gridLine);
    for (const placement of columns.placements) {
      const edge = columnX(placement.x + placement.width);
      if (edge <= gutterWidth || edge >= width) continue;
      quad(edge, titleHeight, theme.gridLineWidth, height - titleHeight, theme.gridLine);
    }
  }

  const scrollbars = computeScrollbars(metrics, input.scrollTop, input.scrollLeft, theme);
  if (scrollbars.verticalTrack !== null && scrollbars.vertical !== null) {
    quads.push(scrollbars.verticalTrack, scrollbars.vertical);
  }
  if (scrollbars.horizontalTrack !== null && scrollbars.horizontal !== null) {
    quads.push(scrollbars.horizontalTrack, scrollbars.horizontal);
  }

  /**
   * Statistics panels, below the table and above nothing: they are outside its
   * bounds, so they layer over the canvas rather than over any of its own rows.
   * Far zoom has already returned by here, which is right — a row of unreadable
   * panels under every table would be noise.
   */
  if (panelRequests.length > 0) {
    const panels = buildSummaryPanels(
      layoutSummaryPanels(panelRequests, height, input.panelObstacles),
      theme,
    );
    quads.push(...panels.quads);
    for (const run of panels.texts) text(run);
  }

  drawHalo();

  return {
    quads,
    polygons,
    texts,
    stats: {
      visibleRows: rows.visibleRowCount,
      renderedRows: rows.renderedRowCount,
      visibleColumns: columns.count,
      quads: quads.length,
      textRuns: texts.length,
      characters,
      placeholderCells,
    },
  };
};

/** Scroll bounds for a table, used by the input controller and the shell. */
export const tableScrollBounds = (
  entity: TableEntity,
  layout: ColumnLayout,
  rowCount: number | null,
  theme: TableTheme,
  gutterWidth = ROW_NUMBER_GUTTER_WIDTH,
): { readonly maxTop: number; readonly maxLeft: number } => {
  const metrics = tableMetrics(entity, layout, rowCount, theme, gutterWidth);
  return { maxTop: maxScrollTopOf(metrics), maxLeft: maxScrollLeftOf(metrics) };
};
