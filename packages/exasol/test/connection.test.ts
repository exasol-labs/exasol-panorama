import { describe, expect, it, vi } from 'vitest';
import type { ConnectionStatus, ExasolConnectionOptions } from '@panorama/exasol';
import { ExasolConnection } from '@panorama/exasol';
import { FakeExasolServer, buildRelation } from './fake-exasol.js';
import type { FakeServerOptions } from './fake-exasol.js';

const ORDERS = buildRelation(
  [
    { name: 'ORDER_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
    { name: 'COUNTRY', dataType: { type: 'VARCHAR', size: 64 } },
  ],
  1_000,
  (column, row) => (column === 0 ? row : `country-${row % 5}`),
);

const connect = async (
  options: FakeServerOptions = {},
  overrides: Partial<ExasolConnectionOptions> = {},
): Promise<{ connection: ExasolConnection; server: FakeExasolServer }> => {
  const server = new FakeExasolServer({ relations: { ORDERS }, ...options });
  const connection = new ExasolConnection({
    url: 'wss://exasol.test:8563',
    credentials: { kind: 'password', username: 'sys', password: 'exasol' },
    socketFactory: server.factory,
    randomBytes: (length) => new Uint8Array(length).fill(3),
    ...overrides,
  });
  await connection.open();
  return { connection, server };
};

describe('ExasolConnection login', () => {
  it('completes the encrypted password handshake', async () => {
    const statuses: ConnectionStatus[] = [];
    const server = new FakeExasolServer();
    const connection = new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'password', username: 'sys', password: 'exasol' },
      socketFactory: server.factory,
      randomBytes: (length) => new Uint8Array(length).fill(3),
      onStatusChange: (status) => statuses.push(status),
    });
    expect(connection.status).toBe('disconnected');

    await connection.open();

    expect(statuses).toEqual(['connecting', 'connected']);
    expect(connection.sessionInfo?.sessionId).toBe(42);
    expect(connection.id).toMatch(/^connection:/);

    const login = JSON.parse(server.socket.sent[0] as string) as Record<string, unknown>;
    expect(login).toMatchObject({ command: 'login', protocolVersion: 3 });
    const credentials = JSON.parse(server.socket.sent[1] as string) as Record<string, unknown>;
    expect(credentials['username']).toBe('sys');
    expect(credentials['useCompression']).toBe(false);
    // The password is never sent in the clear.
    expect(credentials['password']).not.toBe('exasol');
    expect(String(credentials['password'])).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
  });

  it('supports personal access tokens', async () => {
    const server = new FakeExasolServer();
    const connection = new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'token', token: 'pat_123' },
      socketFactory: server.factory,
    });
    await connection.open();
    expect(JSON.parse(server.socket.sent[0] as string)).toMatchObject({ command: 'loginToken' });
    expect(JSON.parse(server.socket.sent[1] as string)).toMatchObject({ token: 'pat_123' });
  });

  const loginWith = (responseData: unknown): ExasolConnection => {
    const server = new FakeExasolServer();
    return new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'password', username: 'sys', password: 'exasol' },
      protocolVersion: 1,
      socketFactory: (url) => {
        const socket = server.factory(url);
        const inner = socket.onRequest;
        socket.onRequest = (request): void => {
          if (request['command'] === 'login') {
            queueMicrotask(() => {
              socket.deliver({ status: 'ok', responseData });
            });
            return;
          }
          inner?.(request);
        };
        return socket;
      },
    });
  };

  it('falls back to the PEM key when hexadecimal components are missing', async () => {
    const pair = await crypto.subtle.generateKey(
      {
        name: 'RSA-OAEP',
        modulusLength: 2048,
        publicExponent: new Uint8Array([0x01, 0x00, 0x01]),
        hash: 'SHA-256',
      },
      true,
      ['encrypt', 'decrypt'],
    );
    const spki = new Uint8Array(await crypto.subtle.exportKey('spki', pair.publicKey));
    let binary = '';
    for (const byte of spki) binary += String.fromCharCode(byte);
    const pem = `-----BEGIN PUBLIC KEY-----\n${btoa(binary)}\n-----END PUBLIC KEY-----`;

    const connection = loginWith({ publicKeyPem: pem });
    await expect(connection.open()).resolves.toBeUndefined();
    expect(connection.status).toBe('connected');
  });

  it('fails when the login response carries no public key at all', async () => {
    const connection = loginWith({});
    await expect(connection.open()).rejects.toMatchObject({ code: 'protocol-error' });
    expect(connection.status).toBe('failed');
  });

  it('reports a login failure as a connection failure', async () => {
    const server = new FakeExasolServer();
    const connection = new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'password', username: 'sys', password: 'wrong' },
      socketFactory: (url) => {
        const socket = server.factory(url);
        const inner = socket.onRequest;
        socket.onRequest = (request): void => {
          if (request['command'] === undefined) {
            queueMicrotask(() => {
              socket.deliver({
                status: 'error',
                exception: { text: 'Authentication failed', sqlCode: '08004' },
              });
            });
            return;
          }
          inner?.(request);
        };
        return socket;
      },
    });
    await expect(connection.open()).rejects.toMatchObject({ code: 'authentication-failed' });
    expect(connection.status).toBe('failed');
  });

  it('wraps non-protocol failures', async () => {
    const connection = new ExasolConnection({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'token', token: 't' },
      socketFactory: () => {
        throw new Error('no network stack');
      },
    });
    await expect(connection.open()).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

describe('ExasolConnection metadata', () => {
  it('lists schemas', async () => {
    const { connection } = await connect({ schemas: ['RETAIL', 'SALES'] });
    await expect(connection.listSchemas()).resolves.toEqual([
      { name: 'RETAIL' },
      { name: 'SALES' },
    ]);
  });

  /**
   * A virtual schema is held by another system and reached through an adapter,
   * which is why its tables have no row count: nothing here counted them. The
   * explorer colours them differently and says the word, and an agent choosing
   * where to compute needs to know that these rows are somebody else's network.
   */
  it('says which schemas are virtual, and says nothing about the ones that are not', async () => {
    const { connection, server } = await connect({
      schemas: ['SALES', { name: 'MONGO_DEMO', virtual: true }],
    });
    await expect(connection.listSchemas()).resolves.toEqual([
      // Absent rather than false: every ordinary schema carrying a flag would be
      // noise in every answer, and absent already means "not virtual".
      { name: 'SALES' },
      { name: 'MONGO_DEMO', virtual: true },
    ]);
    expect(server.executed.at(-1)).toContain('SCHEMA_IS_VIRTUAL');
  });

  it('carries the flag on the relations inside one', async () => {
    const { connection } = await connect({
      tables: {
        MONGO_DEMO: [
          { name: 'CUSTOMERS', kind: 'TABLE', comment: null, virtual: true },
          { name: 'ORDERS', kind: 'TABLE', comment: null, rows: 12, virtual: false },
          // A boolean Exasol sent as text, which is the shape that makes a
          // truthiness check quietly mark everything virtual.
          { name: 'SAID_AS_TEXT', kind: 'TABLE', comment: null, virtual: 'false' },
        ],
      },
    });
    const listed = await connection.listTables('MONGO_DEMO');
    expect(listed.find((entry) => entry.name === 'CUSTOMERS')?.virtual).toBe(true);
    expect(listed.find((entry) => entry.name === 'ORDERS')).not.toHaveProperty('virtual');
    expect(listed.find((entry) => entry.name === 'SAID_AS_TEXT')).not.toHaveProperty('virtual');
  });

  it('lists tables and views', async () => {
    const { connection, server } = await connect({
      tables: {
        SALES: [
          { name: 'ORDERS', kind: 'TABLE', comment: 'fact table', rows: 2_830_000 },
          { name: 'ORDERS_V', kind: 'VIEW', comment: null },
        ],
      },
    });
    await expect(connection.listTables('SALES')).resolves.toEqual([
      {
        schema: 'SALES',
        name: 'ORDERS',
        kind: 'TABLE',
        comment: 'fact table',
        rowCount: 2_830_000,
      },
      // A view has no count in the catalogue, and none is invented for it.
      { schema: 'SALES', name: 'ORDERS_V', kind: 'VIEW' },
    ]);
    expect(server.executed.at(-1)).toContain("TABLE_SCHEMA = 'SALES'");
    expect(server.executed.at(-1)).toContain('TABLE_ROW_COUNT');
  });

  it('reads a row count Exasol sent as digits, and reports an unknown one as absent', async () => {
    const { connection } = await connect({
      tables: {
        SALES: [
          // Eighteen digits is past what a double is trusted with, so Exasol
          // sends the figure as text.
          { name: 'HUGE', kind: 'TABLE', comment: null, rows: '123456789012345678' },
          // A table whose statistics have never been gathered.
          { name: 'FRESH', kind: 'TABLE', comment: null, rows: null },
          { name: 'EMPTY', kind: 'TABLE', comment: null, rows: 0 },
        ],
      },
    });
    const listed = await connection.listTables('SALES');
    expect(listed.find((entry) => entry.name === 'HUGE')?.rowCount).toBe(123_456_789_012_345_678);
    // Absent, not zero: "unknown" and "empty" are different facts.
    expect(listed.find((entry) => entry.name === 'FRESH')).not.toHaveProperty('rowCount');
    expect(listed.find((entry) => entry.name === 'EMPTY')?.rowCount).toBe(0);
  });

  it('escapes schema names in metadata queries', async () => {
    const { connection, server } = await connect({ tables: {} });
    await connection.listTables("O'Neill");
    expect(server.executed.at(-1)).toContain("TABLE_SCHEMA = 'O''Neill'");
  });

  it('describes a table without moving rows', async () => {
    const { connection, server } = await connect();
    const schema = await connection.describeTable('SALES', 'ORDERS');
    expect(schema).toEqual({
      schema: 'SALES',
      table: 'ORDERS',
      columns: [
        {
          name: 'ORDER_ID',
          type: { kind: 'decimal', name: 'DECIMAL(18,0)', precision: 18, scale: 0 },
        },
        { name: 'COUNTRY', type: { kind: 'varchar', name: 'VARCHAR(64)', size: 64 } },
      ],
    });
    // The projection query, then the catalogue lookup for foreign keys.
    //
    // A limit and not a predicate, and the difference is whether a virtual
    // schema's tables can be opened at all: a predicate is pushed down to the
    // adapter, and `1 = 0` is one most adapters cannot render.
    expect(server.executed.some((sql) => sql.includes('LIMIT 0'))).toBe(true);
    expect(server.executed.some((sql) => sql.includes('WHERE 1 = 0'))).toBe(false);
    expect(server.executed.at(-1)).toContain('EXA_ALL_CONSTRAINT_COLUMNS');
    expect(connection.openResultSetCount).toBe(0);
  });

  it('reads single-column foreign keys, ignoring incomplete catalogue rows', async () => {
    const { connection } = await connect({
      foreignKeys: {
        ORDERS: [
          {
            column: 'COUNTRY',
            referencedSchema: 'SALES',
            referencedTable: 'COUNTRIES',
            referencedColumn: 'NAME',
            constraint: 'FK_COUNTRY',
          },
        ],
      },
    });
    const schema = await connection.describeTable('SALES', 'ORDERS');
    expect(schema.columns[1]?.foreignKey).toEqual({
      schema: 'SALES',
      table: 'COUNTRIES',
      column: 'NAME',
      constraint: 'FK_COUNTRY',
    });
    // Columns without a key stay plain.
    expect(schema.columns[0]?.foreignKey).toBeUndefined();
  });

  it('skips catalogue rows missing a reference', async () => {
    const { connection } = await connect({
      foreignKeys: {
        ORDERS: [
          {
            column: 'COUNTRY',
            referencedSchema: null as unknown as string,
            referencedTable: 'COUNTRIES',
            referencedColumn: 'NAME',
            constraint: 'FK_COUNTRY',
          },
        ],
      },
    });
    await expect(connection.listForeignKeys('SALES', 'ORDERS')).resolves.toEqual(new Map());
  });

  it('reports a missing object as an error', async () => {
    const { connection } = await connect();
    await expect(connection.describeTable('SALES', 'MISSING')).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('ExasolConnection result sets', () => {
  it('returns inline data when the whole result fits in one message', async () => {
    const { connection } = await connect({ inlineRows: 1_000 });
    const resultSet = await connection.openResultSet('SELECT * FROM ORDERS');
    expect(resultSet.handle).toBeNull();
    expect(resultSet.numRows).toBe(1_000);
    expect(resultSet.inlineData[0]).toHaveLength(1_000);
    expect(connection.openResultSetCount).toBe(0);
  });

  it('fetches arbitrary ranges by position', async () => {
    const { connection, server } = await connect({ inlineRows: 10, rowsPerFetch: 100 });
    const resultSet = await connection.openResultSet('SELECT * FROM ORDERS');
    expect(resultSet.handle).toBe(1);
    expect(connection.openResultSetCount).toBe(1);

    const chunk = await connection.fetch(1, 500);
    expect(chunk.numRows).toBe(100);
    expect(chunk.columns[0]?.[0]).toBe(500);
    expect(server.fetches.at(-1)).toMatchObject({ startPosition: 500 });
    // No OFFSET-style query was ever issued.
    expect(server.executed.every((sql) => !sql.includes('OFFSET'))).toBe(true);
  });

  it('clamps the byte budget to the protocol maximum', async () => {
    const { connection, server } = await connect({ inlineRows: 0, rowsPerFetch: 10 });
    await connection.openResultSet('SELECT * FROM ORDERS');
    await connection.fetch(1, 0, 1e12);
    expect(server.fetches.at(-1)?.numBytes).toBe(64 * 1024 * 1024);
    await connection.fetch(1, 0, -5);
    expect(server.fetches.at(-1)?.numBytes).toBe(1);
  });

  it('uses the configured default fetch budget', async () => {
    const { connection, server } = await connect(
      { inlineRows: 0, rowsPerFetch: 10 },
      { fetchBytes: 1_024 },
    );
    await connection.openResultSet('SELECT * FROM ORDERS');
    await connection.fetch(1, 0);
    expect(server.fetches.at(-1)?.numBytes).toBe(1_024);
  });

  it('rejects statements that produce no result set', async () => {
    const server = new FakeExasolServer();
    const connection = new ExasolConnection({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
      socketFactory: (url) => {
        const socket = server.factory(url);
        const inner = socket.onRequest;
        socket.onRequest = (request): void => {
          if (request['command'] === 'execute') {
            queueMicrotask(() => {
              socket.deliver({
                status: 'ok',
                responseData: { numResults: 1, results: [{ resultType: 'rowCount', rowCount: 3 }] },
              });
            });
            return;
          }
          inner?.(request);
        };
        return socket;
      },
    });
    await connection.open();
    await expect(connection.openResultSet('DELETE FROM T')).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });

  it('closes result sets exactly once', async () => {
    const { connection, server } = await connect({ inlineRows: 0, rowsPerFetch: 100 });
    await connection.openResultSet('SELECT * FROM ORDERS');
    await connection.closeResultSet(1);
    expect(server.openResultSetCount).toBe(0);
    expect(connection.openResultSetCount).toBe(0);
    // A repeat close is a no-op rather than a protocol error.
    await expect(connection.closeResultSet(1)).resolves.toBeUndefined();
  });

  it('pages through a large metadata result', async () => {
    const wide = buildRelation(
      [{ name: 'SCHEMA_NAME', dataType: { type: 'VARCHAR', size: 128 } }],
      250,
      (_, row) => `S${row}`,
    );
    const { connection } = await connect({
      relations: { EXA_ALL_SCHEMAS: wide },
      inlineRows: 100,
      rowsPerFetch: 60,
    });
    const schemas = await connection.listSchemas();
    expect(schemas).toHaveLength(250);
    expect(schemas.at(-1)).toEqual({ name: 'S249' });
    expect(connection.openResultSetCount).toBe(0);
  });

  it('fails loudly if the server stops returning rows', async () => {
    const server = new FakeExasolServer({ relations: { ORDERS }, inlineRows: 1 });
    const connection = new ExasolConnection({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
      socketFactory: (url) => {
        const socket = server.factory(url);
        const inner = socket.onRequest;
        socket.onRequest = (request): void => {
          if (request['command'] === 'fetch') {
            queueMicrotask(() => {
              socket.deliver({ status: 'ok', responseData: { numRows: 0, data: [[]] } });
            });
            return;
          }
          inner?.(request);
        };
        return socket;
      },
    });
    await connection.open();
    await expect(connection.queryAll('SELECT * FROM ORDERS')).rejects.toMatchObject({
      code: 'protocol-error',
    });
  });
});

describe('ExasolConnection lifecycle', () => {
  it('closes every result set on disconnect', async () => {
    const { connection, server } = await connect({ inlineRows: 0, rowsPerFetch: 100 });
    await connection.openResultSet('SELECT * FROM ORDERS');
    await connection.openResultSet('SELECT * FROM ORDERS');
    expect(connection.openResultSetCount).toBe(2);

    await connection.close();
    expect(server.openResultSetCount).toBe(0);
    expect(connection.status).toBe('disconnected');
    expect(connection.sessionInfo).toBeNull();
  });

  it('closes cleanly with no result sets open', async () => {
    const { connection } = await connect();
    await connection.close();
    expect(connection.status).toBe('disconnected');
    // Closing again is harmless.
    await expect(connection.close()).resolves.toBeUndefined();
  });

  it('tolerates a server that hangs up during shutdown', async () => {
    const { connection, server } = await connect({ inlineRows: 0, rowsPerFetch: 100 });
    await connection.openResultSet('SELECT * FROM ORDERS');
    server.socket.onRequest = null;
    const closing = connection.close();
    server.socket.serverClose(1006, 'gone');
    await expect(closing).resolves.toBeUndefined();
    expect(connection.status).toBe('disconnected');
  });

  it('reports a dropped connection as failed', async () => {
    const onStatusChange = vi.fn();
    const server = new FakeExasolServer({ relations: { ORDERS } });
    const connection = new ExasolConnection({
      url: 'wss://x',
      credentials: { kind: 'token', token: 't' },
      socketFactory: server.factory,
      onStatusChange,
    });
    await connection.open();
    server.socket.serverClose(1006, 'network down');
    expect(connection.status).toBe('failed');
    expect(onStatusChange).toHaveBeenLastCalledWith(
      'failed',
      expect.objectContaining({ code: 'connection-lost' }),
    );
  });
});

describe('the wrapper surface on a connection', () => {
  /**
   * Read lazily and held for the session: it costs a round trip per installed
   * package, and a connection that never opens a document table should not pay
   * for one it will not use.
   */
  it('reads it once and remembers it', async () => {
    const { connection, server } = await connect({
      queries: {
        "TABLE_NAME = '__JVS_ROOTS'": {
          columns: [{ name: 'TABLE_SCHEMA', dataType: { type: 'VARCHAR', size: 128 } }],
          rowCount: 1,
          data: [['H1']],
        },
        '"H1"."__JVS_ROOTS"': {
          columns: [
            { name: 'ROOT_TABLE', dataType: { type: 'VARCHAR', size: 128 } },
            { name: 'SOURCE_SCHEMA', dataType: { type: 'VARCHAR', size: 128 } },
            { name: 'PUBLIC_SCHEMA', dataType: { type: 'VARCHAR', size: 128 } },
            { name: 'PUBLIC_VIEW', dataType: { type: 'VARCHAR', size: 128 } },
          ],
          rowCount: 1,
          data: [['orders'], ['SRC'], ['WRAP'], ['orders']],
        },
      },
    });
    const surface = await connection.wrapperSurface();
    expect([...surface.keys()]).toEqual(['SRC.orders']);

    // Asked once. Everything that needs it asks for it — there is no peeking at
    // what somebody else happened to have read — so the cache is what keeps the
    // cost to one lookup per session.
    const asked = server.executed.filter((sql) => sql.includes('__JVS_ROOTS')).length;
    await connection.wrapperSurface();
    expect(server.executed.filter((sql) => sql.includes('__JVS_ROOTS')).length).toBe(asked);
  });

  /** A reconnect is exactly when a newly installed package should be noticed. */
  it('reads it again when the session ends', async () => {
    const { connection, server } = await connect();
    await connection.wrapperSurface();
    const asked = server.executed.filter((sql) => sql.includes('__JVS_ROOTS')).length;
    await connection.close();
    await connection.wrapperSurface().catch(() => undefined);
    expect(server.executed.filter((sql) => sql.includes('__JVS_ROOTS')).length).toBe(asked);
  });
});

describe('running a statement under a SQL preprocessor', () => {
  /**
   * A JSON wrapper's dotted paths are rewritten by a session preprocessor, and
   * Exasol allows one per session — so a canvas with boxes from two wrapper
   * packages has to set it per statement rather than once.
   */
  const PP_A = '"A_PP"."A_PREPROCESSOR"';
  const PP_B = '"B_PP"."B_PREPROCESSOR"';
  const setting = (script: string): string =>
    `ALTER SESSION SET SQL_PREPROCESSOR_SCRIPT = ${script}`;

  it('sets it before the statement it is for', async () => {
    const { connection, server } = await connect();
    server.executed.length = 0;
    await connection.openResultSet('SELECT * FROM ORDERS', PP_A);
    expect(server.executed).toEqual([setting(PP_A), 'SELECT * FROM ORDERS']);
  });

  /**
   * The steady state costs nothing. Only a switch between packages pays for an
   * `ALTER SESSION`, which is about two milliseconds against a real instance.
   */
  it('sends nothing again while the session is already on that one', async () => {
    const { connection, server } = await connect();
    server.executed.length = 0;
    await connection.openResultSet('SELECT * FROM ORDERS', PP_A);
    await connection.openResultSet('SELECT * FROM ORDERS', PP_A);
    await connection.openResultSet('SELECT * FROM ORDERS', PP_A);
    expect(server.executed.filter((sql) => sql.startsWith('ALTER SESSION'))).toEqual([
      setting(PP_A),
    ]);
  });

  it('leaves the session alone for a statement that asked for nothing', async () => {
    const { connection, server } = await connect();
    await connection.openResultSet('SELECT * FROM ORDERS', PP_A);
    server.executed.length = 0;
    await connection.openResultSet('SELECT * FROM ORDERS');
    expect(server.executed).toEqual(['SELECT * FROM ORDERS']);
  });

  it('switches, and switches off', async () => {
    const { connection, server } = await connect();
    server.executed.length = 0;
    await connection.openResultSet('SELECT * FROM ORDERS', PP_A);
    await connection.openResultSet('SELECT * FROM ORDERS', PP_B);
    await connection.openResultSet('SELECT * FROM ORDERS', null);
    expect(server.executed.filter((sql) => sql.startsWith('ALTER SESSION'))).toEqual([
      setting(PP_A),
      setting(PP_B),
      'ALTER SESSION SET SQL_PREPROCESSOR_SCRIPT = null',
    ]);
  });

  /**
   * **The test this mechanism exists to pass.** Two boxes from different wrapper
   * packages, both queried without waiting for each other — which is the ordinary
   * case on a canvas, and what a user with several documents open will do.
   *
   * The protocol has no correlation ids, so the client keeps a strict FIFO queue
   * and sends one request at a time; the setting and its statement are enqueued in
   * one synchronous block and are therefore adjacent in it. If they were not —
   * if `openResultSet` awaited between them — the queue would interleave as
   * `set A, set B, query A, query B` and each box would silently run under the
   * other's preprocessor.
   */
  it('never lets one statement run under another statement’s preprocessor', async () => {
    const { connection, server } = await connect();
    server.executed.length = 0;
    await Promise.all([
      connection.openResultSet('SELECT a FROM ORDERS', PP_A),
      connection.openResultSet('SELECT b FROM ORDERS', PP_B),
      connection.openResultSet('SELECT c FROM ORDERS', PP_A),
    ]);
    // Every statement is immediately preceded by the setting it asked for.
    const wanted = new Map([
      ['SELECT a FROM ORDERS', PP_A],
      ['SELECT b FROM ORDERS', PP_B],
      ['SELECT c FROM ORDERS', PP_A],
    ]);
    for (const [index, sql] of server.executed.entries()) {
      const expected = wanted.get(sql);
      if (expected === undefined) continue;
      // Either the setting is right before it, or the session was already on it
      // and no setting was sent — in which case the last one sent must be it.
      const before = server.executed
        .slice(0, index)
        .filter((entry) => entry.startsWith('ALTER SESSION'))
        .at(-1);
      expect(before, `${sql} ran under ${String(before)}`).toBe(setting(expected));
    }
  });
});

describe('the semantic layer on a connection', () => {
  const layer = {
    'PRODUCT_VERSION"': {
      columns: [{ name: 'DISPLAY_VERSION', dataType: { type: 'VARCHAR', size: 64 } }],
      rowCount: 1,
      data: [['0.1+dev']],
    },
    '"MODELS"': {
      columns: [
        { name: 'MODEL_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'MODEL_NAME', dataType: { type: 'VARCHAR', size: 128 } },
        { name: 'PUBLISHED_SCHEMA', dataType: { type: 'VARCHAR', size: 128 } },
        { name: 'DESCRIPTION', dataType: { type: 'VARCHAR', size: 2000 } },
        { name: 'STATUS', dataType: { type: 'VARCHAR', size: 32 } },
        { name: 'UPDATED_AT', dataType: { type: 'VARCHAR', size: 32 } },
      ],
      rowCount: 1,
      data: [[1], ['sales'], ['SEMANTIC_SALES'], [null], ['PUBLISHED'], ['2026-09-01']],
    },
    FIELDS_FOR_AGENT: {
      columns: [
        { name: 'MODEL_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'SQL_OBJECT_NAME', dataType: { type: 'VARCHAR', size: 128 } },
        { name: 'SQL_COLUMN_NAME', dataType: { type: 'VARCHAR', size: 128 } },
        { name: 'FIELD_KIND', dataType: { type: 'VARCHAR', size: 32 } },
        { name: 'DISPLAY_NAME', dataType: { type: 'VARCHAR', size: 128 } },
        { name: 'DESCRIPTION', dataType: { type: 'VARCHAR', size: 2000 } },
        { name: 'FORMAT_HINT', dataType: { type: 'VARCHAR', size: 32 } },
        { name: 'UNIT_HINT', dataType: { type: 'VARCHAR', size: 32 } },
        { name: 'IS_CERTIFIED', dataType: { type: 'BOOLEAN' } },
        { name: 'SENSITIVITY_LABEL', dataType: { type: 'VARCHAR', size: 32 } },
        { name: 'FIELD_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
      ],
      rowCount: 1,
      data: [
        [1],
        ['SALES'],
        ['TOTAL_REVENUE'],
        ['METRIC'],
        ['Total Revenue'],
        [null],
        ['currency'],
        [null],
        [true],
        [null],
        [7],
      ],
    },
    '"METRICS"': {
      columns: [
        { name: 'MODEL_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'METRIC_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'METRIC_KIND', dataType: { type: 'VARCHAR', size: 32 } },
        { name: 'AGGREGATION_FUNCTION', dataType: { type: 'VARCHAR', size: 32 } },
      ],
      rowCount: 1,
      data: [[1], [7], ['SIMPLE'], ['SUM']],
    },
    METRIC_DIMENSION_MATRIX: {
      columns: [
        { name: 'MODEL_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'METRIC_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'DIMENSION_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
        { name: 'REASON_CODE', dataType: { type: 'VARCHAR', size: 64 } },
        { name: 'RELATIONSHIP_PATH', dataType: { type: 'VARCHAR', size: 2000 } },
      ],
      rowCount: 0,
      data: [[], [], [], [], []],
    },
  } as const;

  it('reads it once and remembers it', async () => {
    const { connection, server } = await connect({ queries: layer });
    const surface = await connection.semanticSurface();
    expect(surface?.version).toBe('0.1+dev');
    expect(surface?.fields[0]?.displayName).toBe('Total Revenue');

    const asked = server.executed.filter((sql) => sql.includes('FIELDS_FOR_AGENT')).length;
    await connection.semanticSurface();
    expect(server.executed.filter((sql) => sql.includes('FIELDS_FOR_AGENT')).length).toBe(asked);
  });

  /**
   * The answer on nearly every connection, and the one that must not be asked
   * twice: `null` is a real answer here, so "asked, and there is none" has to be
   * remembered as firmly as a surface would be.
   */
  it('remembers that there is not one', async () => {
    const { connection, server } = await connect();
    expect(await connection.semanticSurface()).toBeNull();
    const asked = server.executed.length;
    expect(await connection.semanticSurface()).toBeNull();
    expect(server.executed).toHaveLength(asked);
  });

  /**
   * The other compiler on a connection, and a different project's: where
   * `exasol-json-tables` has installed one, a wrapper statement is compiled
   * rather than run under a session preprocessor.
   */
  it('finds the JSON tables compiler and compiles through it', async () => {
    const { connection } = await connect({
      queries: {
        'ALLOWED_SCHEMAS_JSON%': {
          columns: [
            { name: 'SCRIPT_SCHEMA', dataType: { type: 'VARCHAR', size: 128 } },
            { name: 'SCRIPT_NAME', dataType: { type: 'VARCHAR', size: 128 } },
            { name: 'ALLOWED', dataType: { type: 'VARCHAR', size: 2000 } },
          ],
          rowCount: 1,
          data: [
            ['JVS_COMPILE'],
            ['COMPILE_SQL'],
            [`    local ALLOWED_SCHEMAS_JSON = '["JSON_VIEW"]'`],
          ],
        },
        'EXECUTE SCRIPT': {
          columns: [
            { name: 'STATUS', dataType: { type: 'VARCHAR', size: 32 } },
            { name: 'ERROR_CODE', dataType: { type: 'VARCHAR', size: 64 } },
            { name: 'ERROR_MESSAGE', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'ORIGINAL_SQL', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'GENERATED_SQL', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'PLAN_JSON', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'CLARIFICATION_JSON', dataType: { type: 'VARCHAR', size: 2000 } },
          ],
          rowCount: 1,
          data: [['OK'], [null], [null], ['x'], ['SELECT "a|n" FROM "H"."T"'], [null], [null]],
        },
      },
    });
    const compilers = await connection.wrapperCompilers();
    expect(compilers).toEqual([
      { schema: 'JVS_COMPILE', script: 'COMPILE_SQL', serves: ['JSON_VIEW'] },
    ]);
    // Read once and remembered, like every other catalogue answer here.
    expect(await connection.wrapperCompilers()).toBe(compilers);
    const compiled = await connection.compileWrapper(
      compilers[0] as (typeof compilers)[number],
      'SELECT "a.b" FROM "JSON_VIEW"."T"',
    );
    expect(compiled).toEqual({ status: 'ok', sql: 'SELECT "a|n" FROM "H"."T"', packages: [] });
  });

  it('compiles a statement through the layer’s own script', async () => {
    const { connection, server } = await connect({
      queries: {
        ...layer,
        COMPILE_SQL: {
          columns: [
            { name: 'STATUS', dataType: { type: 'VARCHAR', size: 32 } },
            { name: 'ERROR_CODE', dataType: { type: 'VARCHAR', size: 64 } },
            { name: 'ERROR_MESSAGE', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'ORIGINAL_SQL', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'GENERATED_SQL', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'PLAN_JSON', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'CLARIFICATION_JSON', dataType: { type: 'VARCHAR', size: 2000 } },
            { name: 'VALIDATION_RUN_ID', dataType: { type: 'DECIMAL', precision: 18, scale: 0 } },
            { name: 'AGENT_REQUEST_ID', dataType: { type: 'VARCHAR', size: 64 } },
          ],
          rowCount: 1,
          data: [
            ['OK'],
            [null],
            [null],
            ['SELECT total_revenue FROM SEMANTIC_SALES.SALES'],
            ['SELECT SUM(x) FROM "MART"."ORDER_LINES"'],
            [null],
            [null],
            [1],
            [null],
          ],
        },
      },
    });
    const compiled = await connection.compileSemantic(
      'SELECT total_revenue FROM SEMANTIC_SALES.SALES',
    );
    expect(compiled).toEqual({ status: 'ok', sql: 'SELECT SUM(x) FROM "MART"."ORDER_LINES"' });
    expect(server.executed.some((sql) => sql.includes('COMPILE_SQL'))).toBe(true);
  });

  /**
   * A reconnect is exactly when a newly published model should be noticed, so
   * the surface must not outlive the session it described. Asking again on a
   * closed connection therefore finds nothing rather than handing back what the
   * last session said.
   */
  it('forgets it when the session ends', async () => {
    const { connection } = await connect({ queries: layer });
    expect(await connection.semanticSurface()).not.toBeNull();
    await connection.close();
    expect(await connection.semanticSurface()).toBeNull();
  });
});

/**
 * The value formats a connection pins on itself.
 *
 * Exasol renders some values *as text* before they reach the protocol, and which
 * text depends on the session's NLS settings — which a database or a user may
 * default however they like. Verified against a live instance: one
 * `ALTER SESSION SET NLS_NUMERIC_CHARACTERS = ',.'` turned
 * `"12345678901234567.89"` into `"12345678901234567,89"`, and a date format
 * turned `"2026-09-02"` into `"02/09/2026"`.
 *
 * Nothing in Panorama would have *failed* on that. `filterLiteral`'s numeric test
 * would have stopped matching, so a followed key on a high-precision decimal
 * would have been quoted as a string and compared as one; a chart's `Number()`
 * would have produced `NaN`; the `month` hint would have gone quiet. Each of
 * them would have done something else, silently.
 */
describe('the formats a connection pins', () => {
  it('pins the separators and the date formats it parses', async () => {
    const { server } = await connect();
    expect(server.attributesSet).toEqual([
      {
        numericCharacters: '.,',
        dateFormat: 'YYYY-MM-DD',
        datetimeFormat: 'YYYY-MM-DD HH24:MI:SS.FF6',
      },
    ]);
  });

  /**
   * An older server, or one that has made an attribute read-only, is a server to
   * carry on browsing. The assumptions are then unpinned rather than wrong —
   * which is exactly where they were before this existed.
   */
  it('connects anyway where the server will not have them', async () => {
    const { connection, server } = await connect({ refuseAttributes: true });
    expect(connection.status).toBe('connected');
    expect(server.attributesSet).toHaveLength(1);
    // And still works: the refusal costs the pin and nothing else.
    expect(await connection.listSchemas()).toBeDefined();
  });
});
