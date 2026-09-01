import type { SocketLike } from '@panorama/exasol';
import { ExasolConnection } from '@panorama/exasol';
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
 * The one source the worker cannot build for itself, or nothing.
 *
 * The built-in demo schema is generated in the page, so the table browser works —
 * and can be profiled — with no database at all. That is the whole of what this
 * knows; **everything else returns `undefined`, and the worker builds it.**
 *
 * The `undefined` is the important half. Building a live source here looks
 * harmless and quietly bypasses two decisions that are only made in the worker:
 * which JSON wrapper preprocessor a statement needs, and whether a semantic layer
 * has to compile the statement before the database will run it. This function
 * used to do exactly that, and the symptom was a published semantic object
 * answering with `SEMANTIC_SURFACE_001` — the guard's "run the preprocessor"
 * error — because the statement reached the database as written.
 */
export const createTableSource = (
  request: { schema: string; table: string; filter?: RowFilter; sql?: string },
  options: StartDataWorkerOptions = {},
): TableDataSource | undefined => {
  // A statement is checked first: it names no schema of its own, so the demo
  // branch below could never recognise it, and only a database can run it.
  if (request.sql !== undefined) return undefined;
  const relation = request.schema === DEMO_SCHEMA ? demoRelation(request.table) : undefined;
  if (relation === undefined) return undefined;
  return new MockTableDataSource({
    relation,
    latency: options.demoLatencyMs ?? 45,
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
    // Only the demo relations; everything else is the worker's to build, and
    // must be, or it loses the preprocessor and the semantic compile.
    createSource: (request): TableDataSource | undefined => createTableSource(request, options),
  });
