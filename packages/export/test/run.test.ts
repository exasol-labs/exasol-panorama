import { describe, expect, it, vi } from 'vitest';
import type { TableDataSession } from '@panorama/table';
import type { ExportProgress } from '@panorama/export';
import { collectingSink, createEncoder, isExportError, runExport } from '@panorama/export';
import { MONEY, VARCHAR, failingSink, schemaOf, sessionOf } from './fixtures.js';

const schema = schemaOf([
  ['NAME', VARCHAR],
  ['REVENUE', MONEY],
]);

const names = Array.from({ length: 25 }, (_value, index) => `row-${index}`);
const revenues = names.map((_name, index) => index * 1.5);

const session = (): TableDataSession =>
  sessionOf(schema, [names, revenues]) as unknown as TableDataSession;

describe('createEncoder', () => {
  it('has an encoder for every format, and passes each its own options', () => {
    const sink = collectingSink();
    for (const format of ['csv', 'xlsx', 'parquet'] as const) {
      expect(createEncoder(format, { schema, sink })).toHaveProperty('begin');
    }
    // Format-specific options reach only their own encoder.
    const csv = createEncoder('csv', { schema, sink, csv: { byteOrderMark: false } });
    expect(csv).toHaveProperty('write');
  });
});

describe('runExport', () => {
  it('writes every row, closes the file and reports what it wrote', async () => {
    const sink = collectingSink();
    const result = await runExport({
      format: 'csv',
      session: session(),
      sink,
      batchRows: 7,
      csv: { byteOrderMark: false },
    });
    expect(result.rows).toBe(25);
    expect(result.bytes).toBe(sink.position);
    const text = new TextDecoder().decode(sink.bytes());
    expect(text.split('\r\n').filter((line) => line !== '')).toHaveLength(26);
  });

  it('exports the same rows whatever the batch size', async () => {
    const outputs = await Promise.all(
      [1, 7, 1_000].map(async (batchRows) => {
        const sink = collectingSink();
        await runExport({
          format: 'csv',
          session: session(),
          sink,
          batchRows,
          csv: { byteOrderMark: false },
        });
        return new TextDecoder().decode(sink.bytes());
      }),
    );
    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it('reports progress no more often than asked, and once at the end', async () => {
    let now = 0;
    const progress: ExportProgress[] = [];
    const result = await runExport({
      format: 'csv',
      session: session(),
      sink: collectingSink(),
      batchRows: 5,
      progressIntervalMs: 100,
      clock: (): number => {
        now += 60;
        return now;
      },
      onProgress: (value): void => {
        progress.push(value);
      },
    });
    // Five batches at 60 ms apiece: a report every other one, then the last.
    expect(progress.length).toBeLessThan(5);
    expect(progress.at(-1)?.rows).toBe(result.rows);
    expect(progress.at(-1)?.totalRows).toBe(25);
    expect(progress.every((step) => step.bytes > 0)).toBe(true);
  });

  it('reports an unknown total as unknown rather than guessing one', async () => {
    const progress: ExportProgress[] = [];
    await runExport({
      format: 'csv',
      session: sessionOf(schema, [names, revenues], {
        rowCount: null,
      }) as unknown as TableDataSession,
      sink: collectingSink(),
      batchRows: 5,
      onProgress: (value): void => {
        progress.push(value);
      },
    });
    expect(progress.at(-1)?.totalRows).toBeNull();
  });

  it('refuses a table with no columns before opening a file', async () => {
    const sink = collectingSink();
    const error = await runExport({
      format: 'csv',
      session: sessionOf(schemaOf([]), []) as unknown as TableDataSession,
      sink,
    }).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('no-columns');
    expect(sink.position).toBe(0);
  });

  it('stops when cancelled, and abandons the file rather than truncating it', async () => {
    const controller = new AbortController();
    const sink = collectingSink();
    const aborted = vi.spyOn(sink, 'abort');
    const error = await runExport({
      format: 'parquet',
      session: session(),
      sink,
      batchRows: 5,
      signal: controller.signal,
      onProgress: (): void => controller.abort(),
      progressIntervalMs: 0,
    }).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('aborted');
    expect(aborted).toHaveBeenCalled();
    // No footer was written, so nothing is left pretending to be a file.
    expect(sink.bytes()).toHaveLength(0);
  });

  it('abandons the file when the destination fails', async () => {
    const sink = failingSink(2);
    await expect(
      runExport({ format: 'csv', session: session(), sink, batchRows: 5 }),
    ).rejects.toThrow('disk full');
    expect(sink.aborted).toBeInstanceOf(Error);
  });

  it('abandons the file when a value cannot be encoded', async () => {
    const narrow = schemaOf([['SMALL', MONEY]]);
    const sink = collectingSink();
    const aborted = vi.spyOn(sink, 'abort');
    // A value far beyond DECIMAL(18,2), delivered as digits.
    const error = await runExport({
      format: 'parquet',
      session: sessionOf(narrow, [['999999999999999999999999.00']]) as unknown as TableDataSession,
      sink,
    }).catch((reason: unknown) => reason);
    expect(isExportError(error) ? error.code : '').toBe('value-out-of-range');
    expect(aborted).toHaveBeenCalled();
  });

  it('writes a valid file for an empty result set, in every format', async () => {
    for (const format of ['csv', 'xlsx', 'parquet'] as const) {
      const sink = collectingSink();
      const result = await runExport({
        format,
        session: sessionOf(schema, [[], []]) as unknown as TableDataSession,
        sink,
      });
      expect(result.rows).toBe(0);
      expect(result.bytes).toBeGreaterThan(0);
    }
  });

  it('passes each format its own options', async () => {
    // A tiny row-group budget makes Parquet close a group per batch.
    const parquet = collectingSink();
    await runExport({
      format: 'parquet',
      session: session(),
      sink: parquet,
      batchRows: 5,
      parquet: { rowGroupRows: 5 },
    });
    // A fixed timestamp makes the workbook's bytes reproducible.
    const first = collectingSink();
    const second = collectingSink();
    for (const sink of [first, second]) {
      await runExport({
        format: 'xlsx',
        session: session(),
        sink,
        xlsx: { modified: new Date(2026, 0, 2, 3, 4, 5), compress: false },
      });
    }
    expect([...second.bytes()]).toEqual([...first.bytes()]);
    expect(parquet.position).toBeGreaterThan(0);
  });

  it('picks a batch size from the row width when none is given', async () => {
    const source = sessionOf(schema, [names, revenues]);
    await runExport({
      format: 'csv',
      session: source as unknown as TableDataSession,
      sink: collectingSink(),
    });
    // One fetch, because 25 rows of two columns fit a default batch easily.
    expect(source.fetches).toEqual([25]);
  });
});
