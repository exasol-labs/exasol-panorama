#!/usr/bin/env node
/**
 * Model Context Protocol over stdin and stdout, for clients that speak only
 * that, forwarded to the endpoint on the development server.
 *
 * A pipe and nothing else: no state, no protocol knowledge beyond "one JSON
 * value per line", and no imports. The server it forwards to is the one running
 * inside `npm run dev`, because that is the process the application is in and
 * the application is where every answer comes from.
 *
 *   claude mcp add panorama -- node packages/mcp/bin/panorama-agent.mjs
 *
 * Anything that is not the protocol goes to stderr: stdout is the conversation,
 * and a stray line on it would break it.
 */

const url = process.env.PANORAMA_AGENT_URL ?? 'http://localhost:5173/agent/mcp';
const note = (message) => process.stderr.write(`[panorama-agent] ${message}\n`);

/**
 * How often to ask which catalogue is on the other end.
 *
 * A client fetches the tool list once, when it connects, and then shows what it
 * fetched. That is reasonable of it and it caused a real failure: an agent read a
 * fourteen-tool catalogue for days while the server grew two more, and neither
 * side could tell — not least because for part of that time there was no server
 * running at all, so the list it was showing was a memory of one.
 *
 * The handshake now carries a stamp of the catalogue (`serverInfo.version`). This
 * watches it and, when it moves, tells the client its list is out of date. Which
 * covers the case that started it: connect with nothing there, start `npm run
 * dev` later, and the client is told rather than left holding a snapshot.
 */
const POLL_MS = Number(process.env.PANORAMA_AGENT_POLL_MS ?? 4000);

/** An error the client can read, in the shape the protocol expects. */
const failure = (id, message) =>
  JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code: -32_603, message } });

const forward = async (line) => {
  let id = null;
  try {
    id = JSON.parse(line).id ?? null;
  } catch {
    // Malformed input is the endpoint's to complain about, with its own wording.
  }
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: line,
    });
    // 202 is a notification the endpoint accepted and had nothing to say about.
    if (response.status === 202) return null;
    return (await response.text()).trim();
  } catch (error) {
    return failure(
      id,
      `Could not reach Panorama at ${url}. Is "npm run dev" running? (${String(error)})`,
    );
  }
};

/**
 * The stamp on the other end, or null when there is nothing on the other end.
 *
 * `initialize` is the cheapest thing that carries it, and the endpoint holds no
 * session, so asking again costs a small POST and changes nothing.
 */
const askStamp = async () => {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'panorama-agent/stamp',
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    });
    if (!response.ok) return null;
    const parsed = JSON.parse(await response.text());
    return parsed?.result?.serverInfo?.version ?? null;
  } catch {
    return null;
  }
};

let stamp = null;
let watching = false;

/**
 * Watch for the catalogue changing, once the client has introduced itself.
 *
 * Before that there is nothing to tell: a notification to a client that has not
 * finished its handshake is a line it is entitled to ignore.
 */
const watchCatalogue = () => {
  if (watching) return;
  watching = true;
  const timer = setInterval(async () => {
    const current = await askStamp();
    if (current === null || current === stamp) return;
    const previous = stamp;
    stamp = current;
    /**
     * `null` before means there was nothing listening when the client connected,
     * so whatever list it is holding came from somewhere else — an earlier run, or
     * an empty answer. That is the case this was written for, so it is a change,
     * not a first sighting: a server appearing is news.
     */
    note(
      `catalogue ${previous === null ? 'appeared' : 'changed'}: ${previous ?? 'nothing'} -> ${current}; telling the client to list again`,
    );
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })}\n`,
    );
  }, POLL_MS);
  // A watch must not be the reason this process outlives the conversation.
  timer.unref();
};

note(`forwarding to ${url}`);
process.stdin.setEncoding('utf8');
let pending = '';
for await (const chunk of process.stdin) {
  pending += chunk;
  const lines = pending.split('\n');
  pending = lines.pop() ?? '';
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const answer = await forward(trimmed);
    if (answer !== null && answer !== '') process.stdout.write(`${answer}\n`);
    // The handshake is where a client's tool list comes from, so it is also
    // where watching for that list going stale begins.
    if (trimmed.includes('"initialize"')) {
      stamp = await askStamp();
      watchCatalogue();
    }
  }
}
