/**
 * Document-level constraints applied by the command engine.
 *
 * Interactive drags clamp rather than fail: a user dragging a resize handle
 * past the minimum should stop at the minimum, not produce an error toast.
 */
export interface WorldConstraints {
  readonly minTableWidth: number;
  readonly minTableHeight: number;
  readonly maxTableWidth: number;
  readonly maxTableHeight: number;
  readonly minColumnWidth: number;
  readonly maxColumnWidth: number;
}

export const DEFAULT_CONSTRAINTS: WorldConstraints = Object.freeze({
  minTableWidth: 160,
  minTableHeight: 96,
  maxTableWidth: 100_000,
  maxTableHeight: 100_000,
  minColumnWidth: 24,
  maxColumnWidth: 4_000,
});
