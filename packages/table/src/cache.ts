import type { CellValue, ResultChunk } from './result-chunk.js';
import { cellValue } from './result-chunk.js';
import { DEFAULT_BLOCK_SIZE, blockIndexForRow, blockStartRow } from './blocks.js';

/**
 * Block-based LRU row cache.
 *
 * Client memory must depend on the visible window plus a bounded cache, never
 * on the size of the relation: a 10-billion-row table and a 1-million-row
 * table of the same width cost the same here. Limits are therefore primarily
 * byte-based, with a block count as a secondary guard for very narrow rows.
 */

export type BlockState = 'loading' | 'loaded' | 'failed';

export interface BlockError {
  readonly code: string;
  readonly message: string;
}

interface BlockRecord {
  readonly index: number;
  state: BlockState;
  chunk: ResultChunk | null;
  bytes: number;
  lastAccess: number;
  error: BlockError | null;
  failedAt: number;
  attempts: number;
  /** Generation of the result set this block belongs to. */
  generation: number;
}

export interface BlockSnapshot {
  readonly index: number;
  readonly state: BlockState;
  readonly bytes: number;
  readonly lastAccess: number;
  readonly error: BlockError | null;
  readonly attempts: number;
}

export interface RowCacheStats {
  readonly loadedBlocks: number;
  readonly loadingBlocks: number;
  readonly failedBlocks: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly evictions: number;
}

export interface RowCacheOptions {
  readonly blockSize?: number;
  /** Soft ceiling on retained chunk bytes. */
  readonly maxBytes?: number;
  /** Secondary ceiling for very narrow rows, where bytes stay small. */
  readonly maxBlocks?: number;
  readonly clock?: () => number;
}

export const DEFAULT_MAX_CACHE_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_BLOCKS = 512;

export class RowCache {
  readonly #blockSize: number;
  readonly #maxBytes: number;
  readonly #maxBlocks: number;
  readonly #clock: () => number;
  readonly #blocks = new Map<number, BlockRecord>();
  readonly #pinned = new Set<number>();
  #bytes = 0;
  #evictions = 0;
  #generation = 0;

  constructor(options: RowCacheOptions = {}) {
    this.#blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_CACHE_BYTES;
    this.#maxBlocks = options.maxBlocks ?? DEFAULT_MAX_BLOCKS;
    this.#clock = options.clock ?? ((): number => Date.now());
  }

  get blockSize(): number {
    return this.#blockSize;
  }

  get bytes(): number {
    return this.#bytes;
  }

  get generation(): number {
    return this.#generation;
  }

  /**
   * Invalidates every block and advances the generation. Called when a result
   * set is reopened: row positions in the new result set are not guaranteed to
   * match the old one, so nothing may survive.
   */
  invalidate(): number {
    this.#blocks.clear();
    this.#pinned.clear();
    this.#bytes = 0;
    this.#generation += 1;
    return this.#generation;
  }

  clear(): void {
    this.#blocks.clear();
    this.#pinned.clear();
    this.#bytes = 0;
  }

  stateOf(blockIndex: number): BlockState | 'absent' {
    return this.#blocks.get(blockIndex)?.state ?? 'absent';
  }

  snapshot(blockIndex: number): BlockSnapshot | undefined {
    const record = this.#blocks.get(blockIndex);
    if (record === undefined) return undefined;
    return {
      index: record.index,
      state: record.state,
      bytes: record.bytes,
      lastAccess: record.lastAccess,
      error: record.error,
      attempts: record.attempts,
    };
  }

  has(blockIndex: number): boolean {
    return this.#blocks.get(blockIndex)?.state === 'loaded';
  }

  chunk(blockIndex: number): ResultChunk | null {
    const record = this.#blocks.get(blockIndex);
    if (record === undefined || record.state !== 'loaded') return null;
    return record.chunk;
  }

  #record(blockIndex: number): BlockRecord {
    const existing = this.#blocks.get(blockIndex);
    if (existing !== undefined) return existing;
    const created: BlockRecord = {
      index: blockIndex,
      state: 'loading',
      chunk: null,
      bytes: 0,
      lastAccess: this.#clock(),
      error: null,
      failedAt: 0,
      attempts: 0,
      generation: this.#generation,
    };
    this.#blocks.set(blockIndex, created);
    return created;
  }

  markLoading(blockIndex: number): void {
    const record = this.#record(blockIndex);
    if (record.state === 'loaded') return;
    record.state = 'loading';
    record.error = null;
    record.lastAccess = this.#clock();
  }

  markFailed(blockIndex: number, error: BlockError): void {
    const record = this.#record(blockIndex);
    record.state = 'failed';
    record.error = error;
    record.failedAt = this.#clock();
    record.attempts += 1;
    this.#releaseChunk(record);
  }

  /** Number of failed attempts, used by the scheduler's backoff. */
  attempts(blockIndex: number): number {
    return this.#blocks.get(blockIndex)?.attempts ?? 0;
  }

  failedAt(blockIndex: number): number {
    return this.#blocks.get(blockIndex)?.failedAt ?? 0;
  }

  /** Stores a loaded block and evicts until the cache is back within budget. */
  put(blockIndex: number, chunk: ResultChunk): void {
    const record = this.#record(blockIndex);
    this.#releaseChunk(record);
    record.state = 'loaded';
    record.chunk = chunk;
    record.bytes = chunk.byteSize;
    record.error = null;
    record.attempts = 0;
    record.lastAccess = this.#clock();
    record.generation = this.#generation;
    this.#bytes += chunk.byteSize;
    this.#evict();
  }

  delete(blockIndex: number): boolean {
    const record = this.#blocks.get(blockIndex);
    if (record === undefined) return false;
    this.#releaseChunk(record);
    this.#blocks.delete(blockIndex);
    this.#pinned.delete(blockIndex);
    return true;
  }

  #releaseChunk(record: BlockRecord): void {
    if (record.chunk === null) return;
    this.#bytes -= record.bytes;
    record.chunk = null;
    record.bytes = 0;
  }

  /** Marks blocks as recently used; called once per frame, not once per cell. */
  touch(blockIndices: Iterable<number>): void {
    const now = this.#clock();
    for (const index of blockIndices) {
      const record = this.#blocks.get(index);
      if (record !== undefined) record.lastAccess = now;
    }
  }

  /** Blocks that must never be evicted — typically the visible range. */
  pin(blockIndices: Iterable<number>): void {
    this.#pinned.clear();
    for (const index of blockIndices) this.#pinned.add(index);
  }

  #evict(): void {
    const loaded = (): BlockRecord[] =>
      [...this.#blocks.values()].filter(
        (record) => record.state === 'loaded' && !this.#pinned.has(record.index),
      );
    while (this.#overBudget()) {
      const candidates = loaded();
      if (candidates.length === 0) return;
      let victim = candidates[0] as BlockRecord;
      for (const candidate of candidates) {
        if (candidate.lastAccess < victim.lastAccess) victim = candidate;
      }
      this.delete(victim.index);
      this.#evictions += 1;
    }
  }

  #overBudget(): boolean {
    if (this.#bytes > this.#maxBytes) return true;
    let loadedCount = 0;
    for (const record of this.#blocks.values()) {
      if (record.state === 'loaded') loadedCount += 1;
    }
    return loadedCount > this.#maxBlocks;
  }

  /**
   * Reads one cell by absolute result position. Returns `undefined` when the
   * containing block is not loaded — the renderer draws a placeholder rather
   * than waiting.
   */
  cell(row: number, columnIndex: number): CellValue | undefined {
    if (row < 0) return undefined;
    const record = this.#blocks.get(blockIndexForRow(row, this.#blockSize));
    if (record?.state !== 'loaded' || record.chunk === null) return undefined;
    const offset = row - record.chunk.startRow;
    if (offset < 0 || offset >= record.chunk.rowCount) return undefined;
    const vector = record.chunk.columns[columnIndex];
    if (vector === undefined) return undefined;
    return cellValue(vector, offset);
  }

  /** First row of a block, for building fetch requests. */
  startRowOf(blockIndex: number): number {
    return blockStartRow(blockIndex, this.#blockSize);
  }

  stats(): RowCacheStats {
    let loadedBlocks = 0;
    let loadingBlocks = 0;
    let failedBlocks = 0;
    for (const record of this.#blocks.values()) {
      if (record.state === 'loaded') loadedBlocks += 1;
      else if (record.state === 'loading') loadingBlocks += 1;
      else failedBlocks += 1;
    }
    return {
      loadedBlocks,
      loadingBlocks,
      failedBlocks,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
      evictions: this.#evictions,
    };
  }
}
