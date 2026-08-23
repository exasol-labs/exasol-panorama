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
import { describeQuery, foreignKeyQuery, quoteLiteral } from '../protocol/sql.js';
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

export class ExasolConnection {
  readonly id: ConnectionId;
  readonly #options: ExasolConnectionOptions;
  readonly #client: ExasolProtocolClient;
  readonly #openResultSets = new Set<number>();
  #status: ConnectionStatus = 'disconnected';
  #session: SessionInfo | null = null;

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
    this.#setStatus('disconnected');
  }

  async openResultSet(sqlText: string): Promise<ExasolResultSetHandle> {
    const response = await this.#client.request<ExecuteResponseData>({
      command: 'execute',
      sqlText,
      attributes: {},
    });
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
  async queryAll(sqlText: string): Promise<ExasolChunk> {
    const resultSet = await this.openResultSet(sqlText);
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

  async listSchemas(): Promise<readonly SchemaInfo[]> {
    const result = await this.queryAll(
      'SELECT SCHEMA_NAME FROM SYS.EXA_ALL_SCHEMAS ORDER BY SCHEMA_NAME',
    );
    return (result.columns[0] ?? []).map((name) => ({ name: String(name) }));
  }

  async listTables(schema: string): Promise<readonly TableInfo[]> {
    const literal = quoteLiteral(schema);
    const result = await this.queryAll(
      `SELECT TABLE_NAME AS OBJECT_NAME, 'TABLE' AS OBJECT_KIND, TABLE_COMMENT AS OBJECT_COMMENT` +
        ` FROM SYS.EXA_ALL_TABLES WHERE TABLE_SCHEMA = ${literal}` +
        ` UNION ALL` +
        ` SELECT VIEW_NAME, 'VIEW', VIEW_COMMENT FROM SYS.EXA_ALL_VIEWS WHERE VIEW_SCHEMA = ${literal}` +
        ` ORDER BY 1`,
    );
    const names = result.columns[0] ?? [];
    const kinds = result.columns[1] ?? [];
    const comments = result.columns[2] ?? [];
    return names.map((name, index) => {
      const comment = comments[index];
      return {
        schema,
        name: String(name),
        kind: String(kinds[index] ?? 'TABLE'),
        ...(comment === null || comment === undefined ? {} : { comment: String(comment) }),
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
