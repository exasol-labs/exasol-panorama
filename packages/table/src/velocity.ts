/**
 * Scroll velocity, in pixels per second.
 *
 * The prefetch policy needs a stable sense of direction: raw per-event deltas
 * are far too noisy on trackpads, so samples are smoothed exponentially and
 * decay to zero when scrolling stops.
 */

export interface VelocityTrackerOptions {
  /** Smoothing time constant in milliseconds. */
  readonly timeConstantMs?: number;
  /** Samples older than this are treated as a fresh gesture. */
  readonly resetAfterMs?: number;
}

export class VelocityTracker {
  readonly #timeConstant: number;
  readonly #resetAfter: number;
  #velocity = 0;
  #lastSampleAt: number | null = null;

  constructor(options: VelocityTrackerOptions = {}) {
    this.#timeConstant = options.timeConstantMs ?? 80;
    this.#resetAfter = options.resetAfterMs ?? 200;
  }

  get velocity(): number {
    return this.#velocity;
  }

  /** Records a scroll delta in pixels observed at `timestampMs`. */
  sample(deltaPixels: number, timestampMs: number): number {
    const last = this.#lastSampleAt;
    this.#lastSampleAt = timestampMs;
    if (last === null || timestampMs - last > this.#resetAfter) {
      this.#velocity = 0;
      return 0;
    }
    const elapsed = Math.max(1, timestampMs - last);
    const instant = (deltaPixels / elapsed) * 1000;
    const alpha = 1 - Math.exp(-elapsed / this.#timeConstant);
    this.#velocity += (instant - this.#velocity) * alpha;
    return this.#velocity;
  }

  /** Decays the velocity toward zero when no scrolling happened this frame. */
  idle(timestampMs: number): number {
    const last = this.#lastSampleAt;
    if (last === null) return 0;
    const elapsed = timestampMs - last;
    if (elapsed > this.#resetAfter) {
      this.reset();
      return 0;
    }
    this.#velocity *= Math.exp(-Math.max(0, elapsed) / this.#timeConstant);
    return this.#velocity;
  }

  reset(): void {
    this.#velocity = 0;
    this.#lastSampleAt = null;
  }
}
