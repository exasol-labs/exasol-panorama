import type {
  FetchRequest,
  ResultChunk,
  TableDataErrorCode,
  TableDataSession,
  TableDataSource,
  TableSchema,
} from '@panorama/table';
import { TableDataError, buildVector, createResultChunk } from '@panorama/table';
import type { RelationShape } from './generators.js';
import { generateValue, relationSchema } from './generators.js';
import { seededRandom } from './random.js';
import type { Scheduler } from './scheduler.js';
import { timeoutScheduler } from './scheduler.js';

/**
 * A `TableDataSource` with no database behind it.
 *
 * The table system must be provable without Exasol, and the interaction target
 * — 60 FPS regardless of latency — can only be tested if latency, failures and
 * out-of-order responses are reproducible.
 */

export interface MockLatency {
  /** Base latency in milliseconds. */
  readonly baseMs: number;
  /** Random additional latency in `[0, jitterMs)`, which reorders responses. */
  readonly jitterMs?: number;
}

export interface MockFailure {
  /** Fail every n-th fetch; 0 disables. */
  readonly everyNth?: number;
  /** Fail while the attempt count for a block is below this number. */
  readonly firstAttempts?: number;
  readonly code?: TableDataErrorCode;
}

export interface MockTableDataSourceOptions {
  readonly relation: RelationShape;
  readonly latency?: MockLatency | number;
  readonly failure?: MockFailure;
  readonly scheduler?: Scheduler;
  readonly seed?: number;
  /** Simulates a source that cannot report a total row count. */
  readonly reportRowCount?: boolean;
  /** Fails `open()`, simulating a table that cannot be opened at all. */
  readonly failOpen?: TableDataErrorCode;
}

export interface MockStats {
  readonly fetches: number;
  readonly failures: number;
  readonly rowsDelivered: number;
  readonly maxConcurrentFetches: number;
}

const normaliseLatency = (latency: MockLatency | number | undefined): MockLatency =>
  typeof latency === 'number' ? { baseMs: latency } : (latency ?? { baseMs: 0 });

class MockTableDataSession implements TableDataSession {
  readonly schema: TableSchema;
  readonly rowCount: number | null;
  readonly #shape: RelationShape;
  readonly #latency: MockLatency;
  readonly #failure: MockFailure;
  readonly #scheduler: Scheduler;
  readonly #random: () => number;
  readonly #attempts = new Map<number, number>();
  readonly #onFetch: () => void;
  readonly #onDeliver: (rows: number) => void;
  readonly #onFailure: () => void;
  #closed = false;
  #inFlight = 0;
  #maxInFlight = 0;

  constructor(
    options: MockTableDataSourceOptions,
    hooks: {
      onFetch: () => void;
      onDeliver: (rows: number) => void;
      onFailure: () => void;
      onConcurrency: (value: number) => void;
    },
  ) {
    this.#shape = options.relation;
    this.#latency = normaliseLatency(options.latency);
    this.#failure = options.failure ?? {};
    this.#scheduler = options.scheduler ?? timeoutScheduler;
    this.#random = seededRandom(options.seed ?? 1);
    this.schema = relationSchema(options.relation);
    this.rowCount = options.reportRowCount === false ? null : options.relation.rowCount;
    this.#onFetch = hooks.onFetch;
    this.#onDeliver = hooks.onDeliver;
    this.#onFailure = (): void => {
      hooks.onFailure();
    };
    this.#trackConcurrency = hooks.onConcurrency;
  }

  readonly #trackConcurrency: (value: number) => void;

  #delay(): number {
    const jitter = this.#latency.jitterMs ?? 0;
    return this.#latency.baseMs + (jitter === 0 ? 0 : this.#random() * jitter);
  }

  #shouldFail(fetchIndex: number, startPosition: number): boolean {
    const everyNth = this.#failure.everyNth ?? 0;
    if (everyNth > 0 && fetchIndex % everyNth === 0) return true;
    const firstAttempts = this.#failure.firstAttempts ?? 0;
    if (firstAttempts > 0) {
      const attempts = (this.#attempts.get(startPosition) ?? 0) + 1;
      this.#attempts.set(startPosition, attempts);
      if (attempts <= firstAttempts) return true;
    }
    return false;
  }

  #buildChunk(startPosition: number, rowCount: number): ResultChunk {
    const valueFor = this.#shape.valueFor ?? generateValue;
    const columns = this.#shape.columns.map((column, columnIndex) => {
      const values = new Array<unknown>(rowCount);
      for (let offset = 0; offset < rowCount; offset += 1) {
        values[offset] = valueFor(column.type, columnIndex, startPosition + offset);
      }
      return buildVector(column.type, values);
    });
    return createResultChunk(startPosition, rowCount, columns);
  }

  #fetchIndex = 0;

  fetch(request: FetchRequest, signal?: AbortSignal): Promise<ResultChunk> {
    if (this.#closed) {
      return Promise.reject(new TableDataError('session-closed', 'Mock session is closed'));
    }
    const start = Math.max(0, Math.trunc(request.startPosition));
    const total = this.#shape.rowCount;
    const rows = Math.max(0, Math.min(request.maxRows, total - start));
    const fetchIndex = ++this.#fetchIndex;
    this.#onFetch();
    this.#inFlight += 1;
    this.#maxInFlight = Math.max(this.#maxInFlight, this.#inFlight);
    this.#trackConcurrency(this.#maxInFlight);

    return new Promise<ResultChunk>((resolve, reject) => {
      this.#scheduler(() => {
        this.#inFlight -= 1;
        if (signal?.aborted === true) {
          reject(new TableDataError('aborted', 'Fetch aborted'));
          return;
        }
        if (this.#closed) {
          reject(new TableDataError('session-closed', 'Mock session is closed'));
          return;
        }
        if (this.#shouldFail(fetchIndex, start)) {
          this.#onFailure();
          reject(
            new TableDataError(
              this.#failure.code ?? 'fetch-failed',
              `Simulated failure at row ${start}`,
            ),
          );
          return;
        }
        this.#onDeliver(rows);
        resolve(this.#buildChunk(start, rows));
      }, this.#delay());
    });
  }

  close(): Promise<void> {
    this.#closed = true;
    return Promise.resolve();
  }
}

export class MockTableDataSource implements TableDataSource {
  readonly #options: MockTableDataSourceOptions;
  #session: MockTableDataSession | null = null;
  #fetches = 0;
  #failures = 0;
  #rowsDelivered = 0;
  #maxConcurrent = 0;

  constructor(options: MockTableDataSourceOptions) {
    this.#options = options;
  }

  get relation(): RelationShape {
    return this.#options.relation;
  }

  stats(): MockStats {
    return {
      fetches: this.#fetches,
      failures: this.#failures,
      rowsDelivered: this.#rowsDelivered,
      maxConcurrentFetches: this.#maxConcurrent,
    };
  }

  open(): Promise<TableDataSession> {
    if (this.#options.failOpen !== undefined) {
      return Promise.reject(
        new TableDataError(this.#options.failOpen, 'Simulated failure opening the table'),
      );
    }
    this.#session = new MockTableDataSession(this.#options, {
      onFetch: (): void => {
        this.#fetches += 1;
      },
      onDeliver: (rows): void => {
        this.#rowsDelivered += rows;
      },
      onFailure: (): void => {
        this.#failures += 1;
      },
      onConcurrency: (value): void => {
        this.#maxConcurrent = Math.max(this.#maxConcurrent, value);
      },
    });
    return Promise.resolve(this.#session);
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session !== null) await session.close();
  }
}
