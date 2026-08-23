import type {
  FetchRequest,
  ResultChunk,
  RowFilter,
  TableDataSession,
  TableDataSource,
  TableSchema,
} from '@panorama/table';
import { TableDataError, buildVector, createResultChunk } from '@panorama/table';
import type { ExasolValue } from '../protocol/messages.js';
import { toColumnDataType } from '../protocol/data-types.js';
import { selectAll, selectWhere } from '../protocol/sql.js';
import type { ExasolConnection, ExasolResultSetHandle } from '../connection/connection.js';

/**
 * A Panorama table backed by one live Exasol result set.
 *
 * The result set is opened once and then browsed by position. Those positions
 * are *browsing* positions valid for the lifetime of this result set — never
 * durable row identity — so reopening always starts a fresh session.
 */

export interface ExasolTableDataSourceOptions {
  readonly connection: ExasolConnection;
  readonly schema: string;
  readonly table: string;
  /** Byte budget per protocol fetch. */
  readonly fetchBytes?: number;
  /** Restricts the result set to matching rows; used to follow a foreign key. */
  readonly filter?: RowFilter;
}

class ExasolTableDataSession implements TableDataSession {
  readonly schema: TableSchema;
  readonly rowCount: number;
  readonly #connection: ExasolConnection;
  readonly #resultSet: ExasolResultSetHandle;
  readonly #fetchBytes: number | undefined;
  #closed = false;

  constructor(
    connection: ExasolConnection,
    schema: TableSchema,
    resultSet: ExasolResultSetHandle,
    fetchBytes: number | undefined,
  ) {
    this.#connection = connection;
    this.#resultSet = resultSet;
    this.#fetchBytes = fetchBytes;
    this.schema = schema;
    this.rowCount = resultSet.numRows;
  }

  async fetch(request: FetchRequest, signal?: AbortSignal): Promise<ResultChunk> {
    if (this.#closed) {
      throw new TableDataError('session-closed', 'The result set has been closed');
    }
    const start = Math.max(0, Math.trunc(request.startPosition));
    const wanted = Math.max(0, Math.min(request.maxRows, this.rowCount - start));
    const columnCount = this.schema.columns.length;
    const collected: ExasolValue[][] = Array.from({ length: columnCount }, () => []);
    let loaded = 0;

    while (loaded < wanted) {
      if (signal?.aborted === true) {
        throw new TableDataError('aborted', 'Fetch aborted');
      }
      const chunk = await this.#readRange(start + loaded, wanted - loaded);
      if (chunk.numRows === 0) {
        throw new TableDataError(
          'protocol-error',
          `Exasol returned no rows at position ${start + loaded}`,
        );
      }
      const take = Math.min(chunk.numRows, wanted - loaded);
      for (let index = 0; index < columnCount; index += 1) {
        const values = chunk.columns[index] ?? [];
        (collected[index] as ExasolValue[]).push(...values.slice(0, take));
      }
      loaded += take;
    }

    const vectors = this.schema.columns.map((column, index) =>
      buildVector(column.type, collected[index] ?? []),
    );
    return createResultChunk(start, loaded, vectors);
  }

  /** Reads from the inline response when Exasol delivered the whole result. */
  async #readRange(
    start: number,
    maxRows: number,
  ): Promise<{ numRows: number; columns: readonly (readonly ExasolValue[])[] }> {
    if (this.#resultSet.handle === null) {
      const columns = this.#resultSet.inlineData.map((values) =>
        values.slice(start, start + maxRows),
      );
      return { numRows: columns[0]?.length ?? 0, columns };
    }
    const bytes = this.#fetchBytes;
    return bytes === undefined
      ? this.#connection.fetch(this.#resultSet.handle, start)
      : this.#connection.fetch(this.#resultSet.handle, start, bytes);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#resultSet.handle !== null) {
      await this.#connection.closeResultSet(this.#resultSet.handle);
    }
  }
}

export class ExasolTableDataSource implements TableDataSource {
  readonly #options: ExasolTableDataSourceOptions;
  #session: ExasolTableDataSession | null = null;

  constructor(options: ExasolTableDataSourceOptions) {
    this.#options = options;
  }

  /** Opens a fresh result set, replacing any previous one. */
  async open(): Promise<TableDataSession> {
    await this.close();
    const { connection, schema, table, filter } = this.#options;
    const resultSet = await connection.openResultSet(
      filter === undefined ? selectAll(schema, table) : selectWhere(schema, table, filter),
    );
    const tableSchema: TableSchema = {
      schema,
      table,
      columns: resultSet.columns.map((column) => ({
        name: column.name,
        type: toColumnDataType(column.dataType),
      })),
    };
    const session = new ExasolTableDataSession(
      connection,
      tableSchema,
      resultSet,
      this.#options.fetchBytes,
    );
    this.#session = session;
    return session;
  }

  async close(): Promise<void> {
    const session = this.#session;
    this.#session = null;
    if (session !== null) await session.close();
  }
}
