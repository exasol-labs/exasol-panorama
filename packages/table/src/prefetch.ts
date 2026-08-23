import { blockCountForRows, blocksForRows } from './blocks.js';

/**
 * Velocity-aware block prefetch.
 *
 * Scrolling down should pull blocks below the viewport in first; reversing
 * direction should re-prioritise immediately. No prediction beyond that is
 * warranted at this stage — measured behaviour first, cleverness later.
 */

export interface DesiredBlock {
  readonly index: number;
  /** 0 is highest. Blocks are fetched in ascending priority order. */
  readonly priority: number;
}

export const PRIORITY_VISIBLE = 0;

export interface PrefetchOptions {
  readonly firstVisibleRow: number;
  readonly visibleRowCount: number;
  /** Pixels per second; positive means scrolling towards later rows. */
  readonly velocityY: number;
  readonly blockSize: number;
  readonly rowCount: number | null;
  /** Blocks to pull in ahead of the viewport when moving. */
  readonly aheadBlocks?: number;
  /** Blocks to retain behind the viewport when moving. */
  readonly behindBlocks?: number;
  /** Below this speed the scroll counts as stationary and both sides are equal. */
  readonly idleVelocity?: number;
}

export const DEFAULT_AHEAD_BLOCKS = 3;
export const DEFAULT_BEHIND_BLOCKS = 1;
export const DEFAULT_IDLE_VELOCITY = 40;

/**
 * Returns the blocks worth having, most important first. Callers filter the
 * result against the cache; this function is pure and stateless so the policy
 * can be reasoned about and tested on its own.
 */
export const computeDesiredBlocks = (options: PrefetchOptions): readonly DesiredBlock[] => {
  const {
    firstVisibleRow,
    visibleRowCount,
    velocityY,
    blockSize,
    rowCount,
    aheadBlocks = DEFAULT_AHEAD_BLOCKS,
    behindBlocks = DEFAULT_BEHIND_BLOCKS,
    idleVelocity = DEFAULT_IDLE_VELOCITY,
  } = options;

  const totalBlocks = blockCountForRows(rowCount, blockSize);
  if (totalBlocks === 0) return [];

  const visible = blocksForRows(
    Math.max(0, firstVisibleRow),
    Math.max(1, visibleRowCount),
    blockSize,
  );
  const best = new Map<number, number>();

  const consider = (index: number, priority: number): void => {
    if (index < 0) return;
    if (totalBlocks !== null && index >= totalBlocks) return;
    const current = best.get(index);
    if (current === undefined || priority < current) best.set(index, priority);
  };

  for (let index = visible.first; index <= visible.last; index += 1) {
    consider(index, PRIORITY_VISIBLE);
  }

  const moving = Math.abs(velocityY) >= idleVelocity;
  const forward = velocityY >= 0;
  const ahead = moving ? aheadBlocks : Math.max(aheadBlocks, behindBlocks);
  const behind = moving ? behindBlocks : ahead;

  // Interleave so that the first block on each side is fetched before the
  // second on the leading side; a sudden reversal then costs one block, not
  // the whole prefetch depth.
  const depth = Math.max(ahead, behind);
  let priority = PRIORITY_VISIBLE;
  for (let step = 1; step <= depth; step += 1) {
    if (step <= ahead) {
      priority += 1;
      consider(forward ? visible.last + step : visible.first - step, priority);
    }
    if (step <= behind) {
      priority += 1;
      consider(forward ? visible.first - step : visible.last + step, priority);
    }
  }

  return [...best.entries()]
    .map(([index, blockPriority]) => ({ index, priority: blockPriority }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index);
};

export interface RetryPolicy {
  readonly maxAttempts?: number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
}

export const DEFAULT_RETRY_POLICY: Required<RetryPolicy> = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 250,
  maxDelayMs: 5_000,
});

/** Exponential backoff for a failed block; a fetch failure retries that block only. */
export const shouldRetryBlock = (
  attempts: number,
  failedAt: number,
  now: number,
  policy: RetryPolicy = {},
): boolean => {
  const { maxAttempts, baseDelayMs, maxDelayMs } = { ...DEFAULT_RETRY_POLICY, ...policy };
  if (attempts <= 0) return true;
  if (attempts >= maxAttempts) return false;
  const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempts - 1));
  return now - failedAt >= delay;
};
