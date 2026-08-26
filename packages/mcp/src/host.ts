import type { ChartSpec, EntityActionId, EntityId, PanoramaCore } from '@panorama/core';

/**
 * What an agent needs from the running application.
 *
 * Declared here rather than imported from the shell, and structurally: the
 * workspace already has every one of these methods, so it satisfies this
 * interface by having them rather than by being told to. Which keeps the agent
 * interface out of the app's dependencies and lets the whole of it be tested
 * against a stand-in — the same arrangement the renderer's `InteractionHost`
 * uses, for the same reason.
 *
 * The split it draws is the one that already exists in the application. The
 * *document* is reached through `core`, whose commands are the only way
 * persistent state ever changes, for a pointer and an agent alike. Everything
 * else here is work the document cannot express on its own: opening a relation
 * needs a connection and a result set, and running a statement takes time.
 */

/** A cell, as the result set had it. */
export type AgentCell = number | string | boolean | null;

export interface AgentViewState {
  readonly scrollTop: number;
  readonly scrollLeft: number;
  /** `null` while the source has not said, or cannot say, how many rows. */
  readonly rowCount: number | null;
}

export interface AgentSchemaListing {
  readonly name: string;
}

export interface AgentTableListing {
  readonly schema: string;
  readonly name: string;
  readonly kind: string;
  readonly rowCount?: number;
  readonly comment?: string;
}

export interface AgentExportJob {
  readonly id: number;
  readonly tableName: string;
  readonly fileName: string;
  readonly status: string;
  readonly rows: number;
  readonly bytes: number;
  readonly totalRows: number | null;
  readonly error?: string;
}

export interface AgentHost {
  /** The document, its history and the session. */
  readonly core: PanoramaCore;

  /** Whether there is a database behind the tables. */
  connected(): boolean;
  /**
   * Which database that is, as the database described itself.
   *
   * The evidence anything else needs before its answers can be trusted beside
   * these: a session is one way to reach a database and rarely the fastest, and a
   * machine may be running several.
   */
  reachedDatabase(): {
    readonly url: string;
    readonly database?: string;
    readonly version?: string;
    readonly sessionId?: number;
  } | null;
  listSchemas(): Promise<readonly AgentSchemaListing[]>;
  listTables(schema: string): Promise<readonly AgentTableListing[]>;

  /** What a table has fetched and where it is scrolled. */
  viewOf(tableId: EntityId): AgentViewState | null;
  cellAt(tableId: EntityId, row: number, columnIndex: number): AgentCell | undefined;
  /**
   * Waits for a window of rows to be fetched, and says whether they arrived.
   *
   * Nothing else here waits, and this has to: the rows behind a table are
   * fetched when something asks for them, and on a canvas that something is the
   * frame loop. An agent is not the frame loop.
   */
  ensureRows(tableId: EntityId, from: number, count: number): Promise<boolean>;

  openTable(request: { readonly schema: string; readonly table: string }): Promise<EntityId>;
  /** The halo's vocabulary: close, sql, chart, rows, export-csv and the rest. */
  performAction(tableId: EntityId, action: EntityActionId): Promise<void>;

  queryDraft(tableId: EntityId): string;
  setQueryDraft(tableId: EntityId, sql: string): void;
  runQuery(tableId: EntityId, sql?: string): Promise<void>;
  /** The statement a derived box would actually send, chain and all. */
  composedQuery(tableId: EntityId): string;
  /**
   * What to write after `FROM` in this box's statement.
   *
   * A box built on a stored relation reads that relation, and naming it is
   * clearer than referring to it; a box built on another query or chart has no
   * name to write, so it reads `derived_table`. Answered by the application
   * because that is where the quoting of an identifier lives.
   */
  readsFrom(tableId: EntityId): string;
  editingQueryTables(): readonly EntityId[];

  chartDraft(tableId: EntityId): ChartSpec | null;
  setChartDraft(tableId: EntityId, spec: ChartSpec): void;
  showChart(tableId: EntityId): void;
  /** Renames a box, so a canvas of query boxes can be told apart. */
  setTableLabel(tableId: EntityId, label: string): void;

  /**
   * What the canvas drew of a chart, and what it drew it from.
   *
   * Two halves, and they answer different questions. The rectangle, the counts
   * and the clipped labels say whether the picture came out the right *shape*;
   * the data sets, the series and `unresolved` say whether it came out of the
   * right *numbers*. A written option can be wrong in either way and look fine
   * from here, which is the whole reason both are reported.
   */
  chartGeometry(tableId: EntityId): {
    readonly width: number;
    readonly height: number;
    readonly polygons: number;
    readonly texts: number;
    readonly bounds: { x: number; y: number; width: number; height: number } | null;
    readonly clipped: readonly string[];
    readonly datasets: readonly {
      readonly name?: string;
      readonly dimensions: readonly string[];
      readonly rows: number;
    }[];
    readonly series: readonly {
      readonly index: number;
      readonly type: string;
      readonly dataset?: string;
      readonly encode?: Readonly<Record<string, string>>;
      readonly marks: number;
    }[];
    readonly unresolved: readonly string[];
    /** Whether anything drawn can be pointed at. */
    readonly pickable: boolean;
  } | null;

  /**
   * What fills in each `{{name}}` a box's statement leaves open, and from where.
   *
   * The predicate as it stands, so a statement that came back with everything in
   * it can be told apart from one nobody has picked anything for yet.
   */
  filtersOf(tableId: EntityId): readonly {
    readonly name: string;
    readonly from: EntityId;
    readonly picked: number;
    readonly predicate: string;
  }[];

  /**
   * What a picked mark stands for: the data set, the row, and the value the rows
   * behind it are found by.
   *
   * Asked of the picture rather than worked out from the specification, because a
   * mark knows which data set it came from and only the picture knows that. `null`
   * where the data set has no key — a cell that can be picked out and not drilled
   * into — which is a fact worth reporting rather than an empty answer.
   */
  markMeaning(
    tableId: EntityId,
    mark: { readonly series: number; readonly data: number },
  ): {
    readonly frame: string;
    readonly row: number;
    readonly column: string;
    readonly value: AgentCell;
  } | null;

  /** Which columns a chart could group by or measure, and how they look. */
  chartColumns(
    tableId: EntityId,
  ): readonly { readonly name: string; readonly numeric: boolean; readonly type: string }[];
  /**
   * What the chart has to draw, or how far it has got towards having it.
   *
   * The reduction is declared here structurally rather than imported, because
   * what an agent is told about it depends on whether the chart used it: a
   * written option is handed the same numbers and may ignore every one of them.
   */
  chartState(tableId: EntityId):
    | {
        readonly status: string;
        readonly error?: string;
        readonly data?: {
          readonly categories: readonly string[];
          readonly series: readonly { readonly name: string }[];
          readonly rows: number;
          readonly basis: string;
          readonly gathered?: number;
        };
        /**
         * Each data set the chart holds, and which box it came from.
         *
         * The other half of the resolution report: `drawn` says what the option
         * asked for, and this says what arrived and where from. A data set with no
         * rows and a box named beside it is a different problem from one whose
         * column was misspelt, and neither is visible in a picture.
         */
        readonly frames?: readonly {
          readonly name: string;
          readonly from?: string;
          readonly dimensions: readonly string[];
          /** The column a mark drawn from this data set can be traced back by. */
          readonly key?: string;
          /** Columns it was asked to read that the relation has not got. */
          readonly missing?: readonly string[];
          /** Which part of the relation it read, where it read a part. */
          readonly window?: unknown;
          /** Rows walked to find the ones it kept, where it had to look. */
          readonly scanned?: number;
          readonly rows: number;
          readonly read: number;
          readonly basis: string;
        }[];
      }
    | undefined;
  editingCharts(): readonly EntityId[];

  exportJobs(): readonly AgentExportJob[];
  /** Frame and cache figures, as the performance overlay shows them. */
  metrics(): Readonly<Record<string, number | string>>;
}
