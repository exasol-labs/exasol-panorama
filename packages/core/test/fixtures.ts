import type { ConnectionId, IdFactory, TableEntity, TableEntitySpec } from '@panorama/core';
import { buildTableEntity, createIdFactory, dataType } from '@panorama/core';

/** Deterministic pseudo-random source so generated ids are reproducible. */
export const seededRandom = (seed = 1): (() => number) => {
  let state = seed >>> 0 || 1;
  return (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

/** Id factory with a fake monotonic clock; ids are stable across test runs. */
export const testIds = (seed = 1): IdFactory => {
  let time = 1_700_000_000_000;
  return createIdFactory({
    now: (): number => (time += 1),
    random: seededRandom(seed),
  });
};

export const TEST_CONNECTION = 'connection:TEST' as ConnectionId;

export const sampleColumns = [
  { name: 'ORDER_ID', type: dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 }) },
  { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
  { name: 'ORDER_DATE', type: dataType('date', 'DATE') },
  { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }) },
] as const;

export const makeTable = (ids: IdFactory, overrides: Partial<TableEntitySpec> = {}): TableEntity =>
  buildTableEntity(ids, {
    source: { connectionId: TEST_CONNECTION, schema: 'SALES', table: 'ORDERS' },
    columns: sampleColumns,
    ...overrides,
  });
