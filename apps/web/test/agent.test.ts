import { describe, expect, it, vi } from 'vitest';
import type { EventStreamLike } from '@panorama/mcp';
import { runOperation } from '@panorama/mcp';
import { collectingSink } from '@panorama/export';
import { createAppHarness, firstTableId } from './harness.js';
import { agentHostFor, startAgent } from '../src/panorama/agent.js';

/**
 * The agent interface against the real workspace.
 *
 * The interface itself is proved in `packages/mcp` against a stand-in host; what
 * is left to prove here is that the real workspace *is* that host — that every
 * question an agent can ask has a real answer behind it, and that an edit
 * arrives in the same document a pointer would have changed.
 */

const connected = async (): Promise<ReturnType<typeof createAppHarness>> => {
  const harness = createAppHarness();
  await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
  return harness;
};

const withTable = async (): Promise<{
  harness: ReturnType<typeof createAppHarness>;
  tableId: string;
}> => {
  const harness = await connected();
  await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
  return { harness, tableId: firstTableId(harness) };
};

describe('the agent host', () => {
  it('reads the live application, not a copy of it', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    expect(host.core).toBe(harness.workspace.core);
    const overview = (await runOperation(host, 'overview', {})) as Record<string, unknown>;
    expect(overview['connected']).toBe(true);
    expect(overview['tables']).toBe(1);
    const detail = (await runOperation(host, 'entity', { tableId })) as Record<string, unknown>;
    expect((detail['columns'] as { name: string }[]).map((column) => column.name)).toEqual([
      'ORDER_ID',
      'COUNTRY',
      'ORDER_DATE',
      'REVENUE',
    ]);
    // Types come with the names, because writing SQL needs them; pixels do not.
    expect((detail['columns'] as { type: string }[])[1]?.type).toBe('VARCHAR(64)');
    expect('scroll' in detail).toBe(false);
    const verbose = (await runOperation(host, 'entity', { tableId, verbose: true })) as Record<
      string,
      unknown
    >;
    expect(verbose['scroll']).toEqual({ top: 0, left: 0 });
  });

  it('knows whether there is a database behind the tables', async () => {
    const harness = createAppHarness();
    const host = agentHostFor(harness.workspace);
    expect(host.connected()).toBe(false);
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    expect(host.connected()).toBe(true);
    // Given up with the connection, rather than outliving it.
    await harness.workspace.disconnect();
    expect(host.connected()).toBe(false);
  });

  it('names the database it reached, as the database described itself', async () => {
    const harness = createAppHarness();
    const host = agentHostFor(harness.workspace);
    expect(host.reachedDatabase()).toBeNull();
    await harness.workspace.connect({
      url: 'wss://exasol.test:8563',
      credentials: { kind: 'token', token: 't' },
    });
    // The URL this session used, and whatever the server said at login — which
    // is the evidence anything else claiming to reach Exasol is checked against.
    expect(host.reachedDatabase()).toEqual({
      url: 'wss://exasol.test:8563',
      // Not the URL somebody typed: the name and version the server itself gave.
      database: 'PANORAMA_TEST_DB',
      version: '8.32.0',
      sessionId: 4_242,
    });
    const overview = (await runOperation(host, 'overview', {})) as Record<string, unknown>;
    expect((overview['database'] as { url: string }).url).toBe('wss://exasol.test:8563');
    await harness.workspace.disconnect();
    expect(host.reachedDatabase()).toBeNull();
  });

  it('reports the URL alone when the login said nothing about the database', async () => {
    // A connection factory comes from outside and need not report a session.
    const harness = createAppHarness({ quietLogin: true });
    await harness.workspace.connect({
      url: 'wss://quiet:8563',
      credentials: { kind: 'token', token: 't' },
    });
    expect(agentHostFor(harness.workspace).reachedDatabase()).toEqual({ url: 'wss://quiet:8563' });
  });

  it('lists the database through the same client the explorer uses', async () => {
    const harness = await connected();
    const host = agentHostFor(harness.workspace);
    const catalogue = (await runOperation(host, 'catalogue', {})) as {
      schemas: { name: string }[];
    };
    expect(catalogue.schemas.map((schema) => schema.name)).toContain('PANORAMA_TEST');
    const relations = (await runOperation(host, 'catalogue', { schema: 'PANORAMA_TEST' })) as {
      relations: { name: string }[];
    };
    expect(relations.relations.map((relation) => relation.name)).toContain('SALES');
  });

  it('opens a relation and reads its rows once they arrive', async () => {
    const harness = await connected();
    const host = agentHostFor(harness.workspace);
    const opened = (await harness.drive(
      runOperation(host, 'open_table', { schema: 'PANORAMA_TEST', table: 'SALES' }),
    )) as Record<string, unknown>;
    expect(opened['name']).toBe('PANORAMA_TEST.SALES');
    const tableId = opened['id'] as string;
    harness.workspace.update(16);
    await harness.settle();
    const rows = (await runOperation(host, 'rows', { tableId, limit: 3 })) as {
      rows: Record<string, unknown>[];
      totalRows: number | null;
    };
    expect(rows.totalRows).toBeGreaterThan(0);
    expect(rows.rows[0]).toMatchObject({ row: 0 });
    expect(Object.keys(rows.rows[0] ?? {})).toContain('COUNTRY');
  });

  it('edits the document, and the edit is a commit like any other', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    await runOperation(host, 'dispatch', {
      command: { type: 'MoveEntities', ids: [tableId], position: { x: 640, y: 12, z: 0 } },
    });
    expect(harness.workspace.core.world.entities.get(tableId as never)?.transform.x).toBe(640);
    // And undoes as one: an agent's work is in the same history as a person's.
    await runOperation(host, 'checkout', { to: 'undo' });
    expect(harness.workspace.core.world.entities.get(tableId as never)?.transform.x).not.toBe(640);
  });

  it("derives a query box through the halo's own action, then runs a statement", async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const acted = (await harness.drive(
      runOperation(host, 'action', { tableId, action: 'sql' }),
    )) as { opened: Record<string, unknown>[] };
    expect(acted.opened).toHaveLength(1);
    const queryId = acted.opened[0]?.['id'] as string;
    const answer = (await harness.drive(
      runOperation(host, 'query', {
        tableId: queryId,
        sql: 'SELECT COUNTRY FROM derived_table',
        verbose: true,
      }),
    )) as Record<string, unknown>;
    // Once it has run, the statement is the box's own — so it is said there and
    // not again as a draft.
    expect((answer['source'] as { sql: string }).sql).toBe('SELECT COUNTRY FROM derived_table');
    expect('draft' in answer).toBe(false);
    // One step reads the relation directly: "derived_table" is what the user
    // writes, and the composition is what the database is sent.
    expect(answer['composed']).toContain('"PANORAMA_TEST"."SALES"');
    expect((answer['columns'] as unknown[]).length).toBeGreaterThan(0);
    // The rows come with it, so an analytical step is one call rather than two.
    expect((answer['preview'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('sets a chart up through the same path the form uses', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const acted = (await harness.drive(
      runOperation(host, 'action', { tableId, action: 'chart' }),
    )) as { opened: Record<string, unknown>[] };
    const chartId = acted.opened[0]?.['id'] as string;
    const answer = (await harness.drive(
      runOperation(host, 'chart', {
        tableId: chartId,
        spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
      }),
    )) as Record<string, unknown>;
    expect((answer['source'] as Record<string, unknown>)['kind']).toBe('chart');
    expect(harness.workspace.core.world.entities.get(chartId as never)?.mode).toBe('result');
    // Nothing has drawn it yet — there is no canvas in a test — and it says so
    // rather than reporting numbers it does not have.
    expect(answer['drawn']).toBeNull();
    expect(answer['note']).toContain('Not drawn yet');
    // Asked in full, a chart says its draft and what its columns offer.
    const verbose = (await harness.drive(
      runOperation(host, 'entity', { tableId: chartId, verbose: true }),
    )) as Record<string, unknown>;
    expect((verbose['draft'] as { category: string }).category).toBe('COUNTRY');
    expect((verbose['chartColumns'] as unknown[]).length).toBeGreaterThan(0);
  });

  it('draws whatever ECharts can, when an agent writes the option itself', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const acted = (await harness.drive(
      runOperation(host, 'action', { tableId, action: 'chart' }),
    )) as { opened: Record<string, unknown>[] };
    const chartId = acted.opened[0]?.['id'] as string;
    const answer = (await harness.drive(
      runOperation(host, 'chart', {
        tableId: chartId,
        spec: {
          type: 'custom',
          category: 'COUNTRY',
          values: ['REVENUE'],
          aggregate: 'sum',
          // A series type no control offers, which is the whole point.
          extra: '{"series":[{"type":"treemap","data":[{"name":"a","value":1}]}]}',
        },
      }),
    )) as Record<string, unknown>;
    const source = answer['source'] as { spec: { type: string; extra: string } };
    expect(source.spec.type).toBe('custom');
    expect(source.spec.extra).toContain('treemap');
    // The title says what the option asks for, not just that it was written.
    expect(harness.workspace.core.world.entities.get(chartId as never)?.mode).toBe('result');

    // And a broken option is refused outright rather than drawn as nothing: for
    // a custom chart the option is the chart.
    await expect(
      runOperation(host, 'chart', {
        tableId: chartId,
        spec: { type: 'custom', category: '', values: [], aggregate: 'count' },
      }),
    ).rejects.toThrow(/needs spec.extra/u);
  });

  it('reports what an export left behind', async () => {
    const harness = createAppHarness({
      openExportSink: async () => collectingSink(),
    });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    await opening;
    const tableId = firstTableId(harness);
    const host = agentHostFor(harness.workspace);
    expect(host.exportJobs()).toEqual([]);

    await harness.drive(runOperation(host, 'action', { tableId, action: 'export-csv' }));
    // An export outlives the render that started it, so an agent can ask about
    // one it did not start — and be told how far it got.
    const overview = (await runOperation(host, 'overview', {})) as Record<string, unknown>;
    const jobs = overview['exports'] as Record<string, unknown>[];
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      fileName: 'PANORAMA_TEST.SALES.csv',
      status: 'done',
      tableName: 'PANORAMA_TEST.SALES',
    });
    expect(jobs[0]?.['bytes']).toBeGreaterThan(0);
    expect(host.metrics()['openTables']).toBe(1);
  });

  it('tells an agent to name the relation a fresh box reads', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const acted = (await harness.drive(
      runOperation(host, 'action', { tableId, action: 'sql' }),
    )) as { opened: Record<string, unknown>[] };
    const opened = acted.opened[0];
    // The box the application itself seeds names the relation, and what an agent
    // is told to write after FROM is the same thing.
    expect(opened?.['readsFrom']).toBe('"PANORAMA_TEST"."SALES"');
    const queryId = opened?.['id'] as string;
    expect(host.queryDraft(queryId as never)).toContain('"PANORAMA_TEST"."SALES"');
    expect(host.queryDraft(queryId as never)).not.toContain('derived_table');

    // A box on top of that one has no name to write, so it is the one case
    // "derived_table" is for.
    const again = (await harness.drive(
      runOperation(host, 'query', {
        tableId: queryId,
        sql: 'SELECT COUNTRY FROM "PANORAMA_TEST"."SALES"',
      }),
    )) as Record<string, unknown>;
    expect('note' in again).toBe(false);
    const chained = (await harness.drive(
      runOperation(host, 'action', { tableId: queryId, action: 'sql' }),
    )) as { opened: Record<string, unknown>[] };
    expect(chained.opened[0]?.['readsFrom']).toBe('derived_table');
  });

  it('runs the draft when no statement is given, and passes an export failure on', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const acted = (await harness.drive(
      runOperation(host, 'action', { tableId, action: 'sql' }),
    )) as { opened: Record<string, unknown>[] };
    const queryId = acted.opened[0]?.['id'] as string;
    host.setQueryDraft(queryId as never, 'SELECT COUNTRY FROM derived_table');
    // No statement: run what is in the field, which is what pressing Run does.
    await harness.drive(host.runQuery(queryId as never));
    expect(host.queryDraft(queryId as never)).toBe('SELECT COUNTRY FROM derived_table');
    expect(host.editingQueryTables()).not.toContain(queryId);
  });

  it('says why an export failed, where it failed', async () => {
    const harness = createAppHarness({ openExportSink: async () => null });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    await opening;
    const host = agentHostFor(harness.workspace);
    // Cancelled at the save dialog: no job, because nothing was started.
    await harness.drive(
      runOperation(host, 'action', { tableId: firstTableId(harness), action: 'export-csv' }),
    );
    expect(host.exportJobs()).toEqual([]);
  });

  it('selects, hovers and picks columns out without touching the history', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const commits = harness.workspace.core.history.commits.size;
    const session = (await runOperation(host, 'session_dispatch', {
      command: { type: 'SetSelection', ids: [tableId] },
    })) as Record<string, unknown>;
    expect(session['selection']).toEqual([tableId]);
    expect(harness.workspace.core.history.commits.size).toBe(commits);
  });
});

describe('what only the application knows', () => {
  it('waits for a window of rows, rather than reading what happened to be there', async () => {
    const harness = createAppHarness({ latencyMs: 5 });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    await opening;
    const tableId = firstTableId(harness);
    const host = agentHostFor(harness.workspace);
    // Opening a table asks for its first rows; nothing has asked for these.
    // Far enough to be in a block nothing has fetched: a block is thousands of
    // rows, so "a few hundred down" is still the first one.
    const far = 90_000;
    expect(host.cellAt(tableId, far, 1)).toBeUndefined();
    expect(await harness.drive(host.ensureRows(tableId, far, 5))).toBe(true);
    expect(host.cellAt(tableId, far, 1)).toBeDefined();
    // A window already in the cache is answered without asking for it again.
    expect(await harness.drive(host.ensureRows(tableId, 0, 5))).toBe(true);
    // Nothing to wait for on a box with no result set behind it.
    expect(await host.ensureRows('table:nope' as never, 0, 5)).toBe(false);
    expect(await host.ensureRows(tableId, 0, 0)).toBe(false);
  });

  it('gives up on rows that never arrive, rather than waiting forever', async () => {
    // The source is asked and says nothing; the wait ends and says so, which is
    // more use to a caller than a promise that never settles.
    const harness = createAppHarness({ rowWaitMs: 30, failOpen: false, latencyMs: 5 });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    const opening = harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    await harness.settle();
    await opening;
    const host = agentHostFor(harness.workspace);
    // Nothing runs the scheduler, so the blocks asked for never come back.
    expect(await host.ensureRows(firstTableId(harness), 90_000, 5)).toBe(false);
  });

  it('says why a box cannot be renamed', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    // A stored relation has a name, and it is the relation's.
    expect(() => host.setTableLabel(tableId, 'sales')).toThrow(/stored relation/u);
  });

  it('reports what the canvas drew of a chart, once it has drawn it', async () => {
    const harness = createAppHarness({
      chartSurface: {
        update: () => {},
        point: () => null,
        draw: () => ({
          polygons: [{ corners: [0, 0, 10, 0, 10, 10, 0, 10], color: [0, 0, 1, 1] }],
          texts: [
            {
              x: 4,
              y: 4,
              width: 20,
              height: 10,
              text: 'inside',
              align: 'left',
              fontSize: 9,
              color: [0, 0, 0, 1],
            },
            {
              x: 380,
              y: 4,
              width: 60,
              height: 10,
              text: 'over the edge',
              align: 'left',
              fontSize: 9,
              color: [0, 0, 0, 1],
            },
          ],
        }),
        toSvg: () => '<svg/>',
        dispose: () => {},
      },
    });
    await harness.workspace.connect({ url: 'wss://x', credentials: { kind: 'token', token: 't' } });
    await harness.workspace.openTable({ schema: 'PANORAMA_TEST', table: 'SALES' });
    const { tableId: chartId } = await harness.workspace.openChart(firstTableId(harness));
    await harness.settle();
    const host = agentHostFor(harness.workspace);
    // Nothing has laid it out yet, and it says so rather than inventing numbers.
    expect(host.chartGeometry(chartId)).toBeNull();

    harness.workspace.setChartDraft(chartId, {
      type: 'bar',
      category: 'COUNTRY',
      values: ['REVENUE'],
      aggregate: 'sum',
    });
    await harness.drive(Promise.resolve());
    harness.workspace.update(16);
    await harness.settle();
    // Laid out the way the renderer asks for it, which is the only way these
    // numbers are the real ones.
    harness.workspace.chartFor(
      harness.workspace.core.world.entities.get(chartId) as never,
      400,
      260,
      { measureText: (text: string, size: number) => text.length * size * 0.55, fontFamily: 'x' },
    );
    const drawn = host.chartGeometry(chartId);
    expect(drawn).toMatchObject({ width: 400, height: 260, polygons: 1, texts: 2 });
    expect(drawn?.bounds).toMatchObject({ x: 0, y: 0 });
    // A label that fell outside the box is named, because "a label is clipped"
    // is only actionable if you know which.
    expect(drawn?.clipped).toEqual(['over the edge']);
  });

  it('renames a box through a command, so the name is in the history', async () => {
    const { harness, tableId } = await withTable();
    const host = agentHostFor(harness.workspace);
    const acted = (await harness.drive(
      runOperation(host, 'action', { tableId, action: 'sql' }),
    )) as { opened: Record<string, unknown>[] };
    const queryId = acted.opened[0]?.['id'] as string;
    const named = (await runOperation(host, 'label', {
      tableId: queryId,
      label: 'claims by decile',
    })) as Record<string, unknown>;
    expect(named['name']).toBe('claims by decile');
    const history = (await runOperation(host, 'history', {})) as {
      commits: { did: string }[];
    };
    expect(history.commits.at(-1)?.did).toBe('Rename to claims by decile');
  });
});

describe('startAgent', () => {
  it("reaches for the browser's own stream and posting when given neither", async () => {
    // jsdom has neither, which is the point: this is the one place the page
    // assumes a browser, and it should be plain that it does.
    const harness = await connected();
    const opened: string[] = [];
    const posted: { url: string; body: string }[] = [];
    let deliver: ((event: { data: string }) => void) | null = null;
    class FakeEventSource {
      constructor(url: string) {
        opened.push(url);
      }
      addEventListener(type: string, listener: (event: { data: string }) => void): void {
        if (type === 'message') deliver = listener;
      }
      close(): void {}
    }
    vi.stubGlobal('EventSource', FakeEventSource);
    vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
      posted.push({ url, body: init.body });
      return Promise.resolve(new Response('{}'));
    });
    try {
      const bridge = startAgent(harness.workspace, { origin: 'http://127.0.0.1:5173' });
      expect(opened).toEqual(['http://127.0.0.1:5173/agent/events']);
      deliver?.({ data: JSON.stringify({ id: 2, name: 'session', args: {} }) });
      await harness.settle();
      expect(posted[0]?.url).toBe('http://127.0.0.1:5173/agent/result');
      expect(JSON.parse(posted[0]?.body ?? '{}')).toMatchObject({ id: 2, ok: true });
      bridge.close();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('attaches the workspace to the endpoint and answers a call', async () => {
    const harness = await connected();
    const posted: string[] = [];
    let deliver: ((event: { data: string }) => void) | null = null;
    const stream: EventStreamLike = {
      addEventListener: (type, listener) => {
        if (type === 'message') deliver = listener as (event: { data: string }) => void;
      },
      close: (): void => {},
    };
    const logs: string[] = [];
    const bridge = startAgent(harness.workspace, {
      origin: 'http://127.0.0.1:5173',
      openStream: () => stream,
      post: async (_url, body) => {
        posted.push(body);
      },
      onLog: (message) => logs.push(message),
    });
    // And without being told where to log, which is how the page starts it — on
    // a stream of its own, so it does not take this one's listener.
    startAgent(harness.workspace, {
      openStream: () => ({ addEventListener: () => {}, close: () => {} }),
      post: async () => {},
    }).close();
    deliver?.({ data: JSON.stringify({ id: 1, name: 'overview', args: {} }) });
    await harness.settle();
    expect(JSON.parse(posted[0] ?? '{}')).toMatchObject({ id: 1, ok: true });
    expect(logs).toContain('overview answered');
    bridge.close();
  });
});
