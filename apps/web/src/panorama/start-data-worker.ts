import type { SocketLike } from '@panorama/exasol';
import { ExasolConnection, ExasolTableDataSource } from '@panorama/exasol';
import type { RowFilter, TableDataSource } from '@panorama/table';
import type { WorkerEndpoint } from '@panorama/worker';
import { DataWorker } from '@panorama/worker';
import { MockTableDataSource } from '@panorama/test-support';
import { DEMO_SCHEMA, demoRelation } from './demo.js';
import { databaseSocketUrl } from './shell.js';

/**
 * Starts the data worker on an endpoint.
 *
 * Shared by the real `Worker` entry point and the in-process fallback so both
 * behave identically — only the isolation differs.
 */

export interface StartDataWorkerOptions {
  /** Simulated latency for the built-in demo relations, in milliseconds. */
  readonly demoLatencyMs?: number;
}

/**
 * Chooses the data source for a table: the local demo generator for the
 * built-in schema, otherwise a live Exasol result set.
 */
export const createTableSource = (
  request: { schema: string; table: string; filter?: RowFilter; sql?: string },
  connection: ExasolConnection | null,
  options: StartDataWorkerOptions = {},
): TableDataSource => {
  // A statement is checked first: it names no schema of its own, so the demo
  // branch below could never recognise it, and only a database can run it.
  if (request.sql !== undefined) {
    if (connection === null) throw new Error('Cannot run SQL without a database connection');
    return new ExasolTableDataSource({
      connection,
      schema: request.schema,
      table: request.table,
      sql: request.sql,
    });
  }
  // The demo schema is served locally, so the table browser works — and can be
  // profiled — with no database at all.
  const relation = request.schema === DEMO_SCHEMA ? demoRelation(request.table) : undefined;
  if (relation !== undefined) {
    return new MockTableDataSource({
      relation,
      latency: options.demoLatencyMs ?? 45,
      ...(request.filter === undefined ? {} : { filter: request.filter }),
    });
  }
  if (connection === null) {
    throw new Error(`No connection for ${request.schema}.${request.table}`);
  }
  return new ExasolTableDataSource({
    connection,
    schema: request.schema,
    table: request.table,
    // The filter is what following a foreign key *is*. Dropping it here opened
    // the referenced table in full, which looks so nearly right that it took a
    // while to be believed.
    ...(request.filter === undefined ? {} : { filter: request.filter }),
  });
};

export const startDataWorker = (
  endpoint: WorkerEndpoint,
  options: StartDataWorkerOptions = {},
): DataWorker =>
  new DataWorker({
    endpoint,
    createConnection: (connection) => {
      const via = connection.via;
      return new ExasolConnection({
        url: connection.url,
        credentials: connection.credentials,
        onStatusChange: connection.onStatusChange,
        /**
         * Where the socket actually goes. Left alone in a browser: the driver
         * opens the database's URL, and a certificate the browser does not trust
         * is the end of it. In the desktop application the shell opens the socket
         * instead, so the page connects to the shell and the shell decides about
         * the certificate — see `shell.ts`. The driver is not told, and does not
         * need to be: it is handed a socket either way.
         */
        ...(via === undefined
          ? {}
          : {
              socketFactory: (url: string): SocketLike =>
                new WebSocket(databaseSocketUrl(via, url)) as unknown as SocketLike,
            }),
      });
    },
    createSource: (request, connection): TableDataSource =>
      createTableSource(request, connection, options),
  });
