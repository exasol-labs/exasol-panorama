/**
 * Row blocks.
 *
 * The cache, the scheduler and the worker protocol all speak in fixed-size row
 * blocks rather than individual rows, which bounds request counts and makes
 * eviction decisions cheap. The size is a tuneable constant, never baked into
 * an API signature.
 */

export const DEFAULT_BLOCK_SIZE = 256;

export interface BlockRange {
  /** Index of the first block, inclusive. */
  readonly first: number;
  /** Index of the last block, inclusive. */
  readonly last: number;
}

export const blockIndexForRow = (row: number, blockSize: number): number =>
  Math.floor(row / blockSize);

export const blockStartRow = (blockIndex: number, blockSize: number): number =>
  blockIndex * blockSize;

/**
 * Rows contained in a block, honouring the end of the result set.
 * Returns 0 for blocks entirely past the end.
 */
export const blockRowCount = (
  blockIndex: number,
  blockSize: number,
  totalRows: number | null,
): number => {
  if (totalRows === null) return blockSize;
  const start = blockStartRow(blockIndex, blockSize);
  if (start >= totalRows) return 0;
  return Math.min(blockSize, totalRows - start);
};

/** The inclusive block range covering `[firstRow, firstRow + rowCount)`. */
export const blocksForRows = (
  firstRow: number,
  rowCount: number,
  blockSize: number,
): BlockRange => {
  const start = Math.max(0, firstRow);
  const end = Math.max(start, firstRow + rowCount);
  return {
    first: blockIndexForRow(start, blockSize),
    last: blockIndexForRow(Math.max(start, end - 1), blockSize),
  };
};

/** Total number of blocks needed for `totalRows`, or `null` when unknown. */
export const blockCountForRows = (totalRows: number | null, blockSize: number): number | null =>
  totalRows === null ? null : Math.ceil(totalRows / blockSize);

export const clampBlockIndex = (
  blockIndex: number,
  totalRows: number | null,
  blockSize: number,
): number => {
  if (blockIndex < 0) return 0;
  const count = blockCountForRows(totalRows, blockSize);
  if (count === null) return blockIndex;
  return Math.min(blockIndex, Math.max(0, count - 1));
};
