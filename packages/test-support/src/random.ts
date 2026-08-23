/**
 * Deterministic pseudo-randomness.
 *
 * Every mock in this package is reproducible: a failing interaction or cache
 * test must be replayable, so nothing here calls `Math.random`.
 */
export const seededRandom = (seed = 1): (() => number) => {
  let state = seed >>> 0 || 0x9e37_79b9;
  return (): number => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};
