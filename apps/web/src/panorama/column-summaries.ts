import type { EntityId, TableColumnView, TableEntity, WorldState } from '@panorama/core';
import { findColumn, isTableEntity } from '@panorama/core';
import type { ColumnSummary, JsonColumnSummary } from '@panorama/table';
import { jsonColumnSummary, worthBreakingDown } from '@panorama/table';
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
  /**
   * A property spread across several columns.
   *
   * Its own state rather than a `ColumnSummary` with extra fields, because the
   * first thing to say about it is not a distribution: it is what is in there,
   * across the branches and the three kinds of emptiness.
   */
  | { readonly status: 'document'; readonly summary: JsonColumnSummary }
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
    case 'document':
      return {
        document: state.summary,
        ...(state.summary.dominant === undefined ? {} : { summary: state.summary.dominant }),
      };
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
  /**
   * The name of a result-set column, by position.
   *
   * A presented column knows the *indices* it reads and not the names, because
   * an index is what reads a cell and a name is what a query needs. Rather than
   * carry both on the document, the names are looked up here from the schema the
   * result set was opened with.
   */
  readonly columnAt?: (tableId: EntityId, index: number) => string | undefined;
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
      void this.#load(id, found.tableId, found.column);
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

  async #load(columnId: EntityId, tableId: EntityId, column: TableColumnView): Promise<void> {
    const settle = (state: ColumnSummaryState): void => {
      // Only if it is still wanted: a column let go of while its query was in
      // flight should not have the answer arrive behind it.
      if (this.#states.get(columnId)?.status !== 'loading') return;
      this.#states.set(columnId, state);
      this.#options.onChange?.();
    };
    try {
      const json = column.json;
      if (json !== undefined && worthBreakingDown(json)) {
        settle({
          status: 'document',
          summary: await this.#describeDocument(tableId, column, json),
        });
        return;
      }
      // A presented column with one branch and no masks is an ordinary column
      // with a nicer name, and the name it is asked about has to be the one the
      // database knows — the property's name is not always a column at all.
      const only = json?.branches[0]?.index;
      const asked =
        (only === undefined ? undefined : this.#options.columnAt?.(tableId, only)) ??
        column.sourceColumn.name;
      const summary = await this.#options.summarise(tableId, asked);
      settle(summary === null ? { status: 'unavailable' } : { status: 'ready', summary });
    } catch (error) {
      settle({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Describes a property by describing every column it is spread across.
   *
   * One question per physical column rather than one clever one: they are the
   * same `GROUP BY` the panel has always used, they only run when somebody picks
   * a header out, and the answer is cached until they let go. A column that
   * cannot be summarised comes back `null` and is counted as nothing, which is
   * what it is — and leaves `missing` larger rather than making the whole
   * breakdown fail.
   */
  async #describeDocument(
    tableId: EntityId,
    column: TableColumnView,
    json: NonNullable<TableColumnView['json']>,
  ): Promise<JsonColumnSummary> {
    const wanted = [
      ...json.branches.map((branch) => branch.index),
      json.nullMask,
      json.emptyMask,
      json.objectLink,
      json.arrayCount,
    ].filter((index): index is number => index !== undefined);
    const answered = await Promise.all(
      wanted.map(async (index) => {
        const name = this.#options.columnAt?.(tableId, index);
        const summary =
          name === undefined
            ? null
            : await this.#options.summarise(tableId, name).catch(() => null);
        return [index, summary] as const;
      }),
    );
    return jsonColumnSummary(json, { byIndex: new Map(answered) }, column.sourceColumn.name);
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
