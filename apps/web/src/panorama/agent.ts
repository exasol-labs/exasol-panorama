import type { AgentHost, AgentBridge, EventStreamLike } from '@panorama/mcp';
import { defaultAgentOrigin, startAgentBridge } from '@panorama/mcp';
import type { Workspace } from './workspace.js';

/**
 * The application's side of the agent interface.
 *
 * A thin reading of the workspace, because the workspace already has every
 * method an agent needs — it is the same surface the shell and the renderer use,
 * and an agent asking "what is open" should be told by whatever the person
 * looking at the screen is being told by. What is left here is the small amount
 * of translation between the two vocabularies, and the decision about what
 * "connected" means.
 */

export const agentHostFor = (workspace: Workspace): AgentHost => ({
  core: workspace.core,
  // A connection id is assigned on connecting and given up on disconnecting, so
  // it is the honest answer to whether there is a database behind the tables.
  connected: (): boolean => workspace.connectionId !== 'connection:pending',
  reachedDatabase: () => workspace.reachedDatabase(),
  listSchemas: () => workspace.listSchemas(),
  listTables: (schema) => workspace.listTables(schema),
  viewOf: (tableId) => workspace.viewOf(tableId),
  cellAt: (tableId, row, column) => workspace.cellAt(tableId, row, column),
  ensureRows: (tableId, from, count) => workspace.ensureRows(tableId, from, count),
  openTable: (request) => workspace.openTable(request),
  performAction: (tableId, action) => workspace.performAction(tableId, action),
  queryDraft: (tableId) => workspace.queryDraft(tableId),
  setQueryDraft: (tableId, sql) => {
    workspace.setQueryDraft(tableId, sql);
  },
  runQuery: (tableId, sql) =>
    sql === undefined ? workspace.runQuery(tableId) : workspace.runQuery(tableId, sql),
  composedQuery: (tableId) => workspace.composedQuery(tableId),
  readsFrom: (tableId) => workspace.readsFrom(tableId),
  editingQueryTables: () => workspace.editingQueryTables(),
  chartDraft: (tableId) => workspace.chartDraft(tableId),
  setChartDraft: (tableId, spec) => {
    workspace.setChartDraft(tableId, spec);
  },
  showChart: (tableId) => {
    workspace.showChart(tableId);
  },
  setTableLabel: (tableId, label) => {
    workspace.setTableLabel(tableId, label);
  },
  chartGeometry: (tableId) => workspace.chartGeometry(tableId),
  chartColumns: (tableId) => workspace.chartColumns(tableId),
  chartState: (tableId) => workspace.chartState(tableId),
  markMeaning: (tableId, mark) => workspace.markMeaning(tableId, mark),
  filtersOf: (tableId) => workspace.filtersOf(tableId),
  editingCharts: () => workspace.editingCharts(),
  exportJobs: () =>
    workspace.exportJobs().map((job) => ({
      id: job.id,
      tableName: job.tableName,
      fileName: job.fileName,
      status: job.status,
      rows: job.rows,
      bytes: job.bytes,
      totalRows: job.totalRows,
      ...(job.error === undefined ? {} : { error: job.error }),
    })),
  metrics: () => ({ ...workspace.dataMetrics(), openTables: workspace.openTableCount }),
});

export interface StartAgentOptions {
  /**
   * Where the endpoint is. Left alone it is the origin the page came from, which
   * is the development server that is hosting both.
   */
  readonly origin?: string;
  openStream?: (url: string) => EventStreamLike;
  post?: (url: string, body: string) => Promise<void>;
  readonly onLog?: (message: string) => void;
}

const browserStream = (url: string): EventStreamLike =>
  new EventSource(url) as unknown as EventStreamLike;

const browserPost = async (url: string, body: string): Promise<void> => {
  await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
};

/**
 * Attaches the application to the agent endpoint on the development server.
 *
 * The stream and the posting are handed in so that this can be exercised
 * without either — and so the page reaches for `EventSource` in one place, where
 * it is obvious that a browser is being assumed.
 */
export const startAgent = (workspace: Workspace, options: StartAgentOptions = {}): AgentBridge =>
  startAgentBridge({
    host: agentHostFor(workspace),
    origin: options.origin ?? globalThis.location?.origin ?? defaultAgentOrigin(),
    openStream: options.openStream ?? browserStream,
    post: options.post ?? browserPost,
    ...(options.onLog === undefined ? {} : { onLog: options.onLog }),
  });
