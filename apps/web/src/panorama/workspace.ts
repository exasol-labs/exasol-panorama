import type { EntityId, TableEntity } from '@panorama/core';
import type { Binding, BindingId } from '@panorama/core';
import {
  AUTO_ANCHOR,
  PanoramaCore,
  buildTableEntity,
  findColumn,
  isTableEntity,
} from '@panorama/core';
import type { ConnectionId, EntityActionId } from '@panorama/core';
import type { CellValue, RowFilter, SchemaInfo, TableInfo, TableSchema } from '@panorama/table';
import { DEFAULT_BLOCK_SIZE, formatCell } from '@panorama/table';
import type { TableViewModel, TableViewProvider } from '@panorama/renderer';
import type { ForeignKeyFollow, InteractionHost, TableViewState } from '@panorama/renderer';
import type { ExasolCredentials } from '@panorama/exasol';
import type { DataWorkerClient } from '@panorama/worker';
import { TableView } from './table-view.js';

/**
 * The composition root on the render thread.
 *
 * Owns Panorama Core and one `TableView` per open table, and satisfies the
 * two interfaces the renderer and the interaction controller depend on. It is
 * the only place that knows both halves exist.
 */

export interface WorkspaceOptions {
  readonly client: DataWorkerClient;
  readonly core?: PanoramaCore;
  readonly connectionId?: ConnectionId;
  readonly blockSize?: number;
  readonly maxBytes?: number;
  readonly clock?: () => number;
  /** Called when cached data changed and a redraw is worthwhile. */
  readonly onDataChanged?: () => void;
  /**
   * Supplies a schema without asking the database. The built-in demo relations
   * use this, so following one of their foreign keys works with no connection.
   */
  readonly resolveSchema?: (schema: string, table: string) => TableSchema | undefined;
}

export interface OpenTableRequest {
  readonly schema: string;
  readonly table: string;
  readonly position?: { x: number; y: number };
  /** Supplied when the caller already knows the schema, skipping a round trip. */
  readonly knownSchema?: TableSchema;
  /** Restricts the result set; set when following a foreign key. */
  readonly filter?: RowFilter;
}

/** The result of following a foreign key: the new table and the line to it. */
export interface FollowedForeignKey {
  readonly tableId: EntityId;
  readonly bindingId: BindingId;
}

const TABLE_GRID_STEP = 48;

/**
 * Gap between a table and the one opened by following a key from it. Wide
 * enough that the connector — and its label — are legible between them.
 */
const LINKED_TABLE_GAP = 220;

/** A followed table is sized to its rows, within these bounds. */
const MIN_LINKED_ROWS = 3;
const MAX_LINKED_ROWS = 22;

/** Target cells per block, so a very wide table does not fetch huge blocks. */
const TARGET_CELLS_PER_BLOCK = 65_536;
const MIN_BLOCK_SIZE = 32;

/**
 * Rows per block for a given row width. A four-column table gets the default
 * 256; a five-thousand-column one gets 32, keeping a single block — which is
 * pinned while visible — to a predictable size.
 */
export const blockSizeForColumns = (columnCount: number, maximum: number): number => {
  if (columnCount <= 0) return maximum;
  const rows = Math.floor(TARGET_CELLS_PER_BLOCK / columnCount);
  return Math.max(MIN_BLOCK_SIZE, Math.min(maximum, rows));
};

export class Workspace implements TableViewProvider, InteractionHost {
  readonly core: PanoramaCore;
  readonly #client: DataWorkerClient;
  readonly #views = new Map<EntityId, TableView>();
  readonly #options: WorkspaceOptions;
  readonly #clock: () => number;
  #connectionId: ConnectionId;
  #opened = 0;

  constructor(options: WorkspaceOptions) {
    this.#options = options;
    this.#client = options.client;
    this.core = options.core ?? new PanoramaCore();
    this.#clock = options.clock ?? ((): number => performance.now());
    this.#connectionId = options.connectionId ?? ('connection:pending' as ConnectionId);
  }

  get connectionId(): ConnectionId {
    return this.#connectionId;
  }

  set connectionId(value: ConnectionId) {
    this.#connectionId = value;
  }

  get openTableCount(): number {
    return this.#views.size;
  }

  viewOfTable(tableId: EntityId): TableView | undefined {
    return this.#views.get(tableId);
  }

  /**
   * Opens the database connection. Credentials pass straight through to the
   * data worker and are never retained here.
   */
  async connect(request: {
    url: string;
    credentials: ExasolCredentials;
  }): Promise<{ connectionId: string }> {
    const result = await this.#client.connect(request.url, request.credentials);
    this.#connectionId = result.connectionId as ConnectionId;
    return result;
  }

  async disconnect(): Promise<void> {
    await this.#client.disconnect();
  }

  listSchemas(): Promise<readonly SchemaInfo[]> {
    return this.#client.listSchemas();
  }

  listTables(schema: string): Promise<readonly TableInfo[]> {
    return this.#client.listTables(schema);
  }

  /**
   * Opens a table: describe it, create the entity, then open the result set.
   * The entity appears immediately; rows arrive when they arrive.
   */
  async openTable(request: OpenTableRequest): Promise<EntityId> {
    // `describeTable` runs the same `SELECT *` projection the result set will,
    // so the entity's columns always line up with the fetched chunks.
    const schema =
      request.knownSchema ??
      this.#options.resolveSchema?.(request.schema, request.table) ??
      (await this.#client.describeTable(request.schema, request.table));
    const offset = this.#opened * TABLE_GRID_STEP;
    this.#opened += 1;
    const entity = buildTableEntity(this.core.ids, {
      source: {
        connectionId: this.#connectionId,
        schema: request.schema,
        table: request.table,
      },
      columns: schema.columns.map((column) => ({
        name: column.name,
        type: column.type,
        // Carried onto the entity so its cells render as links and can be
        // followed without consulting the schema again.
        ...(column.foreignKey === undefined ? {} : { foreignKey: column.foreignKey }),
      })),
      position:
        request.position === undefined
          ? { x: offset, y: offset, z: 0 }
          : { ...request.position, z: 0 },
    });

    const created = this.core.dispatch({ type: 'CreateTableEntity', entity });
    if (!created.ok) throw new Error(created.error.message);

    const view = new TableView({
      tableId: entity.id,
      gateway: this.#client,
      blockSize: blockSizeForColumns(
        schema.columns.length,
        this.#options.blockSize ?? DEFAULT_BLOCK_SIZE,
      ),
      ...(this.#options.maxBytes === undefined ? {} : { maxBytes: this.#options.maxBytes }),
      ...(this.#options.onDataChanged === undefined
        ? {}
        : { onChange: this.#options.onDataChanged }),
    });
    this.#views.set(entity.id, view);

    try {
      await view.open(request.schema, request.table, request.filter);
    } catch (error) {
      // The table stays on the canvas showing its chrome; only its body failed.
      this.#views.delete(entity.id);
      await view.close().catch(() => undefined);
      throw error;
    }
    this.core.dispatchSession({ type: 'SetSelection', ids: [entity.id] });
    return entity.id;
  }

  /**
   * Closes a table: releases its result set and removes the entity. Session
   * references are cleared too, so nothing keeps pointing at a table that is
   * gone.
   */
  async closeTable(tableId: EntityId): Promise<void> {
    const view = this.#views.get(tableId);
    this.#views.delete(tableId);
    if (view !== undefined) await view.close();
    if (this.core.world.entities.has(tableId)) {
      this.core.dispatch({ type: 'RemoveEntities', ids: [tableId] });
    }

    const session = this.core.session;
    if (session.hovered === tableId) {
      this.core.dispatchSession({ type: 'SetHovered', id: null });
    }
    if (session.selection.includes(tableId)) {
      this.core.dispatchSession({
        type: 'SetSelection',
        ids: session.selection.filter((id) => id !== tableId),
      });
    }
    if (session.hoveredAction?.entityId === tableId) {
      this.core.dispatchSession({ type: 'SetHoveredAction', target: null });
    }
    if (session.pressedAction?.entityId === tableId) {
      this.core.dispatchSession({ type: 'SetPressedAction', target: null });
    }
  }

  /**
   * Follows a foreign key: opens the referenced table showing only the matching
   * rows, and binds it to the table the click came from.
   *
   * The binding is what makes the pair stay connected afterwards — the line
   * re-routes itself as either table is moved or resized, because its geometry
   * is derived rather than stored.
   */
  async followForeignKey(follow: ForeignKeyFollow): Promise<FollowedForeignKey> {
    const source = this.core.world.entities.get(follow.tableId);
    if (source === undefined || !isTableEntity(source)) {
      throw new Error(`No table with id ${follow.tableId}`);
    }
    const column = findColumn(source, follow.columnId);
    if (column === undefined) throw new Error(`No column with id ${follow.columnId}`);

    const { reference } = follow;
    const filter: RowFilter = {
      column: reference.column,
      value: follow.value,
      type: column.sourceColumn.type,
    };

    // Placed beside the source rather than on the default stagger, so the line
    // between them is short and obviously a relationship.
    const position = {
      x: source.transform.x + source.transform.width + LINKED_TABLE_GAP,
      y: source.transform.y,
    };
    const tableId = await this.openTable({
      schema: reference.schema,
      table: reference.table,
      position,
      filter,
    });

    const binding: Binding = {
      id: this.core.ids.binding(),
      kind: 'connector',
      fromId: follow.tableId,
      toId: tableId,
      from: AUTO_ANCHOR,
      to: AUTO_ANCHOR,
      directed: true,
      label: `${follow.sourceColumn} = ${formatCell(follow.value, column.sourceColumn.type)}`,
      meta: {
        kind: 'foreign-key',
        column: follow.sourceColumn,
        referencedSchema: reference.schema,
        referencedTable: reference.table,
        referencedColumn: reference.column,
        constraint: reference.constraint,
      },
    };
    const created = this.core.dispatch({ type: 'CreateBinding', binding });
    if (!created.ok) throw new Error(created.error.message);

    this.#fitToRows(tableId);
    return { tableId, bindingId: binding.id };
  }

  /**
   * Shrinks a freshly followed table to the rows it actually has. A key that
   * matches one row should not open a window onto twenty empty ones.
   */
  #fitToRows(tableId: EntityId): void {
    const entity = this.core.world.entities.get(tableId);
    const rowCount = this.#views.get(tableId)?.rowCount;
    if (
      entity === undefined ||
      !isTableEntity(entity) ||
      rowCount === null ||
      rowCount === undefined
    ) {
      return;
    }
    const rows = Math.min(MAX_LINKED_ROWS, Math.max(MIN_LINKED_ROWS, rowCount));
    const height = entity.view.headerHeight + rows * entity.view.rowHeight;
    if (height >= entity.transform.height) return;
    this.core.dispatch({
      type: 'ResizeEntity',
      id: tableId,
      width: entity.transform.width,
      height,
    });
  }

  /** Performs a halo action reported by the interaction controller. */
  async performAction(tableId: EntityId, action: EntityActionId): Promise<void> {
    if (action === 'close') await this.closeTable(tableId);
  }

  /** Reopens every result set after a reconnect. */
  async reopenAll(): Promise<void> {
    await Promise.all([...this.#views.values()].map(async (view) => view.reopen()));
  }

  async closeAll(): Promise<void> {
    const ids = [...this.#views.keys()];
    for (const id of ids) await this.closeTable(id);
  }

  /** Advances every open table by one frame. */
  update(deltaMs: number): void {
    const now = this.#clock();
    for (const [tableId, view] of this.#views) {
      const entity = this.core.world.entities.get(tableId);
      if (entity === undefined || !isTableEntity(entity)) continue;
      view.update(entity, deltaMs, now);
    }
  }

  // --- TableViewProvider -------------------------------------------------

  viewFor(entity: TableEntity): TableViewModel | null {
    const view = this.#views.get(entity.id);
    if (view === undefined) return null;
    return {
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
      rowCount: view.rowCount,
      data: { cell: (row, column): ReturnType<TableView['cell']> => view.cell(row, column) },
    };
  }

  // --- InteractionHost ---------------------------------------------------

  viewOf(tableId: EntityId): TableViewState | null {
    const view = this.#views.get(tableId);
    if (view === undefined) return null;
    const entity = this.core.world.entities.get(tableId);
    return {
      // Hit testing can happen before the first frame, so the layout is
      // refreshed here rather than only during `update`.
      layout: entity === undefined ? view.layout : view.layoutFor(entity),
      scrollTop: view.scrollTop,
      scrollLeft: view.scrollLeft,
      rowCount: view.rowCount,
    };
  }

  cellAt(tableId: EntityId, row: number, columnIndex: number): CellValue | undefined {
    return this.#views.get(tableId)?.cell(row, columnIndex);
  }

  scrollBy(tableId: EntityId, deltaX: number, deltaY: number): void {
    this.#views.get(tableId)?.scrollBy(deltaX, deltaY, this.#clock());
  }

  scrollToFraction(tableId: EntityId, axis: 'vertical' | 'horizontal', fraction: number): void {
    const view = this.#views.get(tableId);
    const entity = this.core.world.entities.get(tableId);
    if (view === undefined || entity === undefined || !isTableEntity(entity)) return;
    view.scrollToFraction(axis, fraction, entity);
  }

  /** Aggregated data-side metrics for the performance overlay. */
  dataMetrics(): {
    cacheBlocks: number;
    cacheBytes: number;
    cacheEvictions: number;
    fetchesPending: number;
  } {
    let cacheBlocks = 0;
    let cacheBytes = 0;
    let cacheEvictions = 0;
    let fetchesPending = 0;
    for (const view of this.#views.values()) {
      const status = view.controller.status();
      cacheBlocks += status.cache.loadedBlocks;
      cacheBytes += status.cache.bytes;
      cacheEvictions += status.cache.evictions;
      fetchesPending += status.pendingBlocks;
    }
    return { cacheBlocks, cacheBytes, cacheEvictions, fetchesPending };
  }
}
