import type { EntityId } from '@panorama/core';
import type { CellValue, RetryPolicy, RowCacheStats, TableSchema } from '@panorama/table';
import {
  DEFAULT_BLOCK_SIZE,
  RowCache,
  blocksForRows,
  computeDesiredBlocks,
  shouldRetryBlock,
} from '@panorama/table';
import type { BlockFailure, RowsAvailable, TableDataGateway } from './client.js';

/**
 * The render-thread view of one table's data.
 *
 * Holds the bounded row cache and decides — with pure arithmetic — which
 * blocks are worth having. The expensive half (protocol, decoding, request
 * scheduling) lives in the worker; this side only ever does map lookups, so a
 * cell read during a frame is synchronous and free.
 */

export interface TableDataControllerOptions {
  readonly tableId: EntityId;
  readonly gateway: TableDataGateway;
  readonly blockSize?: number;
  readonly maxBytes?: number;
  readonly maxBlocks?: number;
  readonly aheadBlocks?: number;
  readonly behindBlocks?: number;
  readonly retry?: RetryPolicy;
  readonly clock?: () => number;
  /** Called when cached data changed and the table should be redrawn. */
  readonly onChange?: () => void;
  /** Deferred re-evaluation for retry backoff; injectable for tests. */
  readonly schedule?: (callback: () => void, delayMs: number) => void;
}

export interface TableViewportRequest {
  readonly firstVisibleRow: number;
  readonly visibleRowCount: number;
  readonly velocityY: number;
}

export interface TableDataStatus {
  readonly rowCount: number | null;
  readonly generation: number;
  readonly cache: RowCacheStats;
  readonly pendingBlocks: number;
  readonly lastError: BlockFailure['error'] | null;
}

const DEFAULT_RETRY_DELAY_MS = 250;

export class TableDataController {
  readonly tableId: EntityId;
  readonly #gateway: TableDataGateway;
  readonly #cache: RowCache;
  readonly #options: TableDataControllerOptions;
  readonly #clock: () => number;
  readonly #schedule: (callback: () => void, delayMs: number) => void;
  readonly #unsubscribe: Array<() => void> = [];
  #schema: TableSchema | null = null;
  #rowCount: number | null = null;
  #generation = 0;
  #viewport: TableViewportRequest = { firstVisibleRow: 0, visibleRowCount: 0, velocityY: 0 };
  #pendingBlocks = new Set<number>();
  #lastError: BlockFailure['error'] | null = null;
  #retryScheduled = false;
  #closed = false;

  constructor(options: TableDataControllerOptions) {
    this.#options = options;
    this.tableId = options.tableId;
    this.#gateway = options.gateway;
    this.#clock = options.clock ?? ((): number => Date.now());
    this.#schedule =
      options.schedule ??
      ((callback, delayMs): void => {
        setTimeout(callback, delayMs);
      });
    this.#cache = new RowCache({
      blockSize: options.blockSize ?? DEFAULT_BLOCK_SIZE,
      ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
      ...(options.maxBlocks === undefined ? {} : { maxBlocks: options.maxBlocks }),
      clock: this.#clock,
    });
    this.#unsubscribe.push(
      options.gateway.onRows((event) => {
        this.#onRows(event);
      }),
      options.gateway.onBlockFailed((event) => {
        this.#onBlockFailed(event);
      }),
    );
  }

  get schema(): TableSchema | null {
    return this.#schema;
  }

  get rowCount(): number | null {
    return this.#rowCount;
  }

  get generation(): number {
    return this.#generation;
  }

  get blockSize(): number {
    return this.#cache.blockSize;
  }

  async open(schema: string, table: string): Promise<TableSchema> {
    const result = await this.#gateway.openTable(this.tableId, schema, table);
    this.#schema = result.schema;
    this.#rowCount = result.rowCount;
    this.#generation = result.generation;
    this.#cache.clear();
    this.#pendingBlocks.clear();
    this.refresh();
    return result.schema;
  }

  /**
   * Opens a fresh result set after a reconnect. Everything cached is dropped:
   * positions in the new result set are not the same rows unless the query
   * carried an explicit ORDER BY.
   */
  async reopen(): Promise<TableSchema> {
    const result = await this.#gateway.reopenTable(this.tableId);
    this.#schema = result.schema;
    this.#rowCount = result.rowCount;
    this.#generation = result.generation;
    this.#cache.invalidate();
    this.#pendingBlocks.clear();
    this.#lastError = null;
    this.refresh();
    return result.schema;
  }

  /** Records the viewport and re-evaluates what is worth fetching. */
  setViewport(viewport: TableViewportRequest): void {
    this.#viewport = viewport;
    this.refresh();
  }

  refresh(): void {
    if (this.#closed || this.#schema === null) return;
    const blockSize = this.#cache.blockSize;
    const desired = computeDesiredBlocks({
      firstVisibleRow: this.#viewport.firstVisibleRow,
      visibleRowCount: this.#viewport.visibleRowCount,
      velocityY: this.#viewport.velocityY,
      blockSize,
      rowCount: this.#rowCount,
      ...(this.#options.aheadBlocks === undefined
        ? {}
        : { aheadBlocks: this.#options.aheadBlocks }),
      ...(this.#options.behindBlocks === undefined
        ? {}
        : { behindBlocks: this.#options.behindBlocks }),
    });

    const visible = blocksForRows(
      this.#viewport.firstVisibleRow,
      Math.max(1, this.#viewport.visibleRowCount),
      blockSize,
    );
    const visibleBlocks: number[] = [];
    for (let index = visible.first; index <= visible.last; index += 1) visibleBlocks.push(index);
    this.#cache.pin(visibleBlocks);
    this.#cache.touch(desired.map((block) => block.index));

    const now = this.#clock();
    let retryDelay = Number.POSITIVE_INFINITY;
    const wanted = desired.filter((block) => {
      if (this.#cache.has(block.index)) return false;
      if (this.#cache.stateOf(block.index) !== 'failed') return true;
      const attempts = this.#cache.attempts(block.index);
      if (shouldRetryBlock(attempts, this.#cache.failedAt(block.index), now, this.#options.retry)) {
        return true;
      }
      retryDelay = Math.min(retryDelay, DEFAULT_RETRY_DELAY_MS * 2 ** Math.max(0, attempts - 1));
      return false;
    });

    this.#pendingBlocks = new Set(wanted.map((block) => block.index));
    for (const block of wanted) this.#cache.markLoading(block.index);
    this.#gateway.requestBlocks(this.tableId, this.#generation, blockSize, wanted);

    if (retryDelay !== Number.POSITIVE_INFINITY) this.#scheduleRetry(retryDelay);
  }

  #scheduleRetry(delayMs: number): void {
    if (this.#retryScheduled) return;
    this.#retryScheduled = true;
    this.#schedule(() => {
      this.#retryScheduled = false;
      this.refresh();
    }, delayMs);
  }

  #onRows(event: RowsAvailable): void {
    if (event.tableId !== this.tableId || event.generation !== this.#generation) return;
    this.#cache.put(event.blockIndex, event.chunk);
    this.#pendingBlocks.delete(event.blockIndex);
    this.#options.onChange?.();
  }

  #onBlockFailed(event: BlockFailure): void {
    if (event.tableId !== this.tableId || event.generation !== this.#generation) return;
    this.#cache.markFailed(event.blockIndex, event.error);
    this.#pendingBlocks.delete(event.blockIndex);
    this.#lastError = event.error;
    this.refresh();
    this.#options.onChange?.();
  }

  /** Synchronous cell read; `undefined` means "draw a placeholder". */
  cell(row: number, columnIndex: number): CellValue | undefined {
    return this.#cache.cell(row, columnIndex);
  }

  /** True when every visible row is present, used by the loading indicator. */
  isRangeLoaded(firstRow: number, rowCount: number): boolean {
    if (rowCount <= 0) return true;
    const range = blocksForRows(firstRow, rowCount, this.#cache.blockSize);
    for (let index = range.first; index <= range.last; index += 1) {
      if (!this.#cache.has(index)) return false;
    }
    return true;
  }

  status(): TableDataStatus {
    return {
      rowCount: this.#rowCount,
      generation: this.#generation,
      cache: this.#cache.stats(),
      pendingBlocks: this.#pendingBlocks.size,
      lastError: this.#lastError,
    };
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const off of this.#unsubscribe) off();
    this.#cache.clear();
    await this.#gateway.closeTable(this.tableId);
  }
}
