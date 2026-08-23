import type { EntityId, TableEntity } from '@panorama/core';
import { PanoramaCore, buildTableEntity, isTableEntity } from '@panorama/core';
import type { ConnectionId, EntityActionId } from '@panorama/core';
import type { SchemaInfo, TableInfo, TableSchema } from '@panorama/table';
import { DEFAULT_BLOCK_SIZE } from '@panorama/table';
import type { TableViewModel, TableViewProvider } from '@panorama/renderer';
import type { InteractionHost, TableViewState } from '@panorama/renderer';
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
}

export interface OpenTableRequest {
  readonly schema: string;
  readonly table: string;
  readonly position?: { x: number; y: number };
  /** Supplied when the caller already knows the schema, skipping a round trip. */
  readonly knownSchema?: TableSchema;
}

const TABLE_GRID_STEP = 48;

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
      request.knownSchema ?? (await this.#client.describeTable(request.schema, request.table));
    const offset = this.#opened * TABLE_GRID_STEP;
    this.#opened += 1;
    const entity = buildTableEntity(this.core.ids, {
      source: {
        connectionId: this.#connectionId,
        schema: request.schema,
        table: request.table,
      },
      columns: schema.columns.map((column) => ({ name: column.name, type: column.type })),
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
      await view.open(request.schema, request.table);
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
