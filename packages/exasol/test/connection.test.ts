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

  it('lists tables and views', async () => {
    const { connection, server } = await connect({
      tables: {
        SALES: [
          { name: 'ORDERS', kind: 'TABLE', comment: 'fact table' },
          { name: 'ORDERS_V', kind: 'VIEW', comment: null },
        ],
      },
    });
    await expect(connection.listTables('SALES')).resolves.toEqual([
      { schema: 'SALES', name: 'ORDERS', kind: 'TABLE', comment: 'fact table' },
      { schema: 'SALES', name: 'ORDERS_V', kind: 'VIEW' },
    ]);
    expect(server.executed.at(-1)).toContain("TABLE_SCHEMA = 'SALES'");
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
    expect(server.executed.some((sql) => sql.includes('WHERE 1 = 0'))).toBe(true);
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
