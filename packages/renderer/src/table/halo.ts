import type { EntityActionId, TableEntity } from '@panorama/core';
import { isChartTable, isQueryTable } from '@panorama/core';
import type { ClipRect } from './draw-list.js';
import type { TableMetrics } from './table-draw.js';
import type { TableTheme } from '../theme.js';

/**
 * The action halo.
 *
 * A small row of buttons that appears when a table is activated — by pointer
 * hover on the desktop, and by whatever stands in for it elsewhere: touch, or
 * an XR gaze or controller ray. It is drawn by the GPU renderer like everything
 * else, so it works identically in a browser and in XR; a DOM overlay would
 * not.
 *
 * The buttons sit just *outside* the table so they never cover data, and they are
 * sized in screen pixels so they stay usable when the canvas is zoomed out.
 *
 * They are arranged around the table's top-right corner, and where a button sits
 * says what it does. The ones that make a *new* box — a query, a chart, the rows
 * behind a selection — run down the right edge, which is the edge their line will
 * leave from, so the halo points the way the work is about to grow. The ones that
 * act on the box already there run along the top. Close sits on the corner
 * itself, in neither line, because it is the one that takes the box away.
 */

/**
 * Destructive actions get the warning colour on hover; everything else gets the
 * accent. Without this the SQL button would light up red like a delete.
 */
export type ActionTone = 'neutral' | 'destructive';

/**
 * Which line of the halo a button belongs to.
 *
 * Declared per action rather than derived from a list of ids, so a new action
 * cannot be added without saying what it does: `side` makes a new box joined to
 * this one by a line, `top` acts on the box that is already there, and `corner`
 * is the single slot on the corner.
 */
export type ActionPlace = 'top' | 'side' | 'corner';

export interface HaloButton {
  readonly action: EntityActionId;
  readonly tone: ActionTone;
  /** Screen-pixel font size for the icon; a word needs less than a symbol. */
  readonly iconFontSize?: number;
  readonly place: ActionPlace;
  /** Table-local coordinates, always above or to the right of the table. */
  readonly x: number;
  readonly y: number;
  /** Height, and the width of every button that carries a single glyph. */
  readonly size: number;
  /**
   * Width. Equal to `size` for the square buttons, and wider for the ones whose
   * mark is a word: `PARQUET` spelled out is worth more than a symbol the user
   * has to decode.
   */
  readonly width: number;
  /** Glyph or word drawn on the button; absent when the mark is a `shape`. */
  readonly icon?: string;
  /** A drawn mark, where no glyph does the job. Exactly one of the two is set. */
  readonly shape?: ActionShape;
  readonly label: string;
}

export interface Halo {
  readonly buttons: readonly HaloButton[];
  /** Bounds covering the buttons themselves. */
  readonly bounds: ClipRect;
  /**
   * The bands that keep a table activated while the pointer travels from it to
   * a button.
   *
   * The top one spans the table's whole width, not just the buttons: the pointer
   * leaves the table wherever it likes, and if the band were only as wide as the
   * buttons then any other path out would deactivate the table and the buttons
   * would vanish before they could be reached.
   *
   * Two rectangles rather than one, because the halo turns a corner and their
   * union would not: a single rectangle covering both lines would swallow the
   * top-right of the table itself, and hit testing tries the band before the
   * table, so those cells would stop answering.
   */
  readonly hoverBands: readonly ClipRect[];
}

export interface ActionSpec {
  readonly action: EntityActionId;
  /** Glyph or word to type. Exactly one of `icon` and `shape` is given. */
  readonly icon?: string;
  readonly shape?: ActionShape;
  readonly label: string;
  readonly tone: ActionTone;
  readonly place: ActionPlace;
  readonly iconFontSize?: number;
  /**
   * Screen-pixel width; square when absent, and ignored for anything but the
   * top row, which is the only line a wide button can join without spoiling it.
   */
  readonly width?: number;
}

/**
 * The mark that means "SQL", shared by the halo button and the connector marker
 * on a line a query produced. One constant, so the two can never drift apart:
 * the line and the button that made it should read as the same thing.
 */
export const SQL_ICON = 'SQL';
export const SQL_ICON_FONT_SIZE = 9;

/**
 * A mark that is drawn rather than typed, because no glyph does the job.
 *
 * `bars` is the charting mark, and it is geometry for the same reason the key on
 * a foreign-key line is: the atlas rasterises whatever the system font provides,
 * and the block-drawing characters that spell a bar chart are a full em wide
 * apiece however they are drawn. Three of them cannot fit a square button at a
 * size the shortest bar survives — at eleven pixels in a thirty-pixel button they
 * were being drawn as two bars and an ellipsis — and even where they fit they
 * touch, so the mark reads as one filled staircase rather than as bars.
 */
export type ActionShape = 'bars';

/** One rectangle of a drawn mark, in the coordinates it was asked for. */
export interface IconRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The three ascending bars of the charting mark, in a square icon box.
 *
 * Returned as plain rectangles rather than as anything drawable, because the two
 * places that draw them draw into different batches — the halo into the quads,
 * with the button background it has to sit on top of, and a connector's marker
 * chip into the polygons. One geometry, so the button and the line it produces
 * cannot come to disagree about what a chart looks like.
 */
export const barRects = (x: number, y: number, size: number): readonly IconRect[] => {
  const width = size * 0.24;
  const bottom = y + size * 0.9;
  return [0.36, 0.63, 0.9].map((height, index) => ({
    x: x + size * (0.07 + index * 0.32),
    y: bottom - size * height,
    width,
    height: size * height,
  }));
};

/**
 * Glyphs rather than drawn icons: they are present in every system font, so
 * they need no icon pipeline and no extra draw call. `SQL` is spelled out
 * because no single character means "write a query" without ambiguity, and a
 * button the user has to guess at is worse than a wide one.
 */
const EDIT_ACTION: ActionSpec = Object.freeze({
  action: 'edit',
  icon: '✎',
  label: 'Edit the statement',
  tone: 'neutral',
  place: 'top',
});

/**
 * The same button while the statement is open.
 *
 * One action id with two faces rather than two buttons: the halo keeps a stable
 * shape as a box is edited and run, and "open the editor" and "leave it again"
 * are the same slot doing the same job in both directions.
 */
const CANCEL_EDIT_ACTION: ActionSpec = Object.freeze({
  action: 'edit',
  icon: '↩',
  label: 'Back to the result',
  tone: 'neutral',
  place: 'top',
});

const SQL_ACTION: ActionSpec = Object.freeze({
  action: 'sql',
  icon: SQL_ICON,
  label: 'Query with SQL',
  tone: 'neutral',
  place: 'side',
  iconFontSize: SQL_ICON_FONT_SIZE,
});

const CLOSE_ACTION: ActionSpec = Object.freeze({
  action: 'close',
  icon: '×',
  label: 'Close table',
  tone: 'destructive',
  place: 'corner',
});

/**
 * Charting is a *question about shape*, and the button is a picture of one.
 *
 * A bar chart mark rather than a word, for the same reason the key on a foreign
 * key is a key: at halo size a glyph is read before a label is.
 *
 * Drawn rather than typed, and the same mark the line carries: see `barRects`.
 */
const CHART_ACTION: ActionSpec = Object.freeze({
  action: 'chart',
  shape: 'bars',
  label: 'Chart this table',
  tone: 'neutral',
  place: 'side',
});

/**
 * Export is a *disclosure*, not a deed. One button that writes "a file" would
 * have to pick a format for the user, and a headset has nowhere to put a modal
 * dialog asking which — so pressing this replaces it, in place, with one button
 * per format. Nothing new is drawn and nothing new is hit-tested: it is the same
 * halo with a different list of actions, which is why it works identically on a
 * desktop, under a finger and along an XR ray.
 */
const EXPORT_ACTION: ActionSpec = Object.freeze({
  action: 'export',
  icon: '↓',
  label: 'Export this table as a file',
  tone: 'neutral',
  place: 'top',
});

/**
 * The formats, spelled out.
 *
 * Wide buttons rather than three-letter marks: `PQT` is a puzzle and `PARQUET`
 * is a word, and the halo is sized in screen pixels so a wide button costs
 * nothing but room above a table that is already several hundred pixels across.
 */
const FORMAT_FONT_SIZE = 9;

const EXPORT_CSV_ACTION: ActionSpec = Object.freeze({
  action: 'export-csv',
  icon: 'CSV',
  label: 'Export as CSV',
  tone: 'neutral',
  place: 'top',
  iconFontSize: FORMAT_FONT_SIZE,
  width: 40,
});

const EXPORT_XLSX_ACTION: ActionSpec = Object.freeze({
  action: 'export-xlsx',
  icon: 'XLSX',
  label: 'Export as an Excel workbook',
  tone: 'neutral',
  place: 'top',
  iconFontSize: FORMAT_FONT_SIZE,
  width: 46,
});

const EXPORT_PARQUET_ACTION: ActionSpec = Object.freeze({
  action: 'export-parquet',
  icon: 'PARQUET',
  label: 'Export as Parquet',
  tone: 'neutral',
  place: 'top',
  iconFontSize: FORMAT_FONT_SIZE,
  width: 68,
});

/**
 * The rows behind a picture.
 *
 * Three lines, because that is what a table looks like from a distance and the
 * halo is read at a glance. It opens a table beside the chart holding the rows
 * whatever has been picked out of it was drawn from — empty until something has.
 */
const ROWS_ACTION: ActionSpec = Object.freeze({
  action: 'rows',
  icon: '\u2261',
  label: 'Show the rows behind the selection',
  tone: 'neutral',
  place: 'side',
});

/**
 * A picture's formats.
 *
 * The same disclosure as a table's, with the three formats a chart has: one for a
 * drawing program, one for anywhere a picture goes, and one to print or send.
 */
const EXPORT_SVG_ACTION: ActionSpec = Object.freeze({
  action: 'export-svg',
  icon: 'SVG',
  label: 'Export as SVG',
  tone: 'neutral',
  place: 'top',
  iconFontSize: FORMAT_FONT_SIZE,
  width: 38,
});

const EXPORT_PNG_ACTION: ActionSpec = Object.freeze({
  action: 'export-png',
  icon: 'PNG',
  label: 'Export as a PNG image',
  tone: 'neutral',
  place: 'top',
  iconFontSize: FORMAT_FONT_SIZE,
  width: 38,
});

const EXPORT_PDF_ACTION: ActionSpec = Object.freeze({
  action: 'export-pdf',
  icon: 'PDF',
  label: 'Export as PDF',
  tone: 'neutral',
  place: 'top',
  iconFontSize: FORMAT_FONT_SIZE,
  width: 38,
});

export const CHART_EXPORT_ACTIONS: readonly ActionSpec[] = Object.freeze([
  EXPORT_SVG_ACTION,
  EXPORT_PNG_ACTION,
  EXPORT_PDF_ACTION,
]);

/** The three formats, in the order the halo offers them. */
export const EXPORT_FORMAT_ACTIONS: readonly ActionSpec[] = Object.freeze([
  EXPORT_CSV_ACTION,
  EXPORT_XLSX_ACTION,
  EXPORT_PARQUET_ACTION,
]);

/**
 * What a stored relation offers.
 *
 * The order in a list is reading order within a line, not screen order across the
 * halo: the layout takes each button to the line its action belongs to, so `SQL`
 * next to `close` here means "below it on the right edge", not "beside it".
 */
export const TABLE_ACTIONS: readonly ActionSpec[] = Object.freeze([
  CHART_ACTION,
  EXPORT_ACTION,
  SQL_ACTION,
  CLOSE_ACTION,
]);

/**
 * Switching between the document and the columns it is stored in.
 *
 * Offered only where there is a document to switch to, which is a property of
 * the relation rather than of the moment — a button that is present and inert on
 * every ordinary table would be worse than one that appears where it means
 * something, which is the same rule the pencil follows.
 *
 * A word rather than a glyph: there is no picture of "show me the storage", and
 * the three letters say it.
 */
const JSON_ACTION: ActionSpec = Object.freeze({
  action: 'json',
  icon: 'JSON',
  label: 'Show the document, or the columns it is stored in',
  tone: 'neutral',
  place: 'side',
  iconFontSize: SQL_ICON_FONT_SIZE,
});

/** What a table holding a document family offers, beyond the usual. */
export const DOCUMENT_TABLE_ACTIONS: readonly ActionSpec[] = Object.freeze([
  CHART_ACTION,
  EXPORT_ACTION,
  SQL_ACTION,
  JSON_ACTION,
  CLOSE_ACTION,
]);

/**
 * What a derived table offers: its statement can be reopened for editing.
 *
 * Only a derived table has a statement, so only a derived table gets the pencil.
 * A button that is present but inert on every ordinary table would be worse than
 * one that appears where it means something.
 */
export const DERIVED_TABLE_ACTIONS: readonly ActionSpec[] = Object.freeze([
  EDIT_ACTION,
  CHART_ACTION,
  EXPORT_ACTION,
  SQL_ACTION,
  CLOSE_ACTION,
]);

/** What a derived table offers while its statement is open for editing. */
export const EDITING_TABLE_ACTIONS: readonly ActionSpec[] = Object.freeze([
  CANCEL_EDIT_ACTION,
  CHART_ACTION,
  EXPORT_ACTION,
  SQL_ACTION,
  CLOSE_ACTION,
]);

/**
 * Replaces the disclosing action with the choices it discloses, in place.
 *
 * In place, rather than as a menu of its own, so the buttons that were not
 * asked about stay where they were: pressing export does not take away the
 * ability to close the table or to write a query, and moving the pointer off
 * the halo puts it back as it was.
 */
const expand = (
  actions: readonly ActionSpec[],
  expanded: EntityActionId | null,
  formats: readonly ActionSpec[],
): readonly ActionSpec[] => {
  if (expanded !== 'export') return actions;
  const index = actions.findIndex((spec) => spec.action === 'export');
  if (index < 0) return actions;
  return [...actions.slice(0, index), ...formats, ...actions.slice(index + 1)];
};

/**
 * What a chart offers.
 *
 * No export and no further query: a chart is a picture, and there is nothing in
 * it to write a `WHERE` against or to save as a Parquet file. What it does offer
 * is the way back to its own setup — and no chart of a chart, because charting a
 * picture is not a thing anybody means.
 */
export const CHART_ACTIONS: readonly ActionSpec[] = Object.freeze([
  EDIT_ACTION,
  ROWS_ACTION,
  EXPORT_ACTION,
  CLOSE_ACTION,
]);

/** What a chart offers while it is being set up. */
export const EDITING_CHART_ACTIONS: readonly ActionSpec[] = Object.freeze([
  CANCEL_EDIT_ACTION,
  ROWS_ACTION,
  EXPORT_ACTION,
  CLOSE_ACTION,
]);

/**
 * The halo for a table. `SQL` always derives a *new* table from this one, which
 * is why it is not a toggle: refining a query is how the next one is made.
 * `expanded` names the action whose choices are on show, if any.
 */
export const actionsForTable = (
  entity: TableEntity,
  expanded: EntityActionId | null = null,
): readonly ActionSpec[] => {
  if (isChartTable(entity)) {
    return expand(
      entity.mode === 'editing' ? EDITING_CHART_ACTIONS : CHART_ACTIONS,
      expanded,
      CHART_EXPORT_ACTIONS,
    );
  }
  if (!isQueryTable(entity)) {
    const document = entity.source.kind === 'relation' && entity.source.document === true;
    return expand(
      document ? DOCUMENT_TABLE_ACTIONS : TABLE_ACTIONS,
      expanded,
      EXPORT_FORMAT_ACTIONS,
    );
  }
  return expand(
    entity.mode === 'editing' ? EDITING_TABLE_ACTIONS : DERIVED_TABLE_ACTIONS,
    expanded,
    EXPORT_FORMAT_ACTIONS,
  );
};

const EMPTY_RECT: ClipRect = Object.freeze({ x: 0, y: 0, width: 0, height: 0 });

export const EMPTY_HALO: Halo = Object.freeze({
  buttons: [],
  bounds: EMPTY_RECT,
  hoverBands: [],
});

/**
 * Lays the halo out for a table. `scale` is the camera's pixels-per-world-unit,
 * so button sizes are constant on screen.
 *
 * Buttons come back in the order they were declared, whichever line they landed
 * in: the list is the halo's contents and the geometry is where they went, and a
 * caller that wants one asks for it by name.
 */
export const computeHalo = (
  metrics: TableMetrics,
  theme: TableTheme,
  scale = 1,
  actions: readonly ActionSpec[] = TABLE_ACTIONS,
): Halo => {
  if (actions.length === 0) return EMPTY_HALO;
  const safeScale = Math.max(0.05, scale);
  const size = theme.haloButtonSize / safeScale;
  const gap = theme.haloGap / safeScale;
  const offset = theme.haloOffset / safeScale;
  const indicesOf = (place: ActionPlace): readonly number[] =>
    actions.reduce<number[]>((found, spec, index) => {
      if (spec.place === place) found.push(index);
      return found;
    }, []);
  const topIndices = indicesOf('top');
  // The corner is the head of the right-hand column rather than a place of its
  // own, so the column needs no special case for the button above it.
  const columnIndices = [...indicesOf('corner'), ...indicesOf('side')];

  // A declared width is honoured along the top and ignored down the side, so the
  // column is always one standard button wide. A row can carry a word and still
  // read as a row; a column of several widths reads as a mistake, and one wider
  // than the row it turns the corner from reads as a lopsided halo. Which means
  // a mark that goes on the side has to fit a square, and is drawn at whatever
  // size it takes to.
  const widths = actions.map((spec, index) =>
    columnIndices.includes(index) ? size : (spec.width ?? theme.haloButtonSize) / safeScale,
  );

  // Everything is measured from the corner, which sits diagonally out from the
  // table's own top-right corner and so belongs to neither line.
  const cornerX = metrics.width + offset;
  const cornerY = -(size + offset);

  const positions = actions.map(() => ({ x: cornerX, y: cornerY }));

  // The top row ends a gap short of the corner and is laid out leftwards from
  // there, so adding an action pushes the row away from the corner rather than
  // moving the buttons already in it. It never starts left of the table: a row
  // wider than the box it belongs to would hang off into open space.
  let rowWidth = Math.max(0, topIndices.length - 1) * gap;
  for (const index of topIndices) rowWidth += widths[index] as number;
  let cursor = Math.max(0, cornerX - gap - rowWidth);
  for (const index of topIndices) {
    positions[index] = { x: cursor, y: cornerY };
    cursor += (widths[index] as number) + gap;
  }

  let descent = cornerY;
  for (const index of columnIndices) {
    positions[index] = { x: cornerX, y: descent };
    descent += size + gap;
  }

  const buttons = actions.map((spec, index) => {
    const position = positions[index] as { x: number; y: number };
    return {
      action: spec.action,
      ...(spec.icon === undefined ? {} : { icon: spec.icon }),
      ...(spec.shape === undefined ? {} : { shape: spec.shape }),
      label: spec.label,
      tone: spec.tone,
      place: spec.place,
      ...(spec.iconFontSize === undefined ? {} : { iconFontSize: spec.iconFontSize }),
      x: position.x,
      y: position.y,
      size,
      width: widths[index] as number,
    };
  });

  const left = Math.min(...buttons.map((button) => button.x));
  const right = Math.max(...buttons.map((button) => button.x + button.width));
  const bottom = Math.max(...buttons.map((button) => button.y + button.size));

  // A little forgiveness around the outside, and none towards the table, whose
  // own hit testing owns that space: the top band stops at the top edge and the
  // side band starts at the right one.
  const margin = gap;
  return {
    buttons,
    bounds: { x: left, y: cornerY, width: right - left, height: bottom - cornerY },
    hoverBands: [
      {
        x: -margin,
        y: cornerY - margin,
        width: right + margin * 2,
        height: size + offset + margin,
      },
      {
        x: metrics.width,
        y: 0,
        width: right + margin - metrics.width,
        // Nothing below the corner button leaves nothing to reach for, and a
        // band of no height matches no point — so the empty column needs no
        // case of its own here either.
        height: Math.max(0, bottom + margin),
      },
    ],
  };
};

/** The button under a point in table-local coordinates, if any. */
export const haloButtonAt = (halo: Halo, localX: number, localY: number): HaloButton | null => {
  for (const button of halo.buttons) {
    if (
      localX >= button.x &&
      localX < button.x + button.width &&
      localY >= button.y &&
      localY < button.y + button.size
    ) {
      return button;
    }
  }
  return null;
};

/**
 * True when a point is in one of the halo's bands — on a button or merely on the
 * way to one. This is what keeps the table activated while the pointer crosses
 * the gap, and what lets it turn the corner from one line of buttons to the
 * other without passing through anything that is neither.
 */
export const withinHalo = (halo: Halo, localX: number, localY: number): boolean =>
  halo.buttons.length > 0 &&
  halo.hoverBands.some(
    (band) =>
      localX >= band.x &&
      localX < band.x + band.width &&
      localY >= band.y &&
      localY < band.y + band.height,
  );
