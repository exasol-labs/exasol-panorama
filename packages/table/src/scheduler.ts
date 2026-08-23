import type { DesiredBlock } from './prefetch.js';
import type { ResultChunk } from './result-chunk.js';

/**
 * Fetch scheduler.
 *
 * The table widget never issues database requests itself. It states which
 * blocks it wants; the scheduler decides what to run, in which order, and how
 * many at a time. That is what keeps a fling from queueing hundreds of
 * requests for blocks the user has already scrolled past.
 */

export interface FetchSchedulerOptions {
  /** Bounded concurrency per result set; Exasol fetches are serialised anyway. */
  readonly maxConcurrent?: number;
  readonly execute: (blockIndex: number, signal: AbortSignal) => Promise<ResultChunk>;
  readonly onLoaded: (blockIndex: number, chunk: ResultChunk) => void;
  readonly onFailed: (blockIndex: number, error: unknown) => void;
  /** Consulted immediately before scheduling; the owner filters cached blocks. */
  readonly shouldFetch?: (blockIndex: number) => boolean;
  readonly onStarted?: (blockIndex: number) => void;
  readonly clock?: () => number;
}

export interface FetchSchedulerStats {
  readonly queued: number;
  readonly inFlight: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly lastLatencyMs: number;
  readonly averageLatencyMs: number;
}

interface InFlight {
  readonly controller: AbortController;
  readonly generation: number;
  readonly startedAt: number;
}

export const DEFAULT_MAX_CONCURRENT_FETCHES = 3;

export class FetchScheduler {
  readonly #options: FetchSchedulerOptions;
  readonly #maxConcurrent: number;
  readonly #clock: () => number;
  readonly #inFlight = new Map<number, InFlight>();
  #queue: DesiredBlock[] = [];
  #generation = 0;
  #completed = 0;
  #failed = 0;
  #cancelled = 0;
  #lastLatency = 0;
  #averageLatency = 0;
  #disposed = false;

  constructor(options: FetchSchedulerOptions) {
    this.#options = options;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT_FETCHES;
    this.#clock = options.clock ?? ((): number => Date.now());
  }

  get generation(): number {
    return this.#generation;
  }

  get inFlightCount(): number {
    return this.#inFlight.size;
  }

  get queuedCount(): number {
    return this.#queue.length;
  }

  /**
   * Replaces the wanted set. Requests already in flight for blocks that are no
   * longer wanted are aborted; queued duplicates are collapsed.
   */
  setDesired(blocks: readonly DesiredBlock[]): void {
    if (this.#disposed) return;
    const wanted = new Map<number, number>();
    for (const block of blocks) {
      const existing = wanted.get(block.index);
      if (existing === undefined || block.priority < existing) {
        wanted.set(block.index, block.priority);
      }
    }

    for (const [index, entry] of this.#inFlight) {
      if (!wanted.has(index)) {
        entry.controller.abort();
        this.#inFlight.delete(index);
        this.#cancelled += 1;
      }
    }

    this.#queue = [...wanted.entries()]
      .filter(([index]) => !this.#inFlight.has(index))
      .map(([index, priority]) => ({ index, priority }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index);

    this.pump();
  }

  /** Starts as many queued fetches as the concurrency budget allows. */
  pump(): void {
    if (this.#disposed) return;
    while (this.#inFlight.size < this.#maxConcurrent) {
      const next = this.#queue.shift();
      if (next === undefined) return;
      if (this.#options.shouldFetch?.(next.index) === false) continue;
      this.#start(next.index);
    }
  }

  #start(blockIndex: number): void {
    const controller = new AbortController();
    const generation = this.#generation;
    const startedAt = this.#clock();
    this.#inFlight.set(blockIndex, { controller, generation, startedAt });
    this.#options.onStarted?.(blockIndex);

    this.#options.execute(blockIndex, controller.signal).then(
      (chunk) => this.#settle(blockIndex, generation, startedAt, chunk, null),
      (error: unknown) => this.#settle(blockIndex, generation, startedAt, null, error),
    );
  }

  #settle(
    blockIndex: number,
    generation: number,
    startedAt: number,
    chunk: ResultChunk | null,
    error: unknown,
  ): void {
    const entry = this.#inFlight.get(blockIndex);
    // Drop responses for aborted, superseded or post-dispose requests: the
    // result set they belong to may no longer exist.
    const stale = this.#disposed || generation !== this.#generation || entry === undefined;
    if (entry !== undefined && entry.generation === generation) this.#inFlight.delete(blockIndex);
    if (stale) return;

    const latency = this.#clock() - startedAt;
    this.#lastLatency = latency;
    this.#averageLatency =
      this.#averageLatency === 0 ? latency : this.#averageLatency * 0.8 + latency * 0.2;

    if (chunk !== null) {
      this.#completed += 1;
      this.#options.onLoaded(blockIndex, chunk);
    } else {
      this.#failed += 1;
      this.#options.onFailed(blockIndex, error);
    }
    this.pump();
  }

  /**
   * Abandons everything and advances the generation so that responses already
   * in flight are ignored. Used when a result set is reopened.
   */
  invalidate(): number {
    this.#generation += 1;
    for (const entry of this.#inFlight.values()) entry.controller.abort();
    this.#cancelled += this.#inFlight.size;
    this.#inFlight.clear();
    this.#queue = [];
    return this.#generation;
  }

  dispose(): void {
    this.invalidate();
    this.#disposed = true;
  }

  stats(): FetchSchedulerStats {
    return {
      queued: this.#queue.length,
      inFlight: this.#inFlight.size,
      completed: this.#completed,
      failed: this.#failed,
      cancelled: this.#cancelled,
      lastLatencyMs: this.#lastLatency,
      averageLatencyMs: Math.round(this.#averageLatency),
    };
  }
}
