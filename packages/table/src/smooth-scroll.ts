import { clamp } from '@panorama/core';

/**
 * Frame-rate independent scroll smoothing.
 *
 * A mouse wheel delivers large discrete steps; a trackpad delivers a dense
 * stream of small ones. Easing towards a target makes wheel scrolling feel
 * continuous without adding perceptible lag to trackpad gestures — and, because
 * the easing is time-based rather than per-frame, it behaves identically at
 * 60 Hz and 120 Hz.
 */

export interface SmoothScrollOptions {
  /** Time constant in milliseconds; smaller is snappier. */
  readonly timeConstantMs?: number;
  /** Distance below which the animation snaps to the target. */
  readonly epsilon?: number;
  readonly initial?: number;
}

export class SmoothScroll {
  readonly #timeConstant: number;
  readonly #epsilon: number;
  #current: number;
  #target: number;
  #min = 0;
  #max = Number.POSITIVE_INFINITY;

  constructor(options: SmoothScrollOptions = {}) {
    this.#timeConstant = options.timeConstantMs ?? 55;
    this.#epsilon = options.epsilon ?? 0.35;
    this.#current = options.initial ?? 0;
    this.#target = this.#current;
  }

  get current(): number {
    return this.#current;
  }

  get target(): number {
    return this.#target;
  }

  get settled(): boolean {
    return this.#current === this.#target;
  }

  setBounds(min: number, max: number): void {
    this.#min = min;
    this.#max = Math.max(min, max);
    this.#target = clamp(this.#target, this.#min, this.#max);
    this.#current = clamp(this.#current, this.#min, this.#max);
  }

  /** Jumps immediately, cancelling any in-flight easing. */
  jumpTo(value: number): void {
    this.#target = clamp(value, this.#min, this.#max);
    this.#current = this.#target;
  }

  scrollTo(value: number): void {
    this.#target = clamp(value, this.#min, this.#max);
  }

  scrollBy(delta: number): void {
    this.scrollTo(this.#target + delta);
  }

  /** Advances the animation by `deltaMs` and returns the new position. */
  update(deltaMs: number): number {
    if (this.#current === this.#target) return this.#current;
    if (deltaMs <= 0) return this.#current;
    const alpha = 1 - Math.exp(-deltaMs / this.#timeConstant);
    const next = this.#current + (this.#target - this.#current) * alpha;
    this.#current = Math.abs(this.#target - next) <= this.#epsilon ? this.#target : next;
    return this.#current;
  }
}
