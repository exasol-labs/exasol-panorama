import type { EntityId } from '@panorama/core';
import type { TableDataSource, TableSchema } from '@panorama/table';
import { dataType } from '@panorama/core';
import type { ConnectionFactoryOptions, TableSourceRequest } from '@panorama/worker';
import { DataWorker, DataWorkerClient, createInProcessEndpointPair } from '@panorama/worker';
import type { ExasolConnection, SemanticSurface } from '@panorama/exasol';
import {
  ManualScheduler,
  MockTableDataSource,
  factRelation,
  familyComment,
  jsonFamily,
  relationSchema,
} from '@panorama/test-support';
import type { WorkspaceOptions } from '../src/panorama/workspace.js';
import { Workspace } from '../src/panorama/workspace.js';
import { DEMO_SCHEMA, demoRelation, demoSchema } from '../src/panorama/demo.js';

export interface AppHarness {
  readonly workspace: Workspace;
  readonly client: DataWorkerClient;
  readonly scheduler: ManualScheduler;
  readonly connections: ConnectionFactoryOptions[];
  /** Every source request the worker made, so a test can assert on the SQL. */
  readonly sourceRequests: TableSourceRequest[];
  settle(): Promise<void>;
  /**
   * Runs scheduled work on real turns of the event loop until `promise`
   * settles. `settle` yields only to microtasks, which is all a fetch needs; an
   * export deflates through the platform's `CompressionStream`, whose output
   * arrives on a task.
   */
  drive<TValue>(promise: Promise<TValue>): Promise<TValue>;
  /** Runs a bounded number of real turns, leaving work part-finished. */
  pump(rounds: number): Promise<void>;
}

export const TEST_SCHEMA: TableSchema = {
  schema: 'PANORAMA_TEST',
  table: 'SALES',
  columns: [
    { name: 'ORDER_ID', type: dataType('decimal', 'DECIMAL(18,0)', { scale: 0 }) },
    { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
    { name: 'ORDER_DATE', type: dataType('date', 'DATE') },
    { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { scale: 2 }) },
  ],
};

export interface HarnessOptions {
  readonly rowCount?: number;
  /** Stands in for the browser's save dialog; see `save-file.ts`. */
  readonly openExportSink?: WorkspaceOptions['openExportSink'];
  readonly latencyMs?: number;
  readonly failOpen?: boolean;
  /** Lays charts out; omitted where a test only cares about the numbers. */
  readonly chartSurface?: WorkspaceOptions['chartSurface'];
  /** Turns an SVG into PNG bytes; the browser's job, so stubbed here. */
  readonly rasteriseSvg?: WorkspaceOptions['rasteriseSvg'];
  /** Fails only the statements this matches, for a step that stops working. */
  readonly failStatement?: (sql: string) => boolean;
  readonly failDescribe?: boolean;
  /** Simulates a source that cannot report how many rows it has. */
  readonly hideRowCount?: boolean;
  /** Shortens the wait for a window of rows, for the case where none arrive. */
  readonly rowWaitMs?: number;
  /**
   * A connection that does not say which database it reached.
   *
   * Allowed by the contract — the factory comes from outside, and a stub or an
   * embedder's own connection need not report a session — so it is a case worth
   * having, not only a branch worth covering.
   */
  readonly quietLogin?: boolean;
  /** Where database sockets should be opened; the desktop shell's, in an app. */
  readonly databaseSocket?: WorkspaceOptions['databaseSocket'];
  /**
   * Serves a JSON table family instead of the sales tables.
   *
   * The five tables of `@panorama/test-support`'s family, with the provenance
   * comment a loader would have stamped on each — so what a test opens is a
   * table Panorama has to recognise, rather than one told in advance what it is.
   */
  readonly jsonFamily?: boolean;
  /**
   * Serves a JSON wrapper package over the family's root, as
   * `exasol-json-tables` installs one.
   *
   * Only the root: a package publishes a view per document root and none for the
   * child tables, which is what makes a child box's statement read its source
   * table.
   */
  readonly jsonWrapper?: boolean | 'without-preprocessor';
  /**
   * Installs a semantic layer describing `PANORAMA_TEST.SALES`.
   *
   * The published model's object is the relation the harness already serves, so
   * a box opened on it is a box whose columns a model has something to say
   * about — which is the only case any of this changes.
   */
  readonly semanticLayer?: boolean;
  /**
   * Makes the rows arrive under different column names than `describeTable` gave.
   *
   * What a compiled semantic statement does: the published view a box is
   * described from is a stub whose columns are `REVENUE`, and the SQL that
   * actually fetches the rows aliases them the model author's way, `revenue`.
   */
  readonly renamesColumns?: boolean;
}

/** What the layer says about the harness's own table, as its views report it. */
const SEMANTIC_SURFACE: SemanticSurface = {
  version: '0.1+dev',
  metrics: [
    { modelId: 1, metricId: 10, kind: 'SIMPLE', aggregation: 'SUM' },
    // A ratio declares no aggregation, which is the point: it has to be
    // recomputed per group rather than summed.
    { modelId: 1, metricId: 12, kind: 'RATIO' },
  ],
  // Freight is charged on the order header; attributing it across that order's
  // lines multiplies it. The model says so, and this is where Panorama learns it.
  invalidPairs: [
    {
      modelId: 1,
      metricId: 10,
      dimensionId: 11,
      code: 'ONE_TO_MANY_ATTRIBUTION_UNSUPPORTED',
      path: 'order_line_to_order (rejected)',
    },
  ],
  models: [
    { id: 1, name: 'sales', publishedSchema: 'PANORAMA_TEST', published: true },
    // A draft naming the same schema, which is the shape a live instance had:
    // it describes views it has never written and must describe nothing here.
    { id: 2, name: 'sales_draft', publishedSchema: 'PANORAMA_TEST', published: false },
  ],
  fields: [
    {
      modelId: 1,
      fieldId: 10,
      object: 'SALES',
      column: 'REVENUE',
      kind: 'metric',
      displayName: 'Total Revenue',
      description: 'Net recognized revenue excluding tax',
      format: 'currency',
      certified: true,
    },
    {
      modelId: 1,
      fieldId: 11,
      object: 'SALES',
      column: 'COUNTRY',
      kind: 'dimension',
      displayName: 'Country',
    },
    {
      modelId: 1,
      fieldId: 12,
      object: 'SALES',
      column: 'ORDER_ID',
      kind: 'metric',
      displayName: 'Margin %',
      format: 'percentage',
    },
    {
      modelId: 2,
      fieldId: 20,
      object: 'SALES',
      column: 'REVENUE',
      kind: 'metric',
      displayName: 'Draft Revenue',
    },
  ],
};

/**
 * The wrapper package, as the catalogue would report it.
 *
 * `without-preprocessor` is a real state and not a broken one: the view reads —
 * it is an ordinary view — and only the path syntax is unavailable.
 */
const familyWrapper = (preprocessor: boolean) => [
  {
    sourceSchema: jsonFamily()[0]?.schema ?? 'PANORAMA_JSON',
    rootTable: 'PEOPLE',
    schema: 'PANORAMA_JSON_VIEW',
    view: 'PEOPLE',
    helperSchema: 'PANORAMA_JSON_VIEW_INTERNAL',
    ...(preprocessor ? { preprocessor: '"PANORAMA_JSON_PP"."PANORAMA_JSON_PREPROCESSOR"' } : {}),
  },
];

/** The family as the catalogue would report it, comments and all. */
const FAMILY_TABLES = jsonFamily().map((relation) => ({
  schema: relation.schema,
  name: relation.table,
  kind: 'TABLE',
  rowCount: relation.rowCount,
  comment: familyComment(relation.table === 'PEOPLE' ? 'root' : relation.table),
}));

export const JSON_FAMILY_SCHEMA_NAME = jsonFamily()[0]?.schema ?? 'PANORAMA_JSON';

const wrapperMap = (
  wrapper: HarnessOptions['jsonWrapper'],
): Map<string, ReturnType<typeof familyWrapper>[number]> =>
  new Map(
    (wrapper === undefined || wrapper === false
      ? []
      : familyWrapper(wrapper !== 'without-preprocessor')
    ).map((view) => [`${view.sourceSchema}.${view.rootTable}`, view]),
  );

export const createAppHarness = (options: HarnessOptions = {}): AppHarness => {
  const pair = createInProcessEndpointPair();
  const scheduler = new ManualScheduler();
  const connections: ConnectionFactoryOptions[] = [];
  const sourceRequests: TableSourceRequest[] = [];

  new DataWorker({
    endpoint: pair.worker,
    createConnection: (connection): ExasolConnection => {
      connections.push(connection);
      return {
        id: 'connection:test',
        // What the database says about itself at login, which is what anything
        // else claiming to reach the same one is checked against.
        ...(options.quietLogin === true
          ? {}
          : {
              sessionInfo: {
                sessionId: 4_242,
                databaseName: 'PANORAMA_TEST_DB',
                releaseVersion: '8.32.0',
                productName: 'EXASolution',
              },
            }),
        open: async (): Promise<void> => undefined,
        close: async (): Promise<void> => undefined,
        listSchemas: async () =>
          options.jsonFamily === true
            ? [{ name: JSON_FAMILY_SCHEMA_NAME }]
            : [{ name: 'PANORAMA_TEST' }],
        listTables: async () =>
          options.jsonFamily === true
            ? FAMILY_TABLES
            : [
                // A table's count comes from the catalogue; a view has none.
                { schema: 'PANORAMA_TEST', name: 'SALES', kind: 'TABLE', rowCount: 2_830_000_000 },
                { schema: 'PANORAMA_TEST', name: 'SALES_V', kind: 'VIEW' },
              ],
        wrapperSurface: async () => wrapperMap(options.jsonWrapper),
        wrapperSurfaceIfRead: () => wrapperMap(options.jsonWrapper),
        semanticSurface: async () => (options.semanticLayer === true ? SEMANTIC_SURFACE : null),
        describeTable: async (_schema: string, table: string): Promise<TableSchema> => {
          if (options.failDescribe === true) throw new Error('object not found');
          const member = jsonFamily().find((relation) => relation.table === table);
          return options.jsonFamily === true && member !== undefined
            ? relationSchema(member)
            : TEST_SCHEMA;
        },
      } as unknown as ExasolConnection;
    },
    createSource: (
      request: TableSourceRequest,
      connection: ExasolConnection | null,
    ): TableDataSource => {
      sourceRequests.push(request);
      // Mirrors the real factory: only a database can run a statement.
      if (request.sql !== undefined && connection === null) {
        throw new Error('Cannot run SQL without a database connection');
      }
      // Mirrors the real worker: the demo schema is served locally.
      const relation =
        request.schema === DEMO_SCHEMA
          ? demoRelation(request.table)
          : (jsonFamily().find((member) => member.table === request.table) ??
            factRelation(options.rowCount ?? 100_000));
      if (relation === undefined) throw new Error(`No demo relation ${request.table}`);
      const renamed =
        options.renamesColumns === true
          ? {
              ...relation,
              columns: relation.columns.map((column) => ({
                ...column,
                name: column.name.toLowerCase(),
              })),
            }
          : relation;
      return new MockTableDataSource({
        relation: renamed,
        scheduler: scheduler.schedule,
        ...(options.latencyMs === undefined ? {} : { latency: options.latencyMs }),
        ...(options.failOpen === true ||
        (request.sql !== undefined && options.failStatement?.(request.sql) === true)
          ? { failOpen: 'permission-denied' as const }
          : {}),
        ...(request.filter === undefined ? {} : { filter: request.filter }),
        ...(options.hideRowCount === true ? { reportRowCount: false as const } : {}),
      });
    },
  });

  const client = new DataWorkerClient(pair.main);
  const workspace = new Workspace({
    client,
    blockSize: 256,
    clock: () => scheduler.now,
    resolveSchema: (schema, table) => (schema === DEMO_SCHEMA ? demoSchema(table) : undefined),
    ...(options.openExportSink === undefined ? {} : { openExportSink: options.openExportSink }),
    ...(options.chartSurface === undefined ? {} : { chartSurface: options.chartSurface }),
    ...(options.rasteriseSvg === undefined ? {} : { rasteriseSvg: options.rasteriseSvg }),
    ...(options.rowWaitMs === undefined ? {} : { rowWaitMs: options.rowWaitMs }),
    ...(options.databaseSocket === undefined ? {} : { databaseSocket: options.databaseSocket }),
  });

  return {
    workspace,
    client,
    scheduler,
    connections,
    sourceRequests,
    settle: async (): Promise<void> => {
      for (let round = 0; round < 30; round += 1) {
        scheduler.runAll();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    drive: async <TValue>(promise: Promise<TValue>): Promise<TValue> => {
      let done = false;
      const tracked = promise.then(
        () => {
          done = true;
        },
        () => {
          done = true;
        },
      );
      for (let round = 0; round < 5_000 && !done; round += 1) {
        scheduler.runAll();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
      await tracked;
      return promise;
    },
    pump: async (rounds: number): Promise<void> => {
      for (let round = 0; round < rounds; round += 1) {
        scheduler.runAll();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    },
  };
};

export const firstTableId = (harness: AppHarness): EntityId => {
  const id = harness.workspace.core.world.order[0];
  if (id === undefined) throw new Error('no table is open');
  return id;
};
