/**
 * Drives the built desktop application the way an agent would.
 *
 * The suite proves the pieces: the page answers the protocol
 * (`packages/mcp/test/answer.test.ts`), the transport to the shell behaves
 * (`apps/web/test/shell-agent.test.ts`), and the shell's own guards and session
 * file are checked by `cargo test`. What none of them can prove is the thing the
 * product actually claims — that installing *one* file gives you an application
 * whose canvas an agent can drive, with nothing else running.
 *
 * So this launches the bundle, asks it questions over its own endpoint and through
 * its own stdio pipe, and reads what comes back:
 *
 *   1. It binds an endpoint and writes down where it is.
 *   2. The page attaches, and the catalogue is the page's: sixteen tools, skill first.
 *   3. An agent's edit lands in the live document — and the rows behind it arrive,
 *      which is the data worker running on the shell's own scheme.
 *   4. The guards hold: no token, and no other origin.
 *   5. The pipe answers the handshake with no window open, and does not open one.
 *   6. A *call* with no window open starts one and answers.
 *   7. The database socket is there, and refuses a caller without the token.
 *
 * Run it on a build:
 *
 *     npm run desktop:build && npm run desktop-check
 *
 * It keeps its session file in a directory of its own (`PANORAMA_SESSION_DIR`), so
 * a run does not disturb the application you have open.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const problems = [];
const expect = (claim, message) => {
  if (!claim) problems.push(message);
};
const report = {};

/** Where the bundler puts the executable, per platform. */
const binary = () => {
  const target = 'apps/desktop/src-tauri/target/release';
  if (process.platform === 'darwin') {
    const app = `${target}/bundle/macos/Exasol Panorama.app/Contents/MacOS/panorama-desktop`;
    return existsSync(app) ? app : `${target}/panorama-desktop`;
  }
  return process.platform === 'win32'
    ? `${target}/panorama-desktop.exe`
    : `${target}/panorama-desktop`;
};

const executable = binary();
if (!existsSync(executable)) {
  console.error(`No built application at ${executable}. Run \`npm run desktop:build\` first.`);
  process.exit(1);
}

/** Its own home, so a run cannot be confused with the reader's own session. */
const home = mkdtempSync(join(tmpdir(), 'panorama-desktop-check-'));
const sessions = join(home, 'sessions');
const environment = { ...process.env, PANORAMA_SESSION_DIR: sessions };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The window, as it wrote itself down. */
const session = () => {
  if (!existsSync(sessions)) return null;
  const files = readdirSync(sessions).filter((name) => name.endsWith('.json'));
  if (files.length === 0) return null;
  return JSON.parse(readFileSync(join(sessions, files[0]), 'utf8'));
};

const waitFor = async (what, condition, ms = 30_000) => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await condition();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
};

const call = async (where, message, options = {}) => {
  const response = await fetch(`http://127.0.0.1:${where.port}/agent/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.token === null
        ? {}
        : { authorization: `Bearer ${options.token ?? where.token}` }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    body: JSON.stringify(message),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : JSON.parse(text) };
};

/** One conversation through the stdio pipe, as a client would have it. */
const throughPipe = (messages) =>
  new Promise((resolve, reject) => {
    const pipe = spawn(executable, ['--mcp-stdio'], { env: environment });
    let out = '';
    let notes = '';
    pipe.stdout.on('data', (chunk) => (out += chunk));
    pipe.stderr.on('data', (chunk) => (notes += chunk));
    pipe.on('error', reject);
    pipe.on('close', () =>
      resolve({
        answers: out
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line)),
        notes,
      }),
    );
    for (const message of messages) pipe.stdin.write(`${JSON.stringify(message)}\n`);
    pipe.stdin.end();
  });

const text = (answer) => answer.body.result.content[0].text;

let application = null;
try {
  console.info('launching the application...');
  application = spawn(executable, [], { env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
  // The application is single-instance, so a copy started while one is already
  // open hands over its arguments and exits — leaving this waiting for a session
  // file that the *other* instance has written somewhere else. Worth saying
  // outright, because the alternative is a thirty-second timeout and a guess.
  let handedOver = false;
  application.on('exit', () => (handedOver = true));
  // The shell says where its database socket is on the way up; there is nowhere
  // else to read it, and nothing else should need to.
  let said = '';
  application.stderr.on('data', (chunk) => (said += chunk));

  const where = await waitFor(
    'the session file',
    () =>
      session() ??
      (handedOver
        ? (() => {
            throw new Error(
              'the application it started handed over to one that was already running: quit Panorama and run this again',
            );
          })()
        : null),
  );
  report.port = where.port;
  expect(typeof where.token === 'string' && where.token.length > 8, 'the session has no token');

  const health = await waitFor('a window to attach', async () => {
    const response = await fetch(`http://127.0.0.1:${where.port}/agent/health`).catch(() => null);
    if (response === null) return null;
    const body = await response.json();
    return body.attached > 0 ? body : null;
  });
  report.attached = health.attached;

  const tools = await call(where, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
  report.tools = tools.body.result.tools.length;
  expect(report.tools === 16, `expected sixteen tools, got ${report.tools}`);
  expect(
    tools.body.result.tools[0]?.name === 'skill',
    'the skill is not first, so a client that shows one tool shows the wrong one',
  );

  const skill = await call(where, {
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'skill', arguments: {} },
  });
  expect(
    text(skill).startsWith('# Driving Panorama'),
    'the skill did not come back: the document is not in the bundle',
  );

  const opened = await call(where, {
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'open_table', arguments: { schema: 'PANORAMA_DEMO', table: 'SAMPLE_100' } },
  });
  expect(!opened.body.result.isError, `open_table refused: ${text(opened)}`);
  const tableId = JSON.parse(text(opened)).id;

  const rows = await call(where, {
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'rows', arguments: { tableId, from: 0, limit: 3 } },
  });
  expect(!rows.body.result.isError, `rows refused: ${text(rows)}`);
  const read = JSON.parse(text(rows));
  report.rows = read.rows?.length ?? 0;
  // The one thing only a real bundle can show: the data worker, on the shell's
  // own scheme, actually delivered cells.
  expect(read.rows?.[0]?.COUNTRY === 'Poland', 'the rows behind the table did not arrive');

  const notification = await call(where, { jsonrpc: '2.0', method: 'notifications/initialized' });
  expect(
    notification.status === 202,
    `a notification should be accepted, got ${notification.status}`,
  );

  const untokened = await call(
    where,
    { jsonrpc: '2.0', id: 5, method: 'tools/list' },
    { token: null },
  );
  expect(untokened.status === 401, `an untokened call should be refused, got ${untokened.status}`);
  const foreign = await call(
    where,
    { jsonrpc: '2.0', id: 6, method: 'tools/list' },
    { origin: 'https://example.com' },
  );
  expect(foreign.status === 403, `another origin should be refused, got ${foreign.status}`);

  // What a client actually says when it connects, so the pipe sees — and
  // remembers — both halves of the menu.
  const live = await throughPipe([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  expect(
    live.answers[1]?.result?.tools?.length === 16,
    'the pipe did not reach the window it was pointed at',
  );

  // The database socket: a page opens it to reach an instance whose certificate a
  // browser would refuse. Whether that certificate is *acceptable* is decided in
  // the shell and covered by `cargo test`; what matters here is that the socket is
  // listening and that it is not open to whatever else is on this machine.
  const socketPort = /database socket on ws:\/\/127\.0\.0\.1:(\d+)/u.exec(said)?.[1];
  expect(socketPort !== undefined, `the shell did not report a database socket: ${said}`);
  report.socketPort = Number(socketPort);
  if (socketPort !== undefined) {
    const refusal = await new Promise((resolve) => {
      const socket = new WebSocket(
        `ws://127.0.0.1:${socketPort}/database?token=not-the-token&target=wss://localhost:8563`,
      );
      socket.addEventListener('close', (event) => resolve(event.reason));
      socket.addEventListener('error', () => resolve('error'));
    });
    expect(
      String(refusal).includes('token'),
      `a caller without the token should be told so, and was told: ${refusal}`,
    );
    report.socketGuard = 'refused a caller without the token';
  }

  console.info('closing the application...');
  application.kill('SIGTERM');
  application = null;
  await sleep(1500);

  // The handshake, with nothing running: answered from what the pipe saw, and no
  // window opened for it. A client starting up must not put an application on
  // screen.
  const cold = await throughPipe([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  ]);
  expect(cold.answers.length === 2, 'the pipe did not answer the handshake with nothing running');
  expect(
    cold.answers[1]?.result?.tools?.length === 16,
    'the remembered catalogue was not there or was wrong',
  );
  expect(
    cold.notes.includes('no window opened'),
    `the pipe opened a window for a question about the interface: ${cold.notes}`,
  );
  expect(session() === null, 'a session file was left behind for a window that has gone');

  // And a call *does* open one. This is the whole claim of the desktop
  // application: install one thing, ask your agent, get a canvas.
  const started = await throughPipe([
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'open_table', arguments: { schema: 'PANORAMA_DEMO', table: 'COUNTRIES' } },
    },
  ]);
  const answer = started.answers[0]?.result;
  expect(answer !== undefined && !answer.isError, `a cold call was not answered: ${started.notes}`);
  expect(
    started.notes.includes('starting Panorama'),
    `the pipe did not start an application for a call: ${started.notes}`,
  );
  report.coldStart = 'answered';
} catch (error) {
  problems.push(String(error));
} finally {
  if (application !== null) application.kill('SIGTERM');
  // Whatever the pipe started, too: it is detached from this process.
  const left = session();
  if (left !== null) spawnSync('kill', [String(left.pid)]);
  rmSync(home, { recursive: true, force: true });
}

console.info(JSON.stringify(report, null, 2));
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):`);
  for (const problem of problems) console.error(` - ${problem}`);
  process.exit(1);
}
console.info(
  '\nthe desktop application is self-contained: endpoint, catalogue, rows, guards, pipe, database socket.',
);
