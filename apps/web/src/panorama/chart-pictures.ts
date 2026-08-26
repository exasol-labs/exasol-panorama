import type { ChartSpec, EntityId, SessionState, TableEntity } from '@panorama/core';
import {
  hoveredMarkOf,
  isChartSpecDrawable,
  selectedMarksOf,
  tableDisplayName,
} from '@panorama/core';
import type {
  ChartData,
  ChartDrawList,
  ChartSurface,
  ChartTheme,
  ChartTypography,
} from '@panorama/chart';
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

/** What a chart is drawing, or how far it has got towards it. */
export type ChartState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly data: ChartData }
  /** Nothing chosen yet: the controls are open and waiting. */
  | { readonly status: 'unset' }
  /** Chosen, but the table it reads had no rows to give. */
  | { readonly status: 'empty' }
  | { readonly status: 'failed'; readonly error: string };

/** What the renderer draws for a chart box, and what it says underneath. */
export interface ChartView {
  readonly chart: ChartDrawList;
  readonly note: string;
  /** True where the note is a caveat rather than a count. */
  readonly caution?: boolean;
}

/** What the canvas made of a chart, for whoever cannot look at it. */
export interface ChartGeometry {
  readonly width: number;
  readonly height: number;
  readonly polygons: number;
  readonly texts: number;
  readonly bounds: { x: number; y: number; width: number; height: number } | null;
  readonly clipped: readonly string[];
}

interface ChartLayout {
  /** The specification this was laid out for, compared by identity. */
  readonly spec: ChartSpec;
  readonly data: ChartData;
  readonly chart: ChartDrawList;
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
  readonly reduce: (tableId: EntityId, spec: ChartSpec) => Promise<ChartData | null>;
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
  async load(tableId: EntityId, baseId: EntityId, spec: ChartSpec): Promise<void> {
    if (!isChartSpecDrawable(spec)) {
      this.#states.set(tableId, { status: 'unset' });
      this.#options.onChange?.();
      return;
    }
    this.#states.set(tableId, { status: 'loading' });
    const settle = (state: ChartState): void => {
      // Only if this is still the specification being asked about: a control
      // moved again while the last answer was in flight should not be
      // overwritten by it.
      if (!this.#options.stillWanted(tableId, spec)) return;
      this.#states.set(tableId, state);
      this.#options.onChange?.();
    };
    try {
      const data = await this.#options.reduce(baseId, spec);
      settle(data === null ? { status: 'empty' } : { status: 'ready', data });
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
        width,
        height,
        theme: this.#options.theme(),
        typography,
      });
      this.#layouts.set(tableId, {
        spec,
        data: state.data,
        chart: surface.draw(),
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

  /** The piece of a chart at a point in the box's own coordinates. */
  markAt(
    entity: TableEntity,
    localX: number,
    localY: number,
  ): { readonly series: number; readonly data: number } | null {
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
    const { width, height, chart } = laid;
    const xs: number[] = [];
    const ys: number[] = [];
    for (const polygon of chart.polygons) {
      for (let index = 0; index < polygon.corners.length; index += 2) {
        xs.push(polygon.corners[index] as number);
        ys.push(polygon.corners[index + 1] as number);
      }
    }
    for (const run of chart.texts) {
      xs.push(run.x, run.x + run.width);
      ys.push(run.y, run.y + run.height);
    }
    const past = (value: number, limit: number): boolean => value < -0.5 || value > limit + 0.5;
    return {
      width,
      height,
      polygons: chart.polygons.length,
      texts: chart.texts.length,
      bounds:
        xs.length === 0
          ? null
          : {
              x: Math.min(...xs),
              y: Math.min(...ys),
              width: Math.max(...xs) - Math.min(...xs),
              height: Math.max(...ys) - Math.min(...ys),
            },
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
    };
  }
}
