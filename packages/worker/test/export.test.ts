import { describe, expect, it, vi } from 'vitest';
import { collectingSink } from '@panorama/export';
import { isTableDataError } from '@panorama/table';
import { factRelation } from '@panorama/test-support';
import type { ExportProgressEvent } from '@panorama/worker';
import type { WorkerHarness } from './harness.js';
import { TABLE_ID, createWorkerHarness } from './harness.js';

const OPEN = { tableId: TABLE_ID, schema: 'PANORAMA_TEST', table: 'SALES' } as const;

const decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/**
 * A relation long enough that an export of it spans many batches, so a test can
 * interrupt one part-way through rather than racing its completion.
 */
const longRelation = { source: { relation: factRelation(200_000) } };

const openAndExport = async (
  harness: WorkerHarness,
  format: 'csv' | 'xlsx' | 'parquet',
): Promise<ReturnType<WorkerHarness['client']['startExport']>> => {
  await harness.drive(harness.client.openTable(OPEN));
  return harness.client.startExport({ tableId: TABLE_ID, format, sink: collectingSink() });
};

describe('exporting through the worker', () => {
  it('encodes in the worker and lands the bytes in the main thread sink', async () => {
    const harness = createWorkerHarness();
    await harness.drive(harness.client.openTable(OPEN));
    const sink = collectingSink();
    const handle = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink });
    const result = await harness.drive(handle.done);

    expect(result.rows).toBe(10_000);
    expect(result.bytes).toBe(sink.position);
    const text = decode(sink.bytes());
    expect(text.split('\r\n')[0]?.slice(1)).toBe('ORDER_ID,COUNTRY,ORDER_DATE,REVENUE');
    // Every row, plus the header, plus the tail after the last CRLF.
    expect(text.split('\r\n')).toHaveLength(10_002);
  });

  it('writes each format, and each one starts the way its readers expect', async () => {
    for (const [format, magic] of [
      ['parquet', 'PAR1'],
      ['xlsx', 'PK'],
    ] as const) {
      const harness = createWorkerHarness();
      await harness.drive(harness.client.openTable(OPEN));
      const sink = collectingSink();
      const handle = harness.client.startExport({ tableId: TABLE_ID, format, sink });
      const result = await harness.drive(handle.done);
      expect(result.rows).toBe(10_000);
      expect(decode(sink.bytes().slice(0, magic.length))).toBe(magic);
      expect(harness.worker.runningExportCount).toBe(0);
    }
  });

  it('reads its own result set, leaving the table own alone', async () => {
    const harness = createWorkerHarness();
    const handle = await openAndExport(harness, 'csv');
    await harness.drive(handle.done);
    expect(harness.worker.openTableCount).toBe(1);
    expect(harness.worker.runningExportCount).toBe(0);
    // The table can still be read afterwards, so its session survived.
    const reopened = await harness.drive(harness.client.reopenTable(TABLE_ID));
    expect(reopened.generation).toBe(1);
  });

  it('reports progress as it goes, against the total it knows', async () => {
    const harness = createWorkerHarness();
    await harness.drive(harness.client.openTable(OPEN));
    const progress: ExportProgressEvent[] = [];
    const handle = harness.client.startExport({
      tableId: TABLE_ID,
      format: 'csv',
      sink: collectingSink(),
      onProgress: (event): void => {
        progress.push(event);
      },
    });
    await harness.drive(handle.done);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)?.rows).toBe(10_000);
    expect(progress.at(-1)?.totalRows).toBe(10_000);
    expect(progress.every((step) => step.exportId === handle.exportId)).toBe(true);
  });

  it('waits to be acknowledged before sending the next chunk', async () => {
    const harness = createWorkerHarness(longRelation);
    await harness.drive(harness.client.openTable(OPEN));
    const sink = collectingSink();
    let outstanding = 0;
    let worst = 0;
    const slow = {
      get position(): number {
        return sink.position;
      },
      async write(bytes: Uint8Array): Promise<void> {
        outstanding += 1;
        worst = Math.max(worst, outstanding);
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        await sink.write(bytes);
        outstanding -= 1;
      },
      close: sink.close,
    };
    const handle = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink: slow });
    await harness.drive(handle.done);
    // Many chunks, and never more than one of them in flight: the worker cannot
    // outrun the destination however fast the database is.
    expect(sink.position).toBeGreaterThan(1_000_000);
    expect(worst).toBe(1);
  });

  it('refuses to export a table that is not open', async () => {
    const harness = createWorkerHarness();
    const handle = harness.client.startExport({
      tableId: TABLE_ID,
      format: 'csv',
      sink: collectingSink(),
    });
    await expect(harness.drive(handle.done)).rejects.toThrow(/not open/u);
  });

  it('abandons the file when the destination fails', async () => {
    const harness = createWorkerHarness();
    await harness.drive(harness.client.openTable(OPEN));
    let aborted: unknown = null;
    let closed = false;
    const sink = {
      position: 0,
      async write(): Promise<void> {
        throw new Error('disk full');
      },
      async close(): Promise<void> {
        closed = true;
      },
      async abort(reason: unknown): Promise<void> {
        aborted = reason;
      },
    };
    const handle = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink });
    await expect(harness.drive(handle.done)).rejects.toThrow('disk full');
    expect(aborted).toBeInstanceOf(Error);
    expect(closed).toBe(false);
  });

  it('stops on request, and discards what it had written', async () => {
    const harness = createWorkerHarness(longRelation);
    await harness.drive(harness.client.openTable(OPEN));
    const sink = collectingSink();
    const aborted = vi.spyOn(sink, 'abort');
    const handle = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink });
    // Part-way through: some rows written, many still to come.
    await harness.pump(3);
    expect(harness.worker.runningExportCount).toBe(1);
    handle.cancel();
    const error = await harness.drive(handle.done).catch((reason: unknown) => reason);
    // A cancellation stays a cancellation across the worker boundary.
    expect(isTableDataError(error) ? error.code : '').toBe('aborted');
    expect(aborted).toHaveBeenCalled();
    expect(sink.bytes()).toHaveLength(0);
    expect(harness.worker.runningExportCount).toBe(0);
  });

  it('ignores a cancellation for an export that has already finished', async () => {
    const harness = createWorkerHarness();
    const handle = await openAndExport(harness, 'csv');
    await harness.drive(handle.done);
    handle.cancel();
    await harness.pump(2);
    expect(harness.worker.runningExportCount).toBe(0);
  });

  it('stops an export when its table is closed', async () => {
    const harness = createWorkerHarness(longRelation);
    const handle = await openAndExport(harness, 'csv');
    // Watched from the start: the export ends while the close is being driven,
    // and a rejection nobody is listening for is an unhandled one.
    const ended = handle.done.catch((reason: unknown) => reason);
    await harness.pump(3);
    await harness.drive(harness.client.closeTable(TABLE_ID));
    expect(await harness.drive(ended)).toBeInstanceOf(Error);
    expect(String(await ended)).toMatch(/cancelled/iu);
  });

  it('stops every export on disconnect', async () => {
    const harness = createWorkerHarness({
      ...longRelation,
      createConnection: () =>
        ({
          id: 'connection:test',
          open: async (): Promise<void> => undefined,
          close: async (): Promise<void> => undefined,
        }) as never,
    });
    await harness.drive(
      harness.client.connect('wss://db', { kind: 'password', username: 'u', password: 'p' }),
    );
    const handle = await openAndExport(harness, 'csv');
    const ended = handle.done.catch((reason: unknown) => reason);
    await harness.pump(3);
    await harness.drive(harness.client.disconnect());
    expect(String(await harness.drive(ended))).toMatch(/cancelled/iu);
  });

  it('gives concurrent exports separate identities and identical files', async () => {
    const harness = createWorkerHarness();
    await harness.drive(harness.client.openTable(OPEN));
    const first = collectingSink();
    const second = collectingSink();
    const a = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink: first });
    const b = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink: second });
    expect(a.exportId).not.toBe(b.exportId);
    await harness.drive(Promise.all([a.done, b.done]));
    expect(decode(first.bytes())).toBe(decode(second.bytes()));
  });

  it('releases an encoder parked on an acknowledgement that will never come', async () => {
    const harness = createWorkerHarness(longRelation);
    await harness.drive(harness.client.openTable(OPEN));
    // A destination that never finishes a write leaves the worker waiting for
    // an ack, which is the state a cancellation has to be able to break.
    let release: (() => void) | null = null;
    const sink = {
      position: 0,
      async write(): Promise<void> {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      async close(): Promise<void> {
        /* Never reached. */
      },
    };
    const handle = harness.client.startExport({ tableId: TABLE_ID, format: 'csv', sink });
    await harness.pump(4);
    // Parked inside a write, which is where a real export spends most of its
    // time — and where pressing stop has to work.
    expect(release).not.toBeNull();
    handle.cancel();
    await expect(harness.drive(handle.done)).rejects.toThrow(/cancelled/iu);
    expect(harness.worker.runningExportCount).toBe(0);
    // The write it was parked in is still outstanding: the export did not wait
    // for it, which is the point.
    (release as unknown as () => void)();
  });

  it('drops export traffic once the client is disposed', async () => {
    const harness = createWorkerHarness(longRelation);
    const handle = await openAndExport(harness, 'csv');
    const failed = handle.done.catch((reason: unknown) => reason);
    harness.client.dispose();
    // Cancelling through a disposed client is a no-op rather than a crash.
    handle.cancel();
    expect(await harness.drive(failed)).toBeInstanceOf(Error);
  });
});
