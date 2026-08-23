import { describe, expect, it } from 'vitest';
import { cellValue } from '@panorama/table';
import type { ExasolCredentials } from '@panorama/exasol';
import { ExasolConnection, ExasolTableDataSource } from '@panorama/exasol';

/**
 * Integration tests against a real Exasol development instance.
 *
 * Skipped unless `PANORAMA_EXASOL_URL` is set, so the default test run needs
 * no database. Point them at a development instance with:
 *
 *   PANORAMA_EXASOL_URL=wss://localhost:8563 \
 *   PANORAMA_EXASOL_USER=sys PANORAMA_EXASOL_PASSWORD=exasol \
 *   PANORAMA_EXASOL_SCHEMA=SALES PANORAMA_EXASOL_TABLE=ORDERS \
 *   npm test
 *
 * A development instance with a self-signed certificate also needs
 * `NODE_TLS_REJECT_UNAUTHORIZED=0`.
 */

const url = process.env['PANORAMA_EXASOL_URL'];
const user = process.env['PANORAMA_EXASOL_USER'] ?? 'sys';
const password = process.env['PANORAMA_EXASOL_PASSWORD'];
const token = process.env['PANORAMA_EXASOL_TOKEN'];
const schemaName = process.env['PANORAMA_EXASOL_SCHEMA'];
const tableName = process.env['PANORAMA_EXASOL_TABLE'];

const credentials: ExasolCredentials =
  token === undefined
    ? { kind: 'password', username: user, password: password ?? '' }
    : { kind: 'token', token };

const connect = async (): Promise<ExasolConnection> => {
  const connection = new ExasolConnection({ url: url as string, credentials });
  await connection.open();
  return connection;
};

describe.skipIf(url === undefined)('Exasol integration', () => {
  it('completes the login handshake', async () => {
    const connection = await connect();
    try {
      expect(connection.status).toBe('connected');
      expect(connection.sessionInfo?.sessionId).toBeGreaterThan(0);
      expect(connection.sessionInfo?.releaseVersion).toBeTruthy();
    } finally {
      await connection.close();
    }
  });

  it('lists schemas and tables', async () => {
    const connection = await connect();
    try {
      const schemas = await connection.listSchemas();
      expect(schemas.length).toBeGreaterThan(0);
      const target = schemaName ?? (schemas[0] as { name: string }).name;
      const tables = await connection.listTables(target);
      expect(Array.isArray(tables)).toBe(true);
    } finally {
      await connection.close();
    }
  });

  it.skipIf(schemaName === undefined || tableName === undefined)(
    'describes a table, fetches ranges and closes the result set',
    async () => {
      const connection = await connect();
      try {
        const schema = await connection.describeTable(schemaName as string, tableName as string);
        expect(schema.columns.length).toBeGreaterThan(0);

        const source = new ExasolTableDataSource({
          connection,
          schema: schemaName as string,
          table: tableName as string,
        });
        const session = await source.open();
        expect(session.rowCount).not.toBeNull();

        const first = await session.fetch({ startPosition: 0, maxRows: 16 });
        expect(first.startRow).toBe(0);
        expect(first.columns).toHaveLength(schema.columns.length);
        if (first.rowCount > 0) {
          expect(cellValue(first.columns[0] as never, 0)).not.toBeUndefined();
        }

        // Random access far into the result set must not need an OFFSET query.
        const rowCount = session.rowCount ?? 0;
        if (rowCount > 1_000) {
          const deep = await session.fetch({ startPosition: rowCount - 8, maxRows: 8 });
          expect(deep.rowCount).toBe(8);
          expect(deep.startRow).toBe(rowCount - 8);
        }

        await source.close();
        expect(connection.openResultSetCount).toBe(0);
      } finally {
        await connection.close();
      }
    },
    60_000,
  );
});
