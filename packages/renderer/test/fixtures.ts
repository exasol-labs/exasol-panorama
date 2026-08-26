import type { ConnectionId, IdFactory, TableEntity, TableEntitySpec } from '@panorama/core';
import { buildTableEntity, createIdFactory, dataType } from '@panorama/core';
import type { CellValue } from '@panorama/table';
import type { GlyphMetrics, GlyphRasterizer, TableDataView } from '@panorama/renderer';

export const testIds = (seed = 1): IdFactory => {
  let time = 1_700_000_000_000;
  let state = seed >>> 0 || 1;
  return createIdFactory({
    now: (): number => (time += 1),
    random: (): number => {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  });
};

export const TEST_CONNECTION = 'connection:TEST' as ConnectionId;

export const sampleColumns = [
  { name: 'ORDER_ID', type: dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 }) },
  { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
  { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }) },
];

export const makeTable = (
  ids: IdFactory = testIds(),
  overrides: Partial<TableEntitySpec> = {},
): TableEntity =>
  buildTableEntity(ids, {
    source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'SALES', table: 'ORDERS' },
    columns: sampleColumns,
    size: { width: 600, height: 400 },
    ...overrides,
  });

/** Data view backed by a deterministic generator; `holes` read as unloaded. */
export const dataView = (options: { holes?: (row: number) => boolean } = {}): TableDataView => ({
  cell: (row: number, column: number): CellValue | undefined => {
    if (options.holes?.(row) === true) return undefined;
    if (column === 0) return row;
    if (column === 1) return row % 7 === 0 ? null : `country-${row % 5}`;
    return row * 1.5;
  },
});

/**
 * Fixed-metric rasterizer: no canvas, fully deterministic glyph geometry.
 *
 * `pixelRatio` mirrors the real rasterizer, which scales the font by the
 * device pixel ratio and therefore reports proportionally larger metrics.
 */
export const testRasterizer = (
  pixelRatio = 1,
): GlyphRasterizer & { drawn: string[]; cleared: number } => {
  const drawn: string[] = [];
  const state = { cleared: 0 };
  return {
    drawn,
    get cleared(): number {
      return state.cleared;
    },
    measure: (key): GlyphMetrics => {
      const size = key.fontSize * pixelRatio;
      if (key.char === ' ') {
        return { width: 0, height: 0, bearingX: 0, bearingY: 0, advance: size * 0.3 };
      }
      const width = size * (key.bold ? 0.7 : 0.6);
      return { width, height: size, bearingX: 0, bearingY: size * 0.8, advance: width };
    },
    draw: (key, x, y): void => {
      drawn.push(`${key.char}@${x},${y}`);
    },
    clear: (): void => {
      state.cleared += 1;
    },
  };
};
