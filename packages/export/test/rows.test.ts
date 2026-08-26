import { describe, expect, it } from 'vitest';
import { TableDataError } from '@panorama/table';
import type { ResultChunk, TableDataSession } from '@panorama/table';
import { batchRowsForColumns, isExportError, readBatches } from '@panorama/export';
import { VARCHAR, schemaOf, sessionOf } from './fixtures.js';

const schema = schemaOf([['NAME', VARCHAR]]);
const names = Array.from({ length: 10 }, (_value, index) => `row-${index}`);

const collect = async (
  session: TableDataSession,
  batchRows: number,
  signal?: AbortSignal,
): Promise<ResultChunk[]> => {
  const chunks: ResultChunk[] = [];
  for await (const chunk of readBatches(session, batchRows, signal)) chunks.push(chunk);
  return chunks;
};

describe('batchRowsForColumns', () => {
  it('shrinks the batch as the rows get wider', () => {
    expect(batchRowsForColumns(4)).toBe(16_384);
    expect(batchRowsForColumns(5_000)).toBe(32);
    // Never so small that a fetch stops being worth making.
    expect(batchRowsForColumns(1_000_000)).toBe(32);
    // A shape with no columns yet is not a reason to fetch nothing.
    expect(batchRowsForColumns(0)).toBe(16_384);
  });

  it('keeps a batch near the target number of cells', () => {
    for (const columns of [1, 8, 64, 512]) {
      const cells = batchRowsForColumns(columns) * columns;
      expect(cells).toBeLessThanOrEqual(131_072);
    }
  });
});

describe('readBatches', () => {
  it('walks the result set once, in order, in whole batches', async () => {
    const session = sessionOf(schema, [names]);
    const chunks = await collect(session, 4);
    expect(chunks.map((chunk) => chunk.rowCount)).toEqual([4, 4, 2]);
    expect(chunks.map((chunk) => chunk.startRow)).toEqual([0, 4, 8]);
    // The last fetch asks only for what is left rather than over-reading.
    expect(session.fetches).toEqual([4, 4, 2]);
  });

  it('stops at the first short fetch when the total is unknown', async () => {
    const session = sessionOf(schema, [names], { rowCount: null });
    const chunks = await collect(session, 4);
    expect(chunks.map((chunk) => chunk.rowCount)).toEqual([4, 4, 2]);
  });

  it('yields nothing for an empty result set', async () => {
    expect(await collect(sessionOf(schema, [[]]), 4)).toEqual([]);
  });

  it('does not yield a batch that came back empty', async () => {
    const session = sessionOf(schema, [[]], { rowCount: null });
    expect(await collect(session, 4)).toEqual([]);
  });

  it('reports a cancellation as one, before the first fetch', async () => {
    const controller = new AbortController();
    controller.abort();
    const session = sessionOf(schema, [names]);
    await expect(collect(session, 4, controller.signal)).rejects.toThrow(/cancelled/iu);
    expect(session.fetches).toEqual([]);
  });

  it('translates the data layer own abort into a cancellation', async () => {
    const session: TableDataSession = {
      schema,
      rowCount: 10,
      async fetch(): Promise<ResultChunk> {
        throw new TableDataError('aborted', 'Fetch aborted');
      },
      async close(): Promise<void> {
        /* Nothing to release. */
      },
    };
    const error = await collect(session, 4).catch((reason: unknown) => reason);
    expect(isExportError(error)).toBe(true);
    expect(isExportError(error) ? error.code : '').toBe('aborted');
  });

  it('lets any other failure through untouched', async () => {
    const failure = new TableDataError('connection-lost', 'gone');
    const session: TableDataSession = {
      schema,
      rowCount: 10,
      async fetch(): Promise<ResultChunk> {
        throw failure;
      },
      async close(): Promise<void> {
        /* Nothing to release. */
      },
    };
    await expect(collect(session, 4)).rejects.toBe(failure);
  });
});
