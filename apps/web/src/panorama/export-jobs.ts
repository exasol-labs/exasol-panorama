import type { EntityId } from '@panorama/core';
import type { ByteSink, ExportFormat } from '@panorama/export';
import type { DataWorkerClient, RunningExportHandle } from '@panorama/worker';

/**
 * Exports in flight, and what became of them.
 *
 * Its own object because an export outlives everything around it: it is a long
 * job against a database, and the panel that shows it, the table it came from
 * and the frame that started it may all be gone before it finishes. Keeping that
 * bookkeeping here rather than in the workspace also draws the line where it
 * actually falls — nothing in this file knows what a table is, only that
 * something was named, encoded and written.
 */

export type ExportStatus = 'running' | 'done' | 'failed' | 'cancelled';

/**
 * One export, as the sidebar sees it.
 *
 * Not React state, for the reason above: closing a panel or re-rendering the
 * shell must not lose track of a job that is still writing.
 */
export interface ExportJob {
  readonly id: number;
  readonly tableId: EntityId;
  readonly tableName: string;
  readonly fileName: string;
  readonly format: ExportFormat;
  readonly status: ExportStatus;
  readonly rows: number;
  readonly bytes: number;
  readonly totalRows: number | null;
  readonly error?: string;
}

/** Everything needed to start one, once the destination has been chosen. */
export interface ExportStart {
  readonly tableId: EntityId;
  readonly tableName: string;
  readonly fileName: string;
  readonly format: ExportFormat;
  readonly sink: ByteSink;
  /** What the table said it holds, so progress can be a fraction. */
  readonly totalRows: number | null;
}

export class ExportJobs {
  readonly #client: DataWorkerClient;
  readonly #jobs = new Map<number, ExportJob>();
  readonly #running = new Map<number, RunningExportHandle>();
  /** Cancelled by the user: a failure that was asked for is not a failure. */
  readonly #cancelled = new Set<number>();
  readonly #listeners = new Set<() => void>();

  constructor(client: DataWorkerClient) {
    this.#client = client;
  }

  /** Every export this session has started, oldest first. */
  all(): readonly ExportJob[] {
    return [...this.#jobs.values()];
  }

  /**
   * Notified when an export starts, advances or ends.
   *
   * A subscription rather than a constructor callback because the shell that
   * wants to re-render is built after the workspace it renders.
   */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return (): void => {
      this.#listeners.delete(listener);
    };
  }

  #changed(): void {
    for (const listener of [...this.#listeners]) listener();
  }

  #update(id: number, patch: Partial<ExportJob>): void {
    const existing = this.#jobs.get(id);
    if (existing === undefined) return;
    this.#jobs.set(id, { ...existing, ...patch });
    this.#changed();
  }

  /**
   * Encodes and writes, reporting progress until it is done.
   *
   * Resolves when the file is written and rejects when it could not be — except
   * for a cancellation, which is recorded and swallowed: the user asking for it
   * to stop is not an error to be told about.
   */
  async start(request: ExportStart): Promise<void> {
    const handle = this.#client.startExport({
      tableId: request.tableId,
      format: request.format,
      sink: request.sink,
      onProgress: (progress): void => {
        this.#update(handle.exportId, {
          rows: progress.rows,
          bytes: progress.bytes,
          totalRows: progress.totalRows,
        });
      },
    });
    this.#jobs.set(handle.exportId, {
      id: handle.exportId,
      tableId: request.tableId,
      tableName: request.tableName,
      fileName: request.fileName,
      format: request.format,
      status: 'running',
      rows: 0,
      bytes: 0,
      totalRows: request.totalRows,
    });
    this.#running.set(handle.exportId, handle);
    this.#changed();

    try {
      const result = await handle.done;
      this.#update(handle.exportId, { status: 'done', rows: result.rows, bytes: result.bytes });
    } catch (error) {
      const cancelled = this.#cancelled.delete(handle.exportId);
      this.#update(handle.exportId, {
        status: cancelled ? 'cancelled' : 'failed',
        ...(cancelled ? {} : { error: error instanceof Error ? error.message : String(error) }),
      });
      if (!cancelled) throw error;
    } finally {
      this.#running.delete(handle.exportId);
    }
  }

  /**
   * Stops an export. The half-written file is discarded rather than left under
   * the name the user chose — a truncated Parquet file has no footer and a
   * truncated workbook has no directory, so neither would open.
   */
  cancel(id: number): void {
    const handle = this.#running.get(id);
    if (handle === undefined) return;
    this.#cancelled.add(id);
    handle.cancel();
  }

  /** Forgets a finished export; a running one is left alone. */
  dismiss(id: number): void {
    if (this.#running.has(id)) return;
    this.#jobs.delete(id);
    this.#changed();
  }
}
