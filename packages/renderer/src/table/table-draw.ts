import type { TableEntity } from '@panorama/core';
import { ROW_NUMBER_GUTTER_WIDTH, alignmentForType, clamp, tableDisplayName } from '@panorama/core';
import type { CellValue, ColumnLayout } from '@panorama/table';
import { computeColumnWindow, computeRowWindow, formatCell } from '@panorama/table';
import type { Rgba, TableTheme } from '../theme.js';
import type { LodLevel } from './lod.js';
import { showsCellText, showsGridLines, showsTypeRow } from './lod.js';
import type { EntityActionId } from '@panorama/core';
import { computeHalo } from './halo.js';
import type { QuadInstance, TableDrawList, TextRun } from './draw-list.js';

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
  /** Draws the action halo; set when the table is activated. */
  readonly showHalo?: boolean;
  /** Camera pixels per world unit, so the halo keeps a constant screen size. */
  readonly scale?: number;
  readonly hoveredAction?: EntityActionId | null;
  readonly pressedAction?: EntityActionId | null;
}

const NULL_PLACEHOLDER = '—';

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

export const tableMetrics = (
  entity: TableEntity,
  layout: ColumnLayout,
  rowCount: number | null,
  theme: TableTheme,
  gutterWidth = ROW_NUMBER_GUTTER_WIDTH,
): TableMetrics => {
  const width = entity.transform.width;
  const height = entity.transform.height;
  const headerHeight = entity.view.headerHeight;
  const rowHeight = entity.view.rowHeight;
  const reserve = theme.scrollbarWidth + theme.resizeMargin;
  const contentHeight = (rowCount ?? 0) * rowHeight;
  const contentWidth = layout.totalWidth;

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
  quad(0, 0, width, titleHeight, theme.titleBackground);
  const rowCountLabel = input.rowCountLabel ?? formatRowCount(input.rowCount);
  text({
    x: theme.cellPaddingX,
    y: 0,
    maxWidth: Math.max(0, width - theme.cellPaddingX * 2 - 110),
    height: titleHeight,
    text: tableDisplayName(entity),
    color: theme.titleText,
    align: 'left',
    fontSize: theme.titleFontSize,
    bold: true,
  });
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

  /**
   * The halo is drawn after everything else so it layers above the chrome, and
   * is skipped at far zoom where its buttons would be meaningless.
   */
  const drawHalo = (): void => {
    if (input.showHalo !== true || lod === 'summary') return;
    const halo = computeHalo(metrics, theme, input.scale ?? 1);
    for (const button of halo.buttons) {
      const hovered = input.hoveredAction === button.action;
      const pressed = input.pressedAction === button.action;
      const background = pressed
        ? theme.haloPressedBackground
        : hovered
          ? theme.haloHoverBackground
          : theme.haloBackground;
      quad(button.x, button.y, button.size, button.size, theme.haloBorder);
      const inset = Math.max(0.5, theme.borderWidth / Math.max(0.05, input.scale ?? 1));
      quad(
        button.x + inset,
        button.y + inset,
        button.size - inset * 2,
        button.size - inset * 2,
        background,
      );
      text({
        x: button.x,
        y: button.y,
        maxWidth: button.size,
        height: button.size,
        text: button.icon,
        color: hovered || pressed ? theme.haloHoverIcon : theme.haloIcon,
        align: 'center',
        fontSize: theme.haloIconFontSize / Math.max(0.05, input.scale ?? 1),
        bold: true,
      });
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
    /** Text keeps the full row's baseline and is clipped to the visible part. */
    const rowClip = { x: 0, y: clippedY, width, height: clippedHeight };
    quad(theme.borderWidth, clippedY, cellRight - theme.borderWidth, clippedHeight, background);
    quad(
      theme.borderWidth,
      clippedY,
      gutterWidth - theme.borderWidth,
      clippedHeight,
      hovered ? theme.rowHoverBackground : theme.gutterBackground,
    );

    if (drawCellText) {
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
      if (!drawCellText) continue;

      const type = placement.column.sourceColumn.type;
      const formatted = value === null ? NULL_PLACEHOLDER : formatCell(value, type);
      text({
        x: visibleX + theme.cellPaddingX,
        y,
        maxWidth: Math.max(0, visibleWidth - theme.cellPaddingX * 2),
        height: rowHeight,
        clip: rowClip,
        text: formatted,
        color: value === null ? theme.nullText : theme.cellText,
        align: value === null ? 'left' : alignmentForType(type),
        fontSize: theme.fontSize,
      });
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

  drawHalo();

  return {
    quads,
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
