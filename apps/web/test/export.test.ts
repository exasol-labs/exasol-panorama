import { describe, expect, it, vi } from 'vitest';
import { expandedActionOf } from '@panorama/core';
import type { ByteSink } from '@panorama/export';
import { collectingSink } from '@panorama/export';
import { DEMO_SCHEMA } from '../src/panorama/demo.js';
import type { ExportSinkRequest } from '../src/panorama/workspace.js';
import { createAppHarness, firstTableId } from './harness.js';

const decode = (bytes: Uint8Array): string =>
  new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

/**
 * A save dialog that always accepts, remembering what it was asked for.
 *
 * The real one is a browser dialog; what the workspace needs from it is a sink
 * and the fact that the user did not cancel.
 */
const recordingPicker = (): {
  open: (request: ExportSinkRequest) => Promise<ByteSink | null>;
  requests: ExportSinkRequest[];
  sinks: ReturnType<typeof collectingSink>[];
} => {
  const requests: ExportSinkRequest[] = [];
  const sinks: ReturnType<typeof collectingSink>[] = [];
  return {
    requests,
    sinks,
    open: async (request): Promise<ByteSink> => {
      requests.push(request);
      const sink = collectingSink();
      sinks.push(sink);
      return sink;
    },
  };
};

const openDemo = async (
  harness: ReturnType<typeof createAppHarness>,
  table = 'SAMPLE_100',
): Promise<ReturnType<typeof firstTableId>> => {
  const opening = harness.workspace.openTable({ schema: DEMO_SCHEMA, table });
  await harness.settle();
  await opening;
  return firstTableId(harness);
};

/** A connected harness with a stored relation open, which is what SQL needs. */
const openStored = async (
  harness: ReturnType<typeof createAppHarness>,
): Promise<ReturnType<typeof firstTableId>> => {
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  await harness.settle();
  await opening;
  return firstTableId(harness);
};

describe('exporting a table from the halo', () => {
  it('reveals the formats rather than picking one, and folds them away again', async () => {
    const harness = createAppHarness();
    const tableId = await openDemo(harness);

    await harness.workspace.performAction(tableId, 'export');
    expect(expandedActionOf(harness.workspace.core.session, tableId)).toBe('export');
    // The same button again closes it: it is a disclosure, not a mode.
    await harness.workspace.performAction(tableId, 'export');
    expect(expandedActionOf(harness.workspace.core.session, tableId)).toBeNull();
    // Nothing was exported by opening the choices.
    expect(harness.workspace.exportJobs()).toEqual([]);
  });

  it('writes the file the chosen format asks for, and folds the halo away', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({ openExportSink: picker.open });
    const tableId = await openDemo(harness);
    await harness.workspace.performAction(tableId, 'export');

    const exporting = harness.workspace.performAction(tableId, 'export-csv');
    // Folded away immediately, so the halo is not left open behind the dialog.
    expect(expandedActionOf(harness.workspace.core.session, tableId)).toBeNull();
    await harness.drive(exporting);

    expect(picker.requests).toHaveLength(1);
    expect(picker.requests[0]?.fileName).toBe('PANORAMA_DEMO.SAMPLE_100.csv');
    expect(picker.requests[0]?.format.label).toBe('CSV');
    expect(picker.requests[0]?.tableName).toBe('PANORAMA_DEMO.SAMPLE_100');

    const text = decode(picker.sinks[0]?.bytes() ?? new Uint8Array());
    expect(text.split('\r\n')[0]?.slice(1)).toBe('ORDER_ID,COUNTRY,ORDER_DATE,REVENUE');
    expect(text.split('\r\n')).toHaveLength(102);
  });

  it('suggests a name and a type for each format', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({ openExportSink: picker.open });
    const tableId = await openDemo(harness);
    for (const action of ['export-csv', 'export-xlsx', 'export-parquet'] as const) {
      await harness.drive(harness.workspace.performAction(tableId, action));
    }
    expect(picker.requests.map((request) => request.fileName)).toEqual([
      'PANORAMA_DEMO.SAMPLE_100.csv',
      'PANORAMA_DEMO.SAMPLE_100.xlsx',
      'PANORAMA_DEMO.SAMPLE_100.parquet',
    ]);
    expect(picker.requests.map((request) => request.format.extension)).toEqual([
      '.csv',
      '.xlsx',
      '.parquet',
    ]);
    // Each file begins the way its readers expect.
    expect(decode(picker.sinks[2]?.bytes().slice(0, 4) ?? new Uint8Array())).toBe('PAR1');
    expect(decode(picker.sinks[1]?.bytes().slice(0, 2) ?? new Uint8Array())).toBe('PK');
  });

  it('reports a job the shell can watch, and finishes it', async () => {
    const picker = recordingPicker();
    const changes: number[] = [];
    const harness = createAppHarness({ openExportSink: picker.open });
    harness.workspace.subscribeExports(() => changes.push(harness.workspace.exportJobs().length));
    const tableId = await openDemo(harness);

    await harness.drive(harness.workspace.performAction(tableId, 'export-parquet'));
    const [job] = harness.workspace.exportJobs();
    expect(job?.status).toBe('done');
    expect(job?.format).toBe('parquet');
    expect(job?.rows).toBe(100);
    expect(job?.totalRows).toBe(100);
    expect(job?.bytes).toBeGreaterThan(0);
    expect(job?.tableName).toBe('PANORAMA_DEMO.SAMPLE_100');
    expect(changes.length).toBeGreaterThan(1);
  });

  it('does nothing at all when the save dialog is dismissed', async () => {
    const harness = createAppHarness({ openExportSink: async () => null });
    const tableId = await openDemo(harness);
    await harness.drive(harness.workspace.performAction(tableId, 'export-csv'));
    // Not a failure and not a job: the user closed a dialog.
    expect(harness.workspace.exportJobs()).toEqual([]);
  });

  it('records a failure on the job and reports it', async () => {
    const harness = createAppHarness({
      openExportSink: async () => ({
        position: 0,
        async write(): Promise<void> {
          throw new Error('The disk is full');
        },
        async close(): Promise<void> {
          /* Never reached. */
        },
      }),
    });
    const tableId = await openDemo(harness);
    await expect(
      harness.drive(harness.workspace.performAction(tableId, 'export-csv')),
    ).rejects.toThrow('The disk is full');
    const [job] = harness.workspace.exportJobs();
    expect(job?.status).toBe('failed');
    expect(job?.error).toBe('The disk is full');
  });

  it('reports a stopped export as stopped rather than as a failure', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({
      openExportSink: picker.open,
      rowCount: 200_000,
    });
    const tableId = await openStored(harness);

    const exporting = harness.workspace.performAction(tableId, 'export-csv');
    await harness.pump(3);
    const [running] = harness.workspace.exportJobs();
    expect(running?.status).toBe('running');
    harness.workspace.cancelExport(running?.id ?? 0);
    // Stopping is the user's own doing, so it is not reported as an error.
    await harness.drive(exporting);
    const [stopped] = harness.workspace.exportJobs();
    expect(stopped?.status).toBe('cancelled');
    expect(stopped?.error).toBeUndefined();
  });

  it('forgets a finished export when asked, and keeps a running one', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({ openExportSink: picker.open, rowCount: 200_000 });
    const tableId = await openStored(harness);

    const exporting = harness.workspace.performAction(tableId, 'export-csv');
    await harness.pump(3);
    const id = harness.workspace.exportJobs()[0]?.id ?? 0;
    // A running export cannot be dismissed out from under itself.
    harness.workspace.dismissExport(id);
    expect(harness.workspace.exportJobs()).toHaveLength(1);
    await harness.drive(exporting);
    harness.workspace.dismissExport(id);
    expect(harness.workspace.exportJobs()).toEqual([]);
    // Cancelling something already gone is harmless.
    harness.workspace.cancelExport(id);
  });

  it('refuses a table with no rows behind it yet', async () => {
    const harness = createAppHarness({ openExportSink: async () => collectingSink() });
    const base = await openStored(harness);
    const { tableId } = await harness.workspace.openQuery(base);

    // A statement that has never run has no result set to read.
    await expect(harness.workspace.exportTable(tableId, 'csv')).rejects.toThrow(/no rows/u);
    expect(harness.workspace.disabledActionsFor(tableId)).toContain('export');
    expect(harness.workspace.disabledActionsFor(tableId)).toContain('export-parquet');
  });

  it('offers export on a demo table, which has no engine but does have rows', async () => {
    const harness = createAppHarness();
    const tableId = await openDemo(harness);
    const disabled = harness.workspace.disabledActionsFor(tableId);
    // No SQL engine behind a generated relation, but its rows are real enough.
    expect(disabled).toEqual(['sql']);
  });

  it('says so when the shell cannot save files at all', async () => {
    const harness = createAppHarness();
    const tableId = await openDemo(harness);
    await expect(harness.workspace.exportTable(tableId, 'csv')).rejects.toThrow(/cannot save/u);
  });

  it('refuses a table that is not there', async () => {
    const harness = createAppHarness({ openExportSink: async () => collectingSink() });
    await expect(harness.workspace.exportTable('table:nope' as never, 'csv')).rejects.toThrow(
      /No table/u,
    );
  });

  it('folds the choices away when the table they belong to is closed', async () => {
    const harness = createAppHarness();
    const tableId = await openDemo(harness);
    await harness.workspace.performAction(tableId, 'export');
    expect(harness.workspace.core.session.expandedAction).not.toBeNull();
    await harness.workspace.closeTable(tableId);
    expect(harness.workspace.core.session.expandedAction).toBeNull();
  });

  it('exports a query result, from the statement the box is showing', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({ openExportSink: picker.open });
    const base = await openStored(harness);
    const { tableId } = await harness.workspace.openQuery(base);
    const running = harness.workspace.runQuery(tableId, 'SELECT * FROM SALES');
    await harness.settle();
    await running;

    await harness.drive(harness.workspace.performAction(tableId, 'export-csv'));
    // A run of unsafe characters collapses to one underscore, so ` · ` is `_`.
    expect(picker.requests[0]?.fileName).toBe('PANORAMA_TEST.SALES_SQL.csv');
    // The export ran the box's own statement rather than the base table.
    const sql = harness.sourceRequests.filter((request) => request.sql !== undefined);
    expect(sql.at(-1)?.sql).toBe('SELECT * FROM SALES');
    expect(picker.sinks[0]?.position).toBeGreaterThan(0);
  });

  it('exports the rows a followed key narrowed the table to, not the whole table', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({ openExportSink: picker.open });
    const tableId = await openDemo(harness, 'SAMPLE_100');
    const value = harness.workspace.cellAt(tableId, 0, 1);
    const columns = harness.workspace.core.world.entities.get(tableId);
    if (columns === undefined || value === undefined) throw new Error('expected a cell');

    const following = harness.workspace.followForeignKey({
      tableId,
      columnId: (columns as { columns: { id: string }[] }).columns[1]?.id as never,
      row: 0,
      sourceColumn: 'COUNTRY',
      reference: {
        schema: DEMO_SCHEMA,
        table: 'COUNTRIES',
        column: 'NAME',
        constraint: 'FK_SALES_COUNTRY',
      },
      value,
    });
    await harness.settle();
    const { tableId: followed } = await following;

    await harness.drive(harness.workspace.performAction(followed, 'export-csv'));
    const text = decode(picker.sinks[0]?.bytes() ?? new Uint8Array());
    const rows = text.split('\r\n').filter((line) => line !== '');
    // Only the matching country, so the export is the filtered result set the
    // table is showing rather than the whole dimension.
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain(String(value));
  });

  it('leaves the other halo actions working while the formats are on show', async () => {
    const harness = createAppHarness();
    const tableId = await openDemo(harness);
    await harness.workspace.performAction(tableId, 'export');
    await harness.workspace.closeTable(tableId);
    expect(harness.workspace.openTableCount).toBe(0);
  });

  it('gives every export its own identity', async () => {
    const picker = recordingPicker();
    const harness = createAppHarness({ openExportSink: picker.open });
    const tableId = await openDemo(harness);
    await harness.drive(harness.workspace.performAction(tableId, 'export-csv'));
    await harness.drive(harness.workspace.performAction(tableId, 'export-csv'));
    const ids = harness.workspace.exportJobs().map((job) => job.id);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('the export sink the shell supplies', () => {
  it('is asked for once per export, with the format it will write', async () => {
    const open = vi.fn(async () => collectingSink());
    const harness = createAppHarness({ openExportSink: open });
    const tableId = await openDemo(harness);
    await harness.drive(harness.workspace.performAction(tableId, 'export-xlsx'));
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toMatchObject({
      fileName: 'PANORAMA_DEMO.SAMPLE_100.xlsx',
    });
  });
});
