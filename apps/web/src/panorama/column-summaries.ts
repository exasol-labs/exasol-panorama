import type { EntityId, TableColumnView, TableEntity, WorldState } from '@panorama/core';
import { findColumn, isTableEntity } from '@panorama/core';
import type { ColumnSummary } from '@panorama/table';
import type { SummaryPanelView } from '@panorama/renderer';

/**
 * The statistics under a picked-out column.
 *
 * Kept apart from the workspace because it is one question asked of the database
 * and one answer held until nobody wants it any more — none of which has anything
 * to do with tables, placement or the canvas. What it does need is the selection,
 * and it takes that as an argument rather than reaching for it, which is what
 * makes it testable without a world at all.
 */

/** A column summary, or how far it has got towards being one. */
export type ColumnSummaryState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly summary: ColumnSummary }
  | { readonly status: 'unavailable' }
  | { readonly status: 'failed'; readonly error: string };

/**
 * What the panel under a column should show for it.
 *
 * The three ways of having no numbers are kept apart on purpose. "Still coming"
 * will turn into an answer; "cannot say" never will, and telling someone to wait
 * for an answer that is not coming is worse than saying so; and a failure is the
 * database's own words, which are usually the ones worth reading.
 */
export const summaryPanelView = (state: ColumnSummaryState): SummaryPanelView => {
  switch (state.status) {
    case 'ready':
      return { summary: state.summary };
    case 'unavailable':
      return { note: 'No statistics for this source' };
    case 'failed':
      return { note: state.error };
    default:
      return {};
  }
};

export interface ColumnSummariesOptions {
  /** Asks the database to describe one column of one table. */
  readonly summarise: (tableId: EntityId, column: string) => Promise<ColumnSummary | null>;
  /** Called when an answer arrives, so the canvas redraws. */
  readonly onChange?: () => void;
}

export class ColumnSummaries {
  readonly #options: ColumnSummariesOptions;
  readonly #states = new Map<EntityId, ColumnSummaryState>();

  constructor(options: ColumnSummariesOptions) {
    this.#options = options;
  }

  /**
   * Makes sure every picked-out column has a summary, and none of the others do.
   *
   * Driven by the selection rather than by the click, so it does not matter
   * whether a column was picked out by pointer, by keyboard or by an agent — and
   * so a sweep across eight columns asks eight questions and no more. Summaries
   * for columns no longer picked out are dropped: they were only ever an answer
   * to a question nobody is asking any more.
   *
   * Called every frame, so it does nothing at all in the ordinary case: no
   * column picked out and none held is the first line, not a scan.
   */
  sync(world: WorldState, picked: readonly EntityId[]): void {
    if (picked.length === 0) {
      if (this.#states.size > 0) this.#states.clear();
      return;
    }
    for (const id of [...this.#states.keys()]) {
      if (!picked.includes(id)) this.#states.delete(id);
    }
    for (const id of picked) {
      if (this.#states.has(id)) continue;
      const found = columnOwner(world, id);
      if (found === null) continue;
      this.#states.set(id, { status: 'loading' });
      void this.#load(id, found.tableId, found.column.sourceColumn.name);
    }
  }

  /** The summary of a picked-out column, or its progress towards one. */
  stateOf(columnId: EntityId): ColumnSummaryState | undefined {
    return this.#states.get(columnId);
  }

  /** What the renderer should draw under each of a table's columns. */
  viewsFor(entity: TableEntity): ReadonlyMap<EntityId, SummaryPanelView> | undefined {
    const views = new Map<EntityId, SummaryPanelView>();
    for (const column of entity.columns) {
      const state = this.#states.get(column.id);
      if (state === undefined) continue;
      views.set(column.id, summaryPanelView(state));
    }
    return views.size === 0 ? undefined : views;
  }

  async #load(columnId: EntityId, tableId: EntityId, name: string): Promise<void> {
    const settle = (state: ColumnSummaryState): void => {
      // Only if it is still wanted: a column let go of while its query was in
      // flight should not have the answer arrive behind it.
      if (this.#states.get(columnId)?.status !== 'loading') return;
      this.#states.set(columnId, state);
      this.#options.onChange?.();
    };
    try {
      const summary = await this.#options.summarise(tableId, name);
      settle(summary === null ? { status: 'unavailable' } : { status: 'ready', summary });
    } catch (error) {
      settle({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/** Which table a column view belongs to. Column ids are unique across them. */
export const columnOwner = (
  world: WorldState,
  columnId: EntityId,
): { readonly tableId: EntityId; readonly column: TableColumnView } | null => {
  for (const entity of world.entities.values()) {
    if (!isTableEntity(entity)) continue;
    const column = findColumn(entity, columnId);
    if (column !== undefined) return { tableId: entity.id, column };
  }
  return null;
};
