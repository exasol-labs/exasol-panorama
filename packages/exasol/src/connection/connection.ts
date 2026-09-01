import type { ConnectionId } from '@panorama/core';
import { createIdFactory } from '@panorama/core';
import type { ForeignKeyReference, SchemaInfo, TableInfo, TableSchema } from '@panorama/table';
import { TableDataError } from '@panorama/table';
import type {
  ExasolColumn,
  ExasolValue,
  ExecuteResponseData,
  FetchResponseData,
  LoginChallenge,
  SessionInfo,
} from '../protocol/messages.js';
import { DEFAULT_PROTOCOL_VERSION, isResultSet } from '../protocol/messages.js';
import { toColumnDataType } from '../protocol/data-types.js';
import type { RsaPublicKey } from '../protocol/rsa.js';
import { encryptPassword, publicKeyFromHex, publicKeyFromPem } from '../protocol/rsa.js';
import {
  describeQuery,
  foreignKeyQuery,
  quoteLiteral,
  setPreprocessorStatement,
} from '../protocol/sql.js';
import type { WrapperSurface } from './json-wrapper.js';
import { readWrapperSurface } from './json-wrapper.js';
import { ExasolProtocolClient } from './client.js';
import type { ExasolClientOptions } from './client.js';
import type { SocketFactory } from './socket.js';

/**
 * Panorama-level Exasol connection.
 *
 * Exposes schemas, tables, result sets and range fetches. Credentials enter
 * here and never leave: the world model, history, logs and any future MCP
 * resource only ever see the `connectionId`.
 */

export interface PasswordCredentialsInput {
  readonly kind: 'password';
  readonly username: string;
  readonly password: string;
}

export interface TokenCredentialsInput {
  readonly kind: 'token';
  /** Exasol SaaS personal access token. */
  readonly token: string;
}

export type ExasolCredentials = PasswordCredentialsInput | TokenCredentialsInput;

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'failed';

export interface ExasolConnectionOptions {
  /** For example `wss://demo.exasol.com:8563`. */
  readonly url: string;
  readonly credentials: ExasolCredentials;
  readonly socketFactory?: SocketFactory;
  readonly connectTimeoutMs?: number;
  readonly protocolVersion?: number;
  readonly clientName?: string;
  readonly clientVersion?: string;
  /** Byte budget for a single protocol fetch; Exasol allows up to 64 MB. */
  readonly fetchBytes?: number;
  readonly randomBytes?: (length: number) => Uint8Array;
  readonly onStatusChange?: (status: ConnectionStatus, error?: TableDataError) => void;
  readonly id?: ConnectionId;
}

/** A live result set. `handle` is `null` when Exasol inlined the whole result. */
export interface ExasolResultSetHandle {
  readonly handle: number | null;
  readonly columns: readonly ExasolColumn[];
  readonly numRows: number;
  readonly numRowsInMessage: number;
  /** Column-oriented inline rows delivered with the `execute` response. */
  readonly inlineData: readonly (readonly ExasolValue[])[];
}

/** Column-oriented rows: `columns[column][row]`. */
export interface ExasolChunk {
  readonly numRows: number;
  readonly columns: readonly (readonly ExasolValue[])[];
}

export const DEFAULT_FETCH_BYTES = 5 * 1024 * 1024;
export const MAX_FETCH_BYTES = 64 * 1024 * 1024;

const CLIENT_OS = 'browser';
const CLIENT_RUNTIME = 'JavaScript';

/**
 * A count from the catalogue, which Exasol may deliver as digits rather than as
 * a JSON number: `TABLE_ROW_COUNT` is a `DECIMAL(18,0)`, and eighteen digits is
 * more than a double is trusted with. Absent rather than zero when the database
 * has no figure — a table whose statistics have never been gathered has none,
 * and "unknown" is not "empty".
 */
const toRowCount = (value: ExasolValue | undefined): number | undefined => {
  if (value === null || value === undefined) return undefined;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

/**
 * A catalogue flag, as a flag.
 *
 * `SCHEMA_IS_VIRTUAL` and `TABLE_IS_VIRTUAL` come back as booleans over the
 * protocol, but a driver that reads `'false'` as true because it is a non-empty
 * string is a whole class of bug, and this is the one place to not have it. Only
 * `true` is true.
 */
const toFlag = (value: ExasolValue | undefined): boolean =>
  value === true || value === 'true' || value === 1;

export class ExasolConnection {
  readonly id: ConnectionId;
  readonly #options: ExasolConnectionOptions;
  readonly #client: ExasolProtocolClient;
  readonly #openResultSets = new Set<number>();
  #status: ConnectionStatus = 'disconnected';
  #session: SessionInfo | null = null;
  /**
   * The SQL preprocessor this session is currently set to.
   *
   * Tracked so the steady state costs nothing: a statement asking for the
   * preprocessor already in force sends no `ALTER SESSION`, and only a switch
   * between wrapper packages pays for one. `null` is "none", which is also what a
   * fresh session has.
   */
  #preprocessor: string | null = null;
  /**
   * The wrapper packages on this connection, once asked for.
   *
   * Read lazily rather than on connect: it costs a round trip per package — about
   * six hundred milliseconds on an instance with twenty of them — and a connection
   * that never opens a document table should not pay it. Held for the session,
   * because a package being installed while somebody is reading is worth a
   * reconnect rather than a poll.
   */
  #wrapperSurface: WrapperSurface | null = null;

  constructor(options: ExasolConnectionOptions) {
    this.#options = options;
    this.id = options.id ?? createIdFactory().connection();
    const clientOptions: ExasolClientOptions = {
      url: options.url,
      ...(options.socketFactory === undefined ? {} : { socketFactory: options.socketFactory }),
      ...(options.connectTimeoutMs === undefined
        ? {}
        : { connectTimeoutMs: options.connectTimeoutMs }),
      onUnexpectedClose: (error): void => {
        this.#openResultSets.clear();
        this.#setStatus('failed', error);
      },
    };
    this.#client = new ExasolProtocolClient(clientOptions);
  }

  get status(): ConnectionStatus {
    return this.#status;
  }

  get sessionInfo(): SessionInfo | null {
    return this.#session;
  }

  /** Result-set handles this connection still owns; all are closed on disconnect. */
  get openResultSetCount(): number {
    return this.#openResultSets.size;
  }

  #setStatus(status: ConnectionStatus, error?: TableDataError): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#options.onStatusChange?.(status, error);
  }

  async open(): Promise<void> {
    this.#setStatus('connecting');
    try {
      await this.#client.connect();
      this.#session = await this.#login();
      this.#setStatus('connected');
    } catch (error) {
      const failure =
        error instanceof TableDataError
          ? error
          : new TableDataError('connection-failed', 'Failed to open Exasol connection', error);
      this.#setStatus('failed', failure);
      throw failure;
    }
  }

  async #login(): Promise<SessionInfo> {
    const protocolVersion = this.#options.protocolVersion ?? DEFAULT_PROTOCOL_VERSION;
    const clientInfo = {
      clientName: this.#options.clientName ?? 'Exasol Panorama',
      clientVersion: this.#options.clientVersion ?? '0.1.0',
      clientOs: CLIENT_OS,
      clientRuntime: CLIENT_RUNTIME,
      useCompression: false,
      attributes: {},
    };

    if (this.#options.credentials.kind === 'token') {
      await this.#client.request<LoginChallenge>({ command: 'loginToken', protocolVersion });
      return this.#client.request<SessionInfo>({
        ...clientInfo,
        token: this.#options.credentials.token,
      });
    }

    const challenge = await this.#client.request<LoginChallenge>({
      command: 'login',
      protocolVersion,
    });
    const key = publicKeyFrom(challenge);
    return this.#client.request<SessionInfo>({
      ...clientInfo,
      username: this.#options.credentials.username,
      password: encryptPassword(key, this.#options.credentials.password, this.#options.randomBytes),
    });
  }

  /**
   * Closes every result set this connection owns and disconnects. Result-set
   * cleanup is mandatory resource management, not optional tidying.
   */
  async close(): Promise<void> {
    if (this.#status === 'connected' && this.#openResultSets.size > 0) {
      const handles = [...this.#openResultSets];
      this.#openResultSets.clear();
      try {
        await this.#client.request({ command: 'closeResultSet', resultSetHandles: handles });
      } catch {
        // The connection is going away regardless; the server frees the handles.
      }
    }
    if (this.#status === 'connected') {
      try {
        await this.#client.request({ command: 'disconnect' });
      } catch {
        // Ignore: a server that already hung up needs no goodbye.
      }
    }
    this.#client.close();
    this.#session = null;
    // A new session starts with no preprocessor, so the tracked value must not
    // outlive the one it described. The surface is catalogue state and could in
    // principle survive, but a reconnect is exactly when a newly installed
    // package should be noticed.
    this.#preprocessor = null;
    this.#wrapperSurface = null;
    this.#setStatus('disconnected');
  }

  /**
   * Runs a statement, optionally under a named SQL preprocessor.
   *
   * The preprocessor is what rewrites the dotted paths and array selectors of a
   * JSON wrapper surface, and Exasol allows **one per session** — so a canvas with
   * boxes from two wrapper packages cannot set it once and be done. It is set here
   * instead, per statement, which costs about two milliseconds and only when it
   * changes.
   *
   * The two requests are enqueued **in one synchronous block, deliberately**. The
   * protocol carries no correlation ids, so `ExasolProtocolClient` keeps a strict
   * FIFO queue and sends one request at a time; two pushed without yielding are
   * therefore adjacent in it, and no other caller's statement can land between the
   * setting and the statement it is for. An `await` between these two lines would
   * open exactly that gap, and the symptom would be one box's query silently
   * running under another box's preprocessor.
   */
  async openResultSet(
    sqlText: string,
    preprocessor?: string | null,
  ): Promise<ExasolResultSetHandle> {
    const setting =
      preprocessor === undefined || preprocessor === this.#preprocessor
        ? null
        : this.#client.request({
            command: 'execute',
            sqlText: setPreprocessorStatement(preprocessor),
            attributes: {},
          });
    const executed = this.#client.request<ExecuteResponseData>({
      command: 'execute',
      sqlText,
      attributes: {},
    });
    if (setting !== null) {
      // Awaited before the statement's own answer so a refused setting is
      // reported as itself. Its position in the queue is already fixed.
      await setting;
      this.#preprocessor = preprocessor ?? null;
    }
    const response = await executed;
    const first = response.results[0];
    if (first === undefined || !isResultSet(first)) {
      throw new TableDataError('protocol-error', 'Query did not produce a result set');
    }
    const { resultSet } = first;
    if (resultSet.resultSetHandle !== undefined)
      this.#openResultSets.add(resultSet.resultSetHandle);
    return {
      handle: resultSet.resultSetHandle ?? null,
      columns: resultSet.columns,
      numRows: resultSet.numRows,
      numRowsInMessage: resultSet.numRowsInMessage,
      inlineData: resultSet.data ?? [],
    };
  }

  /**
   * The wrapper surface if it has already been read, without reading it.
   *
   * For the one caller that cannot wait: choosing a statement's preprocessor
   * happens on the way to running it, and an await there would put a catalogue
   * round trip in front of every query. `null` before the first read, which means
   * no preprocessor — correct, because nothing can have seeded a wrapper statement
   * before the surface was known either.
   */
  wrapperSurfaceIfRead(): WrapperSurface | null {
    return this.#wrapperSurface;
  }

  /** The JSON wrapper packages installed here; see `readWrapperSurface`. */
  async wrapperSurface(): Promise<WrapperSurface> {
    this.#wrapperSurface ??= await readWrapperSurface(
      async (sqlText) => (await this.queryAll(sqlText)).columns,
    );
    return this.#wrapperSurface;
  }

  /**
   * Fetches rows at an arbitrary position in an open result set — the
   * mechanism that lets Panorama browse a billion-row relation without ever
   * issuing `OFFSET`.
   */
  async fetch(handle: number, startPosition: number, numBytes?: number): Promise<ExasolChunk> {
    const budget = Math.min(
      MAX_FETCH_BYTES,
      Math.max(1, numBytes ?? this.#options.fetchBytes ?? DEFAULT_FETCH_BYTES),
    );
    const response = await this.#client.request<FetchResponseData>({
      command: 'fetch',
      resultSetHandle: handle,
      startPosition,
      numBytes: budget,
    });
    return { numRows: response.numRows, columns: response.data };
  }

  async closeResultSet(handle: number): Promise<void> {
    if (!this.#openResultSets.delete(handle)) return;
    await this.#client.request({ command: 'closeResultSet', resultSetHandles: [handle] });
  }

  /** Runs a query and returns every row, column-oriented. For metadata only. */
  async queryAll(sqlText: string, preprocessor?: string | null): Promise<ExasolChunk> {
    const resultSet = await this.openResultSet(sqlText, preprocessor);
    const columns: ExasolValue[][] = resultSet.columns.map((_, index) => [
      ...(resultSet.inlineData[index] ?? []),
    ]);
    let loaded = columns[0]?.length ?? resultSet.numRowsInMessage;

    try {
      while (loaded < resultSet.numRows && resultSet.handle !== null) {
        const chunk = await this.fetch(resultSet.handle, loaded);
        if (chunk.numRows === 0) {
          throw new TableDataError('protocol-error', 'Exasol returned an empty fetch');
        }
        chunk.columns.forEach((values, index) => {
          (columns[index] as ExasolValue[]).push(...values);
        });
        loaded += chunk.numRows;
      }
    } finally {
      if (resultSet.handle !== null) await this.closeResultSet(resultSet.handle);
    }
    return { numRows: loaded, columns };
  }

  /**
   * Lists the schemas, saying which of them are virtual.
   *
   * Virtual is not a decoration: a virtual schema's tables are held by another
   * system, so they have no row count here and reading one federates out. The
   * explorer says so, and an agent choosing where to compute needs to know.
   */
  async listSchemas(): Promise<readonly SchemaInfo[]> {
    const result = await this.queryAll(
      'SELECT SCHEMA_NAME, SCHEMA_IS_VIRTUAL FROM SYS.EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME',
    );
    const virtual = result.columns[1] ?? [];
    return (result.columns[0] ?? []).map((name, index) => ({
      name: String(name),
      // Said only when it is true: absent means an ordinary schema, and every
      // schema carrying `virtual: false` would be noise in every answer.
      ...(toFlag(virtual[index]) ? { virtual: true } : {}),
    }));
  }

  /**
   * Lists the relations in a schema, with the row count the catalogue knows.
   *
   * A table's count comes free with this query — `EXA_ALL_TABLES` records it —
   * and it is the database's own figure, maintained with its statistics rather
   * than counted here. A *view* has no count in the catalogue at all: the only
   * way to know how many rows one has is to run it, and a view over a
   * ten-billion-row table would then charge an arbitrary query for the
   * privilege of opening a schema. So a view's count is absent rather than
   * guessed at or paid for.
   */
  async listTables(schema: string): Promise<readonly TableInfo[]> {
    const literal = quoteLiteral(schema);
    const result = await this.queryAll(
      `SELECT TABLE_NAME AS OBJECT_NAME, 'TABLE' AS OBJECT_KIND, TABLE_COMMENT AS OBJECT_COMMENT` +
        `, TABLE_ROW_COUNT AS OBJECT_ROWS, TABLE_IS_VIRTUAL AS OBJECT_IS_VIRTUAL` +
        ` FROM SYS.EXA_ALL_TABLES WHERE TABLE_SCHEMA = ${literal}` +
        ` UNION ALL` +
        // A view is never virtual: what can be virtual is the table an adapter
        // stands in front of, and a view over one is still a view held here.
        ` SELECT VIEW_NAME, 'VIEW', VIEW_COMMENT, CAST(NULL AS DECIMAL(18,0)), FALSE` +
        ` FROM SYS.EXA_ALL_VIEWS WHERE VIEW_SCHEMA = ${literal}` +
        ` ORDER BY 1`,
    );
    const names = result.columns[0] ?? [];
    const kinds = result.columns[1] ?? [];
    const comments = result.columns[2] ?? [];
    const rowCounts = result.columns[3] ?? [];
    const virtual = result.columns[4] ?? [];
    return names.map((name, index) => {
      const comment = comments[index];
      const rowCount = toRowCount(rowCounts[index]);
      return {
        schema,
        name: String(name),
        kind: String(kinds[index] ?? 'TABLE'),
        ...(comment === null || comment === undefined ? {} : { comment: String(comment) }),
        ...(rowCount === undefined ? {} : { rowCount }),
        ...(toFlag(virtual[index]) ? { virtual: true } : {}),
      };
    });
  }

  /**
   * Single-column foreign keys on a table, keyed by column name.
   *
   * Read from the catalogue: result-set metadata carries types but not
   * constraints.
   */
  async listForeignKeys(
    schema: string,
    table: string,
  ): Promise<ReadonlyMap<string, ForeignKeyReference>> {
    const result = await this.queryAll(foreignKeyQuery(schema, table));
    const columns = result.columns[0] ?? [];
    const references = new Map<string, ForeignKeyReference>();
    for (let row = 0; row < columns.length; row += 1) {
      const name = columns[row];
      const referencedSchema = result.columns[1]?.[row];
      const referencedTable = result.columns[2]?.[row];
      const referencedColumn = result.columns[3]?.[row];
      if (
        name === null ||
        name === undefined ||
        referencedSchema === null ||
        referencedSchema === undefined ||
        referencedTable === null ||
        referencedTable === undefined ||
        referencedColumn === null ||
        referencedColumn === undefined
      ) {
        continue;
      }
      references.set(String(name), {
        schema: String(referencedSchema),
        table: String(referencedTable),
        column: String(referencedColumn),
        constraint: String(result.columns[4]?.[row] ?? ''),
      });
    }
    return references;
  }

  /**
   * Column metadata for a table.
   *
   * The projection is the same `SELECT *` the result set will use, so the
   * entity's columns always line up with the fetched chunks; foreign keys come
   * from the catalogue alongside it.
   */
  async describeTable(schema: string, table: string): Promise<TableSchema> {
    const resultSet = await this.openResultSet(describeQuery(schema, table));
    if (resultSet.handle !== null) await this.closeResultSet(resultSet.handle);
    const foreignKeys = await this.listForeignKeys(schema, table);
    return {
      schema,
      table,
      columns: resultSet.columns.map((column) => {
        const reference = foreignKeys.get(column.name);
        return {
          name: column.name,
          type: toColumnDataType(column.dataType),
          ...(reference === undefined ? {} : { foreignKey: reference }),
        };
      }),
    };
  }
}

const publicKeyFrom = (challenge: LoginChallenge): RsaPublicKey => {
  if (
    typeof challenge.publicKeyModulus === 'string' &&
    typeof challenge.publicKeyExponent === 'string'
  ) {
    return publicKeyFromHex(challenge.publicKeyModulus, challenge.publicKeyExponent);
  }
  if (typeof challenge.publicKeyPem === 'string') return publicKeyFromPem(challenge.publicKeyPem);
  throw new TableDataError('protocol-error', 'Login response contained no public key');
};
