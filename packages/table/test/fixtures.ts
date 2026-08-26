import type { ConnectionId, IdFactory, TableEntity, TableEntitySpec } from '@panorama/core';
import { buildTableEntity, createIdFactory, dataType } from '@panorama/core';
import type { TableSchema } from '@panorama/table';

export const seededRandom = (seed = 1): (() => number) => {
  let state = seed >>> 0 || 1;
  return (): number => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
};

export const testIds = (seed = 1): IdFactory => {
  let time = 1_700_000_000_000;
  return createIdFactory({ now: (): number => (time += 1), random: seededRandom(seed) });
};

export const TEST_CONNECTION = 'connection:TEST' as ConnectionId;

export const testSchema: TableSchema = {
  schema: 'SALES',
  table: 'ORDERS',
  columns: [
    { name: 'ORDER_ID', type: dataType('decimal', 'DECIMAL(18,0)', { precision: 18, scale: 0 }) },
    { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
    { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }) },
  ],
};

export const makeTable = (ids: IdFactory, overrides: Partial<TableEntitySpec> = {}): TableEntity =>
  buildTableEntity(ids, {
    source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'SALES', table: 'ORDERS' },
    columns: testSchema.columns.map((column) => ({ name: column.name, type: column.type })),
    ...overrides,
  });
