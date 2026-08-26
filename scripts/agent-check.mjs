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
