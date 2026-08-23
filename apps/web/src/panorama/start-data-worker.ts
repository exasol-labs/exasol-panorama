import { ExasolConnection, ExasolTableDataSource } from '@panorama/exasol';
import type { TableDataSource } from '@panorama/table';
import type { WorkerEndpoint } from '@panorama/worker';
import { DataWorker } from '@panorama/worker';
import { MockTableDataSource } from '@panorama/test-support';
import { DEMO_SCHEMA, demoRelation } from './demo.js';

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
  request: { schema: string; table: string },
  connection: ExasolConnection | null,
  options: StartDataWorkerOptions = {},
): TableDataSource => {
  // The demo schema is served locally, so the table browser works — and can be
  // profiled — with no database at all.
  const relation = request.schema === DEMO_SCHEMA ? demoRelation(request.table) : undefined;
  if (relation !== undefined) {
    return new MockTableDataSource({ relation, latency: options.demoLatencyMs ?? 45 });
  }
  if (connection === null) {
    throw new Error(`No connection for ${request.schema}.${request.table}`);
  }
  return new ExasolTableDataSource({
    connection,
    schema: request.schema,
    table: request.table,
  });
};

export const startDataWorker = (
  endpoint: WorkerEndpoint,
  options: StartDataWorkerOptions = {},
): DataWorker =>
  new DataWorker({
    endpoint,
    createConnection: (connection) =>
      new ExasolConnection({
        url: connection.url,
        credentials: connection.credentials,
        onStatusChange: connection.onStatusChange,
      }),
    createSource: (request, connection): TableDataSource =>
      createTableSource(request, connection, options),
  });
