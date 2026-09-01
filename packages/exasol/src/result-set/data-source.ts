import type {
  CellValue,
  ColumnSummary,
  FetchRequest,
  ResultChunk,
  RowFilter,
  SummaryBin,
  SummaryValueCount,
  TableDataSession,
  TableDataSource,
  TableSchema,
} from '@panorama/table';
import {
  HISTOGRAM_BINS,
  MAX_NAMED_VALUES,
  TableDataError,
  buildVector,
  compareValues,
  createResultChunk,
  isNumericType,
  isOrderedType,
} from '@panorama/table';
import type { ExasolValue } from '../protocol/messages.js';
import { toColumnDataType } from '../protocol/data-types.js';
import {
  selectAll,
  selectWhere,
  summaryAggregateQuery,
  summaryFrequencyQuery,
  summaryHistogramQuery,
} from '../protocol/sql.js';
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
  /**
   * Runs this statement instead of selecting from `table`. `schema` and `table`
   * then only label the result, which is why they stay required: every result
   * set reports where it came from, even one the user wrote by hand.
   */
  readonly sql?: string;
  /**
   * The SQL preprocessor this statement needs, where it reads a JSON wrapper.
   *
   * Carried on the source rather than looked up per query so that a summary and
   * a histogram — which aggregate the *statement*, and therefore inherit its
   * dotted paths — run under the same one the rows did. See `openResultSet`.
   */
  readonly preprocessor?: string;
}

class ExasolTableDataSession implements TableDataSession {
  readonly schema: TableSchema;
  readonly rowCount: number;
  readonly #connection: ExasolConnection;
  readonly #resultSet: ExasolResultSetHandle;
  readonly #fetchBytes: number | undefined;
  /** The statement behind this result set; a summary aggregates it, not the table. */
  readonly #statement: string;
  /** The preprocessor the rows were read under; a summary needs the same one. */
  readonly #preprocessor: string | undefined;
  #closed = false;

  constructor(
    connection: ExasolConnection,
    schema: TableSchema,
    resultSet: ExasolResultSetHandle,
    fetchBytes: number | undefined,
    statement: string,
    preprocessor?: string,
  ) {
    this.#connection = connection;
    this.#resultSet = resultSet;
    this.#fetchBytes = fetchBytes;
    this.#statement = statement;
    this.#preprocessor = preprocessor;
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

  /**
   * Describes one column by asking the database, which is the only way to answer
   * exactly for a result set too large to read.
   *
   * The statement is aggregated rather than the table, so a followed key or a
   * written query is summarised as it is *shown*. Two queries: the counts and
   * extremes, and then the distribution — which is a bar per value when there are
   * few enough values to name, and a bar per range when a numeric column has too
   * many. A column that is neither gets its counts and no chart, which is a
   * truthful answer rather than an invented one.
   */
  async summarise(column: string, signal?: AbortSignal): Promise<ColumnSummary> {
    const type = this.schema.columns.find((entry) => entry.name === column)?.type;
    if (type === undefined) {
      throw new TableDataError('not-found', `No column named ${column}`);
    }
    const numeric = isNumericType(type);
    const aggregate = await this.#queryRows(
      summaryAggregateQuery(this.#statement, column, numeric),
      signal,
    );
    const rows = toCount(aggregate[0]?.[0]);
    const present = toCount(aggregate[1]?.[0]);
    const distinct = toCount(aggregate[2]?.[0]);
    const min = toCell(aggregate[3]?.[0]);
    const max = toCell(aggregate[4]?.[0]);
    const mean = numeric ? toCell(aggregate[5]?.[0]) : null;
    const sum = numeric ? toCell(aggregate[6]?.[0]) : null;
    // Null from the database rather than absent: `STDDEV` of a single row has no
    // answer and says so, which is the same thing the in-memory builder says.
    const deviation = numeric ? toCell(aggregate[7]?.[0]) : null;

    const base: ColumnSummary = {
      column,
      rows,
      nulls: rows - present,
      basis: 'exact',
      distinct,
      ...(min === null ? {} : { min }),
      ...(max === null ? {} : { max }),
      ...(mean === null ? {} : { mean: Number(mean) }),
      ...(sum === null ? {} : { sum: Number(sum) }),
      ...(deviation === null ? {} : { stdDev: Number(deviation) }),
    };
    if (present === 0) return base;

    // Few enough values to name them: those bars *are* the distribution.
    if (distinct <= MAX_NAMED_VALUES) {
      const named = await this.#frequencies(column, distinct, signal);
      return {
        ...base,
        frequencies: isOrderedType(type)
          ? [...named].sort((a, b) => compareValues(a.value, b.value))
          : named,
        frequenciesComplete: true,
      };
    }
    if (numeric) {
      const low = Number(min);
      const high = Number(max);
      if (!Number.isFinite(low) || !Number.isFinite(high) || high === low) {
        return { ...base, bins: [{ from: low, to: low, count: present }] };
      }
      return { ...base, bins: await this.#bins(column, low, high, signal) };
    }
    return {
      ...base,
      frequencies: await this.#frequencies(column, MAX_NAMED_VALUES, signal),
      frequenciesComplete: false,
    };
  }

  async #frequencies(
    column: string,
    limit: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly SummaryValueCount[]> {
    const [values, counts] = await this.#queryPairs(
      summaryFrequencyQuery(this.#statement, column, Math.max(1, limit)),
      signal,
    );
    return values.map((value, index) => ({
      value: value as SummaryValueCount['value'],
      count: toCount(counts[index]),
    }));
  }

  async #bins(
    column: string,
    low: number,
    high: number,
    signal: AbortSignal | undefined,
  ): Promise<readonly SummaryBin[]> {
    const [indices, counts] = await this.#queryPairs(
      summaryHistogramQuery(this.#statement, column, low, high, HISTOGRAM_BINS),
      signal,
    );
    const width = (high - low) / HISTOGRAM_BINS;
    // Every bin, not only the ones with rows in them: a gap in a distribution is
    // part of its shape, and a chart that closes the gaps up tells a different
    // story from the data.
    const filled = new Array<number>(HISTOGRAM_BINS).fill(0);
    indices.forEach((index, position) => {
      const bin = Math.trunc(Number(index));
      if (bin >= 0 && bin < HISTOGRAM_BINS) filled[bin] = toCount(counts[position]);
    });
    return filled.map((count, index) => ({
      from: low + index * width,
      to: low + (index + 1) * width,
      count,
    }));
  }

  /**
   * The two columns of a grouped answer: a thing and how many of it there were.
   *
   * A database that answers with fewer columns than that has said nothing about
   * the distribution, which is a chart with no bars rather than a failure.
   */
  async #queryPairs(
    statement: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly [readonly ExasolValue[], readonly ExasolValue[]]> {
    const columns = await this.#queryRows(statement, signal);
    return [columns[0] ?? [], columns[1] ?? []];
  }

  /** Runs a one-off aggregate and returns its columns, closing what it opened. */
  async #queryRows(
    statement: string,
    signal: AbortSignal | undefined,
  ): Promise<readonly (readonly ExasolValue[])[]> {
    if (this.#closed) {
      throw new TableDataError('session-closed', 'The result set has been closed');
    }
    if (signal?.aborted === true) throw new TableDataError('aborted', 'Summary abandoned');
    const result = await this.#connection.queryAll(statement, this.#preprocessor);
    return result.columns;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#resultSet.handle !== null) {
      await this.#connection.closeResultSet(this.#resultSet.handle);
    }
  }
}

/** An aggregate's value, or `null` for the SQL null and the absent column. */
const toCell = (value: ExasolValue | undefined): CellValue | null =>
  value === undefined || value === null ? null : (value as CellValue);

/** A count from an aggregate, which Exasol may deliver as digits. */
const toCount = (value: ExasolValue | undefined): number => {
  const numeric = Number(value ?? 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

export class ExasolTableDataSource implements TableDataSource {
  readonly #options: ExasolTableDataSourceOptions;
  #session: ExasolTableDataSession | null = null;

  constructor(options: ExasolTableDataSourceOptions) {
    this.#options = options;
  }

  /** Opens a fresh result set, replacing any previous one. */
  async open(): Promise<TableDataSession> {
    await this.close();
    const { connection, schema, table, filter, sql, preprocessor } = this.#options;
    const statement =
      sql ?? (filter === undefined ? selectAll(schema, table) : selectWhere(schema, table, filter));
    const resultSet = await connection.openResultSet(statement, preprocessor);
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
      statement,
      preprocessor,
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
