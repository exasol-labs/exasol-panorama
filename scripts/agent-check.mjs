/**
 * Drives the agent interface the way an agent would.
 *
 * The interface has three parts that can only be wrong together: the endpoint on
 * the development server, the bridge in the page, and the tools that run against
 * the live application. So this speaks the actual protocol over HTTP to the
 * actual server, with a real browser attached, and checks that what comes back
 * describes the application a person would be looking at — and that an edit sent
 * this way lands in the same document, in the same history, as a pointer's would.
 *
 * The stdio proxy is driven too, because that is the path a client that speaks
 * only stdio takes, and a pipe is exactly the sort of thing that works until it
 * is tried.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';

const URL_UNDER_TEST = process.env.PANORAMA_SMOKE_URL ?? 'http://localhost:5199/';
const origin = new URL(URL_UNDER_TEST).origin;
const problems = [];

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
page.on('pageerror', (error) => problems.push(`[pageerror] ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`[console] ${message.text()}`);
});

/** One JSON-RPC message, as a client sends it. */
let nextId = 0;
const rpc = async (method, params) => {
  const response = await fetch(`${origin}/agent/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: (nextId += 1),
      method,
      ...(params === undefined ? {} : { params }),
    }),
  });
  if (response.status === 202) return null;
  return response.json();
};

/** A tool call, with its JSON answer read back out of the content. */
const callTool = async (name, args) => {
  const answer = await rpc('tools/call', {
    name,
    ...(args === undefined ? {} : { arguments: args }),
  });
  const content = answer?.result?.content?.[0]?.text ?? '';
  if (answer?.result?.isError === true) return { error: content };
  try {
    return JSON.parse(content);
  } catch {
    return { unparsed: content };
  }
};

const report = {};

// 1. Before the page: the server is there, and says nobody is attached.
report.beforeAnyPage = await (await fetch(`${origin}/agent/health`)).json();
const orphan = await callTool('overview');
report.withNoSessionAttached = orphan.error ?? null;

// 2. The page attaches by being opened. Nothing else is done to it.
await page.goto(URL_UNDER_TEST, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);
report.afterThePageOpened = await (await fetch(`${origin}/agent/health`)).json();

// 3. The handshake and the tool list, as a client does it on connecting.
const initialize = await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'agent-check', version: '0' },
});
await rpc('notifications/initialized');
const instructions = String(initialize?.result?.instructions ?? '');
report.handshake = {
  protocolVersion: initialize?.result?.protocolVersion,
  serverName: initialize?.result?.serverInfo?.name,
  // What an agent is told before it picks a tool: which server to use for what,
  // how to establish that a native one is the same database, and to read the
  // semantic layer first.
  saysUseTheLocalCliFirst: /local `exasol` command-line tool/u.test(instructions),
  saysUseTheNativeServer: /natively/u.test(instructions),
  saysCheckItIsTheSameDatabase: /same database/u.test(instructions),
  saysReadTheSemanticLayer: /semantic model/u.test(instructions),
};
const tools = await rpc('tools/list');
report.tools = tools?.result?.tools?.map((tool) => tool.name);

// 4. Exploring: the empty document, then a table opened through the interface.
report.emptyOverview = await callTool('overview');
// Which database is behind the canvas, for checking a native server against.
report.databaseReached = report.emptyOverview.database ?? null;
const opened = await callTool('open_table', { schema: 'PANORAMA_DEMO', table: 'SAMPLE_100' });
report.opened = { name: opened.name, columns: opened.columns, id: typeof opened.id };
await page.waitForTimeout(900);
const tableId = opened.id;

const entity = await callTool('entity', { tableId });
report.entity = {
  columns: entity.columns?.map((column) => column.name),
  rows: entity.rows,
  types: entity.columns?.map((column) => column.type?.sql ?? column.type?.kind),
};
const rows = await callTool('rows', { tableId, limit: 3 });
report.rows = rows.rows;
report.rowsNotFetched = rows.notFetchedYet ?? 0;
report.catalogue = (await callTool('catalogue')).error ?? 'listed';

// 4b. What an answer costs. The terse form is the default because the thing
//     reading it has a finite amount of room to think in.
const terse = await rpc('tools/call', { name: 'entity', arguments: { tableId } });
const full = await rpc('tools/call', { name: 'entity', arguments: { tableId, verbose: true } });
const sizeOf = (answer) => (answer?.result?.content?.[0]?.text ?? '').length;
report.answerSize = {
  terse: sizeOf(terse),
  verbose: sizeOf(full),
  saved: `${Math.round((1 - sizeOf(terse) / sizeOf(full)) * 100)}%`,
};

// 5. Editing: a move, then the history it left, then undoing it.
const before = (await callTool('entity', { tableId })).at;
const moved = await callTool('dispatch', {
  command: { type: 'MoveEntities', ids: [tableId], position: { x: 400, y: 120, z: 0 } },
});
const after = (await callTool('entity', { tableId })).at;
report.edit = { did: moved.did, before, after };
report.movedOnScreen = await page.evaluate(
  (id) => globalThis.__panorama.core.world.entities.get(id).transform.x,
  tableId,
);
const history = await callTool('history');
report.history = {
  commits: history.commits.length,
  head: history.commits.find((commit) => commit.head)?.did,
  tips: history.tips.length,
};
await callTool('checkout', { to: 'undo' });
report.afterUndo = (await callTool('entity', { tableId })).at;

// 5b. A dozen boxes tidied in one call rather than a dozen, with no depth given.
const batched = await callTool('dispatch', {
  commands: [
    { type: 'MoveEntities', ids: [tableId], position: { x: -420, y: -260 } },
    { type: 'ResizeEntity', id: tableId, width: 520, height: 300 },
  ],
});
report.batch = { applied: batched.applied, did: batched.did };

// 5c. A stored relation keeps the relation's name, and says so.
report.renamingARelation =
  (await callTool('label', { tableId, label: 'the sample' })).error ?? null;

// 6. The vocabulary a person uses: a chart, set up and shown.
const charted = await callTool('action', { tableId, action: 'chart' });
const chartId = charted.opened?.[0]?.id;
await page.waitForTimeout(600);
const chart = await callTool('chart', {
  tableId: chartId,
  spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum' },
});
await page.waitForTimeout(1500);
report.chart = {
  opened: charted.opened?.length,
  mode: chart.mode,
  status: chart.chart?.status,
  drawnMarks: await page.evaluate((id) => {
    const workspace = globalThis.__panorama;
    const view = workspace.chartFor(workspace.core.world.entities.get(id), 300, 200, {
      measureText: (text, size) => text.length * size * 0.55,
      fontFamily: 'sans-serif',
    });
    return view?.chart.polygons.filter((polygon) => polygon.mark !== undefined).length ?? 0;
  }, chartId),
};

// 6b. A name of its own, and what the canvas made of the picture — which is the
//     only feedback there is on a layout nobody can look at from here. Read
//     rather than set again, because asking should not mean redrawing.
report.chartNamed = (
  await callTool('label', { tableId: chartId, label: 'revenue by country' })
).name;
const settled = await callTool('entity', { tableId: chartId });
report.renderFeedback = settled.drawn;

// 6c. The other half of the feedback: what the picture was drawn *from*. A
//     written option that reads a column the data set has not got lays out
//     perfectly and draws nothing, so the report has to say so by name — and a
//     misspelt *setting* has to be refused rather than dropped, because a chart
//     that comes back looking fine is a chart an agent will believe in.
const written = await callTool('chart', {
  tableId: chartId,
  spec: {
    type: 'custom',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    extra: JSON.stringify({
      xAxis: { type: 'category' },
      yAxis: { type: 'value' },
      series: [{ type: 'bar', datasetId: 'primary', encode: { x: 'COUNTRY', y: 'PROFIT' } }],
    }),
  },
});
await page.waitForTimeout(1500);
const resolved = await callTool('entity', { tableId: chartId });
report.dataFeedback = {
  // Read once it has settled: the `chart` call comes back while the reduction is
  // still in flight, and "loading" has no numbers to describe either way.
  whileLoading: written.chart?.status,
  offeredRatherThanClaimed:
    resolved.chart?.offered !== undefined && resolved.chart?.data === undefined,
  offered: resolved.chart?.offered,
  datasets: resolved.drawn?.datasets,
  series: resolved.drawn?.series,
  unresolved: resolved.drawn?.unresolved,
};
// 6d. A data set of the chart's own: a heatmap of raw rows, which the reduction
//     cannot express at all, plus a reference line at a number the database
//     worked out. Both are the point of naming data sets rather than typing
//     arrays into the option.
const framed = await callTool('chart', {
  tableId: chartId,
  spec: {
    type: 'custom',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    frames: [
      { name: 'cells', kind: 'rows', columns: ['COUNTRY', 'ORDER_DATE', 'REVENUE'], rowLimit: 40 },
      { name: 'mean', kind: 'scalar', column: 'REVENUE', aggregate: 'average' },
    ],
    extra: JSON.stringify({
      xAxis: { type: 'category' },
      yAxis: { type: 'category' },
      visualMap: { min: 0, max: 500, calculable: true },
      series: [
        {
          type: 'heatmap',
          datasetId: 'cells',
          encode: { x: 'COUNTRY', y: 'ORDER_DATE', value: 'REVENUE' },
          markLine: { data: [{ yAxis: { $param: 'mean' } }] },
        },
      ],
    }),
  },
});
await page.waitForTimeout(1800);
const framedRead = await callTool('entity', { tableId: chartId, verbose: true });
report.namedDataSets = {
  accepted: framed.error ?? null,
  datasets: framedRead.drawn?.datasets,
  series: framedRead.drawn?.series,
  unresolved: framedRead.drawn?.unresolved ?? [],
  // A heatmap of raw rows is a mark per row: the shape the reduction could not
  // have produced, drawn from a data set that stays true when the query changes.
  drewCells: (framedRead.drawn?.series ?? []).reduce((total, entry) => total + entry.marks, 0),
};

// 6e. A data set that reads *another* box: a marginal beside the chart's own
//     numbers, which one box's rows cannot produce. The arrow is asked for by
//     name and drawn by the tool, so it is in the history and on the canvas.
const second = await callTool('open_table', { schema: 'PANORAMA_DEMO', table: 'SAMPLE_100' });
await page.waitForTimeout(700);
const panelled = await callTool('chart', {
  tableId: chartId,
  spec: {
    type: 'custom',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    frames: [
      {
        name: 'marginal',
        kind: 'group',
        category: 'COUNTRY',
        values: ['REVENUE'],
        aggregate: 'count',
        from: second.id,
      },
    ],
    extra: JSON.stringify({
      grid: [{ right: '55%' }, { left: '55%' }],
      xAxis: [
        { type: 'category', gridIndex: 0 },
        { type: 'value', gridIndex: 1 },
      ],
      yAxis: [
        { type: 'value', gridIndex: 0 },
        { type: 'category', gridIndex: 1 },
      ],
      series: [
        { type: 'bar', datasetId: 'primary', xAxisIndex: 0, yAxisIndex: 0 },
        {
          type: 'bar',
          datasetId: 'marginal',
          xAxisIndex: 1,
          yAxisIndex: 1,
          // `count` names its measure `rows`, which is what the report said when
          // this asked for REVENUE — the check earning its keep on its own probe.
          encode: { x: 'rows', y: 'COUNTRY' },
        },
      ],
    }),
  },
});
await page.waitForTimeout(1800);
const panelRead = await callTool('entity', { tableId: chartId });
report.readsAnotherBox = {
  arrowsDrawn: panelled.reading,
  reads: panelRead.chart?.reads,
  series: panelRead.drawn?.series,
  unresolved: panelRead.drawn?.unresolved ?? [],
  // The arrow is an ordinary binding: on the canvas, in the history, undoable.
  onTheCanvas: await page.evaluate(
    (id) =>
      [...globalThis.__panorama.core.world.bindings.values()]
        .filter((binding) => binding.kind === 'data' && binding.toId === id)
        .map((binding) => ({ label: binding.label, from: binding.fromId })),
    chartId,
  ),
};

// 6f. What a picked mark *means*. A heatmap cell drawn from a keyed data set can
//     be traced back to the relation, which is what makes selection, hovering and
//     drilling in mean the same thing for every kind of chart.
const keyed = await callTool('chart', {
  tableId: chartId,
  spec: {
    type: 'custom',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    frames: [
      {
        name: 'cells',
        kind: 'rows',
        columns: ['COUNTRY', 'ORDER_DATE', 'REVENUE'],
        key: 'COUNTRY',
        rowLimit: 30,
      },
    ],
    extra: JSON.stringify({
      xAxis: { type: 'category' },
      yAxis: { type: 'category' },
      visualMap: { min: 0, max: 500 },
      series: [
        {
          type: 'heatmap',
          datasetId: 'cells',
          encode: { x: 'COUNTRY', y: 'ORDER_DATE', value: 'REVENUE' },
        },
      ],
    }),
  },
});
await page.waitForTimeout(1500);
// A mark found by pointing at the picture, the way a person would.
const cell = await page.evaluate((id) => {
  const workspace = globalThis.__panorama;
  const entity = workspace.core.world.entities.get(id);
  workspace.chartFor(entity, 400, 260, {
    measureText: (text, size) => text.length * size * 0.55,
    fontFamily: 'sans-serif',
  });
  for (let y = 20; y < 250; y += 6) {
    for (let x = 10; x < 390; x += 6) {
      const mark = workspace.chartMarkAt(id, x, y);
      if (mark !== null) return mark;
    }
  }
  return null;
}, chartId);
const behind = await callTool('action', { tableId: chartId, action: 'rows' });
await callTool('session_dispatch', {
  command: { type: 'SetSelectedMarks', targets: [{ entityId: chartId, ...cell }] },
});
await page.waitForTimeout(1200);
const picked = await callTool('session');
const drilled = await callTool('entity', { tableId: behind.opened?.[0]?.id });
const settledKeyed = await callTool('entity', { tableId: chartId });
report.whatAPickedMarkMeans = {
  // Read once it has settled: the `chart` call comes back while the rows are
  // still being read, and a data set nobody has built yet has no key to report.
  whileLoading: keyed.chart?.status,
  keyedBy: settledKeyed.chart?.reads?.find((frame) => frame.name === 'cells')?.key ?? null,
  markOnTheCanvas: cell,
  reported: picked.selectedMarks?.[0],
  // The rows behind the cell, in a table of their own — which is what identity is
  // for, and what a heatmap could not do at all before.
  rowsBehindIt: drilled.rows,
};

// 6g. Cross-filtering: a statement that leaves a predicate to the chart, wired by
//     an arrow. A cell is already picked out from the step above, so this shows the
//     canvas working as an instrument — pick something, and what is downstream of
//     the arrow re-scopes.
//
//     The box is made through the workspace rather than by running a statement:
//     the sample relations have no database behind them, so nothing can be run
//     against them. What the *database would be sent* is what matters here, and
//     that is what is read back.
const scopedId = await page.evaluate((id) => {
  const workspace = globalThis.__panorama;
  const base = workspace.core.world.entities.get(id);
  const entity = {
    id: workspace.core.ids.entity('table'),
    type: 'table',
    source: {
      kind: 'query',
      connectionId: 'connection:demo',
      sql: 'SELECT COUNTRY, REVENUE FROM derived_table WHERE {{picked}}',
      label: 'scoped by the chart',
      derivedFrom: id,
    },
    mode: 'editing',
    transform: {
      x: base.transform.x + base.transform.width + 60,
      y: base.transform.y + 320,
      z: 0,
      width: 330,
      height: 175,
    },
    columns: [],
    view: { rowHeight: 24, headerHeight: 72, horizontalOffset: 0 },
  };
  const created = workspace.core.dispatch({ type: 'CreateTableEntity', entity });
  return created.ok ? entity.id : null;
}, tableId);
const wired = await callTool('dispatch', {
  command: {
    type: 'CreateBinding',
    binding: {
      id: `binding:filter-${Date.now()}`,
      kind: 'filter',
      fromId: chartId,
      toId: scopedId,
    },
  },
});
report.crossFiltering = {
  refusedWithoutAName: wired.error ?? null,
};
const named = await callTool('dispatch', {
  command: {
    type: 'CreateBinding',
    binding: {
      id: `binding:filter2-${Date.now()}`,
      kind: 'filter',
      fromId: chartId,
      toId: scopedId,
      label: 'picked',
    },
  },
});
await page.waitForTimeout(600);
const scopedBox = await callTool('entity', { tableId: scopedId, verbose: true });
report.crossFiltering.arrowDrawn = named.did ?? named.error;
report.crossFiltering.scopedBy = scopedBox.scopedBy;
// The statement as the database would see it: the placeholder filled in from what
// is picked out in the chart, not from anything typed here.
report.crossFiltering.composed = scopedBox.composed;
// Letting the selection go widens it again, with nothing retyped.
await callTool('session_dispatch', { command: { type: 'SetSelectedMarks', targets: [] } });
await page.waitForTimeout(600);
report.crossFiltering.afterLettingGo = (
  await callTool('entity', { tableId: scopedId, verbose: true })
).composed;
report.crossFiltering.onTheCanvas = await page.evaluate(
  (id) =>
    [...globalThis.__panorama.core.world.bindings.values()]
      .filter((binding) => binding.kind === 'filter' && binding.toId === id)
      .map((binding) => ({ label: binding.label, from: binding.fromId })),
  scopedId,
);

// 6h. A series longer than the screen: resampled where the rows are, read through
//     a window, and moved along by whole windows in one call. The picture it had
//     stays on screen while the next window is in flight — the constraint the
//     whole design answers to does not get an exception for charts.
const seriesSpec = (from) => ({
  type: 'custom',
  category: 'COUNTRY',
  values: ['REVENUE'],
  aggregate: 'sum',
  frames: [
    {
      name: 'line',
      kind: 'resample',
      x: 'ORDER_DATE',
      values: ['REVENUE'],
      method: 'extremes',
      points: 120,
      key: 'ORDER_DATE',
      window: { by: 'position', from, count: 40 },
    },
  ],
  extra: JSON.stringify({
    xAxis: { type: 'category' },
    yAxis: { type: 'value' },
    series: [{ type: 'line', datasetId: 'line', encode: { x: 'ORDER_DATE', y: 'REVENUE' } }],
  }),
});
await callTool('chart', { tableId: chartId, spec: seriesSpec(0) });
await page.waitForTimeout(1500);
const firstWindow = await callTool('entity', { tableId: chartId });
// Moved along by a windowful, in one call and as a commit.
const commitsBefore = (await callTool('history')).commits?.length ?? 0;
// One windowful along. The sample relation is a hundred rows, so a window of
// forty has two and a bit of them in it.
const panned = await callTool('chart', { tableId: chartId, pan: { frame: 'line', pages: 1 } });
await page.waitForTimeout(1500);
const movedWindow = await callTool('entity', { tableId: chartId });
report.movingAlongASeries = {
  read: firstWindow.chart?.reads?.find((frame) => frame.name === 'line'),
  panned: panned.error ?? 'moved',
  after: movedWindow.chart?.reads?.find((frame) => frame.name === 'line'),
  committed: ((await callTool('history')).commits?.length ?? 0) - commitsBefore,
  marks: movedWindow.drawn?.series,
  // And it can be traced back, so a point of a series drills in like anything
  // else.
  keyed: movedWindow.chart?.reads?.find((frame) => frame.name === 'line')?.key ?? null,
};

// 6i. Three things an agent found by using this. The sample relation is a hundred
//     rows, so the shape count here is modest — the stack overflow it used to
//     throw needed about thirty thousand shapes and is pinned by a unit test.
//     What this checks is the rest of it: that measuring a picture answers, that
//     asking twice answers again (which is what "the box is poisoned" looked
//     like), that a picture says whether it can be pointed at, and that a label
//     carries no binary noise.
const heavy = await callTool('chart', {
  tableId: chartId,
  spec: {
    type: 'custom',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    frames: [{ name: 'points', kind: 'rows', columns: ['ORDER_ID', 'REVENUE'], rowLimit: 5_000 }],
    extra: JSON.stringify({
      xAxis: { type: 'value' },
      yAxis: { type: 'value' },
      series: [
        {
          type: 'scatter',
          datasetId: 'points',
          symbolSize: 6,
          encode: { x: 'ORDER_ID', y: 'REVENUE' },
        },
      ],
    }),
  },
});
await page.waitForTimeout(2000);
const measured = await callTool('entity', { tableId: chartId });
report.aPictureMeasured = {
  refused: heavy.error ?? null,
  polygons: measured.drawn?.polygons,
  // Measured in one walk rather than one stack frame per coordinate.
  covers: measured.drawn?.covers,
  pickable: measured.drawn?.pickable ?? true,
  // And asking twice is still an answer, which is what "the box is poisoned"
  // looked like.
  again: (await callTool('entity', { tableId: chartId })).drawn?.polygons,
};

const rounded = await callTool('chart', {
  tableId: chartId,
  spec: {
    type: 'bar',
    category: 'COUNTRY',
    values: ['REVENUE'],
    aggregate: 'sum',
    precision: 2,
    showValues: true,
  },
});
await page.waitForTimeout(1200);
report.figuresWithoutNoise = {
  refused: rounded.error ?? null,
  // Every label on the picture, which is where 3483.7700000000004 used to appear.
  labels: await page.evaluate((id) => {
    const workspace = globalThis.__panorama;
    const view = workspace.chartFor(workspace.core.world.entities.get(id), 420, 260, {
      measureText: (text, size) => text.length * size * 0.55,
      fontFamily: 'sans-serif',
    });
    return (view?.chart.texts ?? []).map((run) => run.text).filter((text) => /\d/u.test(text));
  }, chartId),
};

report.refusesAMisspeltSetting = (
  await callTool('chart', {
    tableId: chartId,
    spec: { type: 'bar', category: 'COUNTRY', values: ['REVENUE'], aggregate: 'sum', pivot: 'X' },
  })
).error;

// 7. Selecting a mark, which is what fills a drill-down table.
await callTool('session_dispatch', {
  command: { type: 'SetSelectedMarks', targets: [{ entityId: chartId, series: 0, data: 0 }] },
});
const session = await callTool('session');
report.session = { selectedMarks: session.selectedMarks?.length };

// 8. Refusals: the three that matter most, said in terms an agent can act on.
report.refusals = {
  unknownTable: (await callTool('entity', { tableId: 'table:nope' })).error,
  assembledEntity: (
    await callTool('dispatch', { command: { type: 'CreateTableEntity', entity: {} } })
  ).error,
  badArgument: (await callTool('rows', { tableId, limit: 'lots' })).error,
  unknownTool: (await callTool('drop_database')).error,
};

// 9. Settings: what Claude there is on this machine, and the guard on the routes
//    that could start it. Nothing here pairs or opens anything — those change the
//    machine, and a check should not.
const claude = await (await fetch(`${origin}/agent/claude`)).json();
report.claudeOnThisMachine = {
  platform: claude.platform,
  cli: claude.cli?.found === true ? (claude.cli.paired === true ? 'paired' : 'found') : 'absent',
  desktop:
    claude.desktop?.found === true
      ? claude.desktop.paired === true
        ? 'paired'
        : 'found'
      : 'absent',
  pointsAgentsAt: claude.mcpUrl,
  canOpenTerminal: claude.canOpenTerminal,
};
const asAForm = await fetch(`${origin}/agent/claude/open`, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: 'prefer=cli',
});
// A form post crosses origins without the browser asking first, so the routes
// that can start a program insist on JSON, which does not.
report.refusesACrossOriginForm = asAForm.status;

// 10. The stdio path, which is how a client that speaks only stdio arrives.
report.stdio = await new Promise((resolve) => {
  const child = spawn('node', ['packages/mcp/bin/panorama-agent.mjs'], {
    env: { ...process.env, PANORAMA_AGENT_URL: `${origin}/agent/mcp` },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let pending = '';
  child.stdout.on('data', (chunk) => {
    pending += chunk.toString();
    const parts = pending.split('\n');
    pending = parts.pop() ?? '';
    for (const part of parts) if (part.trim() !== '') lines.push(JSON.parse(part));
    if (lines.length >= 2) {
      child.kill();
      resolve({
        answered: lines.length,
        serverName: lines[0]?.result?.serverInfo?.name ?? null,
        tables: JSON.parse(lines[1]?.result?.content?.[0]?.text ?? '{}').tables ?? null,
      });
    }
  });
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`,
  );
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(
    `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'overview' } })}\n`,
  );
  setTimeout(() => {
    child.kill();
    resolve({ answered: lines.length, timedOut: true });
  }, 8000);
});

// 11. And the page detaching, which is a reload as far as an agent is concerned.
await page.close();
await new Promise((resolve) => setTimeout(resolve, 400));
report.afterThePageClosed = await (await fetch(`${origin}/agent/health`)).json();

console.log(JSON.stringify(report, null, 2));
console.log('problems:', problems.length === 0 ? '(none)' : problems.join('\n'));
await browser.close();
