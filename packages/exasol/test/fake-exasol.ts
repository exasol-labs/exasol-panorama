import type { SocketCloseEvent, SocketLike } from '@panorama/exasol';
import { SOCKET_CLOSED, SOCKET_CONNECTING, SOCKET_OPEN } from '@panorama/exasol';

/** A scripted WebSocket. Tests drive open/message/close explicitly. */
export class FakeSocket implements SocketLike {
  readyState = SOCKET_CONNECTING;
  readonly sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: SocketCloseEvent) => void) | null = null;
  closedWith: { code?: number; reason?: string } | null = null;

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  send(data: string): void {
    this.sent.push(data);
    this.onRequest?.(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = {
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    };
    this.readyState = SOCKET_CLOSED;
  }

  /** Installed by the fake server to react to outgoing requests. */
  onRequest: ((request: Record<string, unknown>) => void) | null = null;

  acceptConnection(): void {
    this.readyState = SOCKET_OPEN;
    this.onopen?.();
  }

  failConnection(): void {
    this.onerror?.(new Error('refused'));
  }

  deliver(message: unknown): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  deliverRaw(data: unknown): void {
    this.onmessage?.({ data });
  }

  serverClose(code = 1006, reason = 'lost'): void {
    this.readyState = SOCKET_CLOSED;
    this.onclose?.({ code, reason });
  }

  lastRequest(): Record<string, unknown> {
    const last = this.sent.at(-1);
    if (last === undefined) throw new Error('No request was sent');
    return JSON.parse(last) as Record<string, unknown>;
  }
}

export type ExasolValue = string | number | boolean | null;

export interface FakeRelation {
  readonly columns: ReadonlyArray<{ name: string; dataType: Record<string, unknown> }>;
  /** Column-oriented values. */
  readonly data: readonly (readonly ExasolValue[])[];
  readonly rowCount: number;
}

export interface FakeServerOptions {
  /** Rows delivered inline with the `execute` response. */
  readonly inlineRows?: number;
  /**
   * Refuses `setAttributes`, the way an older server or a read-only attribute
   * does. Browsing must survive it: the value formats are then merely unpinned.
   */
  readonly refuseAttributes?: boolean;
  /** Maximum rows a single `fetch` may return, simulating the byte budget. */
  readonly rowsPerFetch?: number;
  readonly relations?: Record<string, FakeRelation>;
  /**
   * Canned answers matched before `relations`, for queries that mention a
   * relation but do not return it — an aggregate over a subquery, say.
   */
  readonly queries?: Record<string, FakeRelation>;
  /**
   * Schema names, or names with the virtual flag the real catalogue carries.
   *
   * A plain string is an ordinary schema, which keeps every existing case
   * readable; the object form is for the ones held by another system.
   */
  readonly schemas?: readonly (string | { name: string; virtual?: boolean | string })[];
  readonly tables?: Record<
    string,
    ReadonlyArray<{
      name: string;
      kind: string;
      comment: string | null;
      /** What the catalogue reports; a view has none, as the real one has none. */
      rows?: number | string | null;
      /** `TABLE_IS_VIRTUAL`, as the real catalogue sends it. */
      virtual?: boolean | string;
    }>
  >;
  /** Single-column foreign keys, keyed by the table that declares them. */
  readonly foreignKeys?: Record<
    string,
    ReadonlyArray<{
      readonly column: string;
      readonly referencedSchema: string;
      readonly referencedTable: string;
      readonly referencedColumn: string;
      readonly constraint: string;
    }>
  >;
}

/** 2048-bit-shaped modulus; the tests never decrypt, only check the envelope. */
export const FAKE_MODULUS_HEX = 'c3' + 'a7b91d5e'.repeat(62) + 'f1';
export const FAKE_EXPONENT_HEX = '010001';

export const buildRelation = (
  columns: ReadonlyArray<{ name: string; dataType: Record<string, unknown> }>,
  rowCount: number,
  value: (column: number, row: number) => ExasolValue,
): FakeRelation => ({
  columns,
  rowCount,
  data: columns.map((_, columnIndex) =>
    Array.from({ length: rowCount }, (__, row) => value(columnIndex, row)),
  ),
});

interface OpenResultSet {
  readonly relation: FakeRelation;
  closed: boolean;
}

/**
 * An in-memory Exasol speaking the real protocol shapes: login handshake,
 * execute with an optional result-set handle, positional fetch, and explicit
 * result-set close.
 */
export class FakeExasolServer {
  readonly sockets: FakeSocket[] = [];
  readonly resultSets = new Map<number, OpenResultSet>();
  readonly executed: string[] = [];
  /** The attribute sets Panorama asked for, in order. */
  readonly attributesSet: Array<Record<string, unknown>> = [];
  readonly fetches: Array<{ handle: number; startPosition: number; numBytes: number }> = [];
  #nextHandle = 1;
  #loggedIn = false;

  readonly #options: FakeServerOptions;

  constructor(options: FakeServerOptions = {}) {
    this.#options = options;
  }

  get socket(): FakeSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('No socket has been created');
    return socket;
  }

  get openResultSetCount(): number {
    return [...this.resultSets.values()].filter((entry) => !entry.closed).length;
  }

  /** Socket factory to hand to `ExasolConnection`. */
  readonly factory = (url: string): FakeSocket => {
    const socket = new FakeSocket(url);
    socket.onRequest = (request): void => {
      queueMicrotask(() => {
        this.#respond(socket, request);
      });
    };
    this.sockets.push(socket);
    queueMicrotask(() => {
      socket.acceptConnection();
    });
    return socket;
  };

  #respond(socket: FakeSocket, request: Record<string, unknown>): void {
    const command = request['command'];
    if (command === 'login') {
      socket.deliver({
        status: 'ok',
        responseData: {
          publicKeyPem: '-----BEGIN PUBLIC KEY-----\nMII\n-----END PUBLIC KEY-----',
          publicKeyModulus: FAKE_MODULUS_HEX,
          publicKeyExponent: FAKE_EXPONENT_HEX,
        },
      });
      return;
    }
    if (command === 'loginToken') {
      socket.deliver({ status: 'ok', responseData: {} });
      return;
    }
    if (command === undefined && !this.#loggedIn) {
      this.#loggedIn = true;
      socket.deliver({
        status: 'ok',
        responseData: {
          sessionId: 42,
          protocolVersion: 3,
          releaseVersion: '8.0.0',
          databaseName: 'TESTDB',
          productName: 'EXASolution',
          maxDataMessageSize: 64 * 1024 * 1024,
          maxIdentifierLength: 128,
          maxVarcharLength: 2_000_000,
          identifierQuoteString: '"',
          timeZone: 'UTC',
          timeZoneBehavior: 'INVALID SHIFT AMBIGUOUS ST',
        },
      });
      return;
    }
    if (command === 'execute') {
      this.#execute(socket, String(request['sqlText']));
      return;
    }
    if (command === 'fetch') {
      this.#fetch(socket, request);
      return;
    }
    if (command === 'closeResultSet') {
      for (const handle of request['resultSetHandles'] as number[]) {
        const entry = this.resultSets.get(handle);
        if (entry !== undefined) entry.closed = true;
      }
      socket.deliver({ status: 'ok', responseData: {} });
      return;
    }
    if (command === 'setAttributes') {
      // Recorded rather than merely accepted: what Panorama pins is the point,
      // and a silent acceptance would let it pin nothing and still pass.
      this.attributesSet.push(
        (request as { attributes?: Record<string, unknown> }).attributes ?? {},
      );
      if (this.#options.refuseAttributes === true) {
        socket.deliver({
          status: 'error',
          exception: { text: 'Cannot set read-only protocol attribute', sqlCode: '00000' },
        });
        return;
      }
      socket.deliver({ status: 'ok', responseData: {} });
      return;
    }
    if (command === 'disconnect') {
      socket.deliver({ status: 'ok' });
      return;
    }
    socket.deliver({
      status: 'error',
      exception: { text: `Unknown command ${String(command)}`, sqlCode: '00000' },
    });
  }

  #relationFor(sqlText: string): FakeRelation | null {
    this.executed.push(sqlText);
    // Catalogue queries first: a relation name can appear inside one.
    if (sqlText.includes('EXA_ALL_CONSTRAINT_COLUMNS')) {
      const table = /CONSTRAINT_TABLE = '([^']*)'/.exec(sqlText)?.[1] ?? '';
      const keys = this.#options.foreignKeys?.[table] ?? [];
      return {
        columns: [
          { name: 'COLUMN_NAME', dataType: { type: 'VARCHAR', size: 128 } },
          { name: 'REFERENCED_SCHEMA', dataType: { type: 'VARCHAR', size: 128 } },
          { name: 'REFERENCED_TABLE', dataType: { type: 'VARCHAR', size: 128 } },
          { name: 'REFERENCED_COLUMN', dataType: { type: 'VARCHAR', size: 128 } },
          { name: 'CONSTRAINT_NAME', dataType: { type: 'VARCHAR', size: 128 } },
        ],
        rowCount: keys.length,
        data: [
          keys.map((key) => key.column),
          keys.map((key) => key.referencedSchema),
          keys.map((key) => key.referencedTable),
          keys.map((key) => key.referencedColumn),
          keys.map((key) => key.constraint),
        ],
      };
    }
    for (const [pattern, relation] of Object.entries(this.#options.queries ?? {})) {
      if (sqlText.includes(pattern)) return relation;
    }
    const relations = this.#options.relations ?? {};
    for (const [pattern, relation] of Object.entries(relations)) {
      if (sqlText.includes(pattern)) return relation;
    }
    if (sqlText.includes('EXA_ALL_SCHEMAS')) {
      const listed = (this.#options.schemas ?? []).map((entry) =>
        typeof entry === 'string' ? { name: entry } : entry,
      );
      return {
        columns: [
          { name: 'SCHEMA_NAME', dataType: { type: 'VARCHAR', size: 128 } },
          { name: 'SCHEMA_IS_VIRTUAL', dataType: { type: 'BOOLEAN' } },
        ],
        rowCount: listed.length,
        data: [listed.map((entry) => entry.name), listed.map((entry) => entry.virtual ?? false)],
      };
    }
    if (sqlText.includes('EXA_ALL_TABLES')) {
      const schema = /TABLE_SCHEMA = '([^']*)'/.exec(sqlText)?.[1] ?? '';
      const entries = this.#options.tables?.[schema] ?? [];
      return {
        columns: [
          { name: 'OBJECT_NAME', dataType: { type: 'VARCHAR', size: 128 } },
          { name: 'OBJECT_KIND', dataType: { type: 'VARCHAR', size: 8 } },
          { name: 'OBJECT_COMMENT', dataType: { type: 'VARCHAR', size: 256 } },
          { name: 'OBJECT_ROWS', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
          { name: 'OBJECT_IS_VIRTUAL', dataType: { type: 'BOOLEAN' } },
        ],
        rowCount: entries.length,
        data: [
          entries.map((entry) => entry.name),
          entries.map((entry) => entry.kind),
          entries.map((entry) => entry.comment),
          entries.map((entry) => entry.rows ?? null),
          entries.map((entry) => entry.virtual ?? false),
        ],
      };
    }
    return null;
  }

  #execute(socket: FakeSocket, sqlText: string): void {
    /**
     * A session setting, which produces no result set.
     *
     * Recorded like any other statement, because what a test needs to see is the
     * *order* it arrived in relative to the queries around it — that is the whole
     * of what makes a per-statement preprocessor safe.
     */
    if (/^\s*ALTER SESSION\b/iu.test(sqlText)) {
      this.executed.push(sqlText);
      socket.deliver({
        status: 'ok',
        responseData: { numResults: 1, results: [{ resultType: 'rowCount', rowCount: 0 }] },
      });
      return;
    }
    const relation = this.#relationFor(sqlText);
    if (relation === null) {
      socket.deliver({
        status: 'error',
        exception: { text: `object ${sqlText} not found`, sqlCode: '42000' },
      });
      return;
    }
    // A describe: the projection only, no rows. `LIMIT 0` rather than a false
    // predicate, because a predicate on a virtual table is pushed down to its
    // adapter and a literal-only one is what most of them refuse.
    const empty = /\blimit\s+0\b/iu.test(sqlText) || sqlText.includes('WHERE 1 = 0');
    const rowCount = empty ? 0 : relation.rowCount;
    const inline = Math.min(rowCount, this.#options.inlineRows ?? rowCount);
    const needsHandle = inline < rowCount;
    const handle = needsHandle ? this.#nextHandle++ : undefined;
    if (handle !== undefined) this.resultSets.set(handle, { relation, closed: false });

    socket.deliver({
      status: 'ok',
      responseData: {
        numResults: 1,
        results: [
          {
            resultType: 'resultSet',
            resultSet: {
              numColumns: relation.columns.length,
              numRows: rowCount,
              numRowsInMessage: inline,
              ...(handle === undefined ? {} : { resultSetHandle: handle }),
              columns: relation.columns,
              data: relation.data.map((values) => values.slice(0, inline)),
            },
          },
        ],
      },
    });
  }

  #fetch(socket: FakeSocket, request: Record<string, unknown>): void {
    const handle = Number(request['resultSetHandle']);
    const startPosition = Number(request['startPosition']);
    this.fetches.push({ handle, startPosition, numBytes: Number(request['numBytes']) });
    const entry = this.resultSets.get(handle);
    if (entry === undefined || entry.closed) {
      socket.deliver({
        status: 'error',
        exception: { text: 'result set not found', sqlCode: 'R0001' },
      });
      return;
    }
    const limit = this.#options.rowsPerFetch ?? entry.relation.rowCount;
    const end = Math.min(entry.relation.rowCount, startPosition + limit);
    const data = entry.relation.data.map((values) => values.slice(startPosition, end));
    socket.deliver({
      status: 'ok',
      responseData: { numRows: Math.max(0, end - startPosition), data },
    });
  }
}
