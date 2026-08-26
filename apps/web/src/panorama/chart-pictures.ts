import type { ChartSpec, EntityId, SessionState, TableEntity } from '@panorama/core';
import {
  hoveredMarkOf,
  isChartSpecDrawable,
  selectedMarksOf,
  tableDisplayName,
} from '@panorama/core';
import type {
  ChartData,
  ChartDatasetResolution,
  ChartDrawList,
  ChartFrame,
  ChartMark,
  ChartResolution,
  ChartSeriesResolution,
  ChartSurface,
  ChartTheme,
  ChartTypography,
} from '@panorama/chart';
import type { CellValue } from '@panorama/table';
import { EMPTY_CHART_DRAW_LIST, chartMarkAt, emphasiseChart } from '@panorama/chart';
import type { ChartFigure } from '@panorama/export';
import { DEFAULT_TABLE_THEME, chartBoxLayout } from '@panorama/renderer';

/**
 * A chart's picture: the numbers it reduced to, the geometry it drew, and what
 * the pointer is doing to that geometry.
 *
 * Separate from the workspace because none of it is about the canvas. A chart's
 * *setup* — opening one, committing a specification, switching a box between the
 * form and the picture — is document work, and it stays where the document work
 * is. This is the other half: given a specification and a size, what is drawn,
 * and what was drawn last time.
 *
 * Every cache in here is keyed by identity rather than by value. A specification,
 * a reduced data set and the session's own mark arrays are all replaced wholesale
 * when they change, so the object *is* the key — and this is read once per chart
 * per frame, where serialising anything to compare it is the expensive way to
 * answer a question that a pointer comparison answers.
 */

/**
 * The boxes a chart reads, as one string.
 *
 * A string rather than a deep comparison because this is asked once per chart per
 * frame: a handful of short names, sorted, so the same set of arrows is the same
 * string whichever order they were drawn in.
 */
const sourceKey = (sources: ReadonlyMap<string, EntityId>): string =>
  [...sources]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([name, from]) => `${name}=${from}`)
    .join('\u0000');

/** What a chart is drawing, or how far it has got towards it. */
export type ChartState =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly data: ChartData;
      /** The reduction and every data set the specification named. */
      readonly frames: readonly ChartFrame[];
    }
  /** Nothing chosen yet: the controls are open and waiting. */
  | { readonly status: 'unset' }
  /** Chosen, but the table it reads had no rows to give. */
  | { readonly status: 'empty' }
  | { readonly status: 'failed'; readonly error: string };

/** One data set as it is reported: what it is, where from, and how much of it. */
export interface ChartFrameReport {
  readonly name: string;
  readonly from?: string;
  readonly dimensions: readonly string[];
  /** The column a mark drawn from this data set can be traced back by. */
  readonly key?: string;
  /** Columns it was asked to read that the relation has not got. */
  readonly missing?: readonly string[];
  /** Which part of the relation it is, where it is a part. */
  readonly window?: unknown;
  /** Rows walked to find the ones it kept, for a window that had to look. */
  readonly scanned?: number;
  readonly rows: number;
  readonly read: number;
  readonly basis: string;
}

/**
 * A chart's state as an answer rather than as working state.
 *
 * The data sets described rather than carried: whoever is asking cannot look at
 * the picture, and a few thousand values would be an answer nobody can read.
 */
export type ChartReport =
  | Exclude<ChartState, { status: 'ready' }>
  | {
      readonly status: 'ready';
      readonly data: ChartData;
      readonly frames: readonly ChartFrameReport[];
    };

/** What the renderer draws for a chart box, and what it says underneath. */
export interface ChartView {
  readonly chart: ChartDrawList;
  readonly note: string;
  /** True where the note is a caveat rather than a count. */
  readonly caution?: boolean;
}

/**
 * What the canvas made of a chart, for whoever cannot look at it.
 *
 * The shape of the picture and the source of its numbers, together: a chart can
 * be laid out perfectly from the wrong column, and a chart drawn from the right
 * column can have half its labels outside the box. Neither is visible from the
 * far end of a pipe, so both are measured.
 */
export interface ChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly polygons: number;
  readonly texts: number;
  readonly bounds: { x: number; y: number; width: number; height: number } | null;
  readonly clipped: readonly string[];
  readonly datasets: readonly ChartDatasetResolution[];
  readonly series: readonly ChartSeriesResolution[];
  readonly unresolved: readonly string[];
  /** Whether anything drawn can be pointed at; see `ChartResolution`. */
  readonly pickable: boolean;
}

interface ChartLayout {
  /** The specification this was laid out for, compared by identity. */
  readonly spec: ChartSpec;
  readonly data: ChartData;
  readonly chart: ChartDrawList;
  /**
   * What that layout read, taken at the same moment as the geometry.
   *
   * One surface lays out every chart in turn, so asking it later would answer
   * about whichever chart was drawn last.
   */
  readonly resolution: ChartResolution;
  readonly width: number;
  readonly height: number;
  readonly fontFamily: string;
}

/** The pointer and selection applied, kept against what they were applied to. */
interface Emphasis {
  readonly hovered: SessionState['hoveredMark'];
  readonly selected: SessionState['selectedMarks'];
  readonly base: ChartDrawList;
  readonly chart: ChartDrawList;
}

const noteFor = (state: ChartState | undefined): string => {
  if (state === undefined) return 'Reading…';
  switch (state.status) {
    case 'unset':
      return 'Choose a column to chart';
    case 'empty':
      return 'No rows to chart';
    case 'failed':
      return state.error;
    default:
      return 'Reading…';
  }
};

/**
 * What a chart has to admit about the rows behind it.
 *
 * A picture cannot say "these are the first twenty thousand rows" or "there were
 * forty more categories", and both change what it means.
 */
export const chartDataNote = (data: ChartData): string => {
  const rows = data.rows.toLocaleString('en-US');
  const parts = [data.basis === 'sampled' ? `first ${rows} rows` : `${rows} rows`];
  if (data.gathered !== undefined) {
    parts.push(`${data.gathered} more categor${data.gathered === 1 ? 'y' : 'ies'} not shown`);
  }
  return parts.join(' · ');
};

export interface ChartPicturesOptions {
  /** Reduces a table's rows where they are, next to the result set. */
  readonly reduce: (
    tableId: EntityId,
    spec: ChartSpec,
    sources: ReadonlyMap<string, EntityId>,
  ) => Promise<{ readonly data: ChartData; readonly frames: readonly ChartFrame[] } | null>;
  /** Lays a chart out. Absent in a build with no chart library behind it. */
  readonly surface?: ChartSurface;
  readonly theme: () => ChartTheme;
  readonly session: () => SessionState;
  /**
   * Whether an answer that has just arrived is still the one being asked for.
   *
   * Supplied rather than decided here, because what makes an answer stale is the
   * draft the form is holding, and the form's drafts are the workspace's.
   */
  readonly stillWanted: (tableId: EntityId, spec: ChartSpec) => boolean;
  readonly onChange?: () => void;
}

export class ChartPictures {
  readonly #options: ChartPicturesOptions;
  readonly #states = new Map<EntityId, ChartState>();
  /** The boxes each chart was last read against, as one comparable string. */
  readonly #sources = new Map<EntityId, string>();
  readonly #layouts = new Map<EntityId, ChartLayout>();
  readonly #emphasis = new Map<EntityId, Emphasis>();

  constructor(options: ChartPicturesOptions) {
    this.#options = options;
  }

  /** What a chart is drawing, or how far it has got towards it. */
  stateOf(tableId: EntityId): ChartState | undefined {
    return this.#states.get(tableId);
  }

  /** Forgets everything about a chart, for a box that has been closed. */
  forget(tableId: EntityId): void {
    this.#states.delete(tableId);
    this.#sources.delete(tableId);
    this.#layouts.delete(tableId);
    this.#emphasis.delete(tableId);
  }

  /**
   * Reads the numbers for a chart.
   *
   * From the table it was opened on, through that table's own session — so a
   * chart of a followed key or of a written query is a chart of what that table
   * is showing, not of the relation underneath it.
   */
  /**
   * Whether a chart is reading the boxes it is supposed to be reading.
   *
   * The arrows are document state and anything can draw or cut one — a pointer,
   * an agent, an undo — so this is asked every frame rather than fired from
   * whatever changed them. The same reason the drill-down tables are derived from
   * the selection: one place decides what should be loaded, and it cannot be
   * bypassed by a new gesture.
   */
  readsFrom(tableId: EntityId, sources: ReadonlyMap<string, EntityId>): boolean {
    return this.#sources.get(tableId) === sourceKey(sources);
  }

  async load(
    tableId: EntityId,
    baseId: EntityId,
    spec: ChartSpec,
    sources: ReadonlyMap<string, EntityId> = new Map(),
  ): Promise<void> {
    if (!isChartSpecDrawable(spec)) {
      this.#states.set(tableId, { status: 'unset' });
      this.#options.onChange?.();
      return;
    }
    this.#states.set(tableId, { status: 'loading' });
    this.#sources.set(tableId, sourceKey(sources));
    const settle = (state: ChartState): void => {
      // Only if this is still the specification being asked about: a control
      // moved again while the last answer was in flight should not be
      // overwritten by it.
      if (!this.#options.stillWanted(tableId, spec)) return;
      this.#states.set(tableId, state);
      this.#options.onChange?.();
    };
    try {
      const reduced = await this.#options.reduce(baseId, spec, sources);
      settle(
        reduced === null
          ? { status: 'empty' }
          : { status: 'ready', data: reduced.data, frames: reduced.frames },
      );
    } catch (error) {
      settle({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The picture for a box of this size, laid out if it has to be.
   *
   * The specification passed in is the *draft* while a box is open, so every
   * control redraws the picture the moment it moves; a closed box draws what was
   * committed.
   */
  view(
    tableId: EntityId,
    spec: ChartSpec,
    width: number,
    height: number,
    typography: ChartTypography,
  ): ChartView | undefined {
    const state = this.#states.get(tableId);
    if (state === undefined || state.status !== 'ready') {
      // The picture it had, while the next one is in flight.
      //
      // The constraint the whole design answers to does not get an exception for
      // charts: rows may arrive late and the canvas may not respond late. Moving
      // along a series would otherwise blank the chart on every step, which is
      // the one thing a person moving along it cannot use. The note says what is
      // happening, so nobody mistakes the old picture for the new one.
      const held = state?.status === 'loading' ? this.#layouts.get(tableId) : undefined;
      if (held !== undefined) {
        return { chart: this.#emphasised(tableId), note: `${chartDataNote(held.data)} · reading…` };
      }
      return {
        chart: EMPTY_CHART_DRAW_LIST,
        note: noteFor(state),
        ...(state?.status === 'failed' ? { caution: true } : {}),
      };
    }
    const surface = this.#options.surface;
    if (surface === undefined) return undefined;
    const cached = this.#layouts.get(tableId);
    if (
      cached === undefined ||
      cached.spec !== spec ||
      cached.width !== width ||
      cached.height !== height ||
      cached.data !== state.data
    ) {
      surface.update({
        spec,
        data: state.data,
        frames: state.frames,
        width,
        height,
        theme: this.#options.theme(),
        typography,
      });
      this.#layouts.set(tableId, {
        spec,
        data: state.data,
        chart: surface.draw(),
        resolution: surface.resolution(),
        width,
        height,
        fontFamily: typography.fontFamily,
      });
    }
    const data = state.data;
    return {
      chart: this.#emphasised(tableId),
      note: chartDataNote(data),
      // A caveat only when there is one: a plain row count in the colour
      // reserved for warnings would cry wolf.
      ...(data.basis === 'sampled' || data.gathered !== undefined ? { caution: true } : {}),
    };
  }

  /**
   * The geometry with the pointer and the selection applied.
   *
   * Kept against what it was applied to, so a frame in which nothing has crossed
   * a boundary costs three pointer comparisons. The unemphasised geometry stays
   * separate because that is what an export writes: a file should not carry
   * whatever happened to be under the pointer when it was written.
   */
  #emphasised(tableId: EntityId): ChartDrawList {
    const layout = this.#layouts.get(tableId) as ChartLayout;
    const session = this.#options.session();
    const cached = this.#emphasis.get(tableId);
    if (
      cached !== undefined &&
      cached.hovered === session.hoveredMark &&
      cached.selected === session.selectedMarks &&
      cached.base === layout.chart
    ) {
      return cached.chart;
    }
    const chart = emphasiseChart(layout.chart, {
      hovered: hoveredMarkOf(session, tableId),
      selected: selectedMarksOf(session, tableId),
    });
    this.#emphasis.set(tableId, {
      hovered: session.hoveredMark,
      selected: session.selectedMarks,
      base: layout.chart,
      chart,
    });
    return chart;
  }

  /**
   * What a picked mark stands for: a column, and the value of it.
   *
   * One rule for every kind of chart. A mark stamped with a data set is traced
   * through that data set's own keys; a mark from a series carrying its own
   * numbers — which is every chart the controls assemble — is traced through the
   * reduction's, where the data index *is* the category. Both end at the value a
   * predicate can be built from rather than at the label an axis was written
   * with, because `String(7)` is a fine label and cannot be compared with a
   * number.
   *
   * `null` where the data set has no key to trace by: a heatmap that never said
   * which of its axes identifies a row can still be pointed at and picked out,
   * and there is nothing to open the rows behind it with. Said rather than
   * guessed at.
   */
  keyFor(tableId: EntityId, mark: ChartMark): { column: string; value: CellValue } | null {
    const state = this.#states.get(tableId);
    if (state?.status !== 'ready') return null;
    const frame =
      mark.frame === undefined
        ? state.frames[0]
        : state.frames.find((entry) => entry.name === mark.frame);
    if (frame?.key === undefined || frame.keys === undefined) return null;
    const value = frame.keys[mark.row ?? mark.data];
    return value === undefined ? null : { column: frame.key, value };
  }

  /** The piece of a chart at a point in the box's own coordinates. */
  markAt(entity: TableEntity, localX: number, localY: number): ChartMark | null {
    const layout = this.#layouts.get(entity.id);
    if (layout === undefined) return null;
    const box = chartBoxLayout(
      entity.transform.width,
      entity.transform.height,
      DEFAULT_TABLE_THEME,
      entity.mode === 'editing',
    );
    // Into the chart's own coordinates: the box holds a title bar, padding, and
    // possibly a column of controls before the picture starts.
    return chartMarkAt(layout.chart, localX - box.chart.x, localY - box.chart.y);
  }

  /** The figure a chart would be exported as, or `null` before it has drawn. */
  figure(entity: TableEntity): ChartFigure | null {
    const state = this.#states.get(entity.id);
    const layout = this.#layouts.get(entity.id);
    if (state?.status !== 'ready' || layout === undefined) return null;
    const theme = this.#options.theme();
    return {
      title: tableDisplayName(entity),
      note: chartDataNote(state.data),
      chart: layout.chart,
      width: layout.width,
      height: layout.height,
      background: theme.background,
      text: theme.text,
      fontFamily: layout.fontFamily,
      fontSize: theme.fontSize,
    };
  }

  /**
   * What the canvas actually drew, for whoever cannot look at it.
   *
   * Read from the layout the renderer last asked for rather than laid out again:
   * these are the real numbers, measured with the real glyph atlas, at the size
   * the box really is. An approximation would report overflow that is not there
   * and miss the overflow that is.
   */
  geometry(tableId: EntityId): ChartGeometry | null {
    const laid = this.#layouts.get(tableId);
    if (laid === undefined) return null;
    const { width, height, chart, resolution } = laid;
    /**
     * Walked rather than spread.
     *
     * `Math.min(...xs)` reads beautifully and is a call with one argument per
     * coordinate: past about thirty thousand shapes the argument list is longer
     * than the stack and it throws `Maximum call stack size exceeded`. A chart of
     * twelve thousand polylines is well past that — and because the failure was in
     * the *report* rather than in the drawing, the picture appeared and every
     * attempt to ask about it failed, which read as a box that had gone bad.
     */
    let left = Number.POSITIVE_INFINITY;
    let top = Number.POSITIVE_INFINITY;
    let right = Number.NEGATIVE_INFINITY;
    let bottom = Number.NEGATIVE_INFINITY;
    let seen = 0;
    const note = (x: number, y: number): void => {
      seen += 1;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    };
    for (const polygon of chart.polygons) {
      for (let index = 0; index < polygon.corners.length; index += 2) {
        note(polygon.corners[index] as number, polygon.corners[index + 1] as number);
      }
    }
    for (const run of chart.texts) {
      note(run.x, run.y);
      note(run.x + run.width, run.y + run.height);
    }
    const past = (value: number, limit: number): boolean => value < -0.5 || value > limit + 0.5;
    return {
      width,
      height,
      polygons: chart.polygons.length,
      texts: chart.texts.length,
      bounds: seen === 0 ? null : { x: left, y: top, width: right - left, height: bottom - top },
      // Named, because "a label is clipped" is only actionable if you know which.
      clipped: chart.texts
        .filter(
          (run) =>
            past(run.x, width) ||
            past(run.x + run.width, width) ||
            past(run.y, height) ||
            past(run.y + run.height, height),
        )
        .map((run) => run.text),
      datasets: resolution.datasets,
      series: resolution.series,
      unresolved: resolution.unresolved,
      pickable: resolution.pickable,
    };
  }
}
