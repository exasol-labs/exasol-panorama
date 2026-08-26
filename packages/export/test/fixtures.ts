import type { ColumnDataType } from '@panorama/core';
import { dataType } from '@panorama/core';
import type { ResultChunk, TableSchema } from '@panorama/table';
import { buildVector, createResultChunk } from '@panorama/table';
import type { ByteSink } from '@panorama/export';

/** Column types the export tests reach for repeatedly. */
export const VARCHAR = dataType('varchar', 'VARCHAR(64)', { size: 64 });
export const DOUBLE = dataType('double', 'DOUBLE');
export const BOOLEAN = dataType('boolean', 'BOOLEAN');
export const DATE = dataType('date', 'DATE');
export const TIMESTAMP = dataType('timestamp', 'TIMESTAMP(3)', { fraction: 3 });
export const MONEY = dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 });
export const BIG_DECIMAL = dataType('decimal', 'DECIMAL(36,6)', { precision: 36, scale: 6 });
export const VAGUE_DECIMAL = dataType('decimal', 'DECIMAL');

export const schemaOf = (
  columns: readonly (readonly [string, ColumnDataType])[],
  table = 'ORDERS',
): TableSchema => ({
  schema: 'SALES',
  table,
  columns: columns.map(([name, type]) => ({ name, type })),
});

/** Builds a chunk from column-major values, choosing vectors as the driver would. */
export const chunkOf = (
  schema: TableSchema,
  columns: ReadonlyArray<readonly unknown[]>,
  startRow = 0,
): ResultChunk => {
  const rowCount = columns[0]?.length ?? 0;
  return createResultChunk(
    startRow,
    rowCount,
    schema.columns.map((column, index) => buildVector(column.type, columns[index] ?? [])),
  );
};

/** A session over one fixed set of rows, sliced on demand like a real one. */
export const sessionOf = (
  schema: TableSchema,
  columns: ReadonlyArray<readonly unknown[]>,
  options: { rowCount?: number | null } = {},
): {
  schema: TableSchema;
  rowCount: number | null;
  fetch: (request: { startPosition: number; maxRows: number }) => Promise<ResultChunk>;
  close: () => Promise<void>;
  fetches: number[];
} => {
  const total = columns[0]?.length ?? 0;
  const fetches: number[] = [];
  return {
    schema,
    rowCount: options.rowCount === undefined ? total : options.rowCount,
    async fetch(request): Promise<ResultChunk> {
      const start = request.startPosition;
      const end = Math.min(total, start + request.maxRows);
      fetches.push(end - start);
      return chunkOf(
        schema,
        columns.map((values) => values.slice(start, end)),
        start,
      );
    },
    async close(): Promise<void> {
      /* Nothing to release. */
    },
    fetches,
  };
};

/** A sink that fails on the nth write, for the error paths. */
export const failingSink = (failOnWrite: number): ByteSink & { aborted: unknown } => {
  let writes = 0;
  let position = 0;
  const sink = {
    aborted: null as unknown,
    get position(): number {
      return position;
    },
    async write(bytes: Uint8Array): Promise<void> {
      writes += 1;
      if (writes === failOnWrite) throw new Error('disk full');
      position += bytes.length;
    },
    async close(): Promise<void> {
      /* Nothing to release. */
    },
    async abort(reason: unknown): Promise<void> {
      sink.aborted = reason;
    },
  };
  return sink;
};
