/**
 * Frame instrumentation.
 *
 * Performance is measured continuously rather than tuned at the end: the
 * overlay is a Stage 1 deliverable, not a debugging afterthought.
 */

export interface FrameCounters {
  readonly visibleRows: number;
  readonly renderedRows: number;
  readonly visibleColumns: number;
  readonly quads: number;
  readonly glyphs: number;
  readonly textRuns: number;
  readonly placeholderCells: number;
  readonly tables: number;
  readonly connectors: number;
}

export interface FrameStats extends FrameCounters {
  readonly fps: number;
  /** Milliseconds of Panorama CPU work on the render thread. */
  readonly cpuMs: number;
  readonly averageCpuMs: number;
  readonly worstCpuMs: number;
  readonly frames: number;
  readonly drawCalls: number;
}

export const EMPTY_COUNTERS: FrameCounters = Object.freeze({
  visibleRows: 0,
  renderedRows: 0,
  visibleColumns: 0,
  quads: 0,
  glyphs: 0,
  textRuns: 0,
  placeholderCells: 0,
  tables: 0,
  connectors: 0,
});

export interface FrameStatsOptions {
  readonly clock?: () => number;
  /** Window over which FPS is averaged, in milliseconds. */
  readonly windowMs?: number;
}

export class FrameStatsCollector {
  readonly #clock: () => number;
  readonly #windowMs: number;
  #frameStart = 0;
  #counters: FrameCounters = EMPTY_COUNTERS;
  #cpuMs = 0;
  #averageCpuMs = 0;
  #worstCpuMs = 0;
  #frames = 0;
  #windowFrames = 0;
  #windowStart: number | null = null;
  #fps = 0;
  #drawCalls = 0;

  constructor(options: FrameStatsOptions = {}) {
    this.#clock = options.clock ?? ((): number => performance.now());
    this.#windowMs = options.windowMs ?? 500;
  }

  beginFrame(): void {
    this.#frameStart = this.#clock();
    if (this.#windowStart === null) this.#windowStart = this.#frameStart;
  }

  endFrame(counters: FrameCounters, drawCalls = 0): void {
    const now = this.#clock();
    this.#cpuMs = now - this.#frameStart;
    this.#averageCpuMs =
      this.#frames === 0 ? this.#cpuMs : this.#averageCpuMs * 0.9 + this.#cpuMs * 0.1;
    this.#worstCpuMs = Math.max(this.#worstCpuMs, this.#cpuMs);
    this.#counters = counters;
    this.#drawCalls = drawCalls;
    this.#frames += 1;
    this.#windowFrames += 1;

    const windowStart = this.#windowStart ?? now;
    const elapsed = now - windowStart;
    if (elapsed >= this.#windowMs) {
      this.#fps = (this.#windowFrames * 1_000) / elapsed;
      this.#windowFrames = 0;
      this.#windowStart = now;
    }
  }

  /** Forgets the worst-case sample, e.g. after a deliberate stall. */
  resetPeak(): void {
    this.#worstCpuMs = 0;
  }

  get stats(): FrameStats {
    return {
      ...this.#counters,
      fps: Math.round(this.#fps * 10) / 10,
      cpuMs: Math.round(this.#cpuMs * 100) / 100,
      averageCpuMs: Math.round(this.#averageCpuMs * 100) / 100,
      worstCpuMs: Math.round(this.#worstCpuMs * 100) / 100,
      frames: this.#frames,
      drawCalls: this.#drawCalls,
    };
  }
}
