import type {
  ChartSpec,
  ConnectionId,
  EntityActionId,
  EntityId,
  IdFactory,
  TableEntity,
  TableEntitySpec,
} from '@panorama/core';
import {
  PanoramaCore,
  buildTableEntity,
  createIdFactory,
  dataType,
  derivedFromOf,
} from '@panorama/core';
import type { AgentCell, AgentHost, AgentViewState } from '@panorama/mcp';

/** Ids with a fake clock, so a commit graph reads the same on every run. */
export const testIds = (seed = 1): IdFactory => {
  let state = seed >>> 0 || 1;
  let time = 1_700_000_000_000;
  return createIdFactory({
    now: (): number => (time += 1),
    random: (): number => {
      state = (state * 1_664_525 + 1_013_904_223) >>> 0;
      return state / 0x1_0000_0000;
    },
  });
};

export const TEST_CONNECTION = 'connection:TEST' as ConnectionId;

export const sampleColumns = [
  { name: 'COUNTRY', type: dataType('varchar', 'VARCHAR(64)', { size: 64 }) },
  { name: 'REVENUE', type: dataType('decimal', 'DECIMAL(18,2)', { precision: 18, scale: 2 }) },
] as const;

export const makeTable = (ids: IdFactory, overrides: Partial<TableEntitySpec> = {}): TableEntity =>
  buildTableEntity(ids, {
    source: { kind: 'relation', connectionId: TEST_CONNECTION, schema: 'SALES', table: 'ORDERS' },
    columns: sampleColumns,
    ...overrides,
  });

export const CHART_SPEC: ChartSpec = {
  type: 'bar',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
};

/**
 * A host with no application behind it.
 *
 * The agent interface is the whole of what an agent can see and do, so it is
 * worth proving without a browser, a database or a canvas: a real
 * `PanoramaCore` for the parts that are the document, and recorded answers for
 * the parts that are the running application.
 */
export class FakeHost implements AgentHost {
  readonly core: PanoramaCore;
  readonly ids: IdFactory;
  readonly calls: string[] = [];
  connectedTo = true;
  rows: readonly Readonly<Record<string, AgentCell>>[] = [];
  rowCount: number | null = 0;
  /** Rows the source has not delivered yet, counted from the first. */
  notFetched = 0;
  openFails: string | null = null;
  opened: EntityId | null = null;
  drafts = new Map<EntityId, string>();
  chartDrafts = new Map<EntityId, ChartSpec>();
  shown: EntityId[] = [];
  /** What `action` should open, so its answer can be checked. */
  opensOnAction: (() => void) | null = null;

  constructor(options: { readonly ids?: IdFactory } = {}) {
    this.ids = options.ids ?? testIds();
    this.core = new PanoramaCore({ ids: this.ids, clock: (): number => 1 });
  }

  add(entity: TableEntity): TableEntity {
    const applied = this.core.dispatch({ type: 'CreateTableEntity', entity });
    if (!applied.ok) throw new Error(applied.error.message);
    return entity;
  }

  connected(): boolean {
    return this.connectedTo;
  }

  reached: {
    url: string;
    database?: string;
    version?: string;
    sessionId?: number;
  } | null = {
    url: 'wss://exasol.test:8563',
    database: 'EXAMPLE_DB',
    version: '8.32.0',
    sessionId: 7,
  };

  reachedDatabase(): typeof this.reached {
    return this.connectedTo ? this.reached : null;
  }

  listSchemas(): Promise<readonly { readonly name: string }[]> {
    this.calls.push('listSchemas');
    return Promise.resolve([{ name: 'SALES' }]);
  }

  listTables(schema: string): Promise<readonly { schema: string; name: string; kind: string }[]> {
    this.calls.push(`listTables ${schema}`);
    return Promise.resolve([{ schema, name: 'ORDERS', kind: 'TABLE' }]);
  }

  viewOf(tableId: EntityId): AgentViewState | null {
    return this.core.world.entities.has(tableId)
      ? { scrollTop: 0, scrollLeft: 0, rowCount: this.rowCount }
      : null;
  }

  cellAt(_tableId: EntityId, row: number, column: number): AgentCell | undefined {
    if (row < this.notFetched) return undefined;
    const record = this.rows[row];
    if (record === undefined) return undefined;
    const name = Object.keys(record)[column];
    return name === undefined ? undefined : record[name];
  }

  openTable(request: { schema: string; table: string }): Promise<EntityId> {
    this.calls.push(`openTable ${request.schema}.${request.table}`);
    if (this.openFails !== null) return Promise.reject(new Error(this.openFails));
    const entity = this.add(
      makeTable(this.ids, {
        source: {
          kind: 'relation',
          connectionId: TEST_CONNECTION,
          schema: request.schema,
          table: request.table,
        },
      }),
    );
    this.opened = entity.id;
    return Promise.resolve(entity.id);
  }

  performAction(tableId: EntityId, action: EntityActionId): Promise<void> {
    this.calls.push(`action ${action} ${tableId}`);
    this.opensOnAction?.();
    return Promise.resolve();
  }

  queryDraft(tableId: EntityId): string {
    return this.drafts.get(tableId) ?? '';
  }

  setQueryDraft(tableId: EntityId, sql: string): void {
    this.drafts.set(tableId, sql);
  }

  runQuery(tableId: EntityId, sql?: string): Promise<void> {
    this.calls.push(`runQuery ${tableId} ${sql ?? '(draft)'}`);
    return Promise.resolve();
  }

  composedQuery(tableId: EntityId): string {
    return `WITH derived_table_1 AS (…) ${this.drafts.get(tableId) ?? ''}`;
  }

  /** A relation by name where there is a parent relation; otherwise the word. */
  readsFrom(tableId: EntityId): string {
    const entity = this.core.world.entities.get(tableId);
    const parentId = entity === undefined ? undefined : derivedFromOf(entity);
    const parent = parentId === undefined ? undefined : this.core.world.entities.get(parentId);
    return parent === undefined || parent.source.kind !== 'relation'
      ? 'derived_table'
      : `"${parent.source.schema}"."${parent.source.table}"`;
  }

  editingQueryTables(): readonly EntityId[] {
    return [];
  }

  chartDraft(tableId: EntityId): ChartSpec | null {
    return this.chartDrafts.get(tableId) ?? null;
  }

  setChartDraft(tableId: EntityId, spec: ChartSpec): void {
    this.chartDrafts.set(tableId, spec);
  }

  showChart(tableId: EntityId): void {
    this.shown.push(tableId);
  }

  ensureRows(_tableId: EntityId, from: number, count: number): Promise<boolean> {
    this.calls.push(`ensureRows ${from}+${count}`);
    // The fake has its rows already; what it records is that it was asked.
    return Promise.resolve(this.notFetched === 0);
  }

  setTableLabel(tableId: EntityId, label: string): void {
    const applied = this.core.dispatch({ type: 'SetTableLabel', tableId, label });
    if (!applied.ok) throw new Error(applied.error.message);
  }

  geometry: {
    width: number;
    height: number;
    polygons: number;
    texts: number;
    bounds: { x: number; y: number; width: number; height: number } | null;
    clipped: readonly string[];
  } | null = {
    width: 400,
    height: 260,
    polygons: 12,
    texts: 5,
    bounds: { x: 0, y: 0, width: 400, height: 260 },
    clipped: [],
  };

  chartGeometry(): typeof this.geometry {
    return this.geometry;
  }

  chartColumns(): readonly { name: string; numeric: boolean; type: string }[] {
    return [
      { name: 'COUNTRY', numeric: false, type: 'VARCHAR(64)' },
      { name: 'REVENUE', numeric: true, type: 'DECIMAL(18,2)' },
    ];
  }

  chartState(): { status: string } | undefined {
    return { status: 'ready' };
  }

  editingCharts(): readonly EntityId[] {
    return [];
  }

  exportJobs(): readonly [] {
    return [];
  }

  metrics(): Readonly<Record<string, number>> {
    return { openTables: this.core.world.entities.size };
  }
}
